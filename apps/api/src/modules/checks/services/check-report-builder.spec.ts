import { AppError, type EvaluationResponse, type RuleEvaluationResult } from '@palcert/contracts';
import { CheckReportBuilder, type SnapshotRule } from './check-report-builder.service';

/**
 * The builder is where engine output becomes evidence, so these tests are
 * about what must not get through it: a result for a rule the captured
 * standard never contained, severity taken from the engine rather than from
 * the snapshot, an invented page number, or a stored list quietly passed off
 * as exhaustive.
 */

const IDS = {
  check: '3f1c2b4a-5d6e-4f70-8912-a3b4c5d6e7f8',
  run: '9a8b7c6d-5e4f-4031-8213-4455667788aa',
  owner: '11111111-2222-4333-8444-555566667777',
  document: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  version: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  organization: 'cccccccc-dddd-4eee-8fff-000011112222',
  standard: 'dddddddd-eeee-4fff-8000-111122223333',
  standardVersion: 'eeeeeeee-ffff-4000-8111-222233334444',
  analysis: '00000000-1111-4222-8333-444455556666',
};

function snapshotRule(overrides: Partial<SnapshotRule> = {}): SnapshotRule {
  return {
    ruleCode: 'MARGIN.TOP.MIN',
    category: 'MARGINS',
    severity: 'MAJOR',
    blocking: true,
    evaluationMode: 'DETERMINISTIC',
    displayOrder: 1,
    titleEn: 'Top margin at least 25 mm',
    titleAr: 'الهامش العلوي 25 مم على الأقل',
    guidanceEn: null,
    guidanceAr: null,
    operator: 'GREATER_THAN_OR_EQUAL',
    ...overrides,
  };
}

function engineResult(overrides: Partial<RuleEvaluationResult> = {}): RuleEvaluationResult {
  return {
    ruleCode: 'MARGIN.TOP.MIN',
    outcome: 'PASS',
    reasonCode: 'SATISFIED',
    evidenceLevel: 'DETERMINISTIC',
    requiresReview: false,
    blocking: true,
    severity: 'MAJOR',
    evaluationMode: 'DETERMINISTIC',
    counts: {
      matchedFacts: 1,
      evaluatedFacts: 1,
      passedFacts: 1,
      failedFacts: 0,
      indeterminateFacts: 0,
    },
    violations: [],
    totalViolationCount: 0,
    truncated: false,
    engine: {
      engineName: 'palcert-rule-engine',
      engineVersion: '1',
      ruleSchemaVersion: 2,
      factSchemaVersion: 2,
    },
    ...overrides,
  };
}

function evaluation(results: RuleEvaluationResult[]): EvaluationResponse {
  return {
    documentId: IDS.version,
    engine: {
      engineName: 'palcert-rule-engine',
      engineVersion: '1',
      ruleSchemaVersion: 2,
      factSchemaVersion: 2,
    },
    results,
  };
}

function build(
  results: RuleEvaluationResult[],
  rules: SnapshotRule[] = [snapshotRule()],
  generatedAt = new Date('2026-09-13T12:00:00.000Z'),
) {
  return new CheckReportBuilder().build({
    checkId: IDS.check,
    checkRunId: IDS.run,
    ownerUserId: IDS.owner,
    document: {
      documentId: IDS.document,
      documentVersionId: IDS.version,
      versionNumber: 1,
      sha256: 'a'.repeat(64),
      format: 'DOCX',
    },
    organization: {
      organizationId: IDS.organization,
      displayName: 'Islamic University of Gaza',
      verificationStatus: 'VERIFIED',
    },
    standard: {
      standardId: IDS.standard,
      standardVersionId: IDS.standardVersion,
      code: 'IUG.THESIS.FORMAT',
      nameEn: 'IUG Thesis Formatting',
      nameAr: 'تنسيق رسائل الجامعة الإسلامية',
      versionLabel: '1.0',
      contentHash: `sha256:${'b'.repeat(64)}`,
      canonicalizationVersion: 1,
      ruleSchemaVersion: 2,
    },
    analysis: {
      analysisId: IDS.analysis,
      analyzerName: 'palcert-docx',
      analyzerVersion: '1',
      factSchemaVersion: 2,
      analysisSchemaVersion: 1,
      artifactSha256: 'c'.repeat(64),
    },
    evaluation: evaluation(results),
    snapshotRules: rules,
    generatedAt,
  });
}

describe('advisory results in a built report (Phase 18, Checkpoint 16)', () => {
  const advisoryRule = snapshotRule({
    ruleCode: 'CITATION.OBSERVED.MIN',
    category: 'CITATIONS',
    severity: 'MAJOR',
    blocking: false,
    displayOrder: 2,
    titleEn: 'Observed citations',
    titleAr: 'الاستشهادات المرصودة',
    operator: 'GREATER_THAN_OR_EQUAL',
  });

  const advisoryResult = engineResult({
    ruleCode: 'CITATION.OBSERVED.MIN',
    outcome: 'INDETERMINATE',
    reasonCode: 'ADVISORY_EVIDENCE_ONLY',
    evidenceLevel: 'ADVISORY',
    blocking: false,
    counts: {
      matchedFacts: 1,
      evaluatedFacts: 0,
      passedFacts: 0,
      failedFacts: 0,
      indeterminateFacts: 1,
    },
  });

  it('keeps the determination a compliant document already earned', () => {
    const built = build([engineResult(), advisoryResult], [snapshotRule(), advisoryRule]);
    expect(built.report.determination).toBe('COMPLIANT');
  });

  it('keeps the authoritative score and its coverage intact', () => {
    // The advisory rule is INDETERMINATE. Scoring it would report reduced
    // coverage for a standard whose authoritative rules were all evaluated.
    const withAdvisory = build([engineResult(), advisoryResult], [snapshotRule(), advisoryRule]);
    const without = build([engineResult()], [snapshotRule()]);
    expect(withAdvisory.report.score.value).toBe(without.report.score.value);
    expect(withAdvisory.report.score.coverage).toBe(without.report.score.coverage);
    expect(withAdvisory.report.score.coverage).toBe('1');
  });

  it('still records the advisory rule in the report', () => {
    // Inert in the determination, and not discarded: rule identity, evidence
    // level, outcome and reason all survive into the stored evidence.
    const built = build([engineResult(), advisoryResult], [snapshotRule(), advisoryRule]);
    const recorded = built.report.ruleResults.find(
      (result) => result.ruleCode === 'CITATION.OBSERVED.MIN',
    );
    expect(recorded).toBeDefined();
    expect(recorded?.evidenceLevel).toBe('ADVISORY');
    expect(recorded?.outcome).toBe('INDETERMINATE');
    expect(recorded?.reasonCode).toBe('ADVISORY_EVIDENCE_ONLY');
  });

  it('cannot rescue a failing document', () => {
    const built = build(
      [engineResult({ outcome: 'FAIL', reasonCode: 'BELOW_MINIMUM' }), advisoryResult],
      [snapshotRule(), advisoryRule],
    );
    expect(built.report.determination).toBe('NON_COMPLIANT');
  });

  it('cannot withhold a determination even when the advisory rule is blocking', () => {
    // Rule validation refuses a blocking advisory rule, so this is historical
    // content or a caller bypassing validation. The determination ignores it
    // either way, because honouring it would withhold a certificate a document
    // authoritatively earned.
    const built = build(
      [engineResult(), { ...advisoryResult, blocking: true }],
      [snapshotRule(), snapshotRule({ ...advisoryRule, blocking: true })],
    );
    expect(built.report.determination).toBe('COMPLIANT');
  });

  it('produces a report that still satisfies the shared contract', () => {
    const built = build([engineResult(), advisoryResult], [snapshotRule(), advisoryRule]);
    expect(built.report.reportSchemaVersion).toBe(1);
    expect(built.reportHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes deterministically and differently from the same check without it', () => {
    const a = build([engineResult(), advisoryResult], [snapshotRule(), advisoryRule]);
    const b = build([engineResult(), advisoryResult], [snapshotRule(), advisoryRule]);
    const without = build([engineResult()], [snapshotRule()]);
    expect(a.reportHash).toBe(b.reportHash);
    expect(a.reportHash).not.toBe(without.reportHash);
  });

  it('leaves an all-advisory standard unable to be compliant', () => {
    const built = build([advisoryResult], [advisoryRule]);
    expect(built.report.determination).toBe('INDETERMINATE');
    expect(built.report.score.value).toBeNull();
  });
});

describe('CheckReportBuilder', () => {
  it('produces a report that satisfies the shared contract', () => {
    const built = build([engineResult()]);
    expect(built.report.reportSchemaVersion).toBe(1);
    expect(built.reportHash).toMatch(/^[0-9a-f]{64}$/);
    expect(built.evaluationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(built.determination).toBe('COMPLIANT');
  });

  it('refuses a result for a rule the captured standard does not contain', () => {
    // The only rules that may appear are the ones the check bound itself to.
    // Anything else means the engine was handed rules from somewhere else.
    expect(() => build([engineResult({ ruleCode: 'SOMETHING.ELSE' })])).toThrow(AppError);
  });

  it('takes severity and blocking from the snapshot, not from the engine', () => {
    // The standard version the check captured is the authority on how serious
    // its own rules are; the engine only echoes what it was told.
    const built = build(
      [engineResult({ severity: 'INFO', blocking: false, outcome: 'FAIL' })],
      [snapshotRule({ severity: 'CRITICAL', blocking: true })],
    );
    expect(built.report.ruleResults[0]!.severity).toBe('CRITICAL');
    expect(built.report.ruleResults[0]!.blocking).toBe(true);
    expect(built.determination).toBe('NON_COMPLIANT');
  });

  it('copies rule titles and guidance from the snapshot into the report', () => {
    // So a historical report renders without reading the owning
    // organization's private tables, in either language (§46, §52).
    const built = build([engineResult()], [snapshotRule({ guidanceAr: 'اضبط الهامش العلوي' })]);
    const result = built.report.ruleResults[0]!;
    expect(result.titleEn).toBe('Top margin at least 25 mm');
    expect(result.titleAr).toBe('الهامش العلوي 25 مم على الأقل');
    expect(result.guidanceAr).toBe('اضبط الهامش العلوي');
  });

  it('stores rule results sorted by rule code, whatever order the engine used', () => {
    const rules = [
      snapshotRule({ ruleCode: 'B.RULE' }),
      snapshotRule({ ruleCode: 'A.RULE', displayOrder: 2 }),
    ];
    const forwards = build(
      [engineResult({ ruleCode: 'A.RULE' }), engineResult({ ruleCode: 'B.RULE' })],
      rules,
    );
    const backwards = build(
      [engineResult({ ruleCode: 'B.RULE' }), engineResult({ ruleCode: 'A.RULE' })],
      rules,
    );
    expect(forwards.report.ruleResults.map((item) => item.ruleCode)).toEqual(['A.RULE', 'B.RULE']);
    // And therefore the hashes agree: order of arrival is not meaning.
    expect(forwards.reportHash).toBe(backwards.reportHash);
  });

  it('orders findings for display worst first, independently of storage order', () => {
    const rules = [
      snapshotRule({ ruleCode: 'A.PASSES' }),
      snapshotRule({ ruleCode: 'B.FAILS', displayOrder: 9 }),
    ];
    const built = build(
      [
        engineResult({ ruleCode: 'A.PASSES' }),
        engineResult({ ruleCode: 'B.FAILS', outcome: 'FAIL' }),
      ],
      rules,
    );
    expect(built.report.ruleResults.map((item) => item.ruleCode)).toEqual(['A.PASSES', 'B.FAILS']);
    expect(built.orderedResults.map((item) => item.ruleCode)).toEqual(['B.FAILS', 'A.PASSES']);
  });

  it('records the true violation total alongside the returned sample', () => {
    const built = build([
      engineResult({
        outcome: 'FAIL',
        truncated: true,
        totalViolationCount: 412,
        violations: [
          {
            reasonCode: 'BELOW_MINIMUM',
            actual: { value: '11', unit: 'POINT' },
            expected: { value: '12', unit: 'POINT' },
          },
        ],
      }),
    ]);
    const result = built.report.ruleResults[0]!;
    expect(result.totalViolationCount).toBe(412);
    expect(result.returnedViolationCount).toBe(1);
    expect(result.truncated).toBe(true);
    expect(built.counts.totalViolations).toBe(412);
  });

  it('omits the page when the extractor did not know it', () => {
    // Structural DOCX analysis does not paginate. An invented page number
    // would send a student to look at the wrong part of their thesis (§85).
    const built = build([
      engineResult({
        outcome: 'FAIL',
        totalViolationCount: 1,
        violations: [
          {
            reasonCode: 'BELOW_MINIMUM',
            location: { locationSchemaVersion: 1, nodeId: 'p:3', elementType: 'PARAGRAPH' },
            actual: { value: '11', unit: 'POINT' },
          },
        ],
      }),
    ]);
    expect(built.report.ruleResults[0]!.violations[0]).not.toHaveProperty('page');
  });

  it('is byte-identical for the same evaluation built twice', () => {
    const first = build([engineResult()]);
    const second = build([engineResult()]);
    expect(second.canonicalJson).toBe(first.canonicalJson);
    expect(second.reportHash).toBe(first.reportHash);
  });

  it('gives the same evaluation hash to the same outcome generated at a different time', () => {
    const first = build([engineResult()], [snapshotRule()], new Date('2026-01-01T00:00:00.000Z'));
    const second = build([engineResult()], [snapshotRule()], new Date('2027-06-30T23:59:59.000Z'));
    expect(second.evaluationHash).toBe(first.evaluationHash);
    // …while the report hash differs, because the reports are different.
    expect(second.reportHash).not.toBe(first.reportHash);
  });

  it('leaves the score null rather than zero when nothing deterministic resolved', () => {
    const built = build(
      [engineResult({ outcome: 'INDETERMINATE', requiresReview: true, evaluationMode: 'MANUAL' })],
      [snapshotRule({ evaluationMode: 'MANUAL' })],
    );
    expect(built.score.value).toBeNull();
    expect(built.report.score.value).toBeNull();
  });

  it('counts a review-required rule without turning it into a failure', () => {
    const built = build(
      [
        engineResult({
          outcome: 'INDETERMINATE',
          requiresReview: true,
          evaluationMode: 'AI_ASSISTED',
        }),
      ],
      [snapshotRule({ evaluationMode: 'AI_ASSISTED' })],
    );
    expect(built.counts.failedRules).toBe(0);
    expect(built.counts.reviewRequiredRules).toBe(1);
    expect(built.determination).toBe('REVIEW_REQUIRED');
  });
});
