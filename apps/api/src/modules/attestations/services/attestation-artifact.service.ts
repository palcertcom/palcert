import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ATTESTATION_ARTIFACT_MIME_TYPES,
  AppError,
  AttestationArtifactStatus,
  AttestationRequestStatus,
  PalCertErrorCode,
  ProcessingJobType,
  SHA256_HEX_PATTERN,
  attestationFormatForFilename,
  contentDispositionAttachment,
  sanitizeOriginalFilename,
  type AttestationArtifactFormat,
  type AttestationUploadAuthorizationView,
  type CreateAttestationArtifactResponse,
  type DownloadAuthorizationView,
} from '@palcert/contracts';
import type { AttestationArtifact } from '@palcert/database';
import { ApiConfigService } from '../../../config/api-config.service';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { ObjectStoragePort } from '../../../infrastructure/storage/object-storage.port';
import { quarantineAttestationObjectKey } from '../../../infrastructure/storage/storage-keys';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { AuthThrottleService, ThrottleScope } from '../../auth/services/auth-throttle.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import {
  artifactView,
  cleanText,
  isUniqueViolation,
  requestNotFound,
  storageUnavailable,
  transitionInvalid,
} from '../attestation-support';
import { AttestationCatalogueService } from './attestation-catalogue.service';
import type { RequestContext } from './attestation-request.service';

export interface CreateArtifactInput {
  readonly originalFilename: string;
  readonly declaredMimeType?: string | undefined;
  readonly sizeBytes: number;
  readonly sha256?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

/**
 * Uploading the certificate itself (§3, §9).
 *
 * The same secure path as every other upload in PalCert. The API creates the
 * row and the server-generated quarantine key before any URL exists, the
 * browser PUTs to a short-lived presigned URL, finalize pins the exact object
 * version, and a worker streams it through the shared ingest pipeline —
 * digest, signature detection, structural validation, malware scan — before
 * anything is promoted to the clean zone. The filename is never trusted for
 * type: it only says what the bytes are expected to be, and the bytes decide.
 */
@Injectable()
export class AttestationArtifactService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly catalogue: AttestationCatalogueService,
    private readonly storage: ObjectStoragePort,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly events: SecurityEventService,
    private readonly throttle: AuthThrottleService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
  ) {}

  async create(
    userId: string,
    requestId: string,
    input: CreateArtifactInput,
    context: RequestContext,
  ): Promise<CreateAttestationArtifactResponse> {
    await this.throttle.consume(ThrottleScope.ATTESTATION_UPLOAD, userId);

    const originalFilename = sanitizeOriginalFilename(input.originalFilename);
    const expectedFormat = attestationFormatForFilename(originalFilename);
    if (expectedFormat === null) {
      throw new AppError(PalCertErrorCode.ATTESTATION_ARTIFACT_TYPE_NOT_ALLOWED, {
        message: 'Upload a PDF, PNG, JPEG or WebP file.',
      });
    }
    const clientSha256 = input.sha256?.toLowerCase() ?? null;
    if (clientSha256 !== null && !SHA256_HEX_PATTERN.test(clientSha256)) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'sha256 must be 64 lowercase hexadecimal characters.',
      });
    }
    const idempotencyKey = cleanText(input.idempotencyKey ?? null);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.upload.sessionTtlSeconds * 1000);

    const run = () =>
      this.tenant.withUser(userId, async (tx) => {
        if (idempotencyKey !== null) {
          const existing = await tx.attestationArtifact.findUnique({
            where: { ownerUserId_idempotencyKey: { ownerUserId: userId, idempotencyKey } },
          });
          if (existing !== null) {
            if (existing.requestId !== requestId) {
              throw new AppError(PalCertErrorCode.IDEMPOTENCY_KEY_REUSED, {
                message: 'This Idempotency-Key was already used for a different upload.',
              });
            }
            return existing;
          }
        }

        await tx.$queryRaw`SELECT "id" FROM "attestation_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
        const request = await tx.attestationRequest.findUnique({ where: { id: requestId } });
        if (request === null || request.ownerUserId !== userId) throw requestNotFound();
        if (
          request.status !== AttestationRequestStatus.DRAFT &&
          request.status !== AttestationRequestStatus.NEEDS_INFORMATION
        ) {
          throw transitionInvalid(request.status as AttestationRequestStatus, 'given a new file');
        }

        const offer = await this.catalogue.offer(tx, request.attestationTypeId);
        if (!offer.allowedFormats.includes(expectedFormat)) {
          throw new AppError(PalCertErrorCode.ATTESTATION_ARTIFACT_TYPE_NOT_ALLOWED, {
            message:
              'This institution does not accept that kind of file for this attestation type.',
            details: { allowedFormats: offer.allowedFormats },
          });
        }
        if (input.sizeBytes > offer.maxFileBytes) {
          throw new AppError(PalCertErrorCode.FILE_TOO_LARGE, {
            message: `The file may be at most ${offer.maxFileBytes} bytes.`,
            details: { maxBytes: offer.maxFileBytes },
          });
        }

        const artifactId = randomUUID();
        return tx.attestationArtifact.create({
          data: {
            id: artifactId,
            requestId,
            ownerUserId: userId,
            organizationId: request.organizationId,
            status: AttestationArtifactStatus.AWAITING_UPLOAD,
            originalFilename,
            declaredMimeType: input.declaredMimeType?.trim().slice(0, 255) ?? null,
            expectedFormat,
            declaredSizeBytes: input.sizeBytes,
            maxFileBytes: offer.maxFileBytes,
            clientSha256,
            quarantineObjectKey: quarantineAttestationObjectKey({
              ownerUserId: userId,
              requestId,
              artifactId,
            }),
            idempotencyKey,
            uploadExpiresAt: expiresAt,
            createdAt: now,
            updatedAt: now,
          },
        });
      });

    let artifact: AttestationArtifact;
    try {
      artifact = await run();
    } catch (error) {
      if (idempotencyKey !== null && isUniqueViolation(error, 'idempotency'))
        artifact = await run();
      else throw error;
    }

    await this.events.audit({
      action: 'ATTESTATION_ARTIFACT_UPLOAD_STARTED',
      actorUserId: userId,
      targetType: 'AttestationArtifact',
      targetId: artifact.id,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      afterState: {
        attestationRequestId: requestId,
        expectedFormat,
        declaredSizeBytes: input.sizeBytes,
      },
    });

    return { artifact: artifactView(artifact)!, upload: await this.authorize(artifact) };
  }

  /**
   * Pin the exact uploaded object and queue its ingestion. Makes it the
   * request's current file.
   *
   * Idempotent: a second call for an artifact already past AWAITING_UPLOAD
   * returns its current state and queues nothing.
   */
  async finalize(
    userId: string,
    requestId: string,
    artifactId: string,
    context: RequestContext,
  ): Promise<CreateAttestationArtifactResponse['artifact']> {
    const current = await this.tenant.withUser(userId, (tx) =>
      this.loadOwn(tx, userId, requestId, artifactId),
    );
    if (current.status !== AttestationArtifactStatus.AWAITING_UPLOAD) return artifactView(current)!;
    if (current.uploadExpiresAt.getTime() <= this.clock.now().getTime()) {
      await this.tenant.withUser(userId, (tx) =>
        tx.attestationArtifact.updateMany({
          where: { id: artifactId, status: AttestationArtifactStatus.AWAITING_UPLOAD },
          data: { status: AttestationArtifactStatus.UPLOAD_EXPIRED },
        }),
      );
      throw new AppError(PalCertErrorCode.UPLOAD_SESSION_EXPIRED, {
        message: 'This upload authorization has expired. Upload the file again.',
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
        message: 'Nothing has been uploaded for this file yet.',
      });
    }
    if (staged.sizeBytes > current.maxFileBytes) {
      throw new AppError(PalCertErrorCode.FILE_TOO_LARGE, {
        message: `The file may be at most ${current.maxFileBytes} bytes.`,
        details: { maxBytes: current.maxFileBytes },
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
    const result = await this.tenant.withUser(userId, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "attestation_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
      const locked = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status"::text AS status FROM "attestation_artifacts"
         WHERE "id" = ${artifactId}::uuid FOR UPDATE`;
      if (locked[0]?.status !== AttestationArtifactStatus.AWAITING_UPLOAD) {
        return { artifact: await this.loadOwn(tx, userId, requestId, artifactId), job: null };
      }
      const request = await tx.attestationRequest.findUnique({ where: { id: requestId } });
      if (
        request === null ||
        (request.status !== AttestationRequestStatus.DRAFT &&
          request.status !== AttestationRequestStatus.NEEDS_INFORMATION)
      ) {
        throw transitionInvalid(
          (request?.status ?? AttestationRequestStatus.CANCELLED) as AttestationRequestStatus,
          'given a new file',
        );
      }
      const artifact = await tx.attestationArtifact.update({
        where: { id: artifactId },
        data: {
          status: AttestationArtifactStatus.UPLOADED,
          uploadedAt: now,
          quarantineObjectVersionId: staged.versionId,
          quarantineObjectEtag: staged.etag,
          updatedAt: now,
        },
      });
      await tx.attestationRequest.update({
        where: { id: requestId },
        data: { currentArtifactId: artifactId, updatedAt: now },
      });
      const job = await this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.ATTESTATION_ARTIFACT_INGEST,
        resourceType: 'ATTESTATION_ARTIFACT',
        resourceId: artifactId,
        ownerUserId: userId,
      });
      return { artifact, job };
    });

    if (result.job !== null) {
      await this.dispatcher.dispatchNow(result.job.id);
      await this.events.audit({
        action: 'ATTESTATION_ARTIFACT_UPLOADED',
        actorUserId: userId,
        targetType: 'AttestationArtifact',
        targetId: artifactId,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: { attestationRequestId: requestId, sizeBytes: staged.sizeBytes },
      });
    }
    return artifactView(result.artifact)!;
  }

  /** A fresh upload URL for an artifact still awaiting its bytes. */
  async reauthorize(
    userId: string,
    requestId: string,
    artifactId: string,
  ): Promise<AttestationUploadAuthorizationView> {
    const artifact = await this.tenant.withUser(userId, (tx) =>
      this.loadOwn(tx, userId, requestId, artifactId),
    );
    if (artifact.status !== AttestationArtifactStatus.AWAITING_UPLOAD) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'This file has already been uploaded.',
      });
    }
    return this.authorize(artifact);
  }

  /** The owner's own file, by a short-lived signed URL bound to the exact version. */
  async ownerDownload(userId: string, requestId: string): Promise<DownloadAuthorizationView> {
    const artifact = await this.tenant.withUser(userId, async (tx) => {
      const request = await tx.attestationRequest.findUnique({ where: { id: requestId } });
      if (
        request === null ||
        request.ownerUserId !== userId ||
        request.currentArtifactId === null
      ) {
        throw requestNotFound();
      }
      return this.loadOwn(tx, userId, requestId, request.currentArtifactId);
    });
    return this.download(artifact, 'attachment');
  }

  /** A signed URL for an artifact the caller has already been authorized to see. */
  async download(
    artifact: AttestationArtifact,
    disposition: 'attachment' | 'inline',
  ): Promise<DownloadAuthorizationView> {
    if (
      artifact.status !== AttestationArtifactStatus.READY ||
      artifact.cleanObjectKey === null ||
      artifact.purgedAt !== null
    ) {
      throw new AppError(PalCertErrorCode.ATTESTATION_ARTIFACT_NOT_READY, {
        message: 'This file is not available.',
      });
    }
    const attachment = contentDispositionAttachment(artifact.originalFilename);
    const grant = await this.storage
      .createDownloadAuthorization({
        ref: {
          zone: 'clean',
          key: artifact.cleanObjectKey,
          versionId: artifact.cleanObjectVersionId,
        },
        expiresInSeconds: this.config.storage.downloadUrlTtlSeconds,
        contentType:
          artifact.detectedFormat === null
            ? 'application/octet-stream'
            : ATTESTATION_ARTIFACT_MIME_TYPES[artifact.detectedFormat as AttestationArtifactFormat],
        contentDisposition:
          disposition === 'inline' ? attachment.replace(/^attachment/, 'inline') : attachment,
      })
      .catch((error: unknown) => {
        throw storageUnavailable(error);
      });
    return {
      method: 'GET',
      url: grant.url,
      expiresAt: grant.expiresAt.toISOString(),
      filename: artifact.originalFilename,
    };
  }

  // -------------------------------------------------------------------------

  private async loadOwn(
    tx: Parameters<Parameters<TenantPrismaService['withUser']>[1]>[0],
    userId: string,
    requestId: string,
    artifactId: string,
  ): Promise<AttestationArtifact> {
    const artifact = await tx.attestationArtifact.findUnique({ where: { id: artifactId } });
    if (artifact === null || artifact.ownerUserId !== userId || artifact.requestId !== requestId) {
      throw new AppError(PalCertErrorCode.ATTESTATION_ARTIFACT_NOT_FOUND, {
        message: 'No such file on this request.',
      });
    }
    return artifact;
  }

  private async authorize(
    artifact: AttestationArtifact,
  ): Promise<AttestationUploadAuthorizationView> {
    const remaining = Math.floor(
      (artifact.uploadExpiresAt.getTime() - this.clock.now().getTime()) / 1000,
    );
    const ttl = Math.max(30, Math.min(this.config.storage.uploadUrlTtlSeconds, remaining));
    const grant = await this.storage
      .createUploadAuthorization({
        zone: 'quarantine',
        key: artifact.quarantineObjectKey,
        contentLength: artifact.declaredSizeBytes,
        contentType:
          ATTESTATION_ARTIFACT_MIME_TYPES[artifact.expectedFormat as AttestationArtifactFormat],
        sha256Hex: artifact.clientSha256,
        expiresInSeconds: ttl,
      })
      .catch((error: unknown) => {
        throw storageUnavailable(error);
      });
    return {
      method: 'PUT',
      url: grant.url,
      headers: { ...grant.headers },
      expiresAt: grant.expiresAt.toISOString(),
    };
  }
}
