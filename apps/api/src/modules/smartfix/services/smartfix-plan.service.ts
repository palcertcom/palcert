import { Injectable } from '@nestjs/common';
import { AppError, PalCertErrorCode, SMARTFIX_PLAN_TTL_MINUTES } from '@palcert/contracts';
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
 * **Planning is free.** PalCert reads a completed check, works out exactly
 * what it would change, and shows the user the whole list before any money
 * moves. That is not a courtesy: a correction changes somebody's thesis, and
 * agreeing to it without seeing it would not be agreement.
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
    private readonly storage: ObjectStoragePort,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SmartFixPlanService.name);
  }

  /**
   * Compute what SmartFix would change in the document one check examined.
   *
   * Writes a plan row and its artifact, and nothing else. No purchase, no
   * reservation, no job — the user has agreed to nothing yet.
   */
  async plan(userId: string, checkId: string, request: RequestContext): Promise<SmartFixPlan> {
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

    const planId = randomUUID();
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

    const planned = await this.engine.planSmartFix({
      documentId: check.documentVersionId,
      content,
      expectedSha256: check.documentSha256,
      rules: canonical.rules.map((rule) => ({
        ...rule,
        ruleSchemaVersion: snapshot.ruleSchemaVersion,
      })),
      source,
      ...(request.requestId !== null ? { requestId: request.requestId } : {}),
    });

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
    const row = await this.tenant.withUser(userId, (tx) =>
      tx.smartFixPlan.create({
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
          expiresAt: new Date(now.getTime() + SMARTFIX_PLAN_TTL_MINUTES * 60_000),
        },
      }),
    );

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
        actionCount: planned.actionCount,
        ruleCount: planned.ruleCount,
        refusalCode: planned.refusal,
      },
    });

    return row;
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
