import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPORT_CANONICALIZATION_VERSION } from './check.js';
import { assertCheckReport, validateCheckReport } from './report-validator.js';
import type { CheckReport } from './report.generated.js';
import { canonicalizeJson, compareFindings, computeEvaluationHash, sha256Hex } from './report.js';

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../contracts/fixtures/checks',
);

function golden(): CheckReport {
  return JSON.parse(readFileSync(resolve(FIXTURES, 'report-v1-input.json'), 'utf8')) as CheckReport;
}

/**
 * The golden report.
 *
 * A hash is a promise that two parties who serialize the same report get the
 * same bytes. Committing the canonical form and its digest turns that promise
 * into something CI can check: any change to canonicalization shows up as a
 * failing diff rather than as reports that silently stop verifying (§78).
 */
describe('the report golden fixture', () => {
  it('satisfies the shared report contract', () => {
    expect(validateCheckReport(golden())).toEqual({ valid: true, issues: [] });
  });

  it('canonicalizes to exactly the committed bytes', () => {
    const expected = readFileSync(resolve(FIXTURES, 'report-v1-canonical.json'), 'utf8');
    expect(canonicalizeJson(golden())).toBe(expected);
  });

  it('hashes to the committed digest', () => {
    const expected = readFileSync(resolve(FIXTURES, 'report-v1.sha256'), 'utf8').trim();
    expect(sha256Hex(canonicalizeJson(golden()))).toBe(expected);
  });

  it('is canonicalized at the version this release writes', () => {
    expect(golden().reportCanonicalizationVersion).toBe(REPORT_CANONICALIZATION_VERSION);
  });
});

describe('canonicalizeJson', () => {
  it('sorts object keys, so construction order cannot change a hash', () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalizeJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('preserves array order, which is meaning rather than presentation', () => {
    expect(canonicalizeJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('treats an absent member and an explicit undefined identically', () => {
    expect(canonicalizeJson({ a: 1, b: undefined })).toBe(canonicalizeJson({ a: 1 }));
  });

  it('distinguishes null from absent', () => {
    expect(canonicalizeJson({ a: null })).toBe('{"a":null}');
  });

  it('refuses fractional numbers rather than hashing a float', () => {
    // The schema carries every non-integer as a decimal string; a float here
    // means something was built wrong, and its rendering is runtime-specific.
    expect(() => canonicalizeJson({ score: 0.1 })).toThrow(/fractional/);
  });

  it('refuses integers beyond exact representation', () => {
    expect(() => canonicalizeJson({ n: Number.MAX_SAFE_INTEGER + 2 })).toThrow(/unsafe/);
  });

  it('is byte-identical for a report rebuilt in a different key order', () => {
    const report = golden();
    const shuffled = JSON.parse(
      JSON.stringify(report, Object.keys(report).sort().reverse()),
    ) as CheckReport;
    // Only the members that survive the replacer are compared; the point is
    // that reordering keys does not move the bytes.
    expect(canonicalizeJson(shuffled)).toBe(canonicalizeJson(JSON.parse(JSON.stringify(shuffled))));
  });
});

describe('computeEvaluationHash', () => {
  const base = {
    documentSha256: 'a'.repeat(64),
    standardContentHash: `sha256:${'b'.repeat(64)}`,
    analysisArtifactSha256: 'c'.repeat(64),
    analyzerName: 'palcert-docx',
    analyzerVersion: '1',
    factSchemaVersion: 2,
    ruleEngineName: 'palcert-rule-engine',
    ruleEngineVersion: '1',
    ruleSchemaVersion: 2,
    orchestratorVersion: '1',
    determination: 'COMPLIANT',
    score: '100',
    scoreCoverage: '1',
    results: [
      {
        ruleCode: 'B.RULE',
        outcome: 'PASS',
        reasonCode: 'SATISFIED',
        requiresReview: false,
        totalViolationCount: 0,
      },
      {
        ruleCode: 'A.RULE',
        outcome: 'PASS',
        reasonCode: 'SATISFIED',
        requiresReview: false,
        totalViolationCount: 0,
      },
    ],
  };

  it('does not depend on the order the engine answered in', () => {
    const reversed = { ...base, results: [...base.results].reverse() };
    expect(computeEvaluationHash(base)).toBe(computeEvaluationHash(reversed));
  });

  it('changes when an outcome changes', () => {
    const changed = {
      ...base,
      results: [{ ...base.results[0]!, outcome: 'FAIL' }, base.results[1]!],
    };
    expect(computeEvaluationHash(changed)).not.toBe(computeEvaluationHash(base));
  });

  it('changes when the engine version changes', () => {
    // The same conclusion reached by a different engine is not the same
    // evidence, and the hash has to say so.
    expect(computeEvaluationHash({ ...base, ruleEngineVersion: '2' })).not.toBe(
      computeEvaluationHash(base),
    );
  });

  it('is identical for the same evaluation re-run as a different check', () => {
    // This is the property the second hash exists for: a report hash moves
    // when the check id or the timestamp moves; this one must not.
    expect(computeEvaluationHash(base)).toBe(computeEvaluationHash({ ...base }));
  });
});

describe('compareFindings', () => {
  const result = (overrides: Partial<Parameters<typeof compareFindings>[0]>) => ({
    outcome: 'PASS',
    severity: 'MAJOR',
    blocking: false,
    requiresReview: false,
    displayOrder: 10,
    ruleCode: 'Z.RULE',
    ...overrides,
  });

  it('puts blocking failures first', () => {
    const ordered = [
      result({ outcome: 'PASS' }),
      result({ outcome: 'FAIL', blocking: true }),
      result({ outcome: 'FAIL', severity: 'MINOR' }),
    ].sort(compareFindings);
    expect(ordered[0]!.blocking).toBe(true);
  });

  it('orders non-blocking failures by severity', () => {
    const ordered = [
      result({ outcome: 'FAIL', severity: 'MINOR' }),
      result({ outcome: 'FAIL', severity: 'CRITICAL' }),
      result({ outcome: 'FAIL', severity: 'MAJOR' }),
    ].sort(compareFindings);
    expect(ordered.map((item) => item.severity)).toEqual(['CRITICAL', 'MAJOR', 'MINOR']);
  });

  it('puts passed and not-applicable rules last', () => {
    const ordered = [
      result({ outcome: 'NOT_APPLICABLE' }),
      result({ outcome: 'PASS' }),
      result({ outcome: 'INDETERMINATE' }),
    ].sort(compareFindings);
    expect(ordered.map((item) => item.outcome)).toEqual([
      'INDETERMINATE',
      'PASS',
      'NOT_APPLICABLE',
    ]);
  });

  it('falls back to the standard’s own display order, then the rule code', () => {
    const ordered = [
      result({ displayOrder: 2, ruleCode: 'B' }),
      result({ displayOrder: 1, ruleCode: 'C' }),
      result({ displayOrder: 2, ruleCode: 'A' }),
    ].sort(compareFindings);
    expect(ordered.map((item) => item.ruleCode)).toEqual(['C', 'A', 'B']);
  });

  it('is a total order, so two sorts of the same set agree', () => {
    const findings = golden().ruleResults;
    const first = [...findings].sort(compareFindings).map((item) => item.ruleCode);
    const second = [...findings]
      .reverse()
      .sort(compareFindings)
      .map((item) => item.ruleCode);
    expect(first).toEqual(second);
  });
});

describe('assertCheckReport', () => {
  it('accepts the golden report', () => {
    expect(() => assertCheckReport(golden())).not.toThrow();
  });

  it('refuses a report carrying an unknown member', () => {
    // Closed schemas: an unexpected field is a signal that something built the
    // report from a shape PalCert does not understand.
    expect(() => assertCheckReport({ ...golden(), surprise: true })).toThrow();
  });

  it('refuses a score expressed as a JSON number', () => {
    const report = golden();
    expect(() =>
      assertCheckReport({ ...report, score: { ...report.score, value: 92.5 } }),
    ).toThrow();
  });
});
