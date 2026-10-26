import { describe, expect, it } from 'vitest';
import { ComplianceDetermination } from '../checks/check.js';
import { determineCompliance, type RuleOutcomeSummary } from '../checks/determination.js';
import { AUTHORITATIVE_EVIDENCE_LEVELS, EvidenceLevelValue } from '../evaluation/constants.js';
import { compatibilityFor } from './format-compatibility.js';
import { isAuthoritativeSupport, supportFor } from './property-support.js';

/**
 * Why advisory evidence cannot certify a document (Phase 18, Checkpoint 15).
 *
 * The safety argument is a chain, and each link is tested here rather than
 * asserted in a comment:
 *
 * 1. an advisory rule is always INDETERMINATE — proved in the Python engine
 *    suite, because that is where the evaluator lives;
 * 2. INDETERMINATE never contributes to COMPLIANT, and a blocking one forces
 *    INDETERMINATE;
 * 3. only COMPLIANT + APPROVED issues a certificate.
 *
 * So an advisory rule can move a determination *away* from COMPLIANT and can
 * never move one towards it. That asymmetry is the whole design: heuristic
 * evidence may withhold a certificate, and can never grant one.
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

describe('advisory evidence and the determination', () => {
  it('cannot turn a compliant document non-compliant', () => {
    // The advisory rule is INDETERMINATE, never FAIL, so NON_COMPLIANT is not
    // reachable through it. A heuristic detector that missed a citation must
    // not be able to fail somebody's thesis.
    const result = determineCompliance({
      results: [summary(), summary({ outcome: 'INDETERMINATE', blocking: false })],
    });
    expect(result.determination).toBe(ComplianceDetermination.COMPLIANT);
    expect(result.blockingFailureCount).toBe(0);
  });

  it('cannot make a non-compliant document compliant', () => {
    // An advisory observation alongside a real blocking failure changes
    // nothing: the failure still decides.
    const result = determineCompliance({
      results: [
        summary({ outcome: 'FAIL' }),
        summary({ outcome: 'INDETERMINATE', blocking: false }),
      ],
    });
    expect(result.determination).toBe(ComplianceDetermination.NON_COMPLIANT);
  });

  it('withholds rather than grants when the advisory rule is blocking', () => {
    // The conservative direction, and the only one an advisory rule can move
    // a determination in: INDETERMINATE, which is not COMPLIANT and therefore
    // not certifiable.
    const result = determineCompliance({
      results: [summary(), summary({ outcome: 'INDETERMINATE', blocking: true })],
    });
    expect(result.determination).toBe(ComplianceDetermination.INDETERMINATE);
    expect(result.determination).not.toBe(ComplianceDetermination.COMPLIANT);
  });

  it('never counts an advisory rule as a pass that earns COMPLIANT', () => {
    // A standard whose every rule is advisory is not a compliant document; it
    // is a document nothing authoritative was said about.
    const result = determineCompliance({
      results: [
        summary({ outcome: 'INDETERMINATE', blocking: true }),
        summary({ outcome: 'INDETERMINATE', blocking: true }),
      ],
    });
    expect(result.determination).toBe(ComplianceDetermination.INDETERMINATE);
  });
});

describe('the evidence level a certificate may rest on', () => {
  it('excludes ADVISORY', () => {
    expect(AUTHORITATIVE_EVIDENCE_LEVELS).not.toContain(EvidenceLevelValue.ADVISORY);
    expect(AUTHORITATIVE_EVIDENCE_LEVELS).toContain(EvidenceLevelValue.DETERMINISTIC);
  });

  it('keeps ADVISORY distinct from every level that existed before', () => {
    // Not a synonym for NONE: the observation exists and is reported. Not a
    // synonym for AI_PROVISIONAL either — that is a model's opinion, this is a
    // deterministic recognition whose population is incomplete.
    const values = Object.values(EvidenceLevelValue);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('compatibility preview distinguishes advisory support', () => {
  const advisoryRule = { ruleCode: 'A.1', scope: { property: 'observedCitationCount' } };
  const exactRule = { ruleCode: 'E.1', scope: { property: 'pageCount' } };
  const unsupportedRule = { ruleCode: 'U.1', scope: { property: 'marginLeft' } };

  it('reports the support level rather than folding it into supported', () => {
    const result = compatibilityFor('PDF', [advisoryRule]);
    expect(result.rules[0]?.support).toBe('ADVISORY');
    expect(result.advisoryRules).toBe(1);
    expect(result.supportedRules).toBe(0);
    expect(result.unsupportedRules).toBe(0);
    expect(result.advisoryProperties).toEqual(['observedCitationCount']);
  });

  it('never calls a standard FULL when a rule is only advisory', () => {
    // The single most misleading thing this preview could say, because it is
    // the number somebody reads before paying.
    const result = compatibilityFor('PDF', [exactRule, advisoryRule]);
    expect(result.level).toBe('PARTIAL');
    expect(result.supportedRules).toBe(1);
    expect(result.advisoryRules).toBe(1);
  });

  it('calls an all-advisory standard NONE, not FULL', () => {
    const result = compatibilityFor('PDF', [advisoryRule]);
    expect(result.level).toBe('NONE');
  });

  it('keeps the three buckets adding up to the total', () => {
    const result = compatibilityFor('PDF', [exactRule, advisoryRule, unsupportedRule]);
    expect(result.supportedRules + result.advisoryRules + result.unsupportedRules).toBe(
      result.totalRules,
    );
  });

  it('is unchanged for a standard with no advisory rule', () => {
    const result = compatibilityFor('PDF', [exactRule, unsupportedRule]);
    expect(result.level).toBe('PARTIAL');
    expect(result.advisoryRules).toBe(0);
    expect(result.advisoryProperties).toEqual([]);
  });

  it('treats DOCX advisory properties as unsupported, since discovery is PDF-only', () => {
    const result = compatibilityFor('DOCX', [advisoryRule]);
    expect(result.rules[0]?.support).toBe('UNSUPPORTED');
    expect(result.advisoryRules).toBe(0);
  });
});

describe('the authoritative-support predicate', () => {
  it('admits EXACT and DERIVED and refuses the rest', () => {
    expect(isAuthoritativeSupport('EXACT')).toBe(true);
    expect(isAuthoritativeSupport('DERIVED')).toBe(true);
    expect(isAuthoritativeSupport('ADVISORY')).toBe(false);
    expect(isAuthoritativeSupport('UNSUPPORTED')).toBe(false);
  });

  it('agrees with the registry about every advisory citation property', () => {
    for (const name of [
      'observedCitationCount',
      'observedReferenceCount',
      'observedReferenceRegionPresent',
    ]) {
      expect(isAuthoritativeSupport(supportFor('PDF', name))).toBe(false);
    }
  });

  it('agrees with the registry about every exact citation property', () => {
    for (const [format, name] of [
      ['PDF', 'referenceRegionPresent'],
      ['PDF', 'citationTargetResolved'],
      ['DOCX', 'nativeCitationCount'],
      ['DOCX', 'nativeBibliographySourceCount'],
      ['DOCX', 'nativeSourceResolved'],
    ] as const) {
      expect(isAuthoritativeSupport(supportFor(format, name))).toBe(true);
    }
  });
});
