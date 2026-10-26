import { describe, expect, it } from 'vitest';
import { computeDeterministicScore, scoreForDisplay, type ScorableRule } from './score.js';

/**
 * The score is a number a student may put in front of a supervisor, so the
 * properties worth pinning are the ones that would make it indefensible:
 * exact arithmetic, one vote per rule, no contribution from rules nobody
 * evaluated, and a null that never renders as zero.
 */

function rule(
  severity: ScorableRule['severity'],
  outcome: ScorableRule['outcome'],
  evaluationMode: ScorableRule['evaluationMode'] = 'DETERMINISTIC',
): ScorableRule {
  return { severity, outcome, evaluationMode };
}

describe('computeDeterministicScore', () => {
  it('is 100 when every scorable rule passed', () => {
    const score = computeDeterministicScore([rule('MAJOR', 'PASS'), rule('CRITICAL', 'PASS')]);
    expect(score.value).toBe('100');
    expect(score.complete).toBe(true);
    expect(score.coverage).toBe('1');
  });

  it('weights by severity, not by count of rules', () => {
    // CRITICAL is 10 and MINOR is 1, so failing the critical rule costs far
    // more than failing the minor one.
    const failedCritical = computeDeterministicScore([
      rule('CRITICAL', 'FAIL'),
      rule('MINOR', 'PASS'),
    ]);
    const failedMinor = computeDeterministicScore([
      rule('CRITICAL', 'PASS'),
      rule('MINOR', 'FAIL'),
    ]);
    expect(failedCritical.value).toBe(ratio(1, 11));
    expect(failedMinor.value).toBe(ratio(10, 11));
  });

  it('excludes AI-assisted and manual rules entirely', () => {
    const withOnlyDeterministic = computeDeterministicScore([rule('MAJOR', 'PASS')]);
    const withUnresolvedAi = computeDeterministicScore([
      rule('MAJOR', 'PASS'),
      rule('CRITICAL', 'INDETERMINATE', 'AI_ASSISTED'),
      rule('CRITICAL', 'INDETERMINATE', 'MANUAL'),
    ]);
    // Identical in every field: an AI rule must not move the score, and must
    // not make it look incomplete either — it was never scorable.
    expect(withUnresolvedAi).toEqual(withOnlyDeterministic);
    expect(withUnresolvedAi.complete).toBe(true);
  });

  it('gives INFO rules no weight at all', () => {
    const withInfo = computeDeterministicScore([rule('MAJOR', 'PASS'), rule('INFO', 'FAIL')]);
    expect(withInfo.value).toBe('100');
    expect(withInfo.evaluatedWeight).toBe('4');
  });

  it('excludes NOT_APPLICABLE rules from both numerator and denominator', () => {
    const score = computeDeterministicScore([
      rule('MAJOR', 'PASS'),
      rule('CRITICAL', 'NOT_APPLICABLE'),
    ]);
    expect(score.value).toBe('100');
    expect(score.evaluatedWeight).toBe('4');
    expect(score.unresolvedWeight).toBe('0');
    expect(score.complete).toBe(true);
  });

  it('treats an unresolved deterministic rule as coverage lost, not as a failure', () => {
    const score = computeDeterministicScore([
      rule('MAJOR', 'PASS'),
      rule('MAJOR', 'INDETERMINATE'),
    ]);
    // The resolved rules all passed, so the score is 100 — but it is
    // explicitly incomplete, and only half the weight was covered.
    expect(score.value).toBe('100');
    expect(score.complete).toBe(false);
    expect(score.coverage).toBe('0.5');
    expect(score.unresolvedWeight).toBe('4');
  });

  it('treats ERROR the same as INDETERMINATE for coverage', () => {
    expect(computeDeterministicScore([rule('MAJOR', 'ERROR')])).toEqual(
      computeDeterministicScore([rule('MAJOR', 'INDETERMINATE')]),
    );
  });

  it('is null, not zero, when nothing scorable resolved', () => {
    // A standard of manual rules only. Rendering this as 0% would be a
    // failing grade for a document PalCert never examined (§14).
    const score = computeDeterministicScore([
      rule('CRITICAL', 'INDETERMINATE', 'MANUAL'),
      rule('INFO', 'PASS'),
      rule('MAJOR', 'INDETERMINATE'),
    ]);
    expect(score.value).toBeNull();
    expect(scoreForDisplay(score)).toBeNull();
  });

  it('is null for an empty rule set', () => {
    const score = computeDeterministicScore([]);
    expect(score.value).toBeNull();
    expect(score.coverage).toBeNull();
    expect(score.complete).toBe(true);
  });

  it('is exact where binary floating point is not', () => {
    // 1/3 of the weight passing. A float would give 33.33333333333333;
    // the exact decimal is pinned to the scale the contract declares.
    const score = computeDeterministicScore([
      rule('MINOR', 'PASS'),
      rule('MINOR', 'FAIL'),
      rule('MINOR', 'FAIL'),
    ]);
    expect(score.value).toBe('33.3333');
  });

  it('rounds half away from zero rather than to even', () => {
    // 1 of 8 MINOR rules passing is 12.5 exactly at one decimal place; at the
    // contract's scale it is exact, and display rounds up to 13.
    const rules: ScorableRule[] = [rule('MINOR', 'PASS')];
    for (let index = 0; index < 7; index += 1) rules.push(rule('MINOR', 'FAIL'));
    const score = computeDeterministicScore(rules);
    expect(score.value).toBe('12.5');
    expect(scoreForDisplay(score)).toBe(13);
  });

  it('does not multiply a rule by how many times it was violated', () => {
    // The contract input carries one entry per rule, so a rule violated on
    // every paragraph of a long thesis still weighs exactly its severity.
    const once = computeDeterministicScore([rule('MAJOR', 'FAIL'), rule('MAJOR', 'PASS')]);
    expect(once.value).toBe('50');
    expect(once.evaluatedWeight).toBe('8');
  });
});

/** The expected decimal for a weight ratio, at the contract's own scale. */
function ratio(passed: number, evaluated: number): string {
  const scaled = Math.round((passed / evaluated) * 100 * 10_000) / 10_000;
  return String(scaled);
}
