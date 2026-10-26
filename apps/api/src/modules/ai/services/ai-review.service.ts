import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AI_ASSESSMENT_SCHEMA_VERSION,
  AI_CONTEXT_SCHEMA_VERSION,
  AI_REVIEW_CANONICALIZATION_VERSION,
  AI_REVIEW_SCHEMA_VERSION,
  AIOperation,
  AIProviderPort,
  AIReviewStatus,
  AppError,
  CheckStatus,
  PalCertErrorCode,
  ProcessingJobType,
  PurchaseFailureCode,
  isAIReviewCancellable,
  type AIReviewView,
} from '@palcert/contracts';
import type { AIReview } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import { promptTemplate, PromptId } from '../../../infrastructure/ai/prompt-registry';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { RequestContext } from '../../documents/services/document.service';
import { AIServiceBillingService } from '../../finance/services/ai-service-billing.service';
import { AIConsentService } from './ai-consent.service';

export interface CreateAIReviewInput {
  readonly checkId: string;
  /** ADR-0149: the AI_REVIEW quote that pays for it. Required; there is no free path. */
  readonly priceQuoteId: string;
  readonly idempotencyKey?: string;
}

/**
 * Creating and driving AI reviews (§10, §12, §84, §85).
 *
 * Creation is where an AI review binds itself to evidence. After it, the
 * review means one thing for ever: this document version's bytes, this
 * standard version's rules, this analysis artifact, this report. A user who
 * wants a review of something else creates another review.
 *
 * Nothing here calls a provider. Creation checks that AI is available and
 * consented to, that the check actually completed, that there is something for
 * an AI to assess, and that the Phase 7 evidence still verifies — then hands
 * the work to the Phase 5 outbox, because a provider call is not something to
 * do inside an HTTP request.
 */
@Injectable()
export class AIReviewService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly consent: AIConsentService,
    private readonly provider: AIProviderPort,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly events: SecurityEventService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
    private readonly billing: AIServiceBillingService,
  ) {
    this.logger.setContext(AIReviewService.name);
  }

  async create(
    userId: string,
    input: CreateAIReviewInput,
    request: RequestContext,
  ): Promise<AIReview> {
    this.assertEnabled();
    await this.consent.assertGranted(userId);

    // A browser retry must not start a second provider call; two deliberate
    // reviews — a different model, a later prompt — are legitimate and are not
    // deduplicated (§11, §59).
    if (input.idempotencyKey !== undefined) {
      const existing = await this.tenant.withUser(userId, (tx) =>
        tx.aIReview.findFirst({
          where: { ownerUserId: userId, idempotencyKey: input.idempotencyKey },
        }),
      );
      if (existing !== null) {
        if (existing.checkId !== input.checkId) {
          throw new AppError(PalCertErrorCode.IDEMPOTENCY_KEY_REUSED, {
            message: 'That idempotency key was already used for a different review.',
          });
        }
        return existing;
      }
    }

    // ADR-0149: one quote funds one review. Repeating the same confirmation —
    // a browser retry without an Idempotency-Key — returns the review that
    // quote already paid for, instead of reserving or calling AI again.
    const funded = await this.tenant.withUser(userId, (tx) =>
      this.billing.purchaseFundedBy(tx, userId, AIOperation.AI_REVIEW, input.priceQuoteId),
    );
    if (funded !== null) {
      const existing = await this.byId(userId, funded.resourceId);
      if (existing.checkId !== input.checkId) {
        throw new AppError(PalCertErrorCode.QUOTE_ALREADY_USED, {
          message: 'That price quote has already been used. Please ask for a new one.',
        });
      }
      return existing;
    }

    // Eligibility first — consent above, evidence here — so no money is
    // reserved for a request that was going to be refused anyway.
    const bindings = await this.loadBindings(userId, input.checkId);
    const capabilities = this.provider.getCapabilities();
    const template = promptTemplate(PromptId.AI_RULE_ASSESSMENT);
    const reviewId = randomUUID();
    const purchaseId = randomUUID();

    const created = await this.tenant
      .withUser(userId, async (tx) => {
        // The payer is the caller, always: the request cannot name anyone else,
        // and no role or permission waives the fee. A shortfall throws here and
        // the whole transaction — purchase, review, job — never happened.
        const purchase = await this.billing.reserve(tx, {
          payerUserId: userId,
          operation: AIOperation.AI_REVIEW,
          resourceId: reviewId,
          purchaseId,
          priceQuoteId: input.priceQuoteId,
        });

        const review = await tx.aIReview.create({
          data: {
            id: reviewId,
            servicePurchaseId: purchase.id,
            ownerUserId: userId,
            checkId: bindings.checkId,
            checkRunId: bindings.checkRunId,
            reportId: bindings.reportId,
            // Captured now and verified again before anything is sent. A review
            // that cannot prove which evidence it rests on is not a review (§12).
            reportHash: bindings.reportHash,
            evaluationHash: bindings.evaluationHash,
            documentVersionId: bindings.documentVersionId,
            documentSha256: bindings.documentSha256,
            analysisId: bindings.analysisId,
            analysisArtifactSha256: bindings.analysisArtifactSha256,
            standardVersionId: bindings.standardVersionId,
            standardContentHash: bindings.standardContentHash,
            provider: capabilities.provider,
            configuredModel: capabilities.configuredModel,
            promptVersion: template.version,
            promptHash: template.hash,
            contextBuilderVersion: this.config.ai.provider === 'fake' ? '1' : '1',
            contextSchemaVersion: AI_CONTEXT_SCHEMA_VERSION,
            aiReviewSchemaVersion: AI_REVIEW_SCHEMA_VERSION,
            aiReviewCanonicalizationVersion: AI_REVIEW_CANONICALIZATION_VERSION,
            status: AIReviewStatus.QUEUED,
            idempotencyKey: input.idempotencyKey ?? null,
          },
        });

        // Same transaction as the state it processes: if Redis is down the row
        // is still there and the sweep publishes it later (§58).
        await this.jobs.enqueueInTransaction(tx, {
          type: ProcessingJobType.AI_REVIEW,
          resourceType: 'AI_REVIEW',
          resourceId: review.id,
          ownerUserId: userId,
        });

        return { review, purchase };
      })
      .then(async ({ review, purchase }) => {
        await this.billing.audit({
          action: 'AI_SERVICE_RESERVED',
          operation: AIOperation.AI_REVIEW,
          purchaseId: purchase.id,
          resourceId: review.id,
          payerUserId: userId,
          actorUserId: userId,
          amountMinor: purchase.amountMinor,
          currency: purchase.currency,
          requestId: request.requestId,
          ipAddress: request.ipAddress,
        });
        return review;
      });

    const job = await this.jobs.findByResource(ProcessingJobType.AI_REVIEW, created.id);
    if (job !== null) await this.dispatcher.dispatchNow(job.id);

    await this.events.audit({
      action: 'AI_REVIEW_REQUESTED',
      actorUserId: userId,
      targetType: 'AIReview',
      targetId: created.id,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      // Identity only: never a prompt, never document content (§103).
      afterState: {
        checkId: input.checkId,
        provider: capabilities.provider,
        configuredModel: capabilities.configuredModel,
        promptVersion: template.version,
      },
    });

    return created;
  }

  async cancel(userId: string, reviewId: string, request: RequestContext): Promise<AIReview> {
    const review = await this.byId(userId, reviewId);
    // Only before the work reaches a provider. PalCert does not claim to
    // recall a request already being processed (§106).
    if (!isAIReviewCancellable(review.status as AIReviewStatus)) {
      throw new AppError(PalCertErrorCode.AI_REVIEW_NOT_CANCELLABLE, {
        message: 'This review has already started and cannot be cancelled.',
        details: { status: review.status },
      });
    }

    const now = this.clock.now();
    // Cancelled before any provider work: the reservation goes back in the
    // same transaction, so a cancelled review can never also be a charged one.
    const released = await this.tenant.withUser(userId, async (tx) => {
      const updated = await tx.aIReview.updateMany({
        where: { id: reviewId, status: { in: [AIReviewStatus.CREATED, AIReviewStatus.QUEUED] } },
        data: { status: AIReviewStatus.CANCELLED, failedAt: now },
      });
      if (updated.count !== 1 || review.servicePurchaseId === null) return false;
      const result = await this.billing.release(
        tx,
        review.servicePurchaseId,
        PurchaseFailureCode.CANCELLED_BY_CUSTOMER,
      );
      return result.released;
    });
    if (released && review.servicePurchaseId !== null) {
      await this.billing.audit({
        action: 'AI_SERVICE_RELEASED',
        operation: AIOperation.AI_REVIEW,
        purchaseId: review.servicePurchaseId,
        resourceId: reviewId,
        payerUserId: userId,
        actorUserId: userId,
        failureCode: PurchaseFailureCode.CANCELLED_BY_CUSTOMER,
        requestId: request.requestId,
        ipAddress: request.ipAddress,
      });
    }

    await this.events.audit({
      action: 'AI_REVIEW_CANCELLED',
      actorUserId: userId,
      targetType: 'AIReview',
      targetId: reviewId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
    });

    return this.byId(userId, reviewId);
  }

  async byId(userId: string, reviewId: string): Promise<AIReview> {
    const review = await this.tenant.withUser(userId, (tx) =>
      tx.aIReview.findUnique({ where: { id: reviewId } }),
    );
    if (review === null) {
      // Row-level security already returns nothing for another user's review,
      // so this is the same 404 a stranger gets (ADR-0017).
      throw new AppError(PalCertErrorCode.AI_REVIEW_NOT_FOUND, { message: 'No such AI review.' });
    }
    return review;
  }

  /** A deployment with AI switched off says so plainly and stays usable (§105). */
  assertEnabled(): void {
    if (!this.config.ai.enabled) {
      throw new AppError(PalCertErrorCode.AI_DISABLED, {
        message: 'AI review is not available. Your PalCert technical report is unaffected.',
      });
    }
  }

  /**
   * Everything an AI review binds to, loaded and checked (§84, §85).
   *
   * A review over a check that did not complete, or over evidence that no
   * longer matches what the report recorded, is advice about something PalCert
   * cannot vouch for — so it is refused rather than produced.
   */
  private async loadBindings(userId: string, checkId: string) {
    return this.tenant.withUser(userId, async (tx) => {
      const check = await tx.documentCheck.findUnique({ where: { id: checkId } });
      if (check === null) {
        throw new AppError(PalCertErrorCode.CHECK_NOT_FOUND, { message: 'No such check.' });
      }
      if (check.status !== CheckStatus.COMPLETED) {
        throw new AppError(PalCertErrorCode.AI_REVIEW_CHECK_NOT_COMPLETED, {
          message: 'AI review runs on a completed check.',
          details: { status: check.status },
        });
      }

      const report = await tx.checkReport.findFirst({
        where: { checkId },
        orderBy: { createdAt: 'desc' },
      });
      if (report === null) {
        throw new AppError(PalCertErrorCode.REPORT_NOT_FOUND, {
          message: 'This check has not produced a report.',
        });
      }

      const run = await tx.checkRun.findUniqueOrThrow({ where: { id: report.checkRunId } });
      const analysisId = run.documentAnalysisId ?? check.documentAnalysisId;
      if (analysisId === null) {
        throw new AppError(PalCertErrorCode.AI_EVIDENCE_INTEGRITY_FAILED, {
          message: 'The evidence behind this report is not available.',
        });
      }

      const analysis = await tx.documentAnalysis.findUniqueOrThrow({ where: { id: analysisId } });
      if (analysis.artifactSha256 === null || analysis.artifactPurgedAt !== null) {
        throw new AppError(PalCertErrorCode.AI_EVIDENCE_INTEGRITY_FAILED, {
          message: 'The analysis behind this report is no longer available.',
        });
      }

      // At least one AI-assisted rule, or there is nothing for an AI to do and
      // sending the document would buy the user nothing (§23).
      const assessable = await tx.checkRuleResult.count({
        where: { checkRunId: run.id, evaluationMode: 'AI_ASSISTED' },
      });
      if (assessable === 0) {
        throw new AppError(PalCertErrorCode.AI_REVIEW_NO_ASSESSABLE_RULES, {
          message: 'This standard has no AI-assisted requirements, so there is nothing to review.',
        });
      }

      return {
        checkId: check.id,
        checkRunId: run.id,
        reportId: report.id,
        reportHash: report.reportHash,
        evaluationHash: report.evaluationHash,
        documentVersionId: check.documentVersionId,
        documentSha256: check.documentSha256,
        analysisId: analysis.id,
        analysisArtifactSha256: analysis.artifactSha256,
        standardVersionId: check.standardVersionId,
        standardContentHash: check.standardContentHash,
      };
    });
  }
}

/** The assessment schema version this release produces, for the digest. */
export const CURRENT_ASSESSMENT_SCHEMA_VERSION = AI_ASSESSMENT_SCHEMA_VERSION;

/** The shape a completed review is projected into for the API (§65). */
export function toAIReviewView(review: AIReview, invocationCount: number): AIReviewView {
  return {
    id: review.id,
    checkId: review.checkId,
    status: review.status as AIReviewView['status'],
    failureKind: review.failureKind as AIReviewView['failureKind'],
    provider: review.provider,
    configuredModel: review.configuredModel,
    providerReturnedModel: review.providerReturnedModel,
    promptVersion: review.promptVersion,
    contextBuilderVersion: review.contextBuilderVersion,
    aiReviewSchemaVersion: review.aiReviewSchemaVersion,
    aiReviewHash: review.aiReviewHash,
    assessmentCount: review.assessmentCount ?? 0,
    humanReviewRequiredCount: review.humanReviewRequiredCount ?? 0,
    insufficientEvidenceCount: review.insufficientEvidenceCount ?? 0,
    contextTruncated: review.contextTruncated,
    usage:
      review.inputTokens === null
        ? null
        : {
            inputTokens: review.inputTokens,
            outputTokens: review.outputTokens ?? 0,
            cacheReadTokens: review.cacheReadTokens,
            cacheWriteTokens: review.cacheWriteTokens,
            invocationCount,
          },
    createdAt: review.createdAt.toISOString(),
    startedAt: review.startedAt?.toISOString() ?? null,
    completedAt: review.completedAt?.toISOString() ?? null,
    failedAt: review.failedAt?.toISOString() ?? null,
  };
}
