import { Injectable } from '@nestjs/common';
import {
  DocumentAuditAction,
  DocumentVersionStatus,
  type DocumentFailureCode,
  type DocumentFormat,
} from '@palcert/contracts';
import type { DocumentVersion, ProcessingJob } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../config/api-config.service';
import { IngestPipeline, type IngestStage } from '../ingestion/ingest-pipeline';
import { MalwareScannerPort } from '../infrastructure/scanner/malware-scanner.port';
import { ObjectStoragePort } from '../infrastructure/storage/object-storage.port';
import { cleanObjectKey } from '../infrastructure/storage/storage-keys';
import {
  TenantPrismaService,
  type TenantClient,
} from '../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../modules/auth/ports/clock.port';
import { SecurityEventService } from '../modules/auth/services/security-event.service';
import { requireJobOwner } from './job-owner';

/**
 * DOCUMENT_INGEST (§61).
 *
 * Re-establishes the owner's scope from the *persisted job row* — never from
 * the queue message — and does everything else inside it, so row-level
 * security applies to the worker exactly as it does to a request (§56).
 *
 * Idempotent: a version that is already READY or REJECTED is a no-op; one
 * left mid-stage by a crashed worker is processed again from the top.
 */
@Injectable()
export class IngestJobHandler {
  private readonly pipeline: IngestPipeline;

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
    storage: ObjectStoragePort,
    scanner: MalwareScannerPort,
    config: ApiConfigService,
    private readonly storagePort: ObjectStoragePort = storage,
  ) {
    this.logger.setContext(IngestJobHandler.name);
    const upload = config.upload;
    this.pipeline = new IngestPipeline(storage, scanner, {
      maxBytesByFormat: upload.maxBytesByFormat,
      archive: upload.archive,
      validationTimeoutMs: upload.validationTimeoutMs,
      scanTimeoutMs: upload.scanTimeoutMs,
    });
  }

  /** Returns true when the job's work is done (READY or REJECTED persisted, or nothing to do). */
  async handle(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    const versionId = job.resourceId;

    const version = await this.tenant.withUser(owner, (tx) =>
      tx.documentVersion.findUnique({ where: { id: versionId } }),
    );
    if (version === null) {
      this.logger.warn(
        { jobId: job.id },
        'Version for ingest job no longer visible; nothing to do',
      );
      return;
    }
    if (!isProcessable(version.status)) {
      this.logger.info(
        { jobId: job.id, status: version.status },
        'Version already settled; duplicate delivery ignored',
      );
      return;
    }

    const outcome = await this.pipeline.run(
      {
        expectedFormat: version.expectedFormat as DocumentFormat,
        quarantineObjectKey: version.quarantineObjectKey,
        quarantineObjectVersionId: version.quarantineObjectVersionId,
        quarantineObjectEtag: version.quarantineObjectEtag,
        declaredSizeBytes: version.declaredSizeBytes,
        clientSha256: version.clientSha256,
        cleanObjectKey: cleanObjectKey({
          ownerUserId: owner,
          documentId: version.documentId,
          versionId,
        }),
      },
      (stage) => this.enterStage(owner, versionId, stage),
    );

    const now = this.clock.now();
    if (outcome.kind === 'ready') {
      await this.tenant.withUser(owner, (tx) =>
        tx.documentVersion.update({
          where: { id: versionId },
          data: {
            status: DocumentVersionStatus.READY,
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
          },
        }),
      );
      await this.events.audit({
        action: DocumentAuditAction.DOCUMENT_VERSION_READY,
        actorUserId: null,
        targetType: 'DocumentVersion',
        targetId: versionId,
        afterState: {
          format: outcome.detectedFormat,
          sizeBytes: outcome.sizeBytes,
          sha256Prefix: outcome.sha256.slice(0, 12),
        },
      });
      this.logger.info(
        { versionId, format: outcome.detectedFormat, sizeBytes: outcome.sizeBytes },
        'Document version ready',
      );
    } else {
      await this.tenant.withUser(owner, (tx) =>
        tx.documentVersion.update({
          where: { id: versionId },
          data: {
            status: DocumentVersionStatus.REJECTED,
            rejectionCode: outcome.code,
            failureDetail: outcome.detail.slice(0, 500),
            rejectedAt: now,
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
        action: DocumentAuditAction.DOCUMENT_VERSION_REJECTED,
        actorUserId: null,
        targetType: 'DocumentVersion',
        targetId: versionId,
        afterState: {
          rejectionCode: outcome.code,
          ...(outcome.scanSignature !== undefined ? { scanSignature: outcome.scanSignature } : {}),
        },
      });
      this.logger.info({ versionId, rejectionCode: outcome.code }, 'Document version rejected');
    }

    // The staged bytes have served their purpose either way (§40). Best
    // effort: a failure here is logged and the lifecycle rule finishes it.
    await this.discardQuarantine(owner, version);
  }

  /** Mark the version FAILED after retries are exhausted (§60). */
  async fail(
    job: ProcessingJob,
    failure: { code: DocumentFailureCode; message: string },
  ): Promise<void> {
    const now = this.clock.now();
    await this.tenant.withUser(requireJobOwner(job), (tx) =>
      tx.documentVersion.updateMany({
        where: {
          id: job.resourceId,
          status: {
            in: [
              DocumentVersionStatus.UPLOADED,
              DocumentVersionStatus.VALIDATING,
              DocumentVersionStatus.SCANNING,
            ],
          },
        },
        data: {
          status: DocumentVersionStatus.FAILED,
          failureCode: failure.code,
          failureDetail: failure.message.slice(0, 500),
          failedAt: now,
        },
      }),
    );
    await this.events.audit({
      action: DocumentAuditAction.DOCUMENT_VERSION_FAILED,
      actorUserId: null,
      targetType: 'DocumentVersion',
      targetId: job.resourceId,
      afterState: { failureCode: failure.code },
    });
  }

  private async enterStage(owner: string, versionId: string, stage: IngestStage): Promise<void> {
    const now = this.clock.now();
    await this.tenant.withUser(owner, async (tx) => {
      if (stage === 'VALIDATING') {
        await transition(
          tx,
          versionId,
          [
            DocumentVersionStatus.UPLOADED,
            DocumentVersionStatus.VALIDATING,
            DocumentVersionStatus.SCANNING,
          ],
          DocumentVersionStatus.VALIDATING,
          {},
        );
      } else {
        await transition(
          tx,
          versionId,
          [DocumentVersionStatus.VALIDATING, DocumentVersionStatus.SCANNING],
          DocumentVersionStatus.SCANNING,
          { validatedAt: now },
        );
      }
    });
    await this.events.audit({
      action:
        stage === 'VALIDATING'
          ? DocumentAuditAction.DOCUMENT_VALIDATION_STARTED
          : DocumentAuditAction.DOCUMENT_SCAN_STARTED,
      actorUserId: null,
      targetType: 'DocumentVersion',
      targetId: versionId,
    });
  }

  private async discardQuarantine(owner: string, version: DocumentVersion): Promise<void> {
    try {
      await this.storagePort.deleteObject({ zone: 'quarantine', key: version.quarantineObjectKey });
      await this.tenant.withUser(owner, (tx) =>
        tx.documentVersion.updateMany({
          where: { id: version.id },
          data: { quarantineDeletedAt: this.clock.now() },
        }),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, versionId: version.id },
        'Quarantine object not removed; lifecycle rule will expire it',
      );
    }
  }
}

function isProcessable(status: string): boolean {
  return (
    status === DocumentVersionStatus.UPLOADED ||
    status === DocumentVersionStatus.VALIDATING ||
    status === DocumentVersionStatus.SCANNING
  );
}

async function transition(
  tx: TenantClient,
  versionId: string,
  from: DocumentVersionStatus[],
  to: DocumentVersionStatus,
  extra: Record<string, Date>,
): Promise<void> {
  const result = await tx.documentVersion.updateMany({
    where: { id: versionId, status: { in: from } },
    data: { status: to, ...extra },
  });
  if (result.count !== 1) {
    throw new Error(`version ${versionId} is not in ${from.join('/')}; cannot enter ${to}`);
  }
}
