import { Injectable } from '@nestjs/common';
import {
  CheckStatus,
  DocumentVersionStatus,
  SmartFixFailureCode,
  SmartFixRequestStatus,
  type DocumentFormat,
} from '@palcert/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import {
  DocumentEngineError,
  DocumentEnginePort,
  SmartFixEngineError,
} from '../../../infrastructure/document-engine/document-engine.port';
import { MalwareScannerPort } from '../../../infrastructure/scanner/malware-scanner.port';
import { ObjectStoragePort } from '../../../infrastructure/storage/object-storage.port';
import {
  cleanObjectKey,
  generatedQuarantineObjectKey,
  smartFixManifestArtifactKey,
} from '../../../infrastructure/storage/storage-keys';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { IngestPipeline, type IngestStage } from '../../../ingestion/ingest-pipeline';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { SmartFixPlanService } from './smartfix-plan.service';
import { SmartFixSettlementService } from './smartfix-settlement.service';

/** A failure that already knows which code the user will be told. */
export class SmartFixFailure extends Error {
  constructor(
    readonly code: SmartFixFailureCode,
    readonly detail: string,
    /** Permanent failures release the reservation now; transient ones retry. */
    readonly permanent = true,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'SmartFixFailure';
  }
}

/** Retention lock kind, so a corrected document's source cannot be purged. */
const SMARTFIX_RETENTION_LOCK = 'SMARTFIX';

/**
 * `SMARTFIX_EXECUTE`: correct the document and start its recheck (§59).
 *
 * Six steps, in the only order that is safe:
 *
 *  1. Re-read the approved plan and the source bytes, and prove both are what
 *     the user agreed to.
 *  2. Ask the engine to apply the plan. It refuses rather than half-correcting.
 *  3. Write the corrected bytes to a server-generated private key and put them
 *     through PalCert's **own** secure ingestion — format detection, digest,
 *     malware scan, promotion. "PalCert made it" is not a security property
 *     (§87, §88).
 *  4. Record the manifest, which is the evidence that the correction changed
 *     formatting and nothing else.
 *  5. Create the automatic recheck against the *exact* historical standard
 *     version, carrying no purchase of its own because the user already paid
 *     for it (§91, §93).
 *  6. Hand over to the recheck and wait.
 *
 * Nothing here is visible to the owner. The corrected version exists, is
 * analyzable and is rechecked, and the user cannot reach it until Phase 12's
 * finalize step decides it is worth delivering (§84).
 */
@Injectable()
export class SmartFixExecutionService {
  private readonly pipeline: IngestPipeline;

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly plans: SmartFixPlanService,
    private readonly settlement: SmartFixSettlementService,
    private readonly engine: DocumentEnginePort,
    private readonly storage: ObjectStoragePort,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
    scanner: MalwareScannerPort,
    config: ApiConfigService,
  ) {
    this.logger.setContext(SmartFixExecutionService.name);
    const upload = config.upload;
    this.pipeline = new IngestPipeline(storage, scanner, {
      maxBytesByFormat: upload.maxBytesByFormat,
      archive: upload.archive,
      validationTimeoutMs: upload.validationTimeoutMs,
      scanTimeoutMs: upload.scanTimeoutMs,
    });
  }

  async execute(userId: string, requestId: string): Promise<void> {
    const request = await this.tenant.withUser(userId, (tx) =>
      tx.smartFixRequest.findUnique({
        where: { id: requestId },
        include: {
          check: true,
          sourceVersion: true,
        },
      }),
    );
    if (request === null) {
      this.logger.warn({ requestId }, 'SmartFix request no longer visible; nothing to do');
      return;
    }
    if (
      request.status !== SmartFixRequestStatus.RESERVED &&
      request.status !== SmartFixRequestStatus.PROCESSING
    ) {
      // Already moved on, cancelled or failed. An at-least-once worker landing
      // here twice must change nothing.
      this.logger.info(
        { requestId, status: request.status },
        'SmartFix request already past execution; duplicate delivery ignored',
      );
      return;
    }

    await this.settlement.markProcessing(userId, requestId);

    const version = request.sourceVersion;
    if (version.cleanObjectKey === null || version.sha256 === null) {
      throw new SmartFixFailure(
        SmartFixFailureCode.SOURCE_UNSUITABLE,
        'the source document has no readable object',
      );
    }
    const { plan, planHash } = await this.plans.artifact(userId, request.planId);
    if (planHash !== request.planHash) {
      throw new SmartFixFailure(
        SmartFixFailureCode.PLAN_STALE,
        'the stored plan is not the plan this correction was bought for',
      );
    }

    const source = await this.storage.getObjectBytes({
      zone: 'clean',
      key: version.cleanObjectKey,
    });
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    if (sourceSha256 !== version.sha256) {
      throw new SmartFixFailure(
        SmartFixFailureCode.SOURCE_UNSUITABLE,
        'the stored object does not match the digest recorded for this version',
      );
    }

    // --- 2. Apply -----------------------------------------------------------
    let applied;
    try {
      applied = await this.engine.applySmartFix({
        content: source,
        expectedSourceSha256: sourceSha256,
        plan,
        planHash,
      });
    } catch (error) {
      throw asFailure(error);
    }

    // --- 3. The corrected version, ingested like any other document ---------
    const correctedVersionId = randomUUID();
    const quarantineKey = generatedQuarantineObjectKey({
      ownerUserId: userId,
      documentId: request.documentId,
      versionId: correctedVersionId,
    });
    const staged = await this.storage.putObject({
      zone: 'quarantine',
      key: quarantineKey,
      content: applied.content,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const now = this.clock.now();
    await this.tenant.withUser(userId, async (tx) => {
      const last = await tx.documentVersion.aggregate({
        where: { documentId: request.documentId },
        _max: { versionNumber: true },
      });
      await tx.documentVersion.create({
        data: {
          id: correctedVersionId,
          documentId: request.documentId,
          ownerUserId: userId,
          versionNumber: (last._max.versionNumber ?? 0) + 1,
          status: DocumentVersionStatus.UPLOADED,
          // A corrected copy of the author's own file, named after it. Never a
          // path, never a key — the same sanitized, user-facing string Phase 5
          // keeps (§41).
          originalFilename: correctedName(version.originalFilename),
          expectedFormat: version.expectedFormat,
          declaredSizeBytes: applied.content.byteLength,
          quarantineObjectKey: quarantineKey,
          quarantineObjectVersionId: staged.versionId,
          quarantineObjectEtag: staged.etag,
          origin: 'SMARTFIX',
          sourceDocumentVersionId: version.id,
          smartFixRequestId: request.id,
          // Invisible until delivery. The database refuses to let this be true
          // before the correction is DELIVERED (§84, §198).
          visibleToOwner: false,
          uploadedAt: now,
        },
      });
      await tx.smartFixRequest.update({
        where: { id: request.id },
        data: { correctedDocumentVersionId: correctedVersionId },
      });
      // The source must not be purged while a correction references it.
      await tx.documentRetentionLock.create({
        data: {
          documentVersionId: version.id,
          ownerUserId: userId,
          lockType: SMARTFIX_RETENTION_LOCK,
          reference: request.id,
        },
      });
    });

    const outcome = await this.pipeline.run(
      {
        expectedFormat: version.expectedFormat as DocumentFormat,
        quarantineObjectKey: quarantineKey,
        quarantineObjectVersionId: staged.versionId,
        quarantineObjectEtag: staged.etag,
        declaredSizeBytes: applied.content.byteLength,
        clientSha256: applied.outputSha256,
        cleanObjectKey: cleanObjectKey({
          ownerUserId: userId,
          documentId: request.documentId,
          versionId: correctedVersionId,
        }),
      },
      // The generated version walks the same lifecycle as an uploaded one.
      // Skipping the stages would leave it stuck at UPLOADED and the status
      // machine would refuse to promote it — which is the machine working.
      (stage) => this.enterStage(userId, correctedVersionId, stage),
    );

    if (outcome.kind !== 'ready') {
      await this.tenant.withUser(userId, (tx) =>
        tx.documentVersion.update({
          where: { id: correctedVersionId },
          data: {
            status: DocumentVersionStatus.REJECTED,
            rejectionCode: outcome.code,
            failureDetail: outcome.detail.slice(0, 500),
            rejectedAt: this.clock.now(),
          },
        }),
      );
      // PalCert produced bytes its own ingestion refuses. That is PalCert's
      // failure, the user is not charged, and nothing is delivered (§89).
      throw new SmartFixFailure(
        SmartFixFailureCode.OUTPUT_REJECTED,
        `the corrected document was rejected by ingestion: ${outcome.code}`,
      );
    }

    await this.tenant.withUser(userId, (tx) =>
      tx.documentVersion.update({
        where: { id: correctedVersionId },
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
          scannedAt: this.clock.now(),
          readyAt: this.clock.now(),
        },
      }),
    );

    // --- 4. The manifest ----------------------------------------------------
    await this.recordManifest(userId, request.id, applied.manifest, applied.manifestSha256);

    // --- 5. The automatic recheck ------------------------------------------
    const recheckId = await this.startRecheck(userId, request, correctedVersionId);

    // --- 6. Hand over -------------------------------------------------------
    await this.settlement.advance(userId, request.id, SmartFixRequestStatus.RECHECKING, {
      recheckCheckId: recheckId,
    });

    await this.events.audit({
      action: 'SMARTFIX_CORRECTED',
      actorUserId: null,
      targetType: 'SmartFixRequest',
      targetId: request.id,
      afterState: {
        correctedDocumentVersionId: correctedVersionId,
        recheckCheckId: recheckId,
        entryCount: applied.entryCount,
      },
    });
  }

  /** Walk the generated version through validation and scanning. */
  private async enterStage(userId: string, versionId: string, stage: IngestStage): Promise<void> {
    const now = this.clock.now();
    await this.tenant.withUser(userId, async (tx) => {
      const from =
        stage === 'VALIDATING'
          ? [
              DocumentVersionStatus.UPLOADED,
              DocumentVersionStatus.VALIDATING,
              DocumentVersionStatus.SCANNING,
            ]
          : [DocumentVersionStatus.VALIDATING, DocumentVersionStatus.SCANNING];
      const to =
        stage === 'VALIDATING' ? DocumentVersionStatus.VALIDATING : DocumentVersionStatus.SCANNING;
      const result = await tx.documentVersion.updateMany({
        where: { id: versionId, status: { in: from } },
        data: { status: to, ...(stage === 'VALIDATING' ? {} : { validatedAt: now }) },
      });
      if (result.count !== 1) {
        throw new SmartFixFailure(
          SmartFixFailureCode.SERVICE_FAILED,
          `the corrected version could not enter ${to}`,
          false,
        );
      }
    });
  }

  /**
   * Store the change manifest and its artifact.
   *
   * The digests are copied into columns rather than left inside the artifact,
   * because the database refuses a manifest whose proofs disagree — and an
   * invariant that lives only inside a JSON blob is an invariant nothing can
   * enforce (§111).
   */
  private async recordManifest(
    userId: string,
    requestId: string,
    manifest: Record<string, unknown>,
    manifestSha256: string,
  ): Promise<void> {
    const existing = await this.tenant.withUser(userId, (tx) =>
      tx.smartFixManifest.findUnique({ where: { requestId } }),
    );
    if (existing !== null) return;

    const integrity = (manifest.integrity ?? {}) as Record<string, string>;
    const engine = (manifest.engine ?? {}) as Record<string, string>;
    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    const changedParts = Array.isArray(manifest.changedParts)
      ? manifest.changedParts.map(String)
      : [];

    const key = smartFixManifestArtifactKey({ ownerUserId: userId, requestId });
    const content = Buffer.from(JSON.stringify(manifest), 'utf8');
    const stored = await this.storage.putObject({
      zone: 'derived',
      key,
      content,
      contentType: 'application/json',
    });

    await this.tenant.withUser(userId, (tx) =>
      tx.smartFixManifest.create({
        data: {
          ownerUserId: userId,
          requestId,
          manifestSchemaVersion: Number(manifest.manifestSchemaVersion ?? 1),
          fixEngineName: String(engine.fixEngineName ?? ''),
          fixEngineVersion: String(engine.fixEngineVersion ?? ''),
          planHash: String(manifest.planHash ?? ''),
          sourceSha256: String(manifest.sourceSha256 ?? ''),
          outputSha256: String(manifest.outputSha256 ?? ''),
          manifestHash: manifestSha256,
          entryCount: entries.length,
          changedParts,
          sourceVisibleTextHash: String(integrity.sourceVisibleTextHash ?? ''),
          outputVisibleTextHash: String(integrity.outputVisibleTextHash ?? ''),
          sourceMediaSetHash: String(integrity.sourceMediaSetHash ?? ''),
          outputMediaSetHash: String(integrity.outputMediaSetHash ?? ''),
          sourceFieldInstructionHash: String(integrity.sourceFieldInstructionHash ?? ''),
          outputFieldInstructionHash: String(integrity.outputFieldInstructionHash ?? ''),
          sourceRelationshipHash: String(integrity.sourceRelationshipHash ?? ''),
          outputRelationshipHash: String(integrity.outputRelationshipHash ?? ''),
          artifactObjectKey: key,
          artifactObjectVersionId: stored.versionId ?? null,
          artifactSizeBytes: content.byteLength,
        },
      }),
    );
  }

  /**
   * Create and start the automatic recheck (§91, §92, §93, §96).
   *
   * Against the *exact* historical standard version — not "the current version
   * of that standard" — even if it has since been archived or made private.
   * Correcting against one set of rules and rechecking against another would
   * produce a report nobody could act on.
   *
   * It carries no purchase, because the user already paid for it as part of
   * this correction. The database enforces both of those, so a service that
   * forgot either is refused rather than quietly billing twice.
   */
  private async startRecheck(
    userId: string,
    request: {
      id: string;
      documentId: string;
      standardVersionId: string;
      recheckCheckId: string | null;
      check: {
        organizationId: string;
        documentTypeId: string;
        standardId: string;
        standardContentHash: string;
        organizationName: string;
        documentTypeName: string;
        standardCode: string;
        standardName: string;
        standardVersionLabel: string;
      };
    },
    correctedVersionId: string,
  ): Promise<string> {
    if (request.recheckCheckId !== null) return request.recheckCheckId;

    const corrected = await this.tenant.withUser(userId, (tx) =>
      tx.documentVersion.findUniqueOrThrow({
        where: { id: correctedVersionId },
        select: { sha256: true },
      }),
    );

    const recheckId = randomUUID();
    await this.tenant.withUser(userId, async (tx) => {
      // The request must already name the corrected version, because the
      // database checks that the recheck is rechecking exactly it.
      await tx.documentCheck.create({
        data: {
          id: recheckId,
          ownerUserId: userId,
          documentId: request.documentId,
          documentVersionId: correctedVersionId,
          organizationId: request.check.organizationId,
          documentTypeId: request.check.documentTypeId,
          standardId: request.check.standardId,
          standardVersionId: request.standardVersionId,
          documentSha256: corrected.sha256!,
          standardContentHash: request.check.standardContentHash,
          organizationName: request.check.organizationName,
          documentTypeName: request.check.documentTypeName,
          standardCode: request.check.standardCode,
          standardName: request.check.standardName,
          standardVersionLabel: request.check.standardVersionLabel,
          status: CheckStatus.CREATED,
          purpose: 'SMARTFIX_RECHECK',
          smartFixRequestId: request.id,
        },
      });
      await tx.documentRetentionLock.create({
        data: {
          documentVersionId: correctedVersionId,
          ownerUserId: userId,
          lockType: 'CHECK',
          reference: recheckId,
        },
      });
      await this.jobs.enqueueInTransaction(tx, {
        type: 'CHECK_PREPARE',
        resourceType: 'DOCUMENT_CHECK',
        resourceId: recheckId,
        ownerUserId: userId,
      });
    });

    // Best-effort: the job row is already committed, so if this fails the
    // outbox sweep publishes it moments later and nothing is lost.
    const job = await this.jobs.findByResource('CHECK_PREPARE', recheckId);
    if (job !== null) await this.dispatcher.dispatchNow(job.id);

    return recheckId;
  }
}

/** A corrected copy, named so a person can tell the two apart in a list. */
function correctedName(original: string): string {
  const dot = original.lastIndexOf('.');
  if (dot <= 0) return `${original} (corrected)`;
  return `${original.slice(0, dot)} (corrected)${original.slice(dot)}`;
}

/** Turn an engine refusal into the failure the customer will be told about. */
function asFailure(error: unknown): SmartFixFailure {
  if (error instanceof SmartFixEngineError) {
    return new SmartFixFailure(
      SmartFixFailureCode.CORRECTION_REFUSED,
      error.fixError ?? error.message,
      error.kind === 'DOCUMENT',
    );
  }
  if (error instanceof DocumentEngineError) {
    return new SmartFixFailure(
      SmartFixFailureCode.SERVICE_FAILED,
      error.message,
      error.kind === 'DOCUMENT',
    );
  }
  if (error instanceof SmartFixFailure) return error;
  // Unrecognized is infrastructure until proven otherwise: it must never
  // become a statement about the user's document.
  return new SmartFixFailure(SmartFixFailureCode.SERVICE_FAILED, 'an unexpected failure', false);
}
