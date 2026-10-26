import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EvidenceLevelValue } from '../evaluation/constants.js';
import { validateRuleDefinition } from '../standards/rule-validation.js';
import { canonicalizeJson, computeReportHash } from './report.js';
import { validateCheckReport } from './report-validator.js';
import { ComplianceDetermination } from './check.js';
import { determineCompliance, type RuleOutcomeSummary } from './determination.js';
import type { CheckReport } from './report.generated.js';

/**
 * The final Phase 18 contract between authoritative and advisory evidence.
 *
 * Checkpoint 15 proved advisory evidence could not *grant* anything. This file
 * proves the other half — that it cannot take anything away either — and then
 * proves the compatibility claims the phase rests on: that widening
 * `evidenceLevel` additively left every historical report byte-identical, and
 * that an advisory result serializes deterministically alongside them.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../contracts/fixtures');

function summary(over: Partial<RuleOutcomeSummary> = {}): RuleOutcomeSummary {
  return {
    outcome: 'PASS',
    blocking: true,
    evaluationMode: 'DETERMINISTIC',
    requiresReview: false,
    ...over,
  };
}

const advisory = (outcome: RuleOutcomeSummary['outcome'] = 'INDETERMINATE', blocking = true) =>
  summary({ outcome, blocking, evidenceLevel: EvidenceLevelValue.ADVISORY });

/**
 * The matrix the checkpoint asks for, in the repository's own vocabulary.
 *
 * "PASS-like" and "FAIL-like" advisory observations are written as the
 * outcomes an advisory rule could carry if the evaluator ever produced them.
 * It does not — Checkpoint 15 makes every advisory rule INDETERMINATE — so the
 * PASS and FAIL rows are testing the aggregation's indifference rather than a
 * reachable state, which is the stronger property: even a future evaluator
 * change could not leak an advisory verdict into the determination.
 */
describe('mixed evidence matrix', () => {
  const cases: ReadonlyArray<{
    readonly authoritative: readonly RuleOutcomeSummary[];
    readonly advisoryResults: readonly RuleOutcomeSummary[];
    readonly expected: ComplianceDetermination;
    readonly name: string;
  }> = [
    {
      name: 'authoritative PASS + advisory PASS-like observation',
      authoritative: [summary()],
      advisoryResults: [advisory('PASS')],
      expected: ComplianceDetermination.COMPLIANT,
    },
    {
      name: 'authoritative PASS + advisory FAIL-like observation',
      authoritative: [summary()],
      advisoryResults: [advisory('FAIL')],
      expected: ComplianceDetermination.COMPLIANT,
    },
    {
      name: 'authoritative PASS + advisory INDETERMINATE',
      authoritative: [summary()],
      advisoryResults: [advisory()],
      expected: ComplianceDetermination.COMPLIANT,
    },
    {
      name: 'authoritative FAIL + advisory anything',
      authoritative: [summary({ outcome: 'FAIL' })],
      advisoryResults: [advisory('PASS'), advisory('FAIL'), advisory()],
      expected: ComplianceDetermination.NON_COMPLIANT,
    },
    {
      name: 'authoritative INDETERMINATE + advisory anything',
      authoritative: [summary({ outcome: 'INDETERMINATE' })],
      advisoryResults: [advisory('PASS'), advisory()],
      expected: ComplianceDetermination.INDETERMINATE,
    },
    {
      name: 'no authoritative rule at all, advisory only',
      authoritative: [],
      advisoryResults: [advisory('PASS'), advisory()],
      expected: ComplianceDetermination.INDETERMINATE,
    },
  ];

  it.each(cases)('$name', ({ authoritative, advisoryResults, expected }) => {
    const withAdvisory = determineCompliance({
      results: [...authoritative, ...advisoryResults],
    });
    expect(withAdvisory.determination).toBe(expected);
  });

  it.each(cases.filter((entry) => entry.authoritative.length > 0))(
    '$name is identical with the advisory rules removed',
    ({ authoritative, advisoryResults }) => {
      // The property stated directly: advisory results are not merely
      // harmless, they are *inert*. Removing them changes nothing.
      const withAdvisory = determineCompliance({
        results: [...authoritative, ...advisoryResults],
      });
      const without = determineCompliance({ results: [...authoritative] });
      expect(withAdvisory.determination).toBe(without.determination);
      expect(withAdvisory.blockingFailureCount).toBe(without.blockingFailureCount);
      expect(withAdvisory.unresolvedDeterministicCount).toBe(without.unresolvedDeterministicCount);
      expect(withAdvisory.blockingPendingReviewCount).toBe(without.blockingPendingReviewCount);
    },
  );

  it('still reports how many advisory observations there were', () => {
    // Inert is not invisible: the count is there so a report can show them.
    const result = determineCompliance({ results: [summary(), advisory(), advisory('FAIL')] });
    expect(result.advisoryCount).toBe(2);
  });
});

describe('certificate safety', () => {
  // Eligibility is `authoritative COMPLIANT + institution APPROVED`. These
  // prove the first half cannot be reached or lost through advisory evidence;
  // the API suite proves the gate itself.
  const certifiable = (determination: ComplianceDetermination) =>
    determination === ComplianceDetermination.COMPLIANT;

  it('an advisory PASS-like observation cannot grant eligibility', () => {
    const result = determineCompliance({
      results: [summary({ outcome: 'INDETERMINATE' }), advisory('PASS')],
    });
    expect(certifiable(result.determination)).toBe(false);
  });

  it('an advisory FAIL-like observation cannot remove eligibility', () => {
    const result = determineCompliance({ results: [summary(), advisory('FAIL')] });
    expect(certifiable(result.determination)).toBe(true);
  });

  it('an advisory INDETERMINATE cannot remove eligibility', () => {
    const result = determineCompliance({ results: [summary(), advisory()] });
    expect(certifiable(result.determination)).toBe(true);
  });

  it('an authoritative FAIL can never be hidden by advisory evidence', () => {
    const result = determineCompliance({
      results: [summary({ outcome: 'FAIL' }), advisory('PASS'), advisory('PASS')],
    });
    expect(result.determination).toBe(ComplianceDetermination.NON_COMPLIANT);
    expect(certifiable(result.determination)).toBe(false);
  });

  it('an all-advisory standard cannot issue a certificate', () => {
    const result = determineCompliance({ results: [advisory('PASS'), advisory('PASS')] });
    expect(result.determination).toBe(ComplianceDetermination.INDETERMINATE);
    expect(certifiable(result.determination)).toBe(false);
  });
});

describe('a blocking rule about an advisory property', () => {
  function rule(property: string, blocking: boolean) {
    return {
      ruleCode: 'TEST.RULE',
      category: 'CITATIONS',
      scope: { kind: 'DOCUMENT', property },
      operator: 'GREATER_THAN_OR_EQUAL',
      expected: { type: 'NUMBER', number: '1' },
      unit: 'COUNT',
      evaluationMode: 'DETERMINISTIC',
      severity: 'MAJOR',
      blocking,
      origin: 'AUTHORED',
      titleEn: 'Observed citations',
      ruleSchemaVersion: 2,
    } as unknown as Parameters<typeof validateRuleDefinition>[0];
  }

  it('is refused at authoring time', () => {
    const result = validateRuleDefinition(rule('observedCitationCount', true));
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain('blocking');
  });

  it('is accepted when it is not blocking', () => {
    const result = validateRuleDefinition(rule('observedCitationCount', false));
    expect(result.issues.filter((issue) => issue.path === 'blocking')).toEqual([]);
  });

  it('leaves a blocking rule about an authoritative property alone', () => {
    const result = validateRuleDefinition(rule('pageCount', true));
    expect(result.issues.filter((issue) => issue.path === 'blocking')).toEqual([]);
  });

  it('leaves a blocking rule about an unknown property alone', () => {
    // UNSUPPORTED everywhere, which the evaluator already answers
    // INDETERMINATE. A standard may legitimately name a property no analyzer
    // implements yet, and refusing it here would refuse the standard.
    const result = validateRuleDefinition(rule('somePropertyNobodyImplements', true));
    expect(result.issues.filter((issue) => issue.path === 'blocking')).toEqual([]);
  });
});

describe('report compatibility after the additive evidenceLevel widening', () => {
  const input = JSON.parse(
    readFileSync(resolve(FIXTURES, 'checks/report-v1-input.json'), 'utf8'),
  ) as CheckReport;

  it('still validates a report written before advisory evidence existed', () => {
    const result = validateCheckReport(input);
    expect(result.valid, JSON.stringify(result.issues)).toBe(true);
  });

  it('canonicalizes a historical report byte-identically', () => {
    const expected = readFileSync(resolve(FIXTURES, 'checks/report-v1-canonical.json'), 'utf8');
    expect(canonicalizeJson(input)).toBe(expected);
  });

  it('hashes a historical report to the value it always hashed to', () => {
    // If this ever moves, the widening was not additive and the schema version
    // is the thing that has to change — not this number.
    const expected = readFileSync(resolve(FIXTURES, 'checks/report-v1.sha256'), 'utf8').trim();
    expect(computeReportHash(input)).toBe(expected);
    expect(createHash('sha256').update(canonicalizeJson(input), 'utf8').digest('hex')).toBe(
      expected,
    );
  });

  it('carries no ADVISORY value in any historical result', () => {
    // The premise the three tests above rest on: nothing in the fixture uses
    // the new enum member, so nothing about it could have changed.
    for (const result of input.ruleResults) {
      expect(result.evidenceLevel).not.toBe(EvidenceLevelValue.ADVISORY);
    }
  });

  it('validates and canonicalizes a report carrying an ADVISORY result', () => {
    const withAdvisory: CheckReport = {
      ...input,
      ruleResults: input.ruleResults.map((result, index) =>
        index === 0
          ? { ...result, outcome: 'INDETERMINATE' as const, evidenceLevel: 'ADVISORY' as const }
          : result,
      ),
    };
    expect(validateCheckReport(withAdvisory).valid).toBe(true);
    // Deterministic: the same input canonicalizes and hashes identically every
    // time, and differently from the report it was derived from.
    expect(canonicalizeJson(withAdvisory)).toBe(canonicalizeJson(withAdvisory));
    expect(computeReportHash(withAdvisory)).toBe(computeReportHash(withAdvisory));
    expect(computeReportHash(withAdvisory)).not.toBe(computeReportHash(input));
  });
});
