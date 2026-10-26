import { Injectable } from '@nestjs/common';
import { SmartFixFailureCode, SmartFixRequestStatus } from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { SmartFixPlanService } from './smartfix-plan.service';
import { SmartFixSettlementService } from './smartfix-settlement.service';
import { SmartFixFailure } from './smartfix-execution.service';

/** The verdict on one corrected document. */
export interface ValidationOutcome {
  /** Rules the plan set out to fix that are now satisfied. */
  readonly resolved: readonly string[];
  /** Rules the plan set out to fix that still fail. */
  readonly unresolved: readonly string[];
  /** Rules that passed before the correction and fail after it. */
  readonly regressed: readonly string[];
}

/**
 * `SMARTFIX_FINALIZE`: decide whether a corrected document may be delivered
 * (§100, §101).
 *
 * Two questions, and both must be answered from the *recheck's own report*
 * rather than from the plan's intentions:
 *
 *   1. **Did the correction do what it said it would?** Every rule the plan
 *      marked FIXABLE has to come back satisfied. One that still fails means
 *      the user was promised something they did not get, so nothing is
 *      delivered and nothing is charged.
 *
 *   2. **Did it break anything?** A deterministic rule that passed before and
 *      fails after is a regression. The corrected document is discarded — not
 *      offered with a warning — because a document that trades one failure for
 *      another is not a correction (§101).
 *
 * Only when both answers are clean does the correction become the user's, in
 * the same transaction that charges for it.
 */
@Injectable()
export class SmartFixFinalizeService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly plans: SmartFixPlanService,
    private readonly settlement: SmartFixSettlementService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SmartFixFinalizeService.name);
  }

  async finalize(userId: string, requestId: string): Promise<void> {
    const request = await this.tenant.withUser(userId, (tx) =>
      tx.smartFixRequest.findUnique({
        where: { id: requestId },
        include: { recheck: { select: { id: true, status: true, currentRunId: true } } },
      }),
    );
    if (request === null) {
      this.logger.warn({ requestId }, 'SmartFix request no longer visible; nothing to finalize');
      return;
    }
    if (
      request.status !== SmartFixRequestStatus.RECHECKING &&
      request.status !== SmartFixRequestStatus.VALIDATING
    ) {
      this.logger.info(
        { requestId, status: request.status },
        'SmartFix request is not awaiting validation; duplicate delivery ignored',
      );
      return;
    }

    const recheck = request.recheck;
    if (recheck === null) {
      throw new SmartFixFailure(
        SmartFixFailureCode.RECHECK_FAILED,
        'the correction has no recheck to validate',
      );
    }
    if (recheck.status !== 'COMPLETED') {
      if (recheck.status === 'FAILED' || recheck.status === 'CANCELLED') {
        throw new SmartFixFailure(
          SmartFixFailureCode.RECHECK_FAILED,
          `the recheck ended as ${recheck.status}`,
        );
      }
      // Still running. The completion of the recheck enqueues this job again.
      this.logger.info(
        { requestId, recheckStatus: recheck.status },
        'Recheck has not finished; finalize will run again when it does',
      );
      return;
    }

    await this.settlement.advance(userId, requestId, SmartFixRequestStatus.VALIDATING);

    const outcome = await this.validate(userId, {
      planId: request.planId,
      originalCheckId: request.checkId,
      recheckId: recheck.id,
    });

    if (outcome.regressed.length > 0) {
      throw new SmartFixFailure(
        SmartFixFailureCode.REGRESSION_DETECTED,
        `rules that passed before the correction now fail: ${outcome.regressed.slice(0, 5).join(', ')}`,
      );
    }
    if (outcome.unresolved.length > 0) {
      throw new SmartFixFailure(
        SmartFixFailureCode.TARGETS_NOT_RESOLVED,
        `rules the plan targeted still fail: ${outcome.unresolved.slice(0, 5).join(', ')}`,
      );
    }

    await this.deliver(userId, requestId);

    await this.events.audit({
      action: 'SMARTFIX_DELIVERED',
      actorUserId: null,
      targetType: 'SmartFixRequest',
      targetId: requestId,
      afterState: {
        recheckCheckId: recheck.id,
        resolvedRuleCount: outcome.resolved.length,
      },
    });
  }

  /**
   * Compare the recheck against the original check and the plan.
   *
   * Read from the stored rule results of both runs rather than from either
   * report's rendered form: the results are the evidence, and the report is a
   * presentation of it.
   */
  async validate(
    userId: string,
    params: { planId: string; originalCheckId: string; recheckId: string },
  ): Promise<ValidationOutcome> {
    const { plan } = await this.plans.artifact(userId, params.planId);
    const targeted = new Set(fixableRuleCodes(plan));

    const [before, after] = await Promise.all([
      this.resultsFor(userId, params.originalCheckId),
      this.resultsFor(userId, params.recheckId),
    ]);

    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const code of targeted) {
      const outcome = after.get(code)?.outcome;
      // NOT_APPLICABLE is a legitimate resolution: correcting a paragraph can
      // remove the thing a rule was selecting, and "nothing to judge" is not a
      // failure. INDETERMINATE is not — it means PalCert cannot tell, and the
      // user was promised a fix (§100).
      if (outcome === 'PASS' || outcome === 'NOT_APPLICABLE') resolved.push(code);
      else unresolved.push(code);
    }

    const regressed: string[] = [];
    for (const [code, previous] of before) {
      if (previous.outcome !== 'PASS') continue;
      // Only deterministic rules. An AI-assisted rule's outcome depends on a
      // model's reading, and calling a changed opinion a regression would
      // discard a correct document because a language model changed its mind.
      if (previous.evaluationMode !== 'DETERMINISTIC') continue;
      const now = after.get(code);
      if (now !== undefined && now.outcome === 'FAIL') regressed.push(code);
    }

    return { resolved, unresolved, regressed: regressed.sort() };
  }

  /**
   * Deliver: the corrected version becomes the user's, and only now is the
   * reservation charged (§79).
   *
   * One transaction. The database refuses at COMMIT to let any part of this
   * exist without the rest — a visible correction with an unpaid purchase, a
   * DELIVERED request with a hidden version, a charge with no manifest.
   */
  private async deliver(userId: string, requestId: string): Promise<void> {
    await this.tenant.withUser(userId, async (tx) => {
      await this.settlement.assertDeliverable(tx, requestId);

      const request = await tx.smartFixRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { correctedDocumentVersionId: true },
      });
      if (request.correctedDocumentVersionId === null) {
        throw new SmartFixFailure(
          SmartFixFailureCode.SERVICE_FAILED,
          'the correction produced no document to deliver',
        );
      }

      await tx.smartFixRequest.update({
        where: { id: requestId },
        data: { status: SmartFixRequestStatus.DELIVERED, deliveredAt: this.clock.now() },
      });
      await tx.documentVersion.update({
        where: { id: request.correctedDocumentVersionId },
        data: { visibleToOwner: true },
      });
      await this.settlement.captureOnDelivery(tx, requestId);
    });
  }

  private async resultsFor(
    userId: string,
    checkId: string,
  ): Promise<Map<string, { outcome: string; evaluationMode: string }>> {
    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.checkRuleResult.findMany({
        where: { run: { checkId, status: 'SUCCEEDED' } },
        orderBy: { run: { attemptNumber: 'desc' } },
        select: { ruleCode: true, outcome: true, evaluationMode: true, checkRunId: true },
      }),
    );
    // The most recent successful run wins: an earlier attempt's results are
    // history, not the current verdict.
    const latestRun = rows[0]?.checkRunId;
    const map = new Map<string, { outcome: string; evaluationMode: string }>();
    for (const row of rows) {
      if (row.checkRunId !== latestRun) continue;
      map.set(row.ruleCode, { outcome: row.outcome, evaluationMode: row.evaluationMode });
    }
    return map;
  }
}

/** The rule codes a plan promised to correct. */
function fixableRuleCodes(plan: Record<string, unknown>): readonly string[] {
  const rules = plan.rules;
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((rule) => {
      const status = (rule as { fixability?: unknown })?.fixability;
      return status === 'FIXABLE' || status === 'PARTIALLY_FIXABLE';
    })
    .map((rule) => String((rule as { ruleCode?: unknown })?.ruleCode ?? ''))
    .filter((code) => code.length > 0);
}
