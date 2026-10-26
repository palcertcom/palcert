import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  type AIReportSupplementView,
  type AIReviewView,
  type AIRuleAssessmentView,
  type PriorityRecommendation,
} from '@palcert/contracts';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { toAIReviewView } from './ai-review.service';

/**
 * Reading AI reviews back (§65, §66, §82).
 *
 * Every query runs under the caller's own row-level security context, so
 * another user's review is not hidden by a `WHERE` clause this code could
 * forget — it is invisible to the connection (ADR-0018).
 *
 * Each assessment is returned beside the deterministic outcome for the same
 * rule, so a client physically cannot render an AI verdict without the machine
 * one next to it.
 */
@Injectable()
export class AIReviewReadService {
  constructor(private readonly tenant: TenantPrismaService) {}

  async list(userId: string, checkId: string): Promise<AIReviewView[]> {
    // The check itself must be visible to the caller first. Row-level security
    // would already return an empty list for someone else's check, but an
    // empty 200 where every other route answers 404 is an inconsistency a
    // client would eventually read meaning into.
    await this.assertCheckVisible(userId, checkId);

    const reviews = await this.tenant.withUser(userId, (tx) =>
      tx.aIReview.findMany({
        where: { checkId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { _count: { select: { invocations: true } } },
      }),
    );
    return reviews.map((review) => toAIReviewView(review, review._count.invocations));
  }

  private async assertCheckVisible(userId: string, checkId: string): Promise<void> {
    const check = await this.tenant.withUser(userId, (tx) =>
      tx.documentCheck.findUnique({ where: { id: checkId }, select: { id: true } }),
    );
    if (check === null) {
      throw new AppError(PalCertErrorCode.CHECK_NOT_FOUND, { message: 'No such check.' });
    }
  }

  async get(userId: string, checkId: string, reviewId: string): Promise<AIReviewView> {
    const review = await this.tenant.withUser(userId, (tx) =>
      tx.aIReview.findFirst({
        where: { id: reviewId, checkId },
        include: { _count: { select: { invocations: true } } },
      }),
    );
    if (review === null) {
      throw new AppError(PalCertErrorCode.AI_REVIEW_NOT_FOUND, { message: 'No such AI review.' });
    }
    return toAIReviewView(review, review._count.invocations);
  }

  async assessments(
    userId: string,
    checkId: string,
    reviewId: string,
  ): Promise<AIRuleAssessmentView[]> {
    await this.get(userId, checkId, reviewId);
    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.aIRuleAssessment.findMany({
        where: { aiReviewId: reviewId },
        orderBy: [{ blocking: 'desc' }, { ruleCode: 'asc' }],
      }),
    );

    return rows.map<AIRuleAssessmentView>((row) => ({
      id: row.id,
      ruleCode: row.ruleCode,
      // Titles come from the deterministic result the assessment sits beside;
      // the AI layer never re-states a standard's own wording.
      titleEn: null,
      titleAr: null,
      severity: row.severity,
      blocking: row.blocking,
      assessment: row.assessment as AIRuleAssessmentView['assessment'],
      reasonCode: row.reasonCode as AIRuleAssessmentView['reasonCode'],
      evidenceSufficiency: row.evidenceSufficiency as AIRuleAssessmentView['evidenceSufficiency'],
      uncertaintyReasons: row.uncertaintyReasons as AIRuleAssessmentView['uncertaintyReasons'],
      evidenceNodeIds: row.evidenceNodeIds,
      explanationEn: row.explanationEn,
      explanationAr: row.explanationAr,
      requiresHumanReview: row.requiresHumanReview,
      deterministicOutcome: row.deterministicOutcome,
    }));
  }

  async supplement(
    userId: string,
    checkId: string,
    reviewId: string,
  ): Promise<AIReportSupplementView> {
    await this.get(userId, checkId, reviewId);
    const row = await this.tenant.withUser(userId, (tx) =>
      tx.aIReportSupplement.findUnique({ where: { aiReviewId: reviewId } }),
    );
    if (row === null) {
      throw new AppError(PalCertErrorCode.AI_REVIEW_NOT_FOUND, {
        message: 'This review has no written summary.',
      });
    }
    return {
      summaryEn: row.summaryEn,
      summaryAr: row.summaryAr,
      priorityRecommendations: row.priorityRecommendations as unknown as PriorityRecommendation[],
    };
  }
}
