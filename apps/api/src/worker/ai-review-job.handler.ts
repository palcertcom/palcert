import { Injectable } from '@nestjs/common';
import {
  AI_ASSESSMENT_SCHEMA_VERSION,
  AI_REVIEW_CANONICALIZATION_VERSION,
  AI_REVIEW_SCHEMA_VERSION,
  AIFailureKind,
  AIInvocationPurpose,
  AIOperation,
  AIInvocationStatus,
  AIProviderError,
  AIProviderPort,
  AIReviewStatus,
  AppError,
  PalCertErrorCode,
  PurchaseFailureCode,
  computeAIReviewHash,
  computeContextHash,
  computeRulesHash,
  isRetryableAIFailure,
  requiresHumanReview,
  validateAnalysisArtifact,
  type AIContextBundle,
  type AIReportSupplementResponse,
  type AIRuleAssessmentResponse,
  type ContextRule,
  type DeterministicFinding,
} from '@palcert/contracts';
import type { AIReview, ProcessingJob } from '@palcert/database';
import { createHash } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../config/api-config.service';
import { PromptId, promptTemplate } from '../infrastructure/ai/prompt-registry';
import {
  buildReportSupplementPrompt,
  buildRuleAssessmentPrompt,
} from '../infrastructure/ai/prompt-builder';
import { ObjectStoragePort } from '../infrastructure/storage/object-storage.port';
import { TenantPrismaService } from '../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../modules/auth/ports/clock.port';
import { SecurityEventService } from '../modules/auth/services/security-event.service';
import { AIContextBuilder } from '../modules/ai/services/ai-context-builder.service';
import { AIOutputValidator } from '../modules/ai/services/ai-output-validator.service';
import { AIServiceBillingService } from '../modules/finance/services/ai-service-billing.service';
import { requireJobOwner } from './job-owner';

/**
 * Running one AI review (§34, §47, §50, §56, §59, §85).
 *
 * The order of steps is the design, and every one of them exists to keep a
 * model's opinion from acquiring authority it has not earned:
 *
 * 1. **Claim** the review atomically. A duplicate delivery is a no-op (§59).
 * 2. **Re-verify the Phase 7 evidence.** The report hash, the analysis digest
 *    and the document digest must still be what the review bound itself to. AI
 *    advice about evidence that has changed underneath it would be advice
 *    about nothing (§85).
 * 3. **Build the bounded context.** Only the AI-assisted rules, only the nodes
 *    those rules need, only within the configured budgets (§15, §49).
 * 4. **Count tokens** and refuse rather than truncate silently (§50).
 * 5. **Call the provider**, in deterministic batches, recording every attempt
 *    in the invocation ledger before it is made (§47, §51).
 * 6. **Validate** the output independently — rule set, node ids, duplicates —
 *    and reject the whole response if any of it was fabricated (§34).
 * 7. **Persist once**, with `requiresHumanReview` forced true for every
 *    blocking rule, and hash the result (§26, §46).
 *
 * Nothing in this file writes to a Phase 7 table. That is the guarantee the
 * whole phase rests on, and it is enforced by the fact that there is no code
 * path here that could.
 */
@Injectable()
export class AIReviewJobHandler {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly storage: ObjectStoragePort,
    private readonly provider: AIProviderPort,
    private readonly contextBuilder: AIContextBuilder,
    private readonly validator: AIOutputValidator,
    private readonly events: SecurityEventService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
    private readonly billing: AIServiceBillingService,
  ) {
    this.logger.setContext(AIReviewJobHandler.name);
  }

  async handle(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    if (owner === null) throw new Error(`AI review job ${job.id} has no owner`);

    const review = await this.claim(owner, job.resourceId);
    if (review === null) return;

    // ADR-0149: every attempt — the first and every retry — re-checks that the
    // fee is still reserved before anything reaches the provider. A lapsed or
    // released reservation fails the review here; the provider is not called
    // and nothing is charged.
    if (!(await this.reservationLive(owner, review))) {
      await this.fail(owner, review, {
        kind: AIFailureKind.RESERVATION_EXPIRED,
        detail: 'the AI service reservation is no longer active',
      });
      return;
    }

    try {
      await this.run(owner, review);
    } catch (error) {
      const failure = classify(error);
      // A transient provider condition is rethrown so the ledger spends an
      // attempt and backs off. Everything else is permanent: a bad credential,
      // a malformed response or a policy refusal will fail identically for
      // ever, and retrying them reaches the same answer more slowly (§56).
      if (isRetryableAIFailure(failure.kind)) {
        await this.recordTransient(owner, review, failure);
        throw error;
      }
      await this.fail(owner, review, failure);
    }
  }

  /** The last attempt has been spent: the review is failed for good. */
  async failPermanently(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    if (owner === null) return;
    const review = await this.tenant.withUser(owner, (tx) =>
      tx.aIReview.findUnique({ where: { id: job.resourceId } }),
    );
    if (review === null || review.status !== AIReviewStatus.RUNNING) return;
    await this.fail(owner, review, {
      kind: (review.failureKind as AIFailureKind | null) ?? AIFailureKind.UNKNOWN_PROVIDER_ERROR,
      detail: 'attempts exhausted',
    });
  }

  private async claim(owner: string, reviewId: string): Promise<AIReview | null> {
    const now = this.clock.now();
    return this.tenant.withUser(owner, async (tx) => {
      const updated = await tx.aIReview.updateMany({
        where: {
          id: reviewId,
          status: { in: [AIReviewStatus.CREATED, AIReviewStatus.QUEUED, AIReviewStatus.RUNNING] },
        },
        data: { status: AIReviewStatus.RUNNING, startedAt: now },
      });
      if (updated.count !== 1) return null;
      return tx.aIReview.findUniqueOrThrow({ where: { id: reviewId } });
    });
  }

  private async run(owner: string, review: AIReview): Promise<void> {
    const evidence = await this.loadEvidence(owner, review);
    const context = this.contextBuilder.build({
      purpose: 'RULE_ASSESSMENT',
      artifact: evidence.artifact,
      rules: evidence.rules,
      deterministicFindings: evidence.findings,
      metadata: evidence.metadata,
    });

    const contextHash = computeContextHash(context);
    const rulesHash = computeRulesHash(context.rules);

    // Batching is deterministic: rules in code order, in fixed-size groups.
    // One call per rule wastes a shared context; one call for every semantic
    // rule in a thesis produces a request nobody can reason about (§51).
    const batches = batch(evidence.rules, this.config.ai.maxRulesPerRequest);
    const assessments: AIRuleAssessmentResponse['assessments'][number][] = [];
    const usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    // A queue retry runs this again; numbering continues after the attempts
    // already recorded, so every invocation keeps its own row (§60).
    let attempt = await this.attemptsSoFar(owner, review.id);
    let providerReturnedModel: string | null = null;

    for (const group of batches) {
      attempt += 1;
      const template = promptTemplate(PromptId.AI_RULE_ASSESSMENT);
      const groupContext: AIContextBundle = { ...context, rules: [...group] };
      const requestedRuleCodes = group.map((rule) => rule.ruleCode);
      const userPrompt = buildRuleAssessmentPrompt(groupContext, requestedRuleCodes);

      await this.assertWithinBudget(template.system, userPrompt);

      const invocationId = await this.beginInvocation(owner, review, {
        purpose: AIInvocationPurpose.RULE_ASSESSMENT,
        attempt,
        contextHash,
        rulesHash,
        promptVersion: template.version,
        promptHash: template.hash,
      });

      try {
        const response = await this.provider.assessRules({
          reviewId: review.id,
          context: groupContext,
          systemPrompt: template.system,
          userPrompt,
          requestedRuleCodes,
        });

        // Validated again here, against what PalCert actually supplied — the
        // provider's own schema enforcement is one layer, not the last (§34).
        const validated = this.validator.validateAssessments({
          response: response.output,
          requestedRuleCodes,
          context: groupContext,
        });

        assessments.push(...validated.assessments);
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        usage.cacheRead += response.usage.cacheReadTokens ?? 0;
        usage.cacheWrite += response.usage.cacheWriteTokens ?? 0;
        providerReturnedModel = response.usage.providerReturnedModel ?? providerReturnedModel;

        await this.settleInvocation(owner, invocationId, {
          status: AIInvocationStatus.SUCCEEDED,
          usage: response.usage,
        });
      } catch (error) {
        const failure = classify(error);
        await this.settleInvocation(owner, invocationId, {
          status: AIInvocationStatus.FAILED,
          failure,
        });
        throw error;
      }
    }

    const supplement = await this.generateSupplement(owner, review, {
      determination: evidence.determination,
      findings: evidence.findings,
      assessments,
      rules: evidence.rules,
      standardName: evidence.standardName,
      organizationName: evidence.organizationName,
      attempt: attempt + 1,
      contextHash,
      rulesHash,
      usage,
    });

    await this.persist(owner, review, {
      context,
      contextHash,
      rulesHash,
      assessments,
      supplement,
      usage,
      providerReturnedModel,
      rules: evidence.rules,
      deterministicOutcomes: evidence.outcomes,
    });
  }

  /**
   * The narrative, generated from results rather than from the document (§40).
   *
   * A failure here does not fail the review: the assessments are the valuable
   * part, and losing them because a summary could not be written would be the
   * wrong trade.
   */
  private async generateSupplement(
    owner: string,
    review: AIReview,
    params: {
      determination: string;
      findings: readonly DeterministicFinding[];
      assessments: readonly AIRuleAssessmentResponse['assessments'][number][];
      rules: readonly ContextRule[];
      standardName: string;
      organizationName: string;
      attempt: number;
      contextHash: string;
      rulesHash: string;
      usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number };
    },
  ): Promise<AIReportSupplementResponse | null> {
    const template = promptTemplate(PromptId.AI_REPORT_SUPPLEMENT);
    const byCode = new Map(params.rules.map((rule) => [rule.ruleCode, rule]));
    const userPrompt = buildReportSupplementPrompt({
      determination: params.determination,
      findings: params.findings,
      assessments: params.assessments.map((assessment) => ({
        ruleCode: assessment.ruleCode,
        assessment: assessment.assessment,
        reasonCode: assessment.reasonCode,
        explanationEn: assessment.explanationEn,
        requiresHumanReview: requiresHumanReview(
          { blocking: byCode.get(assessment.ruleCode)?.blocking ?? false },
          assessment.assessment,
        ),
      })),
      standardName: params.standardName,
      organizationName: params.organizationName,
    });

    const invocationId = await this.beginInvocation(owner, review, {
      purpose: AIInvocationPurpose.REPORT_SUPPLEMENT,
      attempt: params.attempt,
      contextHash: params.contextHash,
      rulesHash: params.rulesHash,
      promptVersion: template.version,
      promptHash: template.hash,
    });

    try {
      const response = await this.provider.generateReportSupplement({
        reviewId: review.id,
        systemPrompt: template.system,
        userPrompt,
      });
      this.validator.validateSupplement(response.output);

      params.usage.inputTokens += response.usage.inputTokens;
      params.usage.outputTokens += response.usage.outputTokens;
      params.usage.cacheRead += response.usage.cacheReadTokens ?? 0;
      params.usage.cacheWrite += response.usage.cacheWriteTokens ?? 0;

      await this.settleInvocation(owner, invocationId, {
        status: AIInvocationStatus.SUCCEEDED,
        usage: response.usage,
      });
      return response.output;
    } catch (error) {
      const failure = classify(error);
      await this.settleInvocation(owner, invocationId, {
        status: AIInvocationStatus.FAILED,
        failure,
      });
      this.logger.warn(
        { reviewId: review.id, failureKind: failure.kind },
        'AI supplement could not be generated; the assessments stand',
      );
      return null;
    }
  }

  /**
   * Persist the whole review in one transaction (§45, §46).
   *
   * `requiresHumanReview` is computed here, from the rule's own blocking flag,
   * and not taken from the model. That is the single most important line in
   * Phase 8: a provider cannot decide that a blocking requirement no longer
   * needs a person, because it is never asked (§26).
   */
  private async persist(
    owner: string,
    review: AIReview,
    result: {
      context: AIContextBundle;
      contextHash: string;
      rulesHash: string;
      assessments: readonly AIRuleAssessmentResponse['assessments'][number][];
      supplement: AIReportSupplementResponse | null;
      usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number };
      providerReturnedModel: string | null;
      rules: readonly ContextRule[];
      deterministicOutcomes: ReadonlyMap<string, string>;
    },
  ): Promise<void> {
    const byCode = new Map(result.rules.map((rule) => [rule.ruleCode, rule]));
    const rows = result.assessments.map((assessment) => {
      const rule = byCode.get(assessment.ruleCode);
      const blocking = rule?.blocking ?? false;
      return {
        ruleCode: assessment.ruleCode,
        severity: rule?.severity ?? 'MINOR',
        blocking,
        assessment: assessment.assessment,
        reasonCode: assessment.reasonCode,
        evidenceSufficiency: assessment.evidenceSufficiency,
        uncertaintyReasons: [...(assessment.uncertaintyReasons ?? [])],
        evidenceNodeIds: [...assessment.evidenceNodeIds],
        explanationEn: assessment.explanationEn,
        explanationAr: assessment.explanationAr,
        requiresHumanReview: requiresHumanReview({ blocking }, assessment.assessment),
        deterministicOutcome: result.deterministicOutcomes.get(assessment.ruleCode) ?? null,
      };
    });

    const digest = {
      aiReviewSchemaVersion: AI_REVIEW_SCHEMA_VERSION,
      aiReviewCanonicalizationVersion: AI_REVIEW_CANONICALIZATION_VERSION,
      provider: review.provider,
      configuredModel: review.configuredModel,
      ...(result.providerReturnedModel !== null
        ? { providerReturnedModel: result.providerReturnedModel }
        : {}),
      promptVersion: review.promptVersion,
      promptHash: review.promptHash,
      contextBuilderVersion: review.contextBuilderVersion,
      contextHash: result.contextHash,
      rulesHash: result.rulesHash,
      boundReportHash: review.reportHash,
      boundEvaluationHash: review.evaluationHash,
      assessments: rows.map((row) => ({
        ruleCode: row.ruleCode,
        assessment: row.assessment,
        reasonCode: row.reasonCode,
        evidenceSufficiency: row.evidenceSufficiency,
        evidenceNodeIds: row.evidenceNodeIds,
        requiresHumanReview: row.requiresHumanReview,
      })),
      ...(result.supplement !== null ? { supplement: result.supplement } : {}),
    };
    const { hash } = computeAIReviewHash(digest as Parameters<typeof computeAIReviewHash>[0]);

    const now = this.clock.now();
    let captured = false;
    await this.tenant.withUser(owner, async (tx) => {
      for (const row of rows) {
        await tx.aIRuleAssessment.create({
          data: { ownerUserId: owner, aiReviewId: review.id, ...row },
        });
      }

      if (result.supplement !== null) {
        await tx.aIReportSupplement.create({
          data: {
            ownerUserId: owner,
            aiReviewId: review.id,
            schemaVersion: result.supplement.schemaVersion,
            summaryEn: result.supplement.summaryEn,
            summaryAr: result.supplement.summaryAr,
            // Stored as validated structured JSON. Prisma's JSON input type
            // does not accept a readonly tuple, and the value has already
            // passed the shared contract, so the cast is safe here.
            priorityRecommendations: result.supplement
              .priorityRecommendations as unknown as object[],
          },
        });
      }

      await tx.aIReview.updateMany({
        where: { id: review.id, status: AIReviewStatus.RUNNING },
        data: {
          status: AIReviewStatus.COMPLETED,
          providerReturnedModel: result.providerReturnedModel,
          contextHash: result.contextHash,
          rulesHash: result.rulesHash,
          aiReviewHash: hash,
          assessmentCount: rows.length,
          humanReviewRequiredCount: rows.filter((row) => row.requiresHumanReview).length,
          insufficientEvidenceCount: rows.filter(
            (row) => row.assessment === 'INSUFFICIENT_EVIDENCE',
          ).length,
          contextTruncated: result.context.truncation.truncated,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheRead,
          cacheWriteTokens: result.usage.cacheWrite,
          completedAt: now,
          failureKind: null,
          failureDetail: null,
        },
      });

      // ADR-0149: COMPLETED is delivery, so it is charged — in this same
      // transaction, exactly once. A redelivered job finds the purchase
      // already DELIVERED and charges nothing; a reservation that lapsed
      // throws and the completion rolls back with it. Billing follows the
      // status, never what the assessments say.
      if (review.servicePurchaseId !== null) {
        captured = (await this.billing.capture(tx, review.servicePurchaseId)).charged;
      }
    });
    if (captured && review.servicePurchaseId !== null) {
      await this.billing.audit({
        action: 'AI_SERVICE_CAPTURED',
        operation: AIOperation.AI_REVIEW,
        purchaseId: review.servicePurchaseId,
        resourceId: review.id,
        payerUserId: owner,
        actorUserId: null,
      });
    }

    await this.events.audit({
      action: 'AI_REVIEW_COMPLETED',
      actorUserId: null,
      targetType: 'AIReview',
      targetId: review.id,
      // Counters and identity only. Never an explanation, never a summary,
      // never a prompt (§103).
      afterState: {
        assessmentCount: rows.length,
        humanReviewRequiredCount: rows.filter((row) => row.requiresHumanReview).length,
        aiReviewHash: hash,
        provider: review.provider,
      },
    });

    this.logger.info(
      {
        reviewId: review.id,
        provider: review.provider,
        assessmentCount: rows.length,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
      'AI review completed',
    );
  }

  /**
   * Re-verify everything the review bound itself to (§85).
   *
   * The artifact is read by its exact object version and hashed; the standard
   * snapshot and the document digest are compared to what the review captured.
   * Advice built on evidence that has moved is advice about nothing.
   */
  private async loadEvidence(owner: string, review: AIReview) {
    const rows = await this.tenant.withUser(owner, async (tx) => {
      const check = await tx.documentCheck.findUniqueOrThrow({ where: { id: review.checkId } });
      const report = await tx.checkReport.findUniqueOrThrow({ where: { id: review.reportId } });
      const analysis = await tx.documentAnalysis.findUniqueOrThrow({
        where: { id: review.analysisId },
      });
      const results = await tx.checkRuleResult.findMany({
        where: { checkRunId: review.checkRunId },
      });
      const run = await tx.checkRun.findUniqueOrThrow({ where: { id: review.checkRunId } });
      return { check, report, analysis, results, run };
    });

    if (
      rows.report.reportHash !== review.reportHash ||
      rows.check.documentSha256 !== review.documentSha256 ||
      rows.check.standardContentHash !== review.standardContentHash ||
      rows.analysis.artifactSha256 !== review.analysisArtifactSha256
    ) {
      throw new AIProviderError(
        AIFailureKind.INVALID_REQUEST,
        'the evidence this review was bound to no longer matches',
      );
    }
    if (rows.analysis.artifactObjectKey === null) {
      throw new AIProviderError(
        AIFailureKind.INVALID_REQUEST,
        'the analysis artifact is no longer available',
      );
    }

    const bytes = await this.storage.getObjectBytes({
      zone: 'derived',
      key: rows.analysis.artifactObjectKey,
      versionId: rows.analysis.artifactObjectVersionId,
    });
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== review.analysisArtifactSha256) {
      throw new AIProviderError(
        AIFailureKind.INVALID_REQUEST,
        'the stored analysis artifact does not match its recorded digest',
      );
    }

    const artifact = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    const contract = validateAnalysisArtifact(artifact);
    if (!contract.valid) {
      throw new AIProviderError(
        AIFailureKind.INVALID_REQUEST,
        'the analysis artifact does not satisfy the shared contract',
      );
    }

    // Only AI-assisted rules. A MANUAL rule stays manual: sending it to a
    // model would be treating an AI opinion as equivalent to human review,
    // which is exactly the claim PalCert refuses to make (§23).
    const assessable = rows.results.filter((result) => result.evaluationMode === 'AI_ASSISTED');

    return {
      artifact: artifact as { structuralModel?: { paragraphs?: [] } },
      rules: assessable.map<ContextRule>((result) => ({
        ruleCode: result.ruleCode,
        category: result.category,
        severity: result.severity as ContextRule['severity'],
        blocking: result.blocking,
        ...(result.titleEn !== null ? { titleEn: result.titleEn } : {}),
        ...(result.titleAr !== null ? { titleAr: result.titleAr } : {}),
        ...(result.guidanceEn !== null ? { guidanceEn: result.guidanceEn } : {}),
        ...(result.guidanceAr !== null ? { guidanceAr: result.guidanceAr } : {}),
      })),
      findings: rows.results.map<DeterministicFinding>((result) => ({
        ruleCode: result.ruleCode,
        outcome: result.outcome as DeterministicFinding['outcome'],
        reasonCode: result.reasonCode,
        severity: result.severity as DeterministicFinding['severity'],
        blocking: result.blocking,
        ...(result.titleEn !== null ? { titleEn: result.titleEn } : {}),
        ...(result.titleAr !== null ? { titleAr: result.titleAr } : {}),
        violationCount: result.totalViolationCount,
      })),
      outcomes: new Map(rows.results.map((result) => [result.ruleCode, result.outcome])),
      determination: rows.run.determination ?? 'INDETERMINATE',
      standardName: rows.check.standardName,
      organizationName: rows.check.organizationName,
      metadata: {},
    };
  }

  /**
   * Refuse rather than silently drop context (§50).
   *
   * A request that does not fit the budget is not quietly shortened: the model
   * would then answer confidently about material nobody sent it.
   */
  private async assertWithinBudget(systemPrompt: string, userPrompt: string): Promise<void> {
    const capabilities = this.provider.getCapabilities();
    if (!capabilities.supportsTokenCounting) return;

    const counted = await this.provider.countTokens({
      purpose: AIInvocationPurpose.RULE_ASSESSMENT,
      systemPrompt,
      userPrompt,
    });
    if (counted.inputTokens > this.config.ai.maxInputTokens) {
      throw new AIProviderError(
        AIFailureKind.CONTEXT_TOO_LARGE,
        'the required evidence exceeds the configured input budget',
      );
    }
  }

  /** Record the attempt *before* it is made, so a lost response leaves a trace (§60). */
  private async beginInvocation(
    owner: string,
    review: AIReview,
    params: {
      purpose: AIInvocationPurpose;
      attempt: number;
      contextHash: string;
      rulesHash: string;
      promptVersion: string;
      promptHash: string;
    },
  ): Promise<string> {
    const row = await this.tenant.withUser(owner, (tx) =>
      tx.aIInvocation.create({
        data: {
          ownerUserId: owner,
          aiReviewId: review.id,
          provider: review.provider,
          purpose: params.purpose,
          configuredModel: review.configuredModel,
          promptVersion: params.promptVersion,
          promptHash: params.promptHash,
          contextBuilderVersion: review.contextBuilderVersion,
          contextHash: params.contextHash,
          rulesHash: params.rulesHash,
          status: AIInvocationStatus.PENDING,
          attempt: params.attempt,
          startedAt: this.clock.now(),
        },
      }),
    );
    return row.id;
  }

  private async settleInvocation(
    owner: string,
    invocationId: string,
    outcome:
      | {
          status: 'SUCCEEDED';
          usage: {
            providerRequestId: string | null;
            providerReturnedModel: string | null;
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number | null;
            cacheWriteTokens: number | null;
            latencyMs: number;
          };
        }
      | { status: 'FAILED'; failure: { kind: AIFailureKind; detail: string } },
  ): Promise<void> {
    const now = this.clock.now();
    await this.tenant.withUser(owner, (tx) =>
      tx.aIInvocation.updateMany({
        where: { id: invocationId, status: AIInvocationStatus.PENDING },
        data:
          outcome.status === 'SUCCEEDED'
            ? {
                status: AIInvocationStatus.SUCCEEDED,
                providerRequestId: outcome.usage.providerRequestId,
                providerReturnedModel: outcome.usage.providerReturnedModel,
                inputTokens: outcome.usage.inputTokens,
                outputTokens: outcome.usage.outputTokens,
                cacheReadTokens: outcome.usage.cacheReadTokens,
                cacheWriteTokens: outcome.usage.cacheWriteTokens,
                latencyMs: outcome.usage.latencyMs,
                completedAt: now,
              }
            : {
                status: AIInvocationStatus.FAILED,
                failureKind: outcome.failure.kind,
                failureDetail: outcome.failure.detail.slice(0, 500),
                completedAt: now,
              },
      }),
    );
  }

  private async fail(
    owner: string,
    review: AIReview,
    failure: { kind: AIFailureKind; detail: string },
  ): Promise<void> {
    const now = this.clock.now();
    // ADR-0149: FAILED is never charged. The reservation goes back in the same
    // transaction that records the failure — provider error, timeout, invalid
    // output, budget, exhausted retries, or a lapsed reservation alike.
    const released = await this.tenant.withUser(owner, async (tx) => {
      const updated = await tx.aIReview.updateMany({
        where: {
          id: review.id,
          status: { in: [AIReviewStatus.QUEUED, AIReviewStatus.RUNNING] },
        },
        data: {
          status: AIReviewStatus.FAILED,
          failureKind: failure.kind,
          failureDetail: failure.detail.slice(0, 500),
          failedAt: now,
        },
      });
      if (updated.count !== 1 || review.servicePurchaseId === null) return false;
      const failureCode =
        failure.kind === AIFailureKind.RESERVATION_EXPIRED
          ? PurchaseFailureCode.RESERVATION_EXPIRED
          : PurchaseFailureCode.SERVICE_FAILED;
      return (await this.billing.release(tx, review.servicePurchaseId, failureCode)).released;
    });
    if (released && review.servicePurchaseId !== null) {
      await this.billing.audit({
        action: 'AI_SERVICE_RELEASED',
        operation: AIOperation.AI_REVIEW,
        purchaseId: review.servicePurchaseId,
        resourceId: review.id,
        payerUserId: owner,
        actorUserId: null,
        failureCode: failure.kind,
      });
    }

    await this.events.audit({
      action: 'AI_REVIEW_FAILED',
      actorUserId: null,
      targetType: 'AIReview',
      targetId: review.id,
      afterState: { failureKind: failure.kind },
    });
  }

  /**
   * Whether the review's fee is still reserved, and mark the purchase as
   * processing if so. Reviews created before AI billing have no purchase and
   * run as they always did — they are history, never billed.
   */
  private async reservationLive(owner: string, review: AIReview): Promise<boolean> {
    if (review.servicePurchaseId === null) return true;
    const purchaseId = review.servicePurchaseId;
    try {
      await this.tenant.withUser(owner, async (tx) => {
        await this.billing.assertReservationLive(tx, purchaseId);
        await this.billing.markProcessing(tx, purchaseId);
      });
      return true;
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === PalCertErrorCode.SERVICE_RESERVATION_EXPIRED
      ) {
        return false;
      }
      throw error;
    }
  }

  /** The highest attempt number already recorded for this review, or 0. */
  private async attemptsSoFar(owner: string, reviewId: string): Promise<number> {
    const latest = await this.tenant.withUser(owner, (tx) =>
      tx.aIInvocation.aggregate({ where: { aiReviewId: reviewId }, _max: { attempt: true } }),
    );
    return latest._max.attempt ?? 0;
  }

  /** Remember why an attempt failed without ending the review. */
  private async recordTransient(
    owner: string,
    review: AIReview,
    failure: { kind: AIFailureKind; detail: string },
  ): Promise<void> {
    await this.tenant.withUser(owner, (tx) =>
      tx.aIReview.updateMany({
        where: { id: review.id, status: AIReviewStatus.RUNNING },
        data: { failureKind: failure.kind, failureDetail: failure.detail.slice(0, 500) },
      }),
    );
  }
}

/** Deterministic grouping, so the same review batches the same way (§51). */
function batch<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

/**
 * Give every error a kind, defaulting to unknown-and-permanent.
 *
 * Unknown is deliberately *not* retried here: an unrecognized failure repeated
 * five times is five provider calls over someone's document for the same
 * answer (§56, §60).
 */
function classify(error: unknown): { kind: AIFailureKind; detail: string } {
  if (error instanceof AIProviderError) {
    return { kind: error.kind, detail: error.message };
  }
  // ADR-0149: the reservation lapsed before the completion could be charged.
  // The review fails and the remaining reservation is released — never a
  // delivery the customer was not charged for, never a retry on lapsed credit.
  if (error instanceof AppError && error.code === PalCertErrorCode.SERVICE_RESERVATION_EXPIRED) {
    return { kind: AIFailureKind.RESERVATION_EXPIRED, detail: error.message };
  }
  return {
    kind: AIFailureKind.UNKNOWN_PROVIDER_ERROR,
    detail: error instanceof Error ? error.message.slice(0, 200) : 'unexpected AI failure',
  };
}

/** The assessment schema version this release writes. */
export const AI_REVIEW_ASSESSMENT_SCHEMA_VERSION = AI_ASSESSMENT_SCHEMA_VERSION;
