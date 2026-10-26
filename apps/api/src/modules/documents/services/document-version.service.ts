import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AppError,
  CANONICAL_MIME_TYPES,
  DocumentAuditAction,
  DocumentRejectionCode,
  DocumentVersionStatus,
  PalCertErrorCode,
  ProcessingJobType,
  SUPPORTED_UPLOAD_EXTENSIONS,
  UploadSessionStatus,
  buildPage,
  contentDispositionAttachment,
  decodeCursor,
  encodeCursor,
  extensionOf,
  resolveLimit,
  sanitizeOriginalFilename,
  type CreateDocumentVersionResponse,
  type DocumentFormat,
  type DocumentVersionView,
  type DownloadAuthorizationView,
  type Page,
  type UploadAuthorizationView,
} from '@palcert/contracts';
import type { DocumentVersion, UploadSession } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { ObjectStoragePort } from '../../../infrastructure/storage/object-storage.port';
import { quarantineObjectKey } from '../../../infrastructure/storage/storage-keys';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { toDocumentVersionView } from '../mapping';
import { loadDocument, type RequestContext } from './document.service';

export interface CreateVersionInput {
  readonly originalFilename: string;
  readonly declaredMimeType?: string | undefined;
  readonly sizeBytes: number;
  readonly sha256?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

type VersionWithSession = DocumentVersion & { uploadSession: UploadSession | null };

/**
 * Versions, uploads, finalization and downloads (§29).
 *
 * The API is the authority: it creates the version, the session and the
 * server-generated key *before* any URL exists, verifies the exact staged
 * object at finalize, and records the processing intent in the same
 * transaction as the state change. Storage is never asked to decide
 * anything about authorization.
 */
@Injectable()
export class DocumentVersionService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly storage: ObjectStoragePort,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly events: SecurityEventService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DocumentVersionService.name);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(
    userId: string,
    documentId: string,
    query: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<Page<DocumentVersionView>> {
    const limit = resolveLimit(query.limit);
    const cursor = parseVersionCursor(query.cursor);

    const rows = await this.tenant.withUser(userId, async (tx) => {
      await loadDocument(tx, documentId);
      return tx.documentVersion.findMany({
        where: {
          documentId,
          // A correction in flight is not the owner's yet: it has not been
          // paid for and its recheck has not proved it worth delivering, so
          // it does not appear in their list of versions (Phase 12 §84).
          visibleToOwner: true,
          ...(cursor === null ? {} : { versionNumber: { lt: cursor } }),
        },
        orderBy: { versionNumber: 'desc' },
        take: limit + 1,
        include: { uploadSession: true },
      });
    });

    return buildPage(rows.map(toDocumentVersionView), limit, (item) =>
      encodeCursor(String(item.versionNumber), item.id),
    );
  }

  async get(userId: string, documentId: string, versionId: string): Promise<DocumentVersionView> {
    const row = await this.tenant.withUser(userId, async (tx) => {
      await loadDocument(tx, documentId);
      return loadVersion(tx, documentId, versionId);
    });
    return toDocumentVersionView(row);
  }

  // -------------------------------------------------------------------------
  // Create + authorize
  // -------------------------------------------------------------------------

  /**
   * Create the next version and its upload session, and issue an authorization.
   *
   * Version numbers are allocated under a row lock on the document, so two
   * concurrent uploads get 3 and 4, never 3 and 3 (§9). An `Idempotency-Key`
   * makes the call safe to retry: the same key returns the same version with
   * a fresh authorization for the same staged key; the same key with a
   * different request is refused (§74).
   */
  async create(
    userId: string,
    documentId: string,
    input: CreateVersionInput,
    request: RequestContext,
  ): Promise<CreateDocumentVersionResponse> {
    const originalFilename = sanitizeOriginalFilename(input.originalFilename);
    const expectedFormat = formatForFilename(originalFilename);
    const maxBytes = this.config.upload.maxBytesByFormat[expectedFormat];
    if (input.sizeBytes > maxBytes) {
      throw new AppError(PalCertErrorCode.FILE_TOO_LARGE, {
        message: `A ${expectedFormat} file may be at most ${maxBytes} bytes.`,
        details: { maxBytes, format: expectedFormat },
      });
    }
    const declaredMimeType = input.declaredMimeType?.trim().slice(0, 255) ?? null;
    const clientSha256 = input.sha256 ?? null;
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.upload.sessionTtlSeconds * 1000);

    const existing = await this.findByIdempotencyKey(userId, documentId, input.idempotencyKey);
    if (existing !== null) {
      assertSameRequest(existing, {
        originalFilename,
        sizeBytes: input.sizeBytes,
        declaredMimeType,
        clientSha256,
      });
      const upload = await this.authorize(existing, expectedFormat);
      return { version: toDocumentVersionView(existing), upload };
    }

    const created = await this.tenant
      .withUser(userId, async (tx) => {
        const document = await loadDocument(tx, documentId);

        // Serialize version allocation per document: the lock is released at
        // commit, and the unique (document_id, version_number) index is the
        // backstop should anything ever bypass this path.
        await tx.$queryRaw`SELECT "id" FROM "documents" WHERE "id" = ${document.id}::uuid FOR UPDATE`;
        const aggregate = await tx.documentVersion.aggregate({
          where: { documentId },
          _max: { versionNumber: true },
        });
        const versionNumber = (aggregate._max.versionNumber ?? 0) + 1;

        // The quarantine key embeds the version id and is immutable once
        // written (the row guard rejects any later change), so the id is
        // allocated here and the row is inserted with its final key.
        const versionId = randomUUID();
        const storageKey = quarantineObjectKey({ ownerUserId: userId, documentId, versionId });
        const version = await tx.documentVersion.create({
          data: {
            id: versionId,
            documentId,
            ownerUserId: userId,
            versionNumber,
            status: DocumentVersionStatus.AWAITING_UPLOAD,
            originalFilename,
            declaredMimeType,
            expectedFormat,
            declaredSizeBytes: input.sizeBytes,
            clientSha256,
            quarantineObjectKey: storageKey,
          },
        });
        const session = await tx.uploadSession.create({
          data: {
            ownerUserId: userId,
            documentId,
            documentVersionId: version.id,
            status: UploadSessionStatus.CREATED,
            storageKey,
            idempotencyKey: input.idempotencyKey ?? null,
            declaredSizeBytes: input.sizeBytes,
            declaredMimeType,
            clientSha256,
            // Both timestamps come from the one clock so that the expiry
            // invariant (expires_at > created_at) holds under any time source.
            createdAt: now,
            expiresAt,
          },
        });
        await tx.document.update({ where: { id: documentId }, data: { updatedAt: now } });
        return { ...version, uploadSession: session };
      })
      .catch(async (error: unknown) => {
        // Two identical requests raced on the idempotency key: the loser reads
        // the winner's session and returns the same result.
        if (isUniqueViolation(error) && input.idempotencyKey !== undefined) {
          const winner = await this.findByIdempotencyKey(userId, documentId, input.idempotencyKey);
          if (winner !== null) return winner;
        }
        throw error;
      });

    await this.events.audit({
      action: DocumentAuditAction.DOCUMENT_VERSION_CREATED,
      actorUserId: userId,
      targetType: 'DocumentVersion',
      targetId: created.id,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: {
        documentId,
        versionNumber: created.versionNumber,
        expectedFormat,
        declaredSizeBytes: input.sizeBytes,
      },
    });
    await this.events.audit({
      action: DocumentAuditAction.UPLOAD_SESSION_CREATED,
      actorUserId: userId,
      targetType: 'UploadSession',
      targetId: created.uploadSession?.id ?? null,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: { documentVersionId: created.id, expiresAt: expiresAt.toISOString() },
    });

    const upload = await this.authorize(created, expectedFormat);
    return { version: toDocumentVersionView(created), upload };
  }

  /** A fresh authorization for a version still awaiting its upload. */
  async reissueUploadAuthorization(
    userId: string,
    documentId: string,
    versionId: string,
  ): Promise<UploadAuthorizationView> {
    const version = await this.tenant.withUser(userId, async (tx) => {
      await loadDocument(tx, documentId);
      return loadVersion(tx, documentId, versionId);
    });
    this.assertAwaitingUpload(version);
    return this.authorize(version, version.expectedFormat as DocumentFormat);
  }

  private async authorize(
    version: VersionWithSession,
    format: DocumentFormat,
  ): Promise<UploadAuthorizationView> {
    const session = version.uploadSession;
    if (session === null) {
      throw new AppError(PalCertErrorCode.UPLOAD_SESSION_NOT_FOUND, {
        message: 'No upload session.',
      });
    }
    // The authorization never outlives the session.
    const remaining = Math.floor((session.expiresAt.getTime() - this.clock.now().getTime()) / 1000);
    const ttl = Math.max(30, Math.min(this.config.storage.uploadUrlTtlSeconds, remaining));
    const grant = await this.storage
      .createUploadAuthorization({
        zone: 'quarantine',
        key: session.storageKey,
        contentLength: session.declaredSizeBytes,
        contentType: CANONICAL_MIME_TYPES[format],
        sha256Hex: session.clientSha256,
        expiresInSeconds: ttl,
      })
      .catch((error: unknown) => {
        throw storageUnavailable(error);
      });
    return {
      method: 'PUT',
      url: grant.url,
      headers: grant.headers,
      expiresAt: grant.expiresAt.toISOString(),
    };
  }

  private async findByIdempotencyKey(
    userId: string,
    documentId: string,
    key: string | undefined,
  ): Promise<VersionWithSession | null> {
    if (key === undefined) return null;
    const session = await this.tenant.withUser(userId, (tx) =>
      tx.uploadSession.findUnique({
        where: { ownerUserId_idempotencyKey: { ownerUserId: userId, idempotencyKey: key } },
        include: { version: true },
      }),
    );
    if (session === null) return null;
    if (session.documentId !== documentId) {
      throw new AppError(PalCertErrorCode.IDEMPOTENCY_KEY_REUSED, {
        message: 'This Idempotency-Key was already used for a different request.',
      });
    }
    return { ...session.version, uploadSession: session };
  }

  // -------------------------------------------------------------------------
  // Finalize
  // -------------------------------------------------------------------------

  /**
   * Finalize (§30): idempotent, and the only place a job is created.
   *
   * The API checks that the staged object exists and has the authorized size,
   * captures its exact object version, and — in one transaction — moves the
   * version to UPLOADED, the session to FINALIZED, and writes the processing
   * intent. A second call for a version already past AWAITING_UPLOAD returns
   * the current state and creates nothing.
   */
  async finalize(
    userId: string,
    documentId: string,
    versionId: string,
    request: RequestContext,
  ): Promise<DocumentVersionView> {
    const current = await this.tenant.withUser(userId, async (tx) => {
      await loadDocument(tx, documentId);
      return loadVersion(tx, documentId, versionId);
    });

    if (current.status !== DocumentVersionStatus.AWAITING_UPLOAD) {
      if (current.status === DocumentVersionStatus.UPLOAD_EXPIRED) throw uploadExpired();
      if (current.status === DocumentVersionStatus.CANCELLED) throw uploadCancelled();
      return toDocumentVersionView(current);
    }
    if (current.uploadSession === null) {
      throw new AppError(PalCertErrorCode.UPLOAD_SESSION_NOT_FOUND, {
        message: 'No upload session.',
      });
    }
    if (current.uploadSession.expiresAt.getTime() <= this.clock.now().getTime()) {
      await this.expire(userId, current);
      throw uploadExpired();
    }

    // Outside the transaction: a storage round trip must not hold a lock. An
    // outage here changes nothing: the version stays AWAITING_UPLOAD and the
    // caller can finalize again once storage is back.
    const staged = await this.storage
      .headObject({ zone: 'quarantine', key: current.uploadSession.storageKey })
      .catch((error: unknown) => {
        throw storageUnavailable(error);
      });
    if (staged === null) {
      throw new AppError(PalCertErrorCode.UPLOAD_OBJECT_NOT_FOUND, {
        message: 'Nothing has been uploaded for this version yet.',
      });
    }
    const format = current.expectedFormat as DocumentFormat;
    const maxBytes = this.config.upload.maxBytesByFormat[format];
    const now = this.clock.now();

    if (staged.sizeBytes > maxBytes) {
      // Unacceptable content, decided here rather than by the worker.
      await this.rejectAtFinalize(
        userId,
        current,
        staged,
        DocumentRejectionCode.FILE_TOO_LARGE,
        now,
      );
      throw new AppError(PalCertErrorCode.FILE_TOO_LARGE, {
        message: `A ${format} file may be at most ${maxBytes} bytes.`,
        details: { maxBytes, format },
      });
    }
    if (staged.sizeBytes !== current.declaredSizeBytes) {
      throw new AppError(PalCertErrorCode.UPLOAD_SIZE_MISMATCH, {
        message: 'The uploaded file is not the size this upload was authorized for.',
        details: {
          declaredSizeBytes: current.declaredSizeBytes,
          uploadedSizeBytes: staged.sizeBytes,
        },
      });
    }

    const result = await this.tenant.withUser(userId, async (tx) => {
      // Re-read under a lock: a concurrent finalize may have won.
      const locked = await lockVersion(tx, versionId);
      if (locked.status !== DocumentVersionStatus.AWAITING_UPLOAD) {
        return { version: await loadVersion(tx, documentId, versionId), job: null };
      }

      const version = await tx.documentVersion.update({
        where: { id: versionId },
        data: {
          status: DocumentVersionStatus.UPLOADED,
          uploadedAt: now,
          quarantineObjectVersionId: staged.versionId,
          quarantineObjectEtag: staged.etag,
        },
        include: { uploadSession: true },
      });
      await tx.uploadSession.update({
        where: { documentVersionId: versionId },
        data: { status: UploadSessionStatus.FINALIZED, finalizedAt: now },
      });
      await tx.document.update({ where: { id: documentId }, data: { updatedAt: now } });
      const job = await this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.DOCUMENT_INGEST,
        resourceType: 'DOCUMENT_VERSION',
        resourceId: versionId,
        ownerUserId: userId,
      });
      return { version, job };
    });

    if (result.job !== null) {
      await this.events.audit({
        action: DocumentAuditAction.UPLOAD_FINALIZED,
        actorUserId: userId,
        targetType: 'DocumentVersion',
        targetId: versionId,
        requestId: request.requestId,
        ipAddress: request.ipAddress,
        afterState: {
          sizeBytes: staged.sizeBytes,
          objectVersionCaptured: staged.versionId !== null,
        },
      });
      if (staged.versionId === null) {
        this.logger.warn(
          { versionId },
          'Quarantine object has no version id; bucket versioning is not enabled',
        );
      }
      await this.dispatcher.dispatchNow(result.job.id);
    }

    return toDocumentVersionView(result.version);
  }

  private async rejectAtFinalize(
    userId: string,
    current: VersionWithSession,
    staged: { versionId: string | null; etag: string | null },
    code: DocumentRejectionCode,
    now: Date,
  ): Promise<void> {
    await this.tenant.withUser(userId, async (tx) => {
      const locked = await lockVersion(tx, current.id);
      if (locked.status !== DocumentVersionStatus.AWAITING_UPLOAD) return;
      await tx.documentVersion.update({
        where: { id: current.id },
        data: {
          status: DocumentVersionStatus.UPLOADED,
          uploadedAt: now,
          quarantineObjectVersionId: staged.versionId,
          quarantineObjectEtag: staged.etag,
        },
      });
      await tx.documentVersion.update({
        where: { id: current.id },
        data: { status: DocumentVersionStatus.REJECTED, rejectionCode: code, rejectedAt: now },
      });
      await tx.uploadSession.update({
        where: { documentVersionId: current.id },
        data: { status: UploadSessionStatus.FINALIZED, finalizedAt: now },
      });
    });
    await this.events.audit({
      action: DocumentAuditAction.DOCUMENT_VERSION_REJECTED,
      actorUserId: userId,
      targetType: 'DocumentVersion',
      targetId: current.id,
      afterState: { rejectionCode: code, stage: 'finalize' },
    });
    await this.discardStaged(current.uploadSession?.storageKey ?? null, current.id, userId);
  }

  // -------------------------------------------------------------------------
  // Cancel, expire, retry
  // -------------------------------------------------------------------------

  async cancel(
    userId: string,
    documentId: string,
    versionId: string,
    request: RequestContext,
  ): Promise<DocumentVersionView> {
    const now = this.clock.now();
    const version = await this.tenant.withUser(userId, async (tx) => {
      await loadDocument(tx, documentId);
      const locked = await lockVersion(tx, versionId);
      if (locked.status !== DocumentVersionStatus.AWAITING_UPLOAD) {
        throw new AppError(PalCertErrorCode.UPLOAD_ALREADY_FINALIZED, {
          message: 'This upload has already been finalized and cannot be cancelled.',
        });
      }
      await tx.uploadSession.updateMany({
        where: { documentVersionId: versionId, status: UploadSessionStatus.CREATED },
        data: { status: UploadSessionStatus.CANCELLED, cancelledAt: now },
      });
      return tx.documentVersion.update({
        where: { id: versionId },
        data: { status: DocumentVersionStatus.CANCELLED },
        include: { uploadSession: true },
      });
    });

    await this.events.audit({
      action: DocumentAuditAction.UPLOAD_SESSION_CANCELLED,
      actorUserId: userId,
      targetType: 'DocumentVersion',
      targetId: versionId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
    });
    await this.discardStaged(version.uploadSession?.storageKey ?? null, versionId, userId);
    return toDocumentVersionView(version);
  }

  private async expire(userId: string, version: VersionWithSession): Promise<void> {
    const now = this.clock.now();
    await this.tenant.withUser(userId, async (tx) => {
      const locked = await lockVersion(tx, version.id);
      if (locked.status !== DocumentVersionStatus.AWAITING_UPLOAD) return;
      await tx.uploadSession.updateMany({
        where: { documentVersionId: version.id, status: UploadSessionStatus.CREATED },
        data: { status: UploadSessionStatus.EXPIRED, expiredAt: now },
      });
      await tx.documentVersion.update({
        where: { id: version.id },
        data: { status: DocumentVersionStatus.UPLOAD_EXPIRED },
      });
    });
    await this.events.audit({
      action: DocumentAuditAction.UPLOAD_SESSION_EXPIRED,
      actorUserId: userId,
      targetType: 'DocumentVersion',
      targetId: version.id,
    });
    await this.discardStaged(version.uploadSession?.storageKey ?? null, version.id, userId);
  }

  /**
   * Ask PalCert to process a FAILED version again, without a new upload (§80).
   *
   * Only an infrastructure failure is retryable, and only while the staged
   * object still exists. A REJECTED version never is: the content was judged.
   */
  async retry(
    userId: string,
    documentId: string,
    versionId: string,
    request: RequestContext,
  ): Promise<DocumentVersionView> {
    const outcome = await this.tenant.withUser(userId, async (tx) => {
      await loadDocument(tx, documentId);
      const locked = await lockVersion(tx, versionId);
      if (locked.status !== DocumentVersionStatus.FAILED || locked.quarantineDeletedAt !== null) {
        throw new AppError(PalCertErrorCode.DOCUMENT_VERSION_NOT_RETRYABLE, {
          message:
            'Only a version that failed processing, whose upload is still held, can be retried.',
        });
      }
      const version = await tx.documentVersion.update({
        where: { id: versionId },
        data: {
          status: DocumentVersionStatus.UPLOADED,
          failureCode: null,
          failureDetail: null,
          failedAt: null,
        },
        include: { uploadSession: true },
      });
      const job = await this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.DOCUMENT_INGEST,
        resourceType: 'DOCUMENT_VERSION',
        resourceId: versionId,
        ownerUserId: userId,
      });
      return { version, job };
    });

    await this.events.audit({
      action: DocumentAuditAction.DOCUMENT_VERSION_RETRIED,
      actorUserId: userId,
      targetType: 'DocumentVersion',
      targetId: versionId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
    });
    await this.dispatcher.dispatchNow(outcome.job.id);
    return toDocumentVersionView(outcome.version);
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  /**
   * A short-lived signed GET of the exact clean object (§43, §44).
   *
   * Authorization is decided here — the caller's own, READY, unpurged
   * version — before anything is signed. The URL is bearer material with a
   * lifetime of minutes, and issuing it is audited as a download.
   */
  async createDownloadAuthorization(
    userId: string,
    documentId: string,
    versionId: string,
    request: RequestContext,
  ): Promise<DownloadAuthorizationView> {
    const version = await this.tenant.withUser(userId, async (tx) => {
      await loadDocument(tx, documentId);
      return loadVersion(tx, documentId, versionId);
    });

    if (version.status !== DocumentVersionStatus.READY || version.cleanObjectKey === null) {
      throw new AppError(PalCertErrorCode.DOCUMENT_NOT_READY, {
        message: 'This version has not been accepted yet, so it cannot be downloaded.',
      });
    }
    if (version.purgedAt !== null) {
      throw new AppError(PalCertErrorCode.DOWNLOAD_NOT_AVAILABLE, {
        message: 'This version is no longer available.',
      });
    }

    const filename = version.originalFilename;
    const contentType =
      version.detectedMimeType ?? CANONICAL_MIME_TYPES[version.expectedFormat as DocumentFormat];
    const grant = await this.storage
      .createDownloadAuthorization({
        ref: {
          zone: 'clean',
          key: version.cleanObjectKey,
          versionId: version.cleanObjectVersionId,
        },
        expiresInSeconds: this.config.storage.downloadUrlTtlSeconds,
        contentDisposition: contentDispositionAttachment(filename),
        contentType,
      })
      .catch((error: unknown) => {
        throw storageUnavailable(error);
      });

    await this.events.audit({
      action: DocumentAuditAction.DOCUMENT_VERSION_DOWNLOADED,
      actorUserId: userId,
      targetType: 'DocumentVersion',
      targetId: versionId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: { expiresAt: grant.expiresAt.toISOString() },
    });

    return { method: 'GET', url: grant.url, expiresAt: grant.expiresAt.toISOString(), filename };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private assertAwaitingUpload(version: VersionWithSession): void {
    if (version.status === DocumentVersionStatus.UPLOAD_EXPIRED) throw uploadExpired();
    if (version.status === DocumentVersionStatus.CANCELLED) throw uploadCancelled();
    if (version.status !== DocumentVersionStatus.AWAITING_UPLOAD) {
      throw new AppError(PalCertErrorCode.UPLOAD_ALREADY_FINALIZED, {
        message: 'This upload has already been finalized.',
      });
    }
    if (
      version.uploadSession !== null &&
      version.uploadSession.expiresAt.getTime() <= this.clock.now().getTime()
    ) {
      throw uploadExpired();
    }
  }

  /** Best effort; the sweep and lifecycle rules catch what this misses. */
  private async discardStaged(
    storageKey: string | null,
    versionId: string,
    userId: string,
  ): Promise<void> {
    if (storageKey === null) return;
    try {
      await this.storage.deleteObject({ zone: 'quarantine', key: storageKey });
      await this.tenant.withUser(userId, (tx) =>
        tx.documentVersion.updateMany({
          where: { id: versionId },
          data: { quarantineDeletedAt: this.clock.now() },
        }),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, versionId },
        'Could not remove staged object; left for lifecycle expiry',
      );
    }
  }
}

export async function loadVersion(
  tx: TenantClient,
  documentId: string,
  versionId: string,
): Promise<VersionWithSession> {
  const row = await tx.documentVersion.findFirst({
    // Not-found rather than forbidden for a correction awaiting delivery: the
    // difference would confirm that PalCert is holding a file the user cannot
    // download (Phase 12 §84).
    where: { id: versionId, documentId, visibleToOwner: true },
    include: { uploadSession: true },
  });
  if (row === null) {
    throw new AppError(PalCertErrorCode.DOCUMENT_VERSION_NOT_FOUND, {
      message: 'That document version does not exist.',
    });
  }
  return row;
}

async function lockVersion(
  tx: TenantClient,
  versionId: string,
): Promise<{ status: string; quarantineDeletedAt: Date | null }> {
  const rows = await tx.$queryRaw<Array<{ status: string; quarantine_deleted_at: Date | null }>>`
    SELECT "status"::text AS status, "quarantine_deleted_at" FROM "document_versions" WHERE "id" = ${versionId}::uuid FOR UPDATE
  `;
  if (rows.length === 0) {
    throw new AppError(PalCertErrorCode.DOCUMENT_VERSION_NOT_FOUND, {
      message: 'That document version does not exist.',
    });
  }
  return { status: rows[0]!.status, quarantineDeletedAt: rows[0]!.quarantine_deleted_at };
}

function formatForFilename(filename: string): DocumentFormat {
  const format = SUPPORTED_UPLOAD_EXTENSIONS[extensionOf(filename)];
  if (format === undefined) {
    throw new AppError(PalCertErrorCode.FILE_EXTENSION_UNSUPPORTED, {
      message: 'Only .docx and .pdf files can be uploaded.',
      details: { supported: Object.keys(SUPPORTED_UPLOAD_EXTENSIONS) },
    });
  }
  return format;
}

function assertSameRequest(
  existing: VersionWithSession,
  incoming: {
    originalFilename: string;
    sizeBytes: number;
    declaredMimeType: string | null;
    clientSha256: string | null;
  },
): void {
  const same =
    existing.originalFilename === incoming.originalFilename &&
    existing.declaredSizeBytes === incoming.sizeBytes &&
    (existing.declaredMimeType ?? null) === incoming.declaredMimeType &&
    (existing.clientSha256 ?? null) === incoming.clientSha256;
  if (!same) {
    throw new AppError(PalCertErrorCode.IDEMPOTENCY_KEY_REUSED, {
      message: 'This Idempotency-Key was already used for a different request.',
    });
  }
}

function storageUnavailable(cause: unknown): AppError {
  return new AppError(PalCertErrorCode.STORAGE_UNAVAILABLE, {
    message: 'File storage is temporarily unavailable. Please try again shortly.',
    internalContext: { cause: cause instanceof Error ? cause.message : String(cause) },
  });
}

function uploadExpired(): AppError {
  return new AppError(PalCertErrorCode.UPLOAD_SESSION_EXPIRED, {
    message: 'This upload authorization has expired. Create a new version to upload again.',
  });
}

function uploadCancelled(): AppError {
  return new AppError(PalCertErrorCode.UPLOAD_SESSION_CANCELLED, {
    message: 'This upload was cancelled.',
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === 'P2002';
}

function parseVersionCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return null;
  const decoded = decodeCursor(cursor);
  if (decoded === null || !/^\d+$/.test(decoded.sortValue)) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: 'That page cursor is not one this API issued.',
      details: { field: 'cursor' },
    });
  }
  return Number.parseInt(decoded.sortValue, 10);
}
