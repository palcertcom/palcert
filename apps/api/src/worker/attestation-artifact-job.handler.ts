import { Injectable } from '@nestjs/common';
import { AttestationArtifactStatus, type AttestationArtifactFormat } from '@palcert/contracts';
import type { AttestationArtifact, ProcessingJob } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../config/api-config.service';
import { IngestPipeline, type IngestStage } from '../ingestion/ingest-pipeline';
import { MalwareScannerPort } from '../infrastructure/scanner/malware-scanner.port';
import { ObjectStoragePort } from '../infrastructure/storage/object-storage.port';
import { cleanAttestationObjectKey } from '../infrastructure/storage/storage-keys';
import { TenantPrismaService } from '../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../modules/auth/ports/clock.port';
import { SecurityEventService } from '../modules/auth/services/security-event.service';
import { AttestationCatalogueService } from '../modules/attestations/services/attestation-catalogue.service';
import { requireJobOwner } from './job-owner';

const PROCESSABLE: readonly string[] = [
  AttestationArtifactStatus.UPLOADED,
  AttestationArtifactStatus.VALIDATING,
  AttestationArtifactStatus.SCANNING,
];

/**
 * ATTESTATION_ARTIFACT_INGEST.
 *
 * The same `IngestPipeline` instance type as documents and guideline sources —
 * streamed SHA-256 over the exact bytes, signature detection, structural
 * validation, malware scan, immutable promotion — through its artifact entry
 * point, which accepts PDF and images and nothing else.
 *
 * Runs in the owner's scope, taken from the persisted job row rather than the
 * queue message. Idempotent: a settled artifact is a no-op, and one left
 * mid-stage by a crashed worker is processed again from the top.
 */
@Injectable()
export class AttestationArtifactJobHandler {
  private readonly pipeline: IngestPipeline;

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly catalogue: AttestationCatalogueService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
    private readonly storage: ObjectStoragePort,
    scanner: MalwareScannerPort,
    config: ApiConfigService,
  ) {
    this.logger.setContext(AttestationArtifactJobHandler.name);
    const upload = config.upload;
    this.pipeline = new IngestPipeline(storage, scanner, {
      maxBytesByFormat: upload.maxBytesByFormat,
      archive: upload.archive,
      validationTimeoutMs: upload.validationTimeoutMs,
      scanTimeoutMs: upload.scanTimeoutMs,
    });
  }

  async handle(job: ProcessingJob): Promise<void> {
    const ownerUserId = requireJobOwner(job);
    const artifactId = job.resourceId;

    const loaded = await this.tenant.withUser(ownerUserId, async (tx) => {
      const artifact = await tx.attestationArtifact.findUnique({ where: { id: artifactId } });
      if (artifact === null) return null;
      const request = await tx.attestationRequest.findUnique({ where: { id: artifact.requestId } });
      if (request === null) return null;
      const offer = await this.catalogue.offer(tx, request.attestationTypeId);
      return { artifact, allowedFormats: offer.allowedFormats };
    });
    if (loaded === null) {
      this.logger.warn({ jobId: job.id }, 'Attestation artifact no longer visible; nothing to do');
      return;
    }
    const { artifact, allowedFormats } = loaded;
    if (!PROCESSABLE.includes(artifact.status)) {
      this.logger.info({ jobId: job.id, status: artifact.status }, 'Artifact already settled');
      return;
    }

    const outcome = await this.pipeline.runArtifact(
      {
        expectedFormat: artifact.expectedFormat as AttestationArtifactFormat,
        allowedFormats,
        maxBytes: artifact.maxFileBytes,
        quarantineObjectKey: artifact.quarantineObjectKey,
        quarantineObjectVersionId: artifact.quarantineObjectVersionId,
        quarantineObjectEtag: artifact.quarantineObjectEtag,
        clientSha256: artifact.clientSha256,
        cleanObjectKey: cleanAttestationObjectKey({
          ownerUserId,
          requestId: artifact.requestId,
          artifactId,
        }),
      },
      (stage) => this.enterStage(ownerUserId, artifactId, stage),
    );

    const now = this.clock.now();
    if (outcome.kind === 'ready') {
      await this.tenant.withUser(ownerUserId, (tx) =>
        tx.attestationArtifact.update({
          where: { id: artifactId },
          data: {
            status: AttestationArtifactStatus.READY,
            sha256: outcome.sha256,
            sizeBytes: outcome.sizeBytes,
            detectedFormat: outcome.detectedFormat,
            detectedMimeType: outcome.detectedMimeType,
            cleanObjectKey: outcome.clean.key,
            cleanObjectVersionId: outcome.clean.versionId,
            cleanObjectEtag: outcome.clean.etag,
            scanEngine: outcome.scanEngine,
            scannedAt: now,
            readyAt: now,
            updatedAt: now,
          },
        }),
      );
      await this.events.audit({
        action: 'ATTESTATION_ARTIFACT_READY',
        actor: { type: 'SYSTEM' },
        targetType: 'AttestationArtifact',
        targetId: artifactId,
        // A digest prefix, a format and a size — never a filename or content.
        afterState: {
          attestationRequestId: artifact.requestId,
          format: outcome.detectedFormat,
          sizeBytes: outcome.sizeBytes,
          sha256Prefix: outcome.sha256.slice(0, 12),
        },
      });
    } else {
      await this.tenant.withUser(ownerUserId, (tx) =>
        tx.attestationArtifact.update({
          where: { id: artifactId },
          data: {
            status: AttestationArtifactStatus.REJECTED,
            rejectionCode: outcome.code,
            failureDetail: outcome.detail.slice(0, 500),
            rejectedAt: now,
            updatedAt: now,
            ...(outcome.scanEngine !== undefined
              ? { scanEngine: outcome.scanEngine, scannedAt: now }
              : {}),
            ...(outcome.scanSignature !== undefined
              ? { scanSignature: outcome.scanSignature }
              : {}),
          },
        }),
      );
      await this.events.audit({
        action: 'ATTESTATION_ARTIFACT_REJECTED',
        actor: { type: 'SYSTEM' },
        targetType: 'AttestationArtifact',
        targetId: artifactId,
        afterState: {
          attestationRequestId: artifact.requestId,
          rejectionCode: outcome.code,
          ...(outcome.scanSignature !== undefined ? { scanSignature: outcome.scanSignature } : {}),
        },
      });
    }

    await this.discardQuarantine(ownerUserId, artifact);
  }

  /** Mark the artifact FAILED once retries are exhausted. */
  async failPermanently(
    job: ProcessingJob,
    failure: { code: string; message: string },
  ): Promise<void> {
    const ownerUserId = requireJobOwner(job);
    await this.tenant.withUser(ownerUserId, (tx) =>
      tx.attestationArtifact.updateMany({
        where: {
          id: job.resourceId,
          status: { in: [...PROCESSABLE] as AttestationArtifactStatus[] },
        },
        data: {
          status: AttestationArtifactStatus.FAILED,
          failureCode: failure.code,
          failureDetail: failure.message.slice(0, 500),
          failedAt: this.clock.now(),
        },
      }),
    );
    await this.events.audit({
      action: 'ATTESTATION_ARTIFACT_FAILED',
      actor: { type: 'SYSTEM' },
      targetType: 'AttestationArtifact',
      targetId: job.resourceId,
      afterState: { failureCode: failure.code },
    });
  }

  private async enterStage(
    ownerUserId: string,
    artifactId: string,
    stage: IngestStage,
  ): Promise<void> {
    const from =
      stage === 'VALIDATING'
        ? [
            AttestationArtifactStatus.UPLOADED,
            AttestationArtifactStatus.VALIDATING,
            AttestationArtifactStatus.SCANNING,
          ]
        : [AttestationArtifactStatus.VALIDATING, AttestationArtifactStatus.SCANNING];
    const now = this.clock.now();
    const result = await this.tenant.withUser(ownerUserId, (tx) =>
      tx.attestationArtifact.updateMany({
        where: { id: artifactId, status: { in: from } },
        data: {
          status:
            stage === 'VALIDATING'
              ? AttestationArtifactStatus.VALIDATING
              : AttestationArtifactStatus.SCANNING,
          ...(stage === 'SCANNING' ? { validatedAt: now } : {}),
          updatedAt: now,
        },
      }),
    );
    if (result.count !== 1) {
      throw new Error(`artifact ${artifactId} is not in ${from.join('/')}; cannot enter ${stage}`);
    }
  }

  private async discardQuarantine(
    ownerUserId: string,
    artifact: AttestationArtifact,
  ): Promise<void> {
    try {
      await this.storage.deleteObject({ zone: 'quarantine', key: artifact.quarantineObjectKey });
      await this.tenant.withUser(ownerUserId, (tx) =>
        tx.attestationArtifact.updateMany({
          where: { id: artifact.id },
          data: { quarantineDeletedAt: this.clock.now() },
        }),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, artifactId: artifact.id },
        'Quarantine object not removed; lifecycle rule will expire it',
      );
    }
  }
}
