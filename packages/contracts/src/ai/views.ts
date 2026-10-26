import type {
  Assessment,
  AssessmentReasonCode,
  EvidenceSufficiency,
  PriorityRecommendation,
  UncertaintyReason,
} from './assessment.generated.js';
import type { AIFailureKind, AIReviewStatus } from './review.js';

/**
 * What the AI API returns (§65, §66).
 *
 * Shaped so a UI cannot accidentally present AI output as a verdict: an
 * assessment always travels with `requiresHumanReview` and with the
 * deterministic outcome it sits beside, and there is no field anywhere in
 * which a score or a determination could be carried.
 */

export interface AIRuleAssessmentView {
  readonly id: string;
  readonly ruleCode: string;
  readonly titleEn: string | null;
  readonly titleAr: string | null;
  readonly severity: string;
  readonly blocking: boolean;
  readonly assessment: Assessment;
  readonly reasonCode: AssessmentReasonCode;
  readonly evidenceSufficiency: EvidenceSufficiency;
  readonly uncertaintyReasons: readonly UncertaintyReason[];
  readonly evidenceNodeIds: readonly string[];
  readonly explanationEn: string;
  readonly explanationAr: string;
  /** Always true for a blocking rule, whatever the model concluded (§26). */
  readonly requiresHumanReview: boolean;
  /** The Phase 7 machine outcome, carried so the two are never confused (§66). */
  readonly deterministicOutcome: string | null;
}

export interface AIReportSupplementView {
  readonly summaryEn: string;
  readonly summaryAr: string;
  readonly priorityRecommendations: readonly PriorityRecommendation[];
}

export interface AIReviewUsageView {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly invocationCount: number;
}

export interface AIReviewView {
  readonly id: string;
  readonly checkId: string;
  readonly status: AIReviewStatus;
  readonly failureKind: AIFailureKind | null;
  /** Identity, so an old review stays explicable after everything moved on (§11). */
  readonly provider: string;
  readonly configuredModel: string;
  readonly providerReturnedModel: string | null;
  readonly promptVersion: string;
  readonly contextBuilderVersion: string;
  readonly aiReviewSchemaVersion: number;
  readonly aiReviewHash: string | null;
  readonly assessmentCount: number;
  readonly humanReviewRequiredCount: number;
  readonly insufficientEvidenceCount: number;
  readonly contextTruncated: boolean;
  readonly usage: AIReviewUsageView | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
}

export interface AIConsentView {
  readonly granted: boolean;
  readonly consentVersion: string | null;
  readonly consentedAt: string | null;
  readonly providerCategory: string | null;
  /** True when a newer consent version exists than the one on record. */
  readonly renewalRequired: boolean;
}
