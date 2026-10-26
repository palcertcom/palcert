import { Injectable } from '@nestjs/common';
import {
  AppError,
  CheckFailureCode,
  CheckRunStatus,
  CheckStatus,
  DocumentAnalysisStatus,
  PalCertErrorCode,
  ProcessingJobType,
  isPermanentCheckFailure,
  validateAnalysisArtifact,
  type CheckReport,
  type EvaluationResponse,
} from '@palcert/contracts';
import type { CheckRun, ProcessingJob } from '@palcert/database';
import { createHash } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../config/api-config.service';
import {
  DocumentEngineError,
  DocumentEnginePort,
} from '../infrastructure/document-engine/document-engine.port';
import {
  ObjectStoragePort,
  ObjectStorageUnavailableError,
} from '../infrastructure/storage/object-storage.port';
import { OutboxDispatcher } from '../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../infrastructure/queue/processing-job.service';
import { checkReportArtifactKey } from '../infrastructure/storage/storage-keys';
import { TenantPrismaService } from '../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../modules/auth/ports/clock.port';
import { SecurityEventService } from '../modules/auth/services/security-event.service';
import { CatalogueService } from '../modules/checks/services/catalogue.service';
import {
  ANALYSIS_RETENTION_LOCK,
  DocumentCheckService,
} from '../modules/checks/services/document-check.service';
import { PaidCheckSettlementService } from '../modules/checks/services/paid-check-settlement.service';
import {
  CheckReportBuilder,
  type BuiltReport,
  type SnapshotRule,
} from '../modules/checks/services/check-report-builder.service';
import { requireJobOwner } from './job-owner';

/**
 * Running one check evaluation (§30–§40, §59–§64).
 *
 * The order of the steps is the design. Every identity the check captured at
 * creation is re-verified against what is actually on disk *before* anything
 * is evaluated, and nothing is persisted until the whole report exists:
 *
 * 1. **Claim** the run atomically. A duplicate delivery is a no-op (§59).
 * 2. **Load the analysis** the check bound itself to, by its exact object
 *    version, and verify the stored bytes against the recorded digest.
 * 3. **Validate the artifact** against the shared contract. Node never parses
 *    whatever dictionary happened to arrive (§33, §35).
 * 4. **Load the standard snapshot** and re-verify its content hash against the
 *    hash the check captured. A mismatch fails closed — it is never resolved by
 *    silently evaluating a different version (§20, §21).
 * 5. **Evaluate** in the Python engine. There is no second evaluator (§34).
 * 6. **Build the report**, hash it, store the artifact.
 * 7. **Persist once**, in a single transaction: results, violations, report
 *    row, run finalization, the capture of every reservation, and check
 *    completion. A crash before the commit leaves a retryable run and no
 *    partial report (§60).
 *
 * Phase 11 adds the money to step 7 and changes nothing else. The charge is
 * part of the delivery commit rather than a second one, because there is no
 * order of two commits that is safe: complete-then-charge gives the report
 * away when the charge fails, and charge-then-complete takes the money when
 * the completion fails (§32). The report itself is untouched — no price, no
 * hold and no balance enters the canonical report, so `reportHash` and
 * `evaluationHash` are exactly what they were before checks were paid for
 * (§51, §102).
 */
@Injectable()
export class CheckEvaluationJobHandler {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly storage: ObjectStoragePort,
    private readonly engine: DocumentEnginePort,
    private readonly catalogue: CatalogueService,
    private readonly builder: CheckReportBuilder,
    private readonly checks: DocumentCheckService,
    private readonly settlement: PaidCheckSettlementService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly events: SecurityEventService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CheckEvaluationJobHandler.name);
  }

  async handle(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    if (owner === null) throw new Error(`check evaluation job ${job.id} has no owner`);

    const run = await this.claim(owner, job.resourceId);
    if (run === null) return;

    const startedAt = Date.now();
    try {
      const built = await this.evaluate(owner, run);
      // The rules have been evaluated and the report is being written. A
      // distinct status rather than a cosmetic one: the lifecycle only reaches
      // COMPLETED through it, so a check can never jump straight from
      // "evaluating" to a finished report.
      await this.markGeneratingReport(owner, run.checkId);
      await this.persist(owner, run, built, Date.now() - startedAt);
    } catch (error) {
      const failure = classify(error);
      // Deciding "this cannot be evaluated" is a decision; the job succeeds
      // and the check is failed. Infrastructure trouble is rethrown so the
      // ledger spends an attempt — it must never become a verdict (§108).
      if (isPermanentCheckFailure(failure.code)) {
        await this.failRun(owner, run, failure, true);
        return;
      }
      await this.failRun(owner, run, failure, false);
      throw error;
    }
  }

  /** The last attempt has been spent: the check is failed for good. */
  async failPermanently(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    if (owner === null) return;
    const run = await this.tenant.withUser(owner, (tx) =>
      tx.checkRun.findUnique({ where: { id: job.resourceId } }),
    );
    if (run === null || run.status !== CheckRunStatus.RUNNING) return;
    await this.failRun(
      owner,
      run,
      {
        code: (run.failureCode as CheckFailureCode | null) ?? CheckFailureCode.CHECK_ENGINE_ERROR,
        detail: 'attempts exhausted',
      },
      true,
    );
  }

  private async markGeneratingReport(owner: string, checkId: string): Promise<void> {
    await this.tenant.withUser(owner, (tx) =>
      tx.documentCheck.updateMany({
        where: { id: checkId, status: CheckStatus.EVALUATING },
        data: { status: CheckStatus.GENERATING_REPORT },
      }),
    );
  }

  private async claim(owner: string, runId: string): Promise<CheckRun | null> {
    const now = this.clock.now();
    return this.tenant.withUser(owner, async (tx) => {
      const updated = await tx.checkRun.updateMany({
        where: { id: runId, status: { in: [CheckRunStatus.PENDING, CheckRunStatus.RUNNING] } },
        data: { status: CheckRunStatus.RUNNING, startedAt: now },
      });
      if (updated.count !== 1) return null;
      return tx.checkRun.findUniqueOrThrow({ where: { id: runId } });
    });
  }

  private async evaluate(owner: string, run: CheckRun): Promise<BuiltReport> {
    const context = await this.tenant.withUser(owner, async (tx) => {
      const check = await tx.documentCheck.findUniqueOrThrow({ where: { id: run.checkId } });
      const version = await tx.documentVersion.findUniqueOrThrow({
        where: { id: check.documentVersionId },
      });
      const analysis =
        run.documentAnalysisId === null
          ? null
          : await tx.documentAnalysis.findUnique({ where: { id: run.documentAnalysisId } });
      return { check, version, analysis };
    });

    const { check, version, analysis } = context;
    if (analysis === null || analysis.status !== DocumentAnalysisStatus.SUCCEEDED) {
      throw new CheckFailure(
        CheckFailureCode.DOCUMENT_ANALYSIS_FAILED,
        'the check has no successful analysis to evaluate',
      );
    }
    if (
      analysis.artifactObjectKey === null ||
      analysis.artifactSha256 === null ||
      version.sha256 !== check.documentSha256
    ) {
      throw new CheckFailure(
        CheckFailureCode.ANALYSIS_ARTIFACT_INTEGRITY_FAILED,
        'the analysis or the document no longer matches what the check captured',
      );
    }

    // The exact object version the analysis recorded — never the latest
    // version of the key (ADR-0034).
    const bytes = await this.storage
      .getObjectBytes({
        zone: 'derived',
        key: analysis.artifactObjectKey,
        versionId: analysis.artifactObjectVersionId,
      })
      .catch((error: unknown) => {
        throw new CheckFailure(CheckFailureCode.CHECK_ENGINE_ERROR, describe(error));
      });

    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== analysis.artifactSha256) {
      throw new CheckFailure(
        CheckFailureCode.ANALYSIS_ARTIFACT_INTEGRITY_FAILED,
        'the stored analysis artifact does not match its recorded digest',
      );
    }

    let artifact: unknown;
    try {
      artifact = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new CheckFailure(
        CheckFailureCode.ANALYSIS_ARTIFACT_INVALID,
        'the analysis artifact is not JSON',
      );
    }
    const contract = validateAnalysisArtifact(artifact);
    if (!contract.valid) {
      throw new CheckFailure(
        CheckFailureCode.ANALYSIS_ARTIFACT_INVALID,
        `the analysis artifact does not satisfy the shared contract: ${contract.issues[0]?.message ?? 'unknown'}`,
      );
    }
    const typed = artifact as AnalysisArtifactShape;

    const snapshot = await this.catalogue.snapshotForVersion(check.standardVersionId);
    if (snapshot === null) {
      throw new CheckFailure(
        CheckFailureCode.STANDARD_SNAPSHOT_INTEGRITY_FAILED,
        'the standard version has no published snapshot',
      );
    }
    if (snapshot.contentHash !== check.standardContentHash) {
      // Fail closed. Evaluating a different version of the rules than the
      // check promised would produce a confidently wrong answer (§20).
      throw new CheckFailure(
        CheckFailureCode.STANDARD_SNAPSHOT_INTEGRITY_FAILED,
        'the published snapshot no longer matches the hash the check captured',
      );
    }

    const canonical = snapshot.canonical as CanonicalSnapshotShape;
    const snapshotRules = canonical.rules.map<SnapshotRule>((rule) => ({
      ruleCode: rule.ruleCode,
      category: rule.category ?? null,
      severity: rule.severity,
      blocking: rule.blocking,
      evaluationMode: rule.evaluationMode,
      displayOrder: rule.displayOrder ?? 0,
      titleEn: rule.titleEn ?? null,
      titleAr: rule.titleAr ?? null,
      guidanceEn: rule.guidanceEn ?? null,
      guidanceAr: rule.guidanceAr ?? null,
      operator: rule.operator ?? null,
    }));

    // The engine receives rule definitions exactly as published, with the
    // snapshot's schema version attached: the canonical form carries it once
    // at the top, the engine wants it per rule.
    const evaluation = await this.engine.evaluateRules({
      documentId: check.documentVersionId,
      factSet: typed.factSet,
      rules: canonical.rules.map((rule) => ({
        ...rule,
        ruleSchemaVersion: canonical.ruleSchemaVersion,
      })),
    });

    return this.buildReport(
      check,
      version,
      run,
      analysis,
      typed,
      snapshot,
      snapshotRules,
      evaluation.response,
    );
  }

  private async buildReport(
    check: { id: string; ownerUserId: string; documentId: string; organizationId: string },
    version: {
      id: string;
      versionNumber: number;
      sha256: string | null;
      detectedFormat: string | null;
      sizeBytes: number | null;
    },
    run: CheckRun,
    analysis: {
      id: string;
      analyzerName: string;
      analyzerVersion: string;
      factSchemaVersion: number;
      artifactSha256: string | null;
      factCount: number | null;
      warningCodes: string[];
    },
    artifact: AnalysisArtifactShape,
    snapshot: { standardVersionId: string; contentHash: string; canonicalizationVersion: number },
    snapshotRules: readonly SnapshotRule[],
    evaluation: EvaluationResponse,
  ): Promise<BuiltReport> {
    const standard = await this.catalogue.reportStandard(snapshot.standardVersionId);

    const document: CheckReport['document'] = {
      documentId: check.documentId,
      documentVersionId: version.id,
      versionNumber: version.versionNumber,
      sha256: version.sha256!,
      format: version.detectedFormat === 'PDF' ? 'PDF' : 'DOCX',
      ...(version.sizeBytes !== null ? { sizeBytes: version.sizeBytes } : {}),
    };

    return this.builder.build({
      checkId: check.id,
      checkRunId: run.id,
      ownerUserId: check.ownerUserId,
      document,
      organization: standard.organization,
      standard: standard.standard,
      analysis: {
        analysisId: analysis.id,
        analyzerName: analysis.analyzerName,
        analyzerVersion: analysis.analyzerVersion,
        factSchemaVersion: artifact.factSchemaVersion,
        analysisSchemaVersion: artifact.analysisSchemaVersion,
        artifactSha256: analysis.artifactSha256!,
        ...(analysis.factCount !== null ? { factCount: analysis.factCount } : {}),
        warningCodes: [...analysis.warningCodes],
      },
      evaluation,
      snapshotRules,
      generatedAt: this.clock.now(),
    });
  }

  /**
   * Store the artifact, then write everything else in one transaction.
   *
   * The object goes first because it is idempotent — the key is derived from
   * the run, so a retry after a crash rewrites the same bytes at the same key
   * — while the database write must be all-or-nothing. An object left behind
   * by a rolled-back commit is an orphan that the next attempt overwrites at
   * the same key; its existence never causes a charge, because only the
   * committed transaction does that (§33, §34).
   */
  private async persist(
    owner: string,
    run: CheckRun,
    built: BuiltReport,
    durationMs: number,
  ): Promise<void> {
    const key = checkReportArtifactKey({
      ownerUserId: owner,
      checkId: run.checkId,
      checkRunId: run.id,
    });
    const content = Buffer.from(built.canonicalJson, 'utf8');

    const stored = await this.storage
      .putObject({ zone: 'derived', key, content, contentType: 'application/json' })
      .catch((error: unknown) => {
        throw new CheckFailure(CheckFailureCode.REPORT_STORAGE_FAILED, describe(error));
      });

    const now = this.clock.now();
    const cap = this.config.checks.maxStoredViolationsPerRule;

    await this.tenant.withUser(owner, async (tx) => {
      // The check's row lock, taken before anything is written. It is what
      // makes completion, cancellation and failure mutually exclusive: a check
      // cancelled while this worker was building its report is terminal by the
      // time we get here, and this throws rather than delivering it (§45,
      // §46, §85).
      await this.settlement.assertDeliverable(tx, run.checkId);

      for (const result of built.report.ruleResults) {
        const row = await tx.checkRuleResult.create({
          data: {
            ownerUserId: owner,
            checkRunId: run.id,
            ruleCode: result.ruleCode,
            category: result.category,
            evaluationMode: result.evaluationMode,
            severity: result.severity,
            blocking: result.blocking,
            displayOrder: result.displayOrder,
            outcome: result.outcome,
            reasonCode: result.reasonCode,
            evidenceLevel: result.evidenceLevel,
            requiresReview: result.requiresReview,
            operator: result.operator ?? null,
            matchedFactCount: result.counts.matchedFacts,
            evaluatedFactCount: result.counts.evaluatedFacts,
            passedFactCount: result.counts.passedFacts,
            failedFactCount: result.counts.failedFacts,
            indeterminateFactCount: result.counts.indeterminateFacts,
            totalViolationCount: result.totalViolationCount,
            returnedViolationCount: Math.min(result.violations.length, cap),
            // True whenever the stored list is shorter than what was found,
            // whether the engine capped it or PalCert did (§45).
            violationsTruncated: result.truncated || result.violations.length > cap,
            titleEn: result.titleEn ?? null,
            titleAr: result.titleAr ?? null,
            guidanceEn: result.guidanceEn ?? null,
            guidanceAr: result.guidanceAr ?? null,
          },
        });

        const kept = result.violations.slice(0, cap);
        if (kept.length > 0) {
          await tx.checkViolation.createMany({
            data: kept.map((violation, index) => ({
              ownerUserId: owner,
              checkRuleResultId: row.id,
              ordinal: index + 1,
              reasonCode: violation.reasonCode,
              nodeId: violation.nodeId ?? null,
              path: violation.path ?? [],
              elementType: violation.elementType ?? null,
              sectionKey: violation.sectionKey ?? null,
              locationOrdinal: violation.ordinal ?? null,
              page: violation.page ?? null,
              expectedValue: violation.expectedValue ?? null,
              expectedUnit: violation.expectedUnit ?? null,
              actualValue: violation.actualValue ?? null,
              actualUnit: violation.actualUnit ?? null,
              tolerance: violation.tolerance ?? null,
            })),
          });
        }
      }

      await tx.checkReport.create({
        data: {
          ownerUserId: owner,
          checkId: run.checkId,
          checkRunId: run.id,
          reportSchemaVersion: built.report.reportSchemaVersion,
          reportCanonicalizationVersion: built.report.reportCanonicalizationVersion,
          artifactObjectKey: key,
          artifactObjectVersionId: stored.versionId,
          artifactSha256: built.reportHash,
          artifactSizeBytes: content.byteLength,
          reportHash: built.reportHash,
          evaluationHash: built.evaluationHash,
        },
      });

      await tx.checkRun.updateMany({
        where: { id: run.id, status: CheckRunStatus.RUNNING },
        data: {
          status: CheckRunStatus.SUCCEEDED,
          analysisArtifactSha256: built.report.analysis.artifactSha256,
          ruleEngineName: built.report.engine.ruleEngineName,
          ruleEngineVersion: built.report.engine.ruleEngineVersion,
          ruleSchemaVersion: built.report.engine.ruleSchemaVersion,
          factSchemaVersion: built.report.engine.factSchemaVersion,
          determination: built.determination,
          scoreValue: built.score.value,
          scoreCoverage: built.score.coverage,
          scoreComplete: built.score.complete,
          passedWeight: built.score.passedWeight,
          evaluatedWeight: built.score.evaluatedWeight,
          unresolvedWeight: built.score.unresolvedWeight,
          evaluationHash: built.evaluationHash,
          totalRules: built.counts.totalRules,
          passedRules: built.counts.passedRules,
          failedRules: built.counts.failedRules,
          notApplicableRules: built.counts.notApplicableRules,
          reviewRequiredRules: built.counts.reviewRequiredRules,
          indeterminateRules: built.counts.indeterminateRules,
          blockingFailures: built.counts.blockingFailures,
          criticalFailures: built.counts.criticalFailures,
          majorFailures: built.counts.majorFailures,
          minorFailures: built.counts.minorFailures,
          infoFailures: built.counts.infoFailures,
          totalViolations: built.counts.totalViolations,
          durationMs,
          completedAt: now,
          failureCode: null,
          failureDetail: null,
        },
      });

      // The charge, inside the delivery commit. Every reservation is captured
      // or the whole transaction rolls back, so there is no partial charge and
      // no charged-but-incomplete check (§32, §35, §119).
      await this.settlement.captureOnDelivery(tx, run.checkId);

      const completed = await tx.documentCheck.updateMany({
        where: { id: run.checkId, status: CheckStatus.GENERATING_REPORT },
        data: { status: CheckStatus.COMPLETED, completedAt: now, currentRunId: run.id },
      });
      if (completed.count !== 1) {
        // The status moved underneath us despite the lock — which should be
        // impossible, and is exactly the kind of impossible that must not
        // become a silent charge.
        throw new CheckFailure(
          CheckFailureCode.CHECK_ENGINE_ERROR,
          'the check was not in a completable state when its report was persisted',
        );
      }

      // A SmartFix recheck finishing is what wakes the correction that owns
      // it (Phase 12 §97). Written inside the completion commit, so a worker
      // that dies one instruction later still leaves the intent behind and the
      // correction is finalized rather than stranded holding a reservation.
      const recheckOf = await tx.smartFixRequest.findUnique({
        where: { recheckCheckId: run.checkId },
        select: { id: true },
      });
      if (recheckOf !== null) {
        await this.jobs.enqueueInTransaction(tx, {
          type: ProcessingJobType.SMARTFIX_FINALIZE,
          resourceType: 'SMARTFIX_REQUEST',
          resourceId: recheckOf.id,
          ownerUserId: owner,
        });
      }

      // The analysis this report was produced from must survive as long as the
      // report references it (§70, §71). Append-only, like the source lock.
      if (run.documentAnalysisId !== null) {
        await tx.documentRetentionLock.create({
          data: {
            documentVersionId: built.report.document.documentVersionId,
            ownerUserId: owner,
            lockType: ANALYSIS_RETENTION_LOCK,
            reference: run.id,
          },
        });
      }
    });

    // A SmartFix recheck that has just completed has a correction waiting on
    // it. The intent is already committed; publishing it now simply saves the
    // outbox sweep a turn.
    const finalize = await this.jobs.findByResource(
      ProcessingJobType.SMARTFIX_FINALIZE,
      (
        await this.tenant.withUser(owner, (tx) =>
          tx.smartFixRequest.findUnique({
            where: { recheckCheckId: run.checkId },
            select: { id: true },
          }),
        )
      )?.id ?? run.checkId,
    );
    if (finalize !== null) await this.dispatcher.dispatchNow(finalize.id);

    await this.events.audit({
      action: 'CHECK_REPORT_CREATED',
      actorUserId: null,
      targetType: 'CheckReport',
      targetId: run.id,
      // Codes and counters only: never a rule's text, a title or an excerpt.
      afterState: {
        determination: built.determination,
        reportHash: built.reportHash,
        totalRules: built.counts.totalRules,
      },
    });
    await this.events.audit({
      action: 'CHECK_PURCHASE_CAPTURED',
      actorUserId: null,
      targetType: 'DocumentCheck',
      targetId: run.checkId,
      // The ledger is the financial authority; this says only that delivery
      // happened, so an operator can correlate the two (§138).
      afterState: { determination: built.determination },
    });
    await this.events.audit({
      action: 'CHECK_COMPLETED',
      actorUserId: null,
      targetType: 'DocumentCheck',
      targetId: run.checkId,
      afterState: { determination: built.determination, runId: run.id },
    });

    this.logger.info(
      {
        checkId: run.checkId,
        runId: run.id,
        determination: built.determination,
        totalRules: built.counts.totalRules,
        durationMs,
      },
      'Check evaluation completed',
    );
  }

  private async failRun(
    owner: string,
    run: CheckRun,
    failure: { code: CheckFailureCode; detail: string },
    terminal: boolean,
  ): Promise<void> {
    const now = this.clock.now();
    await this.tenant.withUser(owner, (tx) =>
      tx.checkRun.updateMany({
        where: { id: run.id, status: CheckRunStatus.RUNNING },
        data: terminal
          ? {
              status: CheckRunStatus.FAILED,
              failureCode: failure.code,
              failureDetail: failure.detail.slice(0, 500),
              failedAt: now,
            }
          : { failureCode: failure.code, failureDetail: failure.detail.slice(0, 500) },
      }),
    );
    if (terminal) {
      await this.checks.fail(owner, run.checkId, failure);
    }
  }
}

/** The parts of a validated artifact this handler reads. */
interface AnalysisArtifactShape {
  readonly analysisSchemaVersion: number;
  readonly factSchemaVersion: number;
  readonly factSet: unknown;
}

interface CanonicalSnapshotShape {
  readonly ruleSchemaVersion: number;
  readonly rules: readonly {
    readonly ruleCode: string;
    readonly category?: string;
    readonly severity: 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL';
    readonly blocking: boolean;
    readonly evaluationMode: 'DETERMINISTIC' | 'AI_ASSISTED' | 'MANUAL';
    readonly displayOrder?: number;
    readonly titleEn?: string;
    readonly titleAr?: string;
    readonly guidanceEn?: string;
    readonly guidanceAr?: string;
    readonly operator?: string;
  }[];
}

/** A failure that already knows its own code. */
export class CheckFailure extends Error {
  constructor(
    readonly code: CheckFailureCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'CheckFailure';
  }
}

/**
 * Give every error a code, defaulting to transient.
 *
 * An unrecognized error is infrastructure until proven otherwise: it must
 * never be turned into a compliance verdict about the user's document (§108).
 */
function classify(error: unknown): { code: CheckFailureCode; detail: string } {
  if (error instanceof CheckFailure) return { code: error.code, detail: error.detail };
  // Phase 11: the two ways a delivery can be refused on financial grounds.
  // Both are permanent — retrying an expired reservation would re-take money,
  // and a check that has already been cancelled or failed must stay that way.
  if (error instanceof AppError) {
    if (error.code === PalCertErrorCode.SERVICE_RESERVATION_EXPIRED) {
      return {
        code: CheckFailureCode.SERVICE_RESERVATION_EXPIRED,
        detail: 'the reservation expired before the report could be delivered',
      };
    }
    if (error.code === PalCertErrorCode.CHECK_NOT_CANCELLABLE) {
      return {
        code: CheckFailureCode.CHECK_ENGINE_ERROR,
        detail: 'the check reached a terminal state before its report was persisted',
      };
    }
  }
  if (error instanceof ObjectStorageUnavailableError) {
    return { code: CheckFailureCode.CHECK_ENGINE_ERROR, detail: error.message };
  }
  if (error instanceof DocumentEngineError) {
    return { code: CheckFailureCode.RULE_ENGINE_FAILED, detail: error.message };
  }
  return { code: CheckFailureCode.CHECK_ENGINE_ERROR, detail: describe(error) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unexpected evaluation failure';
}
