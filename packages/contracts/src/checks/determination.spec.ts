import { describe, expect, it } from 'vitest';
import { ComplianceDetermination } from './check.js';
import { determineCompliance, type RuleOutcomeSummary } from './determination.js';

/**
 * The determination is the single most consequential thing PalCert computes:
 * it is what a student reads as "does my thesis comply". These tests pin down
 * the distinctions that matter most — that "could not decide" is not "failed",
 * that a non-blocking failure is not a rejection, and that an unresolved
 * AI or manual rule can never be silently treated as satisfied.
 */

function rule(overrides: Partial<RuleOutcomeSummary> = {}): RuleOutcomeSummary {
  return {
    outcome: 'PASS',
    blocking: true,
    evaluationMode: 'DETERMINISTIC',
    requiresReview: false,
    ...overrides,
  };
}

describe('determineCompliance', () => {
  it('is COMPLIANT when every blocking rule passed', () => {
    const result = determineCompliance({
      results: [rule(), rule({ blocking: false }), rule({ outcome: 'NOT_APPLICABLE' })],
    });
    expect(result.determination).toBe(ComplianceDetermination.COMPLIANT);
    expect(result.blockingFailureCount).toBe(0);
  });

  it('is NON_COMPLIANT for a blocking deterministic failure', () => {
    const result = determineCompliance({ results: [rule(), rule({ outcome: 'FAIL' })] });
    expect(result.determination).toBe(ComplianceDetermination.NON_COMPLIANT);
    expect(result.blockingFailureCount).toBe(1);
  });

  it('is COMPLIANT when the only failure is non-blocking', () => {
    // A standard's author decides what blocks. A MINOR advisory rule failing
    // is information, not a rejection.
    const result = determineCompliance({
      results: [rule(), rule({ outcome: 'FAIL', blocking: false })],
    });
    expect(result.determination).toBe(ComplianceDetermination.COMPLIANT);
  });

  it.each(['INDETERMINATE', 'ERROR'] as const)(
    'maps a blocking deterministic %s to INDETERMINATE, never to FAIL',
    (outcome) => {
      // The distinction this asserts is the whole point: PalCert could not
      // read the evidence. Blaming the document for that would be a lie.
      const result = determineCompliance({ results: [rule(), rule({ outcome })] });
      expect(result.determination).toBe(ComplianceDetermination.INDETERMINATE);
      expect(result.blockingFailureCount).toBe(0);
      expect(result.unresolvedDeterministicCount).toBe(1);
    },
  );

  it('is REVIEW_REQUIRED when a blocking AI or manual rule is unresolved', () => {
    const result = determineCompliance({
      results: [
        rule(),
        rule({ evaluationMode: 'AI_ASSISTED', requiresReview: true, outcome: 'INDETERMINATE' }),
      ],
    });
    expect(result.determination).toBe(ComplianceDetermination.REVIEW_REQUIRED);
    expect(result.blockingPendingReviewCount).toBe(1);
  });

  it('never reports COMPLIANT while a blocking manual rule is unresolved', () => {
    const result = determineCompliance({
      results: [rule({ evaluationMode: 'MANUAL', requiresReview: true, outcome: 'INDETERMINATE' })],
    });
    expect(result.determination).not.toBe(ComplianceDetermination.COMPLIANT);
  });

  it('lets a non-blocking review rule leave the check COMPLIANT, but counts it', () => {
    const result = determineCompliance({
      results: [
        rule(),
        rule({
          blocking: false,
          evaluationMode: 'AI_ASSISTED',
          requiresReview: true,
          outcome: 'INDETERMINATE',
        }),
      ],
    });
    expect(result.determination).toBe(ComplianceDetermination.COMPLIANT);
    expect(result.pendingReviewCount).toBe(1);
    expect(result.blockingPendingReviewCount).toBe(0);
  });

  it('prefers NON_COMPLIANT over INDETERMINATE and REVIEW_REQUIRED', () => {
    // Precedence matters: a document with a definite blocking failure is
    // non-compliant whatever else could not be decided. Softening that to
    // "needs review" would hide a fact PalCert is certain about.
    const result = determineCompliance({
      results: [
        rule({ outcome: 'FAIL' }),
        rule({ outcome: 'INDETERMINATE' }),
        rule({ evaluationMode: 'MANUAL', requiresReview: true, outcome: 'INDETERMINATE' }),
      ],
    });
    expect(result.determination).toBe(ComplianceDetermination.NON_COMPLIANT);
  });

  it('prefers INDETERMINATE over REVIEW_REQUIRED', () => {
    const result = determineCompliance({
      results: [
        rule({ outcome: 'INDETERMINATE' }),
        rule({ evaluationMode: 'MANUAL', requiresReview: true, outcome: 'INDETERMINATE' }),
      ],
    });
    expect(result.determination).toBe(ComplianceDetermination.INDETERMINATE);
  });

  it('ignores an AI rule that reported FAIL rather than treating it as definitive', () => {
    // Phase 4 does not produce this, but the guard is what stops a future AI
    // verdict from silently becoming a certification failure.
    const result = determineCompliance({
      results: [rule({ outcome: 'FAIL', evaluationMode: 'AI_ASSISTED' })],
    });
    expect(result.blockingFailureCount).toBe(0);
    expect(result.determination).not.toBe(ComplianceDetermination.NON_COMPLIANT);
  });

  it('is COMPLIANT for an empty rule set', () => {
    // A standard with no rules cannot fail a document. Nothing was asserted.
    expect(determineCompliance({ results: [] }).determination).toBe(
      ComplianceDetermination.COMPLIANT,
    );
  });
});
