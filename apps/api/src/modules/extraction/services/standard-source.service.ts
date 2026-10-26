import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AppError,
  CANONICAL_MIME_TYPES,
  PalCertErrorCode,
  ProcessingJobType,
  contentDispositionAttachment,
  SOURCE_KIND_FORMAT,
  StandardSourceStatus,
  sanitizeOriginalFilename,
  type CreateStandardSourceResponse,
  type DownloadAuthorizationView,
  type StandardSourceAuthority,
  type StandardSourceKind,
  type StandardSourceView,
} from '@palcert/contracts';
import type { StandardSourceAsset } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { ObjectStoragePort } from '../../../infrastructure/storage/object-storage.port';
import { quarantineSourceObjectKey } from '../../../infrastructure/storage/storage-keys';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { TenantContext } from '../../organizations/tenant-context';

export interface CreateSourceInput {
  readonly sourceKind: StandardSourceKind;
  readonly originalFilename: string;
  readonly declaredMimeType?: string | undefined;
  readonly sizeBytes: number;
  readonly sha256?: string | undefined;
  readonly authority?: StandardSourceAuthority | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface SourceRequestContext {
  readonly requestId: string | null;
  readonly ipAddress: string | null;
}

/**
 * Guideline and template sources (§5, §7, §8, §9, §10, §100, §101).
 *
 * The same secure ingestion as a student document, and deliberately so: an
 * organization upload path with its own weaker validation would be the softest
 * target in the platform. The API creates the row and the server-generated key
 * before any URL exists, verifies the exact staged object at finalize, and
 * writes the processing intent in the same transaction as the state change.
 *
 * Two differences from Phase 5, both of them the point. The rows are
 * organization-scoped rather than user-private, because an institution's
 * guidelines belong to the institution. And a source attaches to a DRAFT
 * version only: a published standard is history, and adding a source to it
 * would be editing the past (§7).
 */
@Injectable()
export class StandardSourceService {
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
    this.logger.setContext(StandardSourceService.name);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(context: TenantContext, versionId: string): Promise<StandardSourceView[]> {
    const rows = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      await assertVersionVisible(tx, versionId);
      return tx.standardSourceAsset.findMany({
        where: { standardVersionId: versionId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    });
    return rows.map(toSourceView);
  }

  async get(
    context: TenantContext,
    versionId: string,
    sourceId: string,
  ): Promise<StandardSourceView> {
    return toSourceView(await this.load(context, versionId, sourceId));
  }

  // -------------------------------------------------------------------------
  // Create + finalize
  // -------------------------------------------------------------------------

  /**
   * Create a source and authorize its upload.
   *
   * The declared kind decides the accepted format, and the content decides
   * whether that was true: a "guideline PDF" whose bytes are a DOCX is rejected
   * by the pipeline, not accepted and mislabelled.
   */
  async create(
    context: TenantContext,
    versionId: string,
    input: CreateSourceInput,
    request: SourceRequestContext,
  ): Promise<CreateStandardSourceResponse> {
    const originalFilename = sanitizeOriginalFilename(input.originalFilename);
    const expectedFormat = SOURCE_KIND_FORMAT[input.sourceKind];
    const maxBytes = this.config.upload.maxBytesByFormat[expectedFormat];
    if (input.sizeBytes > maxBytes) {
      throw new AppError(PalCertErrorCode.FILE_TOO_LARGE, {
        message: `A ${expectedFormat} source may be at most ${maxBytes} bytes.`,
        details: { maxBytes, format: expectedFormat },
      });
    }

    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.upload.sessionTtlSeconds * 1000);

    const existing = await this.findByIdempotencyKey(context, versionId, input.idempotencyKey);
    if (existing !== null) {
      return {
        source: toSourceView(existing),
        upload: await this.authorize(existing, expectedFormat),
      };
    }

    const created = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      const version = await assertVersionVisible(tx, versionId);
      if (version.status !== 'DRAFT') throw notDraft();

      // Bounded per version: an institution with fifty guidelines has a
      // process problem PalCert should not silently absorb (§134).
      const count = await tx.standardSourceAsset.count({
        where: { standardVersionId: versionId, status: { not: StandardSourceStatus.CANCELLED } },
      });
      if (count >= this.config.extraction.maxSources) {
        throw new AppError(PalCertErrorCode.STANDARD_SOURCE_LIMIT_EXCEEDED, {
          message: `A standard version may have at most ${this.config.extraction.maxSources} sources.`,
          details: { maxSources: this.config.extraction.maxSources },
        });
      }

      // The key embeds the source id and is immutable once written, so the id
      // is allocated here and the row inserted with its final key.
      const sourceId = randomUUID();
      return tx.standardSourceAsset.create({
        data: {
          id: sourceId,
          organizationId: context.organizationId,
          standardVersionId: versionId,
          sourceKind: input.sourceKind,
          status: StandardSourceStatus.AWAITING_UPLOAD,
          authority: input.authority ?? null,
          originalFilename,
          declaredMimeType: input.declaredMimeType?.trim().slice(0, 255) ?? null,
          expectedFormat,
          declaredSizeBytes: input.sizeBytes,
          clientSha256: input.sha256 ?? null,
          quarantineObjectKey: quarantineSourceObjectKey({
            organizationId: context.organizationId,
            standardVersionId: versionId,
            sourceId,
          }),
          idempotencyKey: input.idempotencyKey ?? null,
          uploadExpiresAt: expiresAt,
          uploadedByUserId: context.userId,
        },
      });
    });

    await this.events.audit({
      action: 'STANDARD_SOURCE_CREATED',
      actorUserId: context.userId,
      targetType: 'StandardSourceAsset',
      targetId: created.id,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: {
        standardVersionId: versionId,
        sourceKind: input.sourceKind,
        declaredSizeBytes: input.sizeBytes,
      },
    });

    return { source: toSourceView(created), upload: await this.authorize(created, expectedFormat) };
  }

  /**
   * Finalize an upload and queue ingestion.
   *
   * Idempotent: a second call for a source already past AWAITING_UPLOAD returns
   * the current state and creates nothing.
   */
  async finalize(
    context: TenantContext,
    versionId: string,
    sourceId: string,
    request: SourceRequestContext,
  ): Promise<StandardSourceView> {
    const current = await this.load(context, versionId, sourceId);
    if (current.status !== StandardSourceStatus.AWAITING_UPLOAD) return toSourceView(current);

    if (current.uploadExpiresAt.getTime() <= this.clock.now().getTime()) {
      await this.settleExpired(context, sourceId);
      throw new AppError(PalCertErrorCode.UPLOAD_SESSION_EXPIRED, {
        message: 'This upload authorization has expired. Start a new source upload.',
      });
    }

    // Outside the transaction: a storage round trip must not hold a lock.
    const staged = await this.storage
      .headObject({ zone: 'quarantine', key: current.quarantineObjectKey })
      .catch((error: unknown) => {
        throw storageUnavailable(error);
      });
    if (staged === null) {
      throw new AppError(PalCertErrorCode.UPLOAD_OBJECT_NOT_FOUND, {
        message: 'Nothing has been uploaded for this source yet.',
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

    const now = this.clock.now();
    const result = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      // Re-read under a lock: a concurrent finalize may have won.
      const locked = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status"::text AS status FROM "standard_source_assets"
        WHERE "id" = ${sourceId}::uuid FOR UPDATE
      `;
      if (locked[0]?.status !== StandardSourceStatus.AWAITING_UPLOAD) {
        return { source: await loadSource(tx, versionId, sourceId), job: null };
      }

      const source = await tx.standardSourceAsset.update({
        where: { id: sourceId },
        data: {
          status: StandardSourceStatus.UPLOADED,
          uploadedAt: now,
          quarantineObjectVersionId: staged.versionId,
          quarantineObjectEtag: staged.etag,
        },
      });
      const job = await this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.STANDARD_SOURCE_INGEST,
        resourceType: 'STANDARD_SOURCE_ASSET',
        resourceId: sourceId,
        // The uploader, for the ledger's own owner column; the tenant, for the
        // scope the worker will re-enter.
        ownerUserId: context.userId,
        organizationId: context.organizationId,
      });
      return { source, job };
    });

    if (result.job !== null) {
      await this.dispatcher.dispatchNow(result.job.id);
      await this.events.audit({
        action: 'STANDARD_SOURCE_UPLOADED',
        actorUserId: context.userId,
        targetType: 'StandardSourceAsset',
        targetId: sourceId,
        requestId: request.requestId,
        ipAddress: request.ipAddress,
        afterState: { sizeBytes: staged.sizeBytes },
      });
    }

    return toSourceView(result.source);
  }

  /**
   * A short-lived signed download for an authorized member (§100).
   *
   * Sources are never public, and the URL is bound to the exact stored object
   * version rather than to a key, so an old link cannot pick up new bytes.
   */
  async downloadAuthorization(
    context: TenantContext,
    versionId: string,
    sourceId: string,
  ): Promise<DownloadAuthorizationView> {
    const source = await this.load(context, versionId, sourceId);
    if (source.status !== StandardSourceStatus.READY || source.cleanObjectKey === null) {
      throw new AppError(PalCertErrorCode.STANDARD_SOURCE_NOT_READY, {
        message: 'This source has not finished processing.',
      });
    }

    const grant = await this.storage
      .createDownloadAuthorization({
        // Bound to the exact stored object *version*, so an old link cannot
        // pick up new bytes (ADR-0034).
        ref: {
          zone: 'clean',
          key: source.cleanObjectKey,
          versionId: source.cleanObjectVersionId,
        },
        expiresInSeconds: this.config.storage.downloadUrlTtlSeconds,
        contentType: source.detectedMimeType ?? 'application/octet-stream',
        contentDisposition: contentDispositionAttachment(source.originalFilename),
      })
      .catch((error: unknown) => {
        throw storageUnavailable(error);
      });

    return {
      method: 'GET',
      url: grant.url,
      expiresAt: grant.expiresAt.toISOString(),
      filename: source.originalFilename,
    };
  }

  /**
   * Remove a source that nothing depends on (§101).
   *
   * A source an accepted rule's provenance points at is never deleted: an
   * explanation that names a missing file is not an explanation. The retention
   * lock is set when a proposal is accepted, and this refuses on it rather than
   * checking a join it could get wrong.
   */
  async remove(
    context: TenantContext,
    versionId: string,
    sourceId: string,
    request: SourceRequestContext,
  ): Promise<void> {
    const source = await this.load(context, versionId, sourceId);
    if (source.retentionLockedAt !== null) {
      throw new AppError(PalCertErrorCode.STANDARD_SOURCE_RETENTION_LOCKED, {
        message:
          'An accepted rule cites this source, so it is kept to explain where that rule came from.',
      });
    }

    await this.tenant.withTenant(scopeOf(context), async (tx) => {
      const used = await tx.ruleExtractionRunSource.count({ where: { sourceAssetId: sourceId } });
      if (used > 0) {
        throw new AppError(PalCertErrorCode.STANDARD_SOURCE_RETENTION_LOCKED, {
          message:
            'An extraction run read this source, and its results explain where proposals came from.',
        });
      }
      await tx.standardSourceAsset.delete({ where: { id: sourceId } });
    });

    // Best effort, and last: the row is the record, and an orphaned object is
    // swept by the lifecycle rule.
    for (const key of [source.quarantineObjectKey, source.cleanObjectKey]) {
      if (key === null) continue;
      const zone = key === source.quarantineObjectKey ? 'quarantine' : 'clean';
      await this.storage.deleteObject({ zone, key }).catch((error: unknown) => {
        this.logger.warn({ err: error, sourceId }, 'Source object not removed; lifecycle will');
      });
    }

    await this.events.audit({
      action: 'STANDARD_SOURCE_DELETED',
      actorUserId: context.userId,
      targetType: 'StandardSourceAsset',
      targetId: sourceId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async load(
    context: TenantContext,
    versionId: string,
    sourceId: string,
  ): Promise<StandardSourceAsset> {
    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      await assertVersionVisible(tx, versionId);
      return loadSource(tx, versionId, sourceId);
    });
  }

  private async findByIdempotencyKey(
    context: TenantContext,
    versionId: string,
    key: string | undefined,
  ): Promise<StandardSourceAsset | null> {
    if (key === undefined) return null;
    const existing = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.standardSourceAsset.findUnique({
        where: {
          organizationId_idempotencyKey: {
            organizationId: context.organizationId,
            idempotencyKey: key,
          },
        },
      }),
    );
    if (existing === null) return null;
    if (existing.standardVersionId !== versionId) {
      throw new AppError(PalCertErrorCode.IDEMPOTENCY_KEY_REUSED, {
        message: 'This Idempotency-Key was already used for a different request.',
      });
    }
    return existing;
  }

  private async authorize(
    source: StandardSourceAsset,
    format: 'PDF' | 'DOCX',
  ): Promise<CreateStandardSourceResponse['upload']> {
    const remaining = Math.floor(
      (source.uploadExpiresAt.getTime() - this.clock.now().getTime()) / 1000,
    );
    const ttl = Math.max(30, Math.min(this.config.storage.uploadUrlTtlSeconds, remaining));
    const grant = await this.storage
      .createUploadAuthorization({
        zone: 'quarantine',
        key: source.quarantineObjectKey,
        contentLength: source.declaredSizeBytes,
        contentType: CANONICAL_MIME_TYPES[format],
        sha256Hex: source.clientSha256,
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

  private async settleExpired(context: TenantContext, sourceId: string): Promise<void> {
    await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.standardSourceAsset.updateMany({
        where: { id: sourceId, status: StandardSourceStatus.AWAITING_UPLOAD },
        data: { status: StandardSourceStatus.UPLOAD_EXPIRED },
      }),
    );
  }
}

export function toSourceView(source: StandardSourceAsset): StandardSourceView {
  return {
    id: source.id,
    standardVersionId: source.standardVersionId,
    sourceKind: source.sourceKind as StandardSourceKind,
    status: source.status as StandardSourceStatus,
    authority: (source.authority as StandardSourceAuthority | null) ?? null,
    originalFilename: source.originalFilename,
    declaredMimeType: source.declaredMimeType,
    detectedMimeType: source.detectedMimeType,
    detectedFormat: source.detectedFormat,
    sizeBytes: source.sizeBytes,
    sha256: source.sha256,
    pageCount: source.pageCount,
    rejectionCode: source.rejectionCode,
    failureCode: source.failureCode,
    // A rejection is about the file and will not change on a retry; a failure
    // is about PalCert and may (§60 of Phase 5).
    retryable: source.failureCode !== null,
    retentionLocked: source.retentionLockedAt !== null,
    legacyEquationCount: source.legacyEquationCount,
    uploadExpiresAt:
      source.status === StandardSourceStatus.AWAITING_UPLOAD
        ? source.uploadExpiresAt.toISOString()
        : null,
    uploadedByUserId: source.uploadedByUserId,
    createdAt: source.createdAt.toISOString(),
    readyAt: source.readyAt?.toISOString() ?? null,
    rejectedAt: source.rejectedAt?.toISOString() ?? null,
    failedAt: source.failedAt?.toISOString() ?? null,
  };
}

export function scopeOf(context: TenantContext): {
  organizationId: string;
  userId: string;
  isPlatformAdmin: boolean;
} {
  return {
    organizationId: context.organizationId,
    userId: context.userId,
    isPlatformAdmin: context.viaPlatformAdmin,
  };
}

/**
 * The draft a source or run attaches to.
 *
 * A version invisible under the caller's tenant policy answers 404 like any
 * other missing id: the difference between "does not exist" and "belongs to
 * someone else" is information, and it is not given away.
 */
export async function assertVersionVisible(
  tx: TenantClient,
  versionId: string,
): Promise<{ id: string; status: string; revision: number; ruleSchemaVersion: number }> {
  const version = await tx.standardVersion.findUnique({ where: { id: versionId } });
  if (version === null) {
    throw new AppError(PalCertErrorCode.STANDARD_VERSION_NOT_FOUND, {
      message: 'That standard version does not exist.',
    });
  }
  return {
    id: version.id,
    status: version.status,
    revision: version.revision,
    ruleSchemaVersion: version.ruleSchemaVersion,
  };
}

async function loadSource(
  tx: TenantClient,
  versionId: string,
  sourceId: string,
): Promise<StandardSourceAsset> {
  const source = await tx.standardSourceAsset.findFirst({
    where: { id: sourceId, standardVersionId: versionId },
  });
  if (source === null) {
    throw new AppError(PalCertErrorCode.STANDARD_SOURCE_NOT_FOUND, {
      message: 'That source does not exist.',
    });
  }
  return source;
}

function notDraft(): AppError {
  return new AppError(PalCertErrorCode.STANDARD_SOURCE_VERSION_NOT_DRAFT, {
    message:
      'Sources attach to a draft version. Clone this version into a new draft to add sources to it.',
  });
}

function storageUnavailable(cause: unknown): AppError {
  return new AppError(PalCertErrorCode.STORAGE_UNAVAILABLE, {
    message: 'File storage is temporarily unavailable. Please try again shortly.',
    internalContext: { cause: cause instanceof Error ? cause.message : 'storage call failed' },
  });
}
