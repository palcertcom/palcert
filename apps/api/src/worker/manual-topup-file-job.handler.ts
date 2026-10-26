import { Injectable } from '@nestjs/common';
import {
  LOGO_FORMATS,
  ManualTopUpFileStatus,
  ProcessingJobType,
  RECEIPT_FORMATS,
  type AttestationArtifactFormat,
} from '@palcert/contracts';
import type { ProcessingJob } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../config/api-config.service';
import { IngestPipeline, type IngestStage } from '../ingestion/ingest-pipeline';
import { MalwareScannerPort } from '../infrastructure/scanner/malware-scanner.port';
import { ObjectStoragePort } from '../infrastructure/storage/object-storage.port';
import {
  cleanManualTopUpReceiptKey,
  cleanPaymentMethodLogoKey,
  cleanWithdrawalProofKey,
} from '../infrastructure/storage/storage-keys';
import {
  TenantPrismaService,
  type TenantClient,
} from '../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../modules/auth/ports/clock.port';
import { SecurityEventService } from '../modules/auth/services/security-event.service';
import { requireJobOwner } from './job-owner';

/** The audit actions each kind of file records as it settles. */
const FILE_AUDIT: Readonly<
  Record<FileKind['label'], { ready: string; rejected: string; failed: string }>
> = {
  ManualTopUpReceipt: {
    ready: 'MANUAL_TOPUP_RECEIPT_READY',
    rejected: 'MANUAL_TOPUP_RECEIPT_REJECTED',
    failed: 'MANUAL_TOPUP_RECEIPT_FAILED',
  },
  ManualPaymentMethodLogo: {
    ready: 'MANUAL_PAYMENT_METHOD_LOGO_READY',
    rejected: 'MANUAL_PAYMENT_METHOD_LOGO_REJECTED',
    failed: 'MANUAL_PAYMENT_METHOD_LOGO_FAILED',
  },
  WithdrawalProof: {
    ready: 'WITHDRAWAL_PROOF_READY',
    rejected: 'WITHDRAWAL_PROOF_REJECTED',
    failed: 'WITHDRAWAL_PROOF_FAILED',
  },
};

const PROCESSABLE: readonly ManualTopUpFileStatus[] = [
  ManualTopUpFileStatus.UPLOADED,
  ManualTopUpFileStatus.VALIDATING,
  ManualTopUpFileStatus.SCANNING,
];

/** The columns both file tables share, which is everything the scan touches. */
interface FileRow {
  readonly id: string;
  readonly status: string;
  readonly expectedFormat: string;
  readonly maxFileBytes: number;
  readonly quarantineObjectKey: string;
  readonly quarantineObjectVersionId: string | null;
  readonly quarantineObjectEtag: string | null;
  readonly clientSha256: string | null;
}

/** Which table, which scope, which formats: everything that differs between the two kinds. */
interface FileKind {
  readonly label: 'ManualTopUpReceipt' | 'ManualPaymentMethodLogo' | 'WithdrawalProof';
  readonly allowed: readonly AttestationArtifactFormat[];
  run<T>(work: (tx: TenantClient) => Promise<T>): Promise<T>;
  load(tx: TenantClient): Promise<(FileRow & { cleanKey: string }) | null>;
  update(
    tx: TenantClient,
    where: { status?: { in: ManualTopUpFileStatus[] } },
    data: Record<string, unknown>,
  ): Promise<number>;
}

/**
 * MANUAL_TOPUP_RECEIPT_INGEST, MANUAL_PAYMENT_METHOD_LOGO_INGEST and
 * WITHDRAWAL_PROOF_INGEST (ADR-0150, the same file shape and statuses).
 *
 * The same `IngestPipeline` every other upload goes through — streamed SHA-256
 * over the exact bytes, signature detection, structural validation, malware
 * scan, immutable promotion — through its artifact entry point. A receipt may
 * be a PDF or an image; a logo only a raster image, so a PDF or an SVG
 * renamed `.png` is rejected by its bytes, not its name.
 *
 * A receipt is processed in its owner's scope, taken from the persisted job
 * row. A logo is PalCert's, so it is processed under the platform elevation as
 * the administrator who uploaded it. Idempotent: a settled file is a no-op.
 */
@Injectable()
export class ManualTopUpFileJobHandler {
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
    this.logger.setContext(ManualTopUpFileJobHandler.name);
    const upload = config.upload;
    this.pipeline = new IngestPipeline(storage, scanner, {
      maxBytesByFormat: upload.maxBytesByFormat,
      archive: upload.archive,
      validationTimeoutMs: upload.validationTimeoutMs,
      scanTimeoutMs: upload.scanTimeoutMs,
    });
  }

  async handle(job: ProcessingJob): Promise<void> {
    const kind = this.kindOf(job);
    const file = await kind.run((tx) => kind.load(tx));
    if (file === null) {
      this.logger.warn({ jobId: job.id }, 'Manual top-up file no longer visible; nothing to do');
      return;
    }
    if (!PROCESSABLE.includes(file.status as ManualTopUpFileStatus)) {
      this.logger.info({ jobId: job.id, status: file.status }, 'File already settled');
      return;
    }

    const outcome = await this.pipeline.runArtifact(
      {
        expectedFormat: file.expectedFormat as AttestationArtifactFormat,
        allowedFormats: kind.allowed,
        maxBytes: file.maxFileBytes,
        quarantineObjectKey: file.quarantineObjectKey,
        quarantineObjectVersionId: file.quarantineObjectVersionId,
        quarantineObjectEtag: file.quarantineObjectEtag,
        clientSha256: file.clientSha256,
        cleanObjectKey: file.cleanKey,
      },
      (stage) => this.enterStage(kind, stage),
    );

    const now = this.clock.now();
    if (outcome.kind === 'ready') {
      await kind.run((tx) =>
        kind.update(
          tx,
          {},
          {
            status: ManualTopUpFileStatus.READY,
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
        ),
      );
      await this.events.audit({
        action: FILE_AUDIT[kind.label].ready,
        actor: { type: 'SYSTEM' },
        targetType: kind.label,
        targetId: file.id,
        // A digest prefix, a format and a size — never a filename or content.
        afterState: {
          format: outcome.detectedFormat,
          sizeBytes: outcome.sizeBytes,
          sha256Prefix: outcome.sha256.slice(0, 12),
        },
      });
    } else {
      await kind.run((tx) =>
        kind.update(
          tx,
          {},
          {
            status: ManualTopUpFileStatus.REJECTED,
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
        ),
      );
      await this.events.audit({
        action: FILE_AUDIT[kind.label].rejected,
        actor: { type: 'SYSTEM' },
        targetType: kind.label,
        targetId: file.id,
        afterState: {
          rejectionCode: outcome.code,
          ...(outcome.scanSignature !== undefined ? { scanSignature: outcome.scanSignature } : {}),
        },
      });
    }

    try {
      await this.storage.deleteObject({ zone: 'quarantine', key: file.quarantineObjectKey });
      await kind.run((tx) => kind.update(tx, {}, { quarantineDeletedAt: this.clock.now() }));
    } catch (error) {
      this.logger.warn(
        { err: error, fileId: file.id },
        'Quarantine object not removed; lifecycle rule will expire it',
      );
    }
  }

  /** Mark the file FAILED once retries are exhausted. */
  async failPermanently(
    job: ProcessingJob,
    failure: { code: string; message: string },
  ): Promise<void> {
    const kind = this.kindOf(job);
    await kind.run((tx) =>
      kind.update(
        tx,
        { status: { in: [...PROCESSABLE] } },
        {
          status: ManualTopUpFileStatus.FAILED,
          failureCode: failure.code,
          failureDetail: failure.message.slice(0, 500),
          failedAt: this.clock.now(),
        },
      ),
    );
    await this.events.audit({
      action: FILE_AUDIT[kind.label].failed,
      actor: { type: 'SYSTEM' },
      targetType: kind.label,
      targetId: job.resourceId,
      afterState: { failureCode: failure.code },
    });
  }

  private async enterStage(kind: FileKind, stage: IngestStage): Promise<void> {
    const from =
      stage === 'VALIDATING'
        ? [...PROCESSABLE]
        : [ManualTopUpFileStatus.VALIDATING, ManualTopUpFileStatus.SCANNING];
    const now = this.clock.now();
    const count = await kind.run((tx) =>
      kind.update(
        tx,
        { status: { in: from } },
        {
          status:
            stage === 'VALIDATING'
              ? ManualTopUpFileStatus.VALIDATING
              : ManualTopUpFileStatus.SCANNING,
          ...(stage === 'SCANNING' ? { validatedAt: now } : {}),
          updatedAt: now,
        },
      ),
    );
    if (count !== 1) throw new Error(`file is not in ${from.join('/')}; cannot enter ${stage}`);
  }

  private kindOf(job: ProcessingJob): FileKind {
    const ownerUserId = requireJobOwner(job);
    const id = job.resourceId;

    if (job.jobType === ProcessingJobType.MANUAL_TOPUP_RECEIPT_INGEST) {
      return {
        label: 'ManualTopUpReceipt',
        allowed: RECEIPT_FORMATS as readonly AttestationArtifactFormat[],
        run: (work) => this.tenant.withUser(ownerUserId, work),
        load: async (tx) => {
          const row = await tx.manualTopUpReceipt.findUnique({ where: { id } });
          if (row === null || row.ownerUserId !== ownerUserId) return null;
          return {
            ...row,
            cleanKey: cleanManualTopUpReceiptKey({
              ownerUserId,
              requestId: row.requestId,
              receiptId: row.id,
            }),
          };
        },
        update: async (tx, where, data) =>
          (await tx.manualTopUpReceipt.updateMany({ where: { id, ...where }, data })).count,
      };
    }

    if (job.jobType === ProcessingJobType.MANUAL_PAYMENT_METHOD_LOGO_INGEST) {
      return {
        label: 'ManualPaymentMethodLogo',
        allowed: LOGO_FORMATS as readonly AttestationArtifactFormat[],
        run: (work) =>
          this.tenant.withPlatformAdmin(
            { actorUserId: ownerUserId, reason: 'scan a manual payment method logo' },
            work,
          ),
        load: async (tx) => {
          const row = await tx.manualPaymentMethodLogo.findUnique({ where: { id } });
          if (row === null) return null;
          return {
            ...row,
            cleanKey: cleanPaymentMethodLogoKey({
              paymentMethodId: row.paymentMethodId,
              logoId: row.id,
            }),
          };
        },
        update: async (tx, where, data) =>
          (await tx.manualPaymentMethodLogo.updateMany({ where: { id, ...where }, data })).count,
      };
    }

    if (job.jobType === ProcessingJobType.WITHDRAWAL_PROOF_INGEST) {
      // A payout proof is PalCert finance's record, scanned under the
      // platform elevation as the finance user who uploaded it.
      return {
        label: 'WithdrawalProof',
        allowed: RECEIPT_FORMATS as readonly AttestationArtifactFormat[],
        run: (work) =>
          this.tenant.withPlatformAdmin(
            { actorUserId: ownerUserId, reason: 'scan a withdrawal payout proof' },
            work,
          ),
        load: async (tx) => {
          const row = await tx.withdrawalProof.findUnique({ where: { id } });
          if (row === null || row.uploadedByUserId !== ownerUserId) return null;
          return {
            ...row,
            cleanKey: cleanWithdrawalProofKey({ requestId: row.requestId, proofId: row.id }),
          };
        },
        update: async (tx, where, data) =>
          (await tx.withdrawalProof.updateMany({ where: { id, ...where }, data })).count,
      };
    }

    throw new Error(`job ${job.id} of type ${job.jobType} is not a manual top-up file job`);
  }
}
