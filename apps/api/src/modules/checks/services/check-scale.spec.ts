import { computeDeterministicScore, determineCompliance } from '@palcert/contracts';
import type { EvaluationResponse, RuleEvaluationResult } from '@palcert/contracts';
import { CheckReportBuilder, type SnapshotRule } from './check-report-builder.service';

/**
 * Report building at the size a real standard reaches (§128).
 *
 * A university standard can carry a couple of hundred rules, and a long thesis
 * can violate one of them on every paragraph. The numbers here are the shape
 * of the worst realistic case, and the assertion is that building the report,
 * canonicalizing it and hashing it stays comfortably inside a request budget —
 * because if it does not, the failure mode is a worker that times out on
 * exactly the documents that most need checking.
 */
describe('CheckReportBuilder at scale', () => {
  const RULES = 200;
  const VIOLATIONS_PER_FAILING_RULE = 1_000;

  function snapshotRules(): SnapshotRule[] {
    return Array.from({ length: RULES }, (_, index) => ({
      ruleCode: `RULE.${String(index).padStart(4, '0')}`,
      category: 'TYPOGRAPHY',
      severity: (['INFO', 'MINOR', 'MAJOR', 'CRITICAL'] as const)[index % 4]!,
      blocking: index % 3 === 0,
      evaluationMode: 'DETERMINISTIC' as const,
      displayOrder: index,
      titleEn: `Rule ${index}`,
      titleAr: `قاعدة ${index}`,
      guidanceEn: null,
      guidanceAr: null,
      operator: 'EQUALS',
    }));
  }

  function results(rules: SnapshotRule[]): RuleEvaluationResult[] {
    return rules.map((rule, index) => {
      const failing = index % 5 === 0;
      return {
        ruleCode: rule.ruleCode,
        outcome: failing ? 'FAIL' : 'PASS',
        reasonCode: failing ? 'VALUE_MISMATCH' : 'SATISFIED',
        evidenceLevel: 'DETERMINISTIC',
        requiresReview: false,
        blocking: rule.blocking,
        severity: rule.severity,
        evaluationMode: 'DETERMINISTIC',
        counts: {
          matchedFacts: 1_000,
          evaluatedFacts: 1_000,
          passedFacts: failing ? 0 : 1_000,
          failedFacts: failing ? 1_000 : 0,
          indeterminateFacts: 0,
        },
        violations: failing
          ? Array.from({ length: VIOLATIONS_PER_FAILING_RULE }, (_, ordinal) => ({
              reasonCode: 'VALUE_MISMATCH' as const,
              location: {
                locationSchemaVersion: 1,
                nodeId: `p:${ordinal}`,
                elementType: 'PARAGRAPH',
                ordinal: ordinal + 1,
              },
              expected: { value: '12', unit: 'POINT' as const },
              actual: { value: '11', unit: 'POINT' as const },
            }))
          : [],
        totalViolationCount: failing ? VIOLATIONS_PER_FAILING_RULE : 0,
        truncated: false,
        engine: {
          engineName: 'palcert-rule-engine',
          engineVersion: '1',
          ruleSchemaVersion: 2,
          factSchemaVersion: 2,
        },
      };
    });
  }

  it('builds, canonicalizes and hashes a 200-rule report well inside budget', () => {
    const rules = snapshotRules();
    const evaluation: EvaluationResponse = {
      documentId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      engine: {
        engineName: 'palcert-rule-engine',
        engineVersion: '1',
        ruleSchemaVersion: 2,
        factSchemaVersion: 2,
      },
      results: results(rules),
    };

    const startedAt = Date.now();
    const built = new CheckReportBuilder().build({
      checkId: '3f1c2b4a-5d6e-4f70-8912-a3b4c5d6e7f8',
      checkRunId: '9a8b7c6d-5e4f-4031-8213-4455667788aa',
      ownerUserId: '11111111-2222-4333-8444-555566667777',
      document: {
        documentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        documentVersionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
        versionNumber: 1,
        sha256: 'a'.repeat(64),
        format: 'DOCX',
      },
      organization: {
        organizationId: 'cccccccc-dddd-4eee-8fff-000011112222',
        displayName: 'Islamic University of Gaza',
        verificationStatus: 'VERIFIED',
      },
      standard: {
        standardId: 'dddddddd-eeee-4fff-8000-111122223333',
        standardVersionId: 'eeeeeeee-ffff-4000-8111-222233334444',
        code: 'IUG.THESIS.FORMAT',
        nameEn: 'IUG Thesis Formatting',
        nameAr: 'تنسيق رسائل الجامعة الإسلامية',
        versionLabel: '1.0',
        contentHash: `sha256:${'b'.repeat(64)}`,
        canonicalizationVersion: 1,
        ruleSchemaVersion: 2,
      },
      analysis: {
        analysisId: '00000000-1111-4222-8333-444455556666',
        analyzerName: 'palcert-docx',
        analyzerVersion: '1',
        factSchemaVersion: 2,
        analysisSchemaVersion: 1,
        artifactSha256: 'c'.repeat(64),
      },
      evaluation,
      snapshotRules: rules,
      generatedAt: new Date('2026-09-13T12:00:00.000Z'),
    });
    const elapsed = Date.now() - startedAt;

    expect(built.report.ruleResults).toHaveLength(RULES);
    expect(built.counts.totalViolations).toBe(40 * VIOLATIONS_PER_FAILING_RULE);
    expect(built.determination).toBe('NON_COMPLIANT');
    // Generous, because a CI machine under load is not a benchmark rig. It
    // still fails loudly if this ever becomes quadratic.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('computes a determination and a score over 200 rules in linear time', () => {
    const rules = snapshotRules();
    const summaries = results(rules).map((result) => ({
      outcome: result.outcome,
      blocking: result.blocking,
      evaluationMode: result.evaluationMode,
      requiresReview: result.requiresReview,
      severity: result.severity,
    }));

    const startedAt = Date.now();
    for (let round = 0; round < 100; round += 1) {
      determineCompliance({ results: summaries });
      computeDeterministicScore(summaries);
    }
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
