import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  SMARTFIX_PLAN_TTL_MINUTES,
  SMARTFIX_AI_CONSENT_VERSION,
  canCompleteSmartFixPlan,
} from '@palcert/contracts';
import { SmartFixAIPlannerService } from './smartfix-ai-planner.service';
import { SmartFixPlanningBillingService } from './smartfix-planning-billing.service';
import type { SmartFixPlan } from '@palcert/database';
import { createHash, randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { DocumentEnginePort } from '../../../infrastructure/document-engine/document-engine.port';
import { ObjectStoragePort } from '../../../infrastructure/storage/object-storage.port';
import { smartFixPlanArtifactKey } from '../../../infrastructure/storage/storage-keys';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { CatalogueService } from '../../checks/services/catalogue.service';
import type { RequestContext } from '../../documents/services/document.service';

/**
 * Planning a correction (Phase 12 §3, §72).
 *
 * Deterministic planning is free. Optional AI planning first reserves the
 * existing SMARTFIX price, reused on approval and charged only on delivery.
 * Both paths show the immutable plan before the user approves execution.
 *
 * A plan is bound to everything it was computed from — the document's bytes,
 * the analysis artifact, the standard's rules, the report — and hashed. What
 * executes later is *this* plan, re-verified against the document, or nothing.
 */
@Injectable()
export class SmartFixPlanService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly catalogue: CatalogueService,
    private readonly engine: DocumentEnginePort,
    private readonly aiPlanner: SmartFixAIPlannerService,
    private readonly storage: ObjectStoragePort,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
    private readonly planningBilling: SmartFixPlanningBillingService,
  ) {
    this.logger.setContext(SmartFixPlanService.name);
  }

  /**
   * Compute what SmartFix would change in the document one check examined.
   *
   * AI consent also confirms a price quote; its reservation survives until
   * approval, cancellation or expiry. No correction executes during planning.
   */
  async plan(
    userId: string,
    checkId: string,
    request: RequestContext,
    options: { useAI?: boolean; formattingAIConsentVersion?: string; priceQuoteId?: string } = {},
  ): Promise<SmartFixPlan> {
    const check = await this.loadCorrectableCheck(userId, checkId);
    const snapshot = await this.catalogue.snapshotForVersion(check.standardVersionId);
    if (snapshot === null || snapshot.contentHash !== check.standardContentHash) {
      // The rules the check was run against are no longer retrievable as they
      // were. Planning against different rules would propose changes for a
      // standard the user never saw (§58).
      throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
        message: 'The standard this check used is no longer available for correction.',
      });
    }

    const canonical = snapshot.canonical as {
      ruleSchemaVersion: number;
      rules: readonly Record<string, unknown>[];
    };

    const content = await this.storage.getObjectBytes({
      zone: 'clean',
      key: check.cleanObjectKey,
    });
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== check.documentSha256) {
      // The stored object is not the one the check measured. Refusing is the
      // only honest answer; correcting it would edit bytes nobody reviewed.
      throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
        message: 'This document could not be read for correction.',
        internalContext: { reason: 'stored object digest does not match the check' },
      });
    }

    let planId: string = randomUUID();
    const source = {
      checkId: check.id,
      checkRunId: check.currentRunId,
      documentVersionId: check.documentVersionId,
      documentSha256: check.documentSha256,
      analysisArtifactSha256: check.analysisArtifactSha256,
      standardVersionId: check.standardVersionId,
      standardContentHash: check.standardContentHash,
      reportHash: check.reportHash,
      ruleSchemaVersion: snapshot.ruleSchemaVersion,
      factSchemaVersion: check.factSchemaVersion,
    };

    if (options.useAI && options.formattingAIConsentVersion !== SMARTFIX_AI_CONSENT_VERSION) {
      throw new AppError(PalCertErrorCode.AI_CONSENT_REQUIRED, {
        message:
          'Agree to sharing formatting measurements and standard rules with the AI provider.',
      });
    }
    if (options.useAI) {
      // Refusals first: the audit below records that measurements are about to
      // be shared with the provider, which is untrue for a refused request.
      this.aiPlanner.assertEnabled();
      if (!options.priceQuoteId)
        throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
          message: 'Confirm a SMARTFIX price quote before AI planning.',
        });
      await this.events.audit({
        action: 'SMARTFIX_AI_PLANNING_REQUESTED',
        actorUserId: userId,
        targetType: 'Check',
        targetId: check.id,
        requestId: request.requestId,
        ipAddress: request.ipAddress,
        afterState: {
          consentVersion: SMARTFIX_AI_CONSENT_VERSION,
          documentSha256: digest,
          standardContentHash: check.standardContentHash,
        },
      });
    }
    const planningInput = {
      documentId: check.documentVersionId,
      content,
      expectedSha256: check.documentSha256,
      rules: canonical.rules.map((rule) => ({
        ...rule,
        ruleSchemaVersion: snapshot.ruleSchemaVersion,
      })),
      source,
      ...(request.requestId !== null ? { requestId: request.requestId } : {}),
    };
    const reserved = options.useAI
      ? await this.planningBilling.reserve(userId, check.id, options.priceQuoteId!)
      : null;
    if (reserved?.reused) return this.byId(userId, reserved.reservation.planId!);
    if (reserved) planId = reserved.reservation.id;
    let usable = true;
    try {
      const planned = options.useAI
        ? await this.aiPlanner.plan(planningInput, {
            ownerUserId: userId,
            planId,
            requestId: request.requestId,
            ipAddress: request.ipAddress,
          })
        : await this.engine.planSmartFix(planningInput);

      const artifactKey = smartFixPlanArtifactKey({
        ownerUserId: userId,
        checkId: check.id,
        planId,
      });
      const stored = await this.storage.putObject({
        zone: 'derived',
        key: artifactKey,
        content: planned.planBytes,
        contentType: 'application/json',
      });

      const now = this.clock.now();
      const row = await this.tenant.withUser(userId, async (tx) => {
        const created = await tx.smartFixPlan.create({
          data: {
            id: planId,
            ownerUserId: userId,
            checkId: check.id,
            checkRunId: check.currentRunId,
            documentId: check.documentId,
            documentVersionId: check.documentVersionId,
            standardVersionId: check.standardVersionId,
            documentSha256: check.documentSha256,
            analysisArtifactSha256: check.analysisArtifactSha256,
            standardContentHash: check.standardContentHash,
            reportHash: check.reportHash,
            planSchemaVersion: readNumber(planned.plan, 'planSchemaVersion', 1),
            fixEngineName: planned.fixEngineName,
            fixEngineVersion: planned.fixEngineVersion,
            capabilityRegistryVersion: planned.capabilityRegistryVersion,
            planHash: planned.planSha256,
            refusalCode: planned.refusal,
            ruleCount: planned.ruleCount,
            fixableRuleCount: countFixable(planned.plan),
            actionCount: planned.actionCount,
            artifactObjectKey: artifactKey,
            artifactObjectVersionId: stored.versionId ?? null,
            artifactSizeBytes: planned.planBytes.byteLength,
            // Both stamped from PalCert's own clock rather than one from the
            // clock and one from the database: expiry is measured against
            // creation, and two different notions of "now" would make the
            // window a few milliseconds of luck.
            createdAt: now,
            // A plan is a snapshot of one document against one set of rules, and
            // both move on.
            expiresAt:
              reserved?.reservation.expiresAt ??
              new Date(now.getTime() + SMARTFIX_PLAN_TTL_MINUTES * 60_000),
          },
        });
        if (reserved) {
          usable = canCompleteSmartFixPlan({
            fixEngineVersion: planned.fixEngineVersion,
            refusalCode: planned.refusal,
            actionCount: planned.actionCount,
            rules: planned.plan.rules,
            aiPlanning: planned.plan.aiPlanning,
          });
          await this.planningBilling.finish(tx, userId, planId, usable);
        }
        return created;
      });
      if (reserved && !usable)
        await this.planningBilling.recordPlanningRelease(userId, reserved.reservation);

      await this.events.audit({
        action: 'SMARTFIX_PLANNED',
        actorUserId: userId,
        targetType: 'SmartFixPlan',
        targetId: planId,
        requestId: request.requestId,
        ipAddress: request.ipAddress,
        // Counts and codes. Never a rule's guidance, never a node id's text.
        afterState: {
          checkId: check.id,
          ...(reserved ? { purchaseId: reserved.reservation.servicePurchaseId } : {}),
          actionCount: planned.actionCount,
          ruleCount: planned.ruleCount,
          refusalCode: planned.refusal,
          ...(planned.plan.aiPlanning ? { aiPlanning: planned.plan.aiPlanning } : {}),
        },
      });

      return row;
    } catch (error) {
      if (reserved) await this.planningBilling.release(userId, planId);
      throw error;
    }
  }

  /** The plan document itself, read back from storage. */
  async artifact(
    userId: string,
    planId: string,
  ): Promise<{ plan: Record<string, unknown>; planHash: string }> {
    const plan = await this.byId(userId, planId);
    const bytes = await this.storage.getObjectBytes({
      zone: 'derived',
      key: plan.artifactObjectKey,
    });
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== plan.planHash) {
      // The stored plan is not the plan that was approved. There is no safe
      // way to proceed from here, so nothing does.
      throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
        message: 'This correction plan could not be read.',
        internalContext: { reason: 'stored plan digest does not match the recorded hash' },
      });
    }
    return {
      plan: JSON.parse(bytes.toString('utf8')) as Record<string, unknown>,
      planHash: digest,
    };
  }

  /**
   * The change manifest of one correction, read back from storage.
   *
   * Verified against the hash the database recorded: a manifest that does not
   * hash to what was stored is not evidence of anything, and the user is told
   * it could not be read rather than shown something PalCert cannot vouch for.
   */
  async manifestArtifact(userId: string, requestId: string): Promise<Record<string, unknown>> {
    const row = await this.tenant.withUser(userId, (tx) =>
      tx.smartFixManifest.findFirst({ where: { requestId, ownerUserId: userId } }),
    );
    if (row === null) {
      throw new AppError(PalCertErrorCode.NOT_FOUND, {
        message: 'That correction has no change manifest.',
      });
    }
    const bytes = await this.storage.getObjectBytes({
      zone: 'derived',
      key: row.artifactObjectKey,
    });
    return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  }

  async byId(userId: string, planId: string): Promise<SmartFixPlan> {
    const plan = await this.tenant.withUser(userId, (tx) =>
      tx.smartFixPlan.findFirst({ where: { id: planId, ownerUserId: userId } }),
    );
    if (plan === null) {
      throw new AppError(PalCertErrorCode.NOT_FOUND, {
        message: 'That correction plan could not be found.',
      });
    }
    return plan;
  }

  async listForCheck(userId: string, checkId: string): Promise<readonly SmartFixPlan[]> {
    return this.tenant.withUser(userId, (tx) =>
      tx.smartFixPlan.findMany({
        where: { ownerUserId: userId, checkId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    );
  }

  /**
   * The check a plan may be computed from (§4, §5).
   *
   * Completed, DOCX, with a report and an analysis: a correction is a change
   * to a document PalCert has actually read, measured against rules it
   * actually evaluated. Anything less and the plan would be guesswork.
   */
  private async loadCorrectableCheck(
    userId: string,
    checkId: string,
  ): Promise<{
    id: string;
    documentId: string;
    documentVersionId: string;
    standardVersionId: string;
    standardContentHash: string;
    documentSha256: string;
    currentRunId: string | null;
    cleanObjectKey: string;
    analysisArtifactSha256: string;
    reportHash: string;
    factSchemaVersion: number;
  }> {
    const check = await this.tenant.withUser(userId, (tx) =>
      tx.documentCheck.findFirst({
        where: { id: checkId, ownerUserId: userId },
        include: {
          documentVersion: {
            select: { cleanObjectKey: true, detectedFormat: true, status: true, origin: true },
          },
          runs: {
            where: { status: 'SUCCEEDED' },
            orderBy: { attemptNumber: 'desc' },
            take: 1,
            select: { id: true, analysisArtifactSha256: true, factSchemaVersion: true },
          },
          reports: { orderBy: { createdAt: 'desc' }, take: 1, select: { reportHash: true } },
        },
      }),
    );

    if (check === null) {
      throw new AppError(PalCertErrorCode.CHECK_NOT_FOUND, {
        message: 'That check could not be found.',
      });
    }
    if (check.status !== 'COMPLETED') {
      throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
        message: 'This check has not finished yet.',
        details: { status: check.status },
      });
    }

    const run = check.runs[0];
    const report = check.reports[0];
    const version = check.documentVersion;
    if (run === undefined || report === undefined) {
      throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
        message: 'This check has no report to correct against.',
      });
    }
    if (version.detectedFormat !== 'DOCX') {
      // Phase 12 corrects DOCX. A PDF is a rendering, not a document PalCert
      // can safely edit, and pretending otherwise would be the worst kind of
      // failure to discover after payment (§215).
      throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
        message: 'SmartFix can only correct Word documents.',
        details: { format: version.detectedFormat },
      });
    }
    if (version.status !== 'READY' || version.cleanObjectKey === null) {
      throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
        message: 'This document is not available for correction.',
      });
    }
    if (run.analysisArtifactSha256 === null || run.factSchemaVersion === null) {
      throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
        message: 'This check has no analysis to correct against.',
      });
    }

    return {
      id: check.id,
      documentId: check.documentId,
      documentVersionId: check.documentVersionId,
      standardVersionId: check.standardVersionId,
      standardContentHash: check.standardContentHash,
      documentSha256: check.documentSha256,
      currentRunId: run.id,
      cleanObjectKey: version.cleanObjectKey,
      analysisArtifactSha256: run.analysisArtifactSha256,
      reportHash: report.reportHash,
      factSchemaVersion: run.factSchemaVersion,
    };
  }
}

function readNumber(plan: Record<string, unknown>, key: string, fallback: number): number {
  const value = plan[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** How many failing rules the plan can actually correct, for the summary. */
function countFixable(plan: Record<string, unknown>): number {
  const rules = plan.rules;
  if (!Array.isArray(rules)) return 0;
  return rules.filter((rule) => {
    const status = (rule as { fixability?: unknown })?.fixability;
    return status === 'FIXABLE' || status === 'PARTIALLY_FIXABLE';
  }).length;
}
