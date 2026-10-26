import { describe, expect, it } from 'vitest';
import { ComplianceDetermination } from './check.js';
import { determineCompliance, type RuleOutcomeSummary } from './determination.js';
import { computeDeterministicScore, type ScorableRule } from './score.js';

/**
 * How advisory results aggregated when Checkpoint 16 began.
 *
 * Written before the change and kept afterwards. Checkpoint 15 made an
 * advisory rule always INDETERMINATE, which was the right verdict for the
 * rule; what it did not settle is what the *document* determination does with
 * one. The answer, at commit 0542fcd, was that a blocking advisory rule
 * behaved exactly like deterministic evidence that could not decide — it moved
 * an otherwise COMPLIANT document to INDETERMINATE and withheld certificate
 * eligibility.
 *
 * That is safe in the sense that matters most (it never granted anything) and
 * wrong in a way that matters too: a heuristic detector's inability to
 * recognize a citation style is not a reason to withhold somebody's
 * certificate. These tests state the starting position precisely so the change
 * is visible rather than assumed.
 */

function summary(over: Partial<RuleOutcomeSummary> = {}): RuleOutcomeSummary {
  return {
    outcome: 'PASS',
    blocking: true,
    evaluationMode: 'DETERMINISTIC',
    requiresReview: false,
    ...over,
  };
}

const AUTHORITATIVE_PASS = summary();
const AUTHORITATIVE_FAIL = summary({ outcome: 'FAIL' });
const AUTHORITATIVE_INDETERMINATE = summary({ outcome: 'INDETERMINATE' });

/** What Checkpoint 15 produces for a rule reading an advisory property. */
const ADVISORY_BLOCKING = summary({ outcome: 'INDETERMINATE', evidenceLevel: 'ADVISORY' });
const ADVISORY_NON_BLOCKING = summary({
  outcome: 'INDETERMINATE',
  blocking: false,
  evidenceLevel: 'ADVISORY',
});

describe('authoritative evidence alone (unchanged by this checkpoint)', () => {
  it('passes to COMPLIANT', () => {
    expect(determineCompliance({ results: [AUTHORITATIVE_PASS] }).determination).toBe(
      ComplianceDetermination.COMPLIANT,
    );
  });

  it('fails to NON_COMPLIANT', () => {
    expect(determineCompliance({ results: [AUTHORITATIVE_FAIL] }).determination).toBe(
      ComplianceDetermination.NON_COMPLIANT,
    );
  });

  it('is INDETERMINATE when blocking deterministic evidence could not decide', () => {
    expect(determineCompliance({ results: [AUTHORITATIVE_INDETERMINATE] }).determination).toBe(
      ComplianceDetermination.INDETERMINATE,
    );
  });

  it('lets a failure outrank unresolved evidence', () => {
    expect(
      determineCompliance({ results: [AUTHORITATIVE_FAIL, AUTHORITATIVE_INDETERMINATE] })
        .determination,
    ).toBe(ComplianceDetermination.NON_COMPLIANT);
  });

  it('ignores a non-blocking unresolved rule', () => {
    expect(
      determineCompliance({
        results: [AUTHORITATIVE_PASS, summary({ outcome: 'INDETERMINATE', blocking: false })],
      }).determination,
    ).toBe(ComplianceDetermination.COMPLIANT);
  });
});

describe('advisory evidence in the determination', () => {
  it('never turns a compliant document non-compliant', () => {
    // True before and after: an advisory rule is INDETERMINATE, never FAIL.
    expect(
      determineCompliance({ results: [AUTHORITATIVE_PASS, ADVISORY_BLOCKING] }).determination,
    ).not.toBe(ComplianceDetermination.NON_COMPLIANT);
  });

  it('never rescues a failing document', () => {
    expect(
      determineCompliance({ results: [AUTHORITATIVE_FAIL, ADVISORY_BLOCKING] }).determination,
    ).toBe(ComplianceDetermination.NON_COMPLIANT);
  });

  it('leaves a compliant document compliant when the advisory rule is non-blocking', () => {
    expect(
      determineCompliance({ results: [AUTHORITATIVE_PASS, ADVISORY_NON_BLOCKING] }).determination,
    ).toBe(ComplianceDetermination.COMPLIANT);
  });

  it('no longer withholds compliance when the advisory rule is blocking', () => {
    // THE BEHAVIOUR CHECKPOINT 16 CHANGED. At 0542fcd this returned
    // INDETERMINATE: a blocking advisory rule was counted as unresolved
    // deterministic evidence, so a heuristic detector that did not recognize a
    // citation style withheld an otherwise earned certificate.
    expect(
      determineCompliance({ results: [AUTHORITATIVE_PASS, ADVISORY_BLOCKING] }).determination,
    ).toBe(ComplianceDetermination.COMPLIANT);
  });

  it('counts an advisory result separately rather than silently dropping it', () => {
    const result = determineCompliance({ results: [AUTHORITATIVE_PASS, ADVISORY_BLOCKING] });
    expect(result.advisoryCount).toBe(1);
    expect(result.unresolvedDeterministicCount).toBe(0);
  });
});

describe('a standard with nothing authoritative in it', () => {
  it('is INDETERMINATE rather than COMPLIANT', () => {
    // Nothing authoritative was checked, so there is nothing to be compliant
    // with. COMPLIANT here would be the single most dangerous answer in the
    // system: a certificate earned by a standard that decided nothing.
    expect(
      determineCompliance({ results: [ADVISORY_BLOCKING, ADVISORY_NON_BLOCKING] }).determination,
    ).toBe(ComplianceDetermination.INDETERMINATE);
  });
});

describe('the deterministic score', () => {
  function scorable(over: Partial<ScorableRule> = {}): ScorableRule {
    return { severity: 'MAJOR', evaluationMode: 'DETERMINISTIC', outcome: 'PASS', ...over };
  }

  it('reports full coverage for an exact-only standard', () => {
    const score = computeDeterministicScore([scorable()]);
    expect(score.value).toBe('100');
    expect(score.coverage).toBe('1');
    expect(score.complete).toBe(true);
  });

  it('does not let an advisory rule reduce authoritative coverage', () => {
    // An authoritative number degraded by a non-authoritative rule would
    // misdescribe the evaluation: "92%, coverage 0.5" reads as PalCert having
    // failed to check half the standard, when in fact it checked all of the
    // half that could be checked authoritatively.
    const score = computeDeterministicScore([
      scorable(),
      scorable({ outcome: 'INDETERMINATE', evidenceLevel: 'ADVISORY' }),
    ]);
    expect(score.value).toBe('100');
    expect(score.coverage).toBe('1');
    expect(score.complete).toBe(true);
  });

  it('has no score at all when every rule is advisory', () => {
    // Null is not zero: nothing scorable resolved, and 0% would be a failing
    // grade for a document PalCert never authoritatively examined.
    const score = computeDeterministicScore([
      scorable({ outcome: 'INDETERMINATE', evidenceLevel: 'ADVISORY' }),
    ]);
    expect(score.value).toBeNull();
    expect(score.coverage).toBeNull();
  });
});
