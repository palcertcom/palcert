/**
 * The AI review domain (§10, §13, §24, §45).
 *
 * Phase 8's central claim is that AI output is *supplementary*. Everything in
 * this file exists to make that claim structural rather than a convention
 * somebody could forget: a separate status vocabulary from the deterministic
 * one, a separate assessment vocabulary from PASS/FAIL, and a rule that a
 * blocking AI-assisted requirement still needs a person no matter what the
 * model said.
 */

/**
 * How far the AI job got. Deliberately technical, and deliberately not
 * PASS/FAIL: "the provider timed out" is not a statement about a document
 * (§13).
 */
export const AIReviewStatus = {
  CREATED: 'CREATED',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type AIReviewStatus = (typeof AIReviewStatus)[keyof typeof AIReviewStatus];

export const AI_REVIEW_STATUSES: readonly AIReviewStatus[] = Object.values(AIReviewStatus);

export const AI_REVIEW_TRANSITIONS: Readonly<Record<AIReviewStatus, readonly AIReviewStatus[]>> = {
  CREATED: ['QUEUED', 'FAILED', 'CANCELLED'],
  QUEUED: ['RUNNING', 'FAILED', 'CANCELLED'],
  // Re-entrant: an at-least-once delivery may re-claim a run it already holds.
  RUNNING: ['RUNNING', 'COMPLETED', 'FAILED'],
  // A finished review is history. A different model or prompt is a new review,
  // never a rewrite of this one (§11, §45).
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionAIReview(from: AIReviewStatus, to: AIReviewStatus): boolean {
  return AI_REVIEW_TRANSITIONS[from].includes(to);
}

export const TERMINAL_AI_REVIEW_STATUSES: readonly AIReviewStatus[] = [
  AIReviewStatus.COMPLETED,
  AIReviewStatus.FAILED,
  AIReviewStatus.CANCELLED,
];

export function isAIReviewTerminal(status: AIReviewStatus): boolean {
  return TERMINAL_AI_REVIEW_STATUSES.includes(status);
}

/** A queued review can still be called off; one already at the provider cannot (§106). */
export function isAIReviewCancellable(status: AIReviewStatus): boolean {
  return status === AIReviewStatus.CREATED || status === AIReviewStatus.QUEUED;
}

/** What one provider call was for. Every AI task has a named PalCert purpose (§83). */
export const AIInvocationPurpose = {
  RULE_ASSESSMENT: 'RULE_ASSESSMENT',
  REPORT_SUPPLEMENT: 'REPORT_SUPPLEMENT',
  TOKEN_COUNT: 'TOKEN_COUNT',
} as const;

export type AIInvocationPurpose = (typeof AIInvocationPurpose)[keyof typeof AIInvocationPurpose];

export const AIInvocationStatus = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;

export type AIInvocationStatus = (typeof AIInvocationStatus)[keyof typeof AIInvocationStatus];

/**
 * Provider failures, in PalCert's own vocabulary (§55).
 *
 * Mapped at the adapter boundary so nothing above it ever sees an Anthropic
 * error class, and so the retry policy is written against stable names rather
 * than against whatever a provider called a condition this quarter.
 */
export const AIFailureKind = {
  RATE_LIMITED: 'RATE_LIMITED',
  OVERLOADED: 'OVERLOADED',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  AUTHENTICATION: 'AUTHENTICATION',
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** The model declined. Not a statement about the document (§54). */
  PROVIDER_REFUSAL: 'PROVIDER_REFUSAL',
  /** The payload did not satisfy PalCert's own validation (§34). */
  OUTPUT_INVALID: 'OUTPUT_INVALID',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  /** Budgets exceeded before a call was made (§49, §50). */
  CONTEXT_TOO_LARGE: 'CONTEXT_TOO_LARGE',
  UNKNOWN_PROVIDER_ERROR: 'UNKNOWN_PROVIDER_ERROR',
  /**
   * ADR-0149: the AI fee's reservation lapsed or was released before the
   * provider was called, so the provider was not called. Nothing is charged.
   */
  RESERVATION_EXPIRED: 'RESERVATION_EXPIRED',
} as const;

export type AIFailureKind = (typeof AIFailureKind)[keyof typeof AIFailureKind];

/**
 * Conditions worth another attempt (§56).
 *
 * Everything else is permanent: a bad key, a malformed request or a policy
 * refusal will fail identically for ever, and retrying them burns quota and
 * the user's patience to reach the same answer.
 */
export const RETRYABLE_AI_FAILURES: readonly AIFailureKind[] = [
  AIFailureKind.RATE_LIMITED,
  AIFailureKind.OVERLOADED,
  AIFailureKind.TIMEOUT,
  AIFailureKind.NETWORK,
];

export function isRetryableAIFailure(kind: AIFailureKind): boolean {
  return RETRYABLE_AI_FAILURES.includes(kind);
}

/**
 * Whether an AI assessment still needs a person (§25, §26).
 *
 * The one rule that must never be relaxed: a *blocking* AI-assisted
 * requirement requires human review whatever the model concluded. PalCert can
 * say "this appears satisfied"; it cannot say "this is accepted", and no
 * provider is given that authority.
 */
export function requiresHumanReview(rule: { blocking: boolean }, _assessment: string): boolean {
  if (rule.blocking) return true;
  // A non-blocking rule the model could not decide is still worth a person's
  // attention, but it does not block anything.
  return _assessment === 'INSUFFICIENT_EVIDENCE';
}

/** The consent a user gives before any document content leaves PalCert (§14, §63). */
export const AI_CONSENT_VERSION = '1';

/**
 * What the user is consenting to, coarsely. Recorded rather than the provider
 * name so that changing vendor cannot silently reuse consent given for a
 * different arrangement (§64, §68).
 */
export const AIProviderCategory = {
  EXTERNAL_AI_PROVIDER: 'EXTERNAL_AI_PROVIDER',
} as const;

export type AIProviderCategory = (typeof AIProviderCategory)[keyof typeof AIProviderCategory];

/** Versions persisted with every review, so old output stays explicable (§11, §18, §78). */
export const AI_REVIEW_SCHEMA_VERSION = 1;
export const AI_REVIEW_CANONICALIZATION_VERSION = 1;
export const AI_CONTEXT_SCHEMA_VERSION = 1;
export const AI_ASSESSMENT_SCHEMA_VERSION = 1;
export const AI_CONTEXT_BUILDER_VERSION = '1';

/** Deterministic identity for one AI review job. */
export function aiReviewJobKey(reviewId: string): string {
  return `AI_REVIEW:${reviewId}`;
}
