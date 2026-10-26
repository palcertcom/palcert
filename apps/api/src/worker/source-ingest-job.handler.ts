import { Injectable } from '@nestjs/common';
import { StandardSourceStatus, type DocumentFormat } from '@palcert/contracts';
import type { ProcessingJob, StandardSourceAsset } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../config/api-config.service';
import { IngestPipeline, type IngestStage } from '../ingestion/ingest-pipeline';
import { MalwareScannerPort } from '../infrastructure/scanner/malware-scanner.port';
import { ObjectStoragePort } from '../infrastructure/storage/object-storage.port';
import { cleanSourceObjectKey } from '../infrastructure/storage/storage-keys';
import { TenantPrismaService } from '../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../modules/auth/ports/clock.port';
import { SecurityEventService } from '../modules/auth/services/security-event.service';
import { requireJobOwner } from './job-owner';

/**
 * STANDARD_SOURCE_INGEST (Phase 9, §9).
 *
 * The *same pipeline* as a student document: signature detection, format
 * validation, archive and macro safety, malware scanning, digest verification,
 * immutable promotion. Not a similar one — literally the same class, because an
 * organization upload path with its own copy of that logic would drift from it
 * and become the platform's softest target.
 *
 * The scope comes from the persisted job row's `organization_id`, never from
 * the queue message, so row-level security applies to the worker exactly as it
 * does to a request (ADR-0018).
 *
 * Idempotent: a source already settled is a no-op; one left mid-stage by a
 * crashed worker is processed again from the top.
 */
@Injectable()
export class SourceIngestJobHandler {
  private readonly pipeline: IngestPipeline;

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
    private readonly storage: ObjectStoragePort,
    scanner: MalwareScannerPort,
    config: ApiConfigService,
  ) {
    this.logger.setContext(SourceIngestJobHandler.name);
    const upload = config.upload;
    this.pipeline = new IngestPipeline(storage, scanner, {
      maxBytesByFormat: upload.maxBytesByFormat,
      archive: upload.archive,
      validationTimeoutMs: upload.validationTimeoutMs,
      scanTimeoutMs: upload.scanTimeoutMs,
    });
  }

  async handle(job: ProcessingJob): Promise<void> {
    const scope = this.scopeOf(job);
    if (scope === null) return;
    const sourceId = job.resourceId;

    const source = await this.tenant.withTenant(scope, (tx) =>
      tx.standardSourceAsset.findUnique({ where: { id: sourceId } }),
    );
    if (source === null) {
      this.logger.warn({ jobId: job.id }, 'Source for ingest job no longer visible; nothing to do');
      return;
    }
    if (!isProcessable(source.status)) {
      this.logger.info(
        { jobId: job.id, status: source.status },
        'Source already settled; duplicate delivery ignored',
      );
      return;
    }

    const outcome = await this.pipeline.run(
      {
        expectedFormat: source.expectedFormat as DocumentFormat,
        quarantineObjectKey: source.quarantineObjectKey,
        quarantineObjectVersionId: source.quarantineObjectVersionId,
        quarantineObjectEtag: source.quarantineObjectEtag,
        declaredSizeBytes: source.declaredSizeBytes,
        clientSha256: source.clientSha256,
        cleanObjectKey: cleanSourceObjectKey({
          organizationId: source.organizationId,
          standardVersionId: source.standardVersionId,
          sourceId,
        }),
      },
      (stage) => this.enterStage(scope, sourceId, stage),
    );

    const now = this.clock.now();
    if (outcome.kind === 'ready') {
      await this.tenant.withTenant(scope, (tx) =>
        tx.standardSourceAsset.update({
          where: { id: sourceId },
          data: {
            status: StandardSourceStatus.READY,
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
            legacyEquationCount: outcome.legacyEquationCount,
          },
        }),
      );
      await this.events.audit({
        action: 'STANDARD_SOURCE_READY',
        actorUserId: null,
        targetType: 'StandardSourceAsset',
        targetId: sourceId,
        // A digest prefix, a format and a size. Never a filename, a title or a
        // line of the guideline (§118, §150).
        afterState: {
          format: outcome.detectedFormat,
          sizeBytes: outcome.sizeBytes,
          sha256Prefix: outcome.sha256.slice(0, 12),
          legacyEquationCount: outcome.legacyEquationCount,
        },
      });
      this.logger.info(
        {
          sourceId,
          format: outcome.detectedFormat,
          sizeBytes: outcome.sizeBytes,
          // Accepted as data, never executed; the count is what the classifier verified.
          legacyEquationCount: outcome.legacyEquationCount,
          notices: outcome.notices,
        },
        'Standard source ready',
      );
    } else {
      await this.tenant.withTenant(scope, (tx) =>
        tx.standardSourceAsset.update({
          where: { id: sourceId },
          data: {
            status: StandardSourceStatus.REJECTED,
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
        action: 'STANDARD_SOURCE_REJECTED',
        actorUserId: null,
        targetType: 'StandardSourceAsset',
        targetId: sourceId,
        afterState: {
          rejectionCode: outcome.code,
          ...(outcome.scanSignature !== undefined ? { scanSignature: outcome.scanSignature } : {}),
        },
      });
      this.logger.info({ sourceId, rejectionCode: outcome.code }, 'Standard source rejected');
    }

    await this.discardQuarantine(scope, source);
  }

  /** Mark the source FAILED once retries are exhausted. */
  async failPermanently(
    job: ProcessingJob,
    failure: { code: string; message: string },
  ): Promise<void> {
    const scope = this.scopeOf(job);
    if (scope === null) return;
    const now = this.clock.now();

    await this.tenant.withTenant(scope, (tx) =>
      tx.standardSourceAsset.updateMany({
        where: {
          id: job.resourceId,
          status: {
            in: [
              StandardSourceStatus.UPLOADED,
              StandardSourceStatus.VALIDATING,
              StandardSourceStatus.SCANNING,
            ],
          },
        },
        data: {
          status: StandardSourceStatus.FAILED,
          failureCode: failure.code,
          failureDetail: failure.message.slice(0, 500),
          failedAt: now,
        },
      }),
    );
    await this.events.audit({
      action: 'STANDARD_SOURCE_FAILED',
      actorUserId: null,
      targetType: 'StandardSourceAsset',
      targetId: job.resourceId,
      afterState: { failureCode: failure.code },
    });
  }

  /**
   * The scope this job runs in, from the persisted row.
   *
   * A Phase 9 job without an organization cannot be scoped, and guessing one
   * would be exactly the bug row-level security exists to catch. It is logged
   * and abandoned rather than run under someone else's tenancy.
   */
  private scopeOf(job: ProcessingJob): { organizationId: string; userId: string } | null {
    if (job.organizationId === null) {
      this.logger.error(
        { jobId: job.id },
        'Source ingest job carries no organization; refusing to guess a scope',
      );
      return null;
    }
    return { organizationId: job.organizationId, userId: requireJobOwner(job) };
  }

  private async enterStage(
    scope: { organizationId: string; userId: string },
    sourceId: string,
    stage: IngestStage,
  ): Promise<void> {
    const now = this.clock.now();
    await this.tenant.withTenant(scope, async (tx) => {
      const from =
        stage === 'VALIDATING'
          ? [
              StandardSourceStatus.UPLOADED,
              StandardSourceStatus.VALIDATING,
              StandardSourceStatus.SCANNING,
            ]
          : [StandardSourceStatus.VALIDATING, StandardSourceStatus.SCANNING];
      const result = await tx.standardSourceAsset.updateMany({
        where: { id: sourceId, status: { in: from } },
        data: {
          status:
            stage === 'VALIDATING'
              ? StandardSourceStatus.VALIDATING
              : StandardSourceStatus.SCANNING,
          ...(stage === 'SCANNING' ? { validatedAt: now } : {}),
        },
      });
      if (result.count !== 1) {
        throw new Error(`source ${sourceId} is not in ${from.join('/')}; cannot enter ${stage}`);
      }
    });
  }

  private async discardQuarantine(
    scope: { organizationId: string; userId: string },
    source: StandardSourceAsset,
  ): Promise<void> {
    try {
      await this.storage.deleteObject({ zone: 'quarantine', key: source.quarantineObjectKey });
      await this.tenant.withTenant(scope, (tx) =>
        tx.standardSourceAsset.updateMany({
          where: { id: source.id },
          data: { quarantineDeletedAt: this.clock.now() },
        }),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, sourceId: source.id },
        'Quarantine object not removed; lifecycle rule will expire it',
      );
    }
  }
}

function isProcessable(status: string): boolean {
  return (
    status === StandardSourceStatus.UPLOADED ||
    status === StandardSourceStatus.VALIDATING ||
    status === StandardSourceStatus.SCANNING
  );
}
