import { describe, expect, it } from 'vitest';
import {
  AIFailureKind,
  AIReviewStatus,
  AI_REVIEW_TRANSITIONS,
  aiReviewJobKey,
  canTransitionAIReview,
  isAIReviewCancellable,
  isAIReviewTerminal,
  isRetryableAIFailure,
  requiresHumanReview,
} from './review.js';

/**
 * The AI review domain rules.
 *
 * These tests pin the distinctions the phase is built on: that a finished
 * review is history, that infrastructure trouble is retried while a policy
 * refusal is not, and — the one that matters most — that a blocking
 * AI-assisted requirement always still needs a person.
 */

describe('requiresHumanReview', () => {
  it.each(['SATISFIED', 'NOT_SATISFIED', 'INSUFFICIENT_EVIDENCE'] as const)(
    'is true for a blocking rule the AI assessed as %s',
    (assessment) => {
      // The single most important guarantee in Phase 8. An AI provider is
      // never given certification authority, so a confident SATISFIED changes
      // nothing about whether a person must look (§26).
      expect(requiresHumanReview({ blocking: true }, assessment)).toBe(true);
    },
  );

  it('is false for a non-blocking rule the AI could decide', () => {
    expect(requiresHumanReview({ blocking: false }, 'SATISFIED')).toBe(false);
    expect(requiresHumanReview({ blocking: false }, 'NOT_SATISFIED')).toBe(false);
  });

  it('is true for a non-blocking rule the AI could not decide', () => {
    // Worth a person's attention, though it blocks nothing.
    expect(requiresHumanReview({ blocking: false }, 'INSUFFICIENT_EVIDENCE')).toBe(true);
  });
});

describe('the AI review lifecycle', () => {
  it('never leaves a terminal status', () => {
    for (const status of Object.values(AIReviewStatus)) {
      if (!isAIReviewTerminal(status)) continue;
      expect(AI_REVIEW_TRANSITIONS[status], status).toEqual([]);
    }
  });

  it('treats a completed review as history', () => {
    // A different model or prompt is a new review, never a rewrite (§11, §45).
    expect(canTransitionAIReview(AIReviewStatus.COMPLETED, AIReviewStatus.RUNNING)).toBe(false);
    expect(canTransitionAIReview(AIReviewStatus.FAILED, AIReviewStatus.RUNNING)).toBe(false);
  });

  it('re-entering RUNNING is allowed, for at-least-once delivery', () => {
    expect(canTransitionAIReview(AIReviewStatus.RUNNING, AIReviewStatus.RUNNING)).toBe(true);
  });

  it('can be cancelled only before it reaches the provider', () => {
    // PalCert does not claim to recall a request already being processed (§106).
    expect(isAIReviewCancellable(AIReviewStatus.CREATED)).toBe(true);
    expect(isAIReviewCancellable(AIReviewStatus.QUEUED)).toBe(true);
    expect(isAIReviewCancellable(AIReviewStatus.RUNNING)).toBe(false);
    expect(isAIReviewCancellable(AIReviewStatus.COMPLETED)).toBe(false);
  });

  it('does not use a compliance word as a job status', () => {
    // A job is not a verdict (§13).
    const statuses: string[] = Object.values(AIReviewStatus);
    expect(statuses).not.toContain('PASS');
    expect(statuses).not.toContain('FAIL');
    expect(statuses).not.toContain('SATISFIED');
  });
});

describe('AI failure classification', () => {
  it.each([
    AIFailureKind.RATE_LIMITED,
    AIFailureKind.OVERLOADED,
    AIFailureKind.TIMEOUT,
    AIFailureKind.NETWORK,
  ])('retries %s', (kind) => {
    expect(isRetryableAIFailure(kind)).toBe(true);
  });

  it.each([
    AIFailureKind.AUTHENTICATION,
    AIFailureKind.INVALID_REQUEST,
    AIFailureKind.PROVIDER_REFUSAL,
    AIFailureKind.OUTPUT_INVALID,
    AIFailureKind.MODEL_UNAVAILABLE,
    AIFailureKind.CONTEXT_TOO_LARGE,
    AIFailureKind.UNKNOWN_PROVIDER_ERROR,
  ])('does not retry %s', (kind) => {
    // A bad credential, a malformed request or a policy refusal will fail
    // identically for ever; retrying reaches the same answer more slowly and
    // spends somebody's quota to do it (§56).
    expect(isRetryableAIFailure(kind)).toBe(false);
  });

  it('treats a provider refusal as a provider fact, not a document verdict', () => {
    // There is no failure kind that means "the document failed a rule",
    // because a provider declining says nothing about a document (§54).
    const kinds: string[] = Object.values(AIFailureKind);
    expect(kinds).not.toContain('NOT_SATISFIED');
    expect(kinds).not.toContain('NON_COMPLIANT');
  });
});

describe('aiReviewJobKey', () => {
  it('is derived from the review, so a second review is a different job', () => {
    expect(aiReviewJobKey('a')).not.toBe(aiReviewJobKey('b'));
    expect(aiReviewJobKey('a')).toBe(aiReviewJobKey('a'));
  });
});
