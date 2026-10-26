import { Injectable } from '@nestjs/common';
import {
  AppError,
  CHECK_ORCHESTRATOR_VERSION,
  ComplianceDetermination,
  PalCertErrorCode,
  REPORT_CANONICALIZATION_VERSION,
  REPORT_SCHEMA_VERSION,
  assertCheckReport,
  compareFindings,
  computeEvaluationHash,
  canonicalizeJson,
  sha256Hex,
  determineCompliance,
  computeDeterministicScore,
  type CheckReport,
  type DeterministicScore,
  type EvaluationResponse,
  type ReportCounts,
  type ReportRuleResult,
  type ReportViolation,
  type RuleEvaluationResult,
  type ScorableRule,
} from '@palcert/contracts';

/**
 * The rule metadata a report needs, taken from the standard snapshot.
 *
 * Copied into the report rather than joined at render time: a historical
 * report must render for ever without reading the owning organization's
 * private tables, and without being rewritten when the standard changes
 * (§46, §52).
 */
export interface SnapshotRule {
  readonly ruleCode: string;
  readonly category: string | null;
  readonly severity: 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL';
  readonly blocking: boolean;
  readonly evaluationMode: 'DETERMINISTIC' | 'AI_ASSISTED' | 'MANUAL';
  readonly displayOrder: number;
  readonly titleEn: string | null;
  readonly titleAr: string | null;
  readonly guidanceEn: string | null;
  readonly guidanceAr: string | null;
  readonly operator: string | null;
}

export interface BuildReportInput {
  readonly checkId: string;
  readonly checkRunId: string;
  readonly ownerUserId: string;
  readonly document: CheckReport['document'];
  readonly organization: CheckReport['organization'];
  readonly standard: CheckReport['standard'];
  readonly analysis: CheckReport['analysis'];
  readonly evaluation: EvaluationResponse;
  readonly snapshotRules: readonly SnapshotRule[];
  readonly generatedAt: Date;
}

export interface BuiltReport {
  readonly report: CheckReport;
  readonly reportHash: string;
  readonly evaluationHash: string;
  readonly canonicalJson: string;
  readonly determination: ComplianceDetermination;
  readonly score: DeterministicScore;
  readonly counts: ReportCounts;
  /** Findings in presentation order: worst first, stable within a rank (§44). */
  readonly orderedResults: readonly ReportRuleResult[];
}

/**
 * Turn engine output into the immutable report (§41–§50).
 *
 * Everything here is a pure function of its inputs. It reads no database, has
 * no clock of its own, and calls no model: the same evaluation of the same
 * document against the same standard must produce byte-identical output on any
 * machine on any day, or the hashes it computes would mean nothing.
 */
@Injectable()
export class CheckReportBuilder {
  build(input: BuildReportInput): BuiltReport {
    const bySnapshot = new Map(input.snapshotRules.map((rule) => [rule.ruleCode, rule]));

    // A result for a rule the snapshot does not contain means the engine was
    // given rules from somewhere else. Fail closed rather than store evidence
    // that cannot be traced to the standard version the check captured (§39).
    for (const result of input.evaluation.results) {
      if (!bySnapshot.has(result.ruleCode)) {
        throw new AppError(PalCertErrorCode.CHECK_EVALUATION_FAILED, {
          message: 'The evaluation could not be recorded.',
          internalContext: { reason: 'result for a rule outside the snapshot' },
        });
      }
    }

    const ruleResults = input.evaluation.results.map((result) =>
      this.toReportResult(result, bySnapshot.get(result.ruleCode)!),
    );

    const determination = determineCompliance({
      results: ruleResults.map((result) => ({
        outcome: result.outcome,
        blocking: result.blocking,
        evaluationMode: result.evaluationMode,
        requiresReview: result.requiresReview,
        // Carried so advisory results aggregate into nothing (Checkpoint 16).
        evidenceLevel: result.evidenceLevel,
      })),
    }).determination;

    const score = computeDeterministicScore(
      ruleResults.map<ScorableRule>((result) => ({
        severity: result.severity,
        evaluationMode: result.evaluationMode,
        outcome: result.outcome,
        evidenceLevel: result.evidenceLevel,
      })),
    );

    const counts = countOf(ruleResults);

    // Stored in snapshot order — sorted by rule code, exactly as the standard
    // canonicalization emitted them — so the hash never depends on the order
    // the engine happened to answer in.
    const canonicalOrder = [...ruleResults].sort((a, b) =>
      a.ruleCode < b.ruleCode ? -1 : a.ruleCode > b.ruleCode ? 1 : 0,
    );

    const engine = this.engineInfo(input);
    const evaluationHash = computeEvaluationHash({
      documentSha256: input.document.sha256,
      standardContentHash: input.standard.contentHash,
      analysisArtifactSha256: input.analysis.artifactSha256,
      analyzerName: input.analysis.analyzerName,
      analyzerVersion: input.analysis.analyzerVersion,
      factSchemaVersion: input.analysis.factSchemaVersion,
      ruleEngineName: engine.ruleEngineName,
      ruleEngineVersion: engine.ruleEngineVersion,
      ruleSchemaVersion: engine.ruleSchemaVersion,
      orchestratorVersion: engine.orchestratorVersion,
      determination,
      score: score.value,
      scoreCoverage: score.coverage,
      results: canonicalOrder,
    });

    const report: CheckReport = {
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
      reportCanonicalizationVersion: REPORT_CANONICALIZATION_VERSION,
      checkId: input.checkId,
      checkRunId: input.checkRunId,
      ownerUserId: input.ownerUserId,
      document: input.document,
      organization: input.organization,
      standard: input.standard,
      analysis: input.analysis,
      engine,
      determination,
      score: {
        value: score.value,
        coverage: score.coverage,
        complete: score.complete,
        passedWeight: score.passedWeight,
        evaluatedWeight: score.evaluatedWeight,
        unresolvedWeight: score.unresolvedWeight,
      },
      counts,
      ruleResults: canonicalOrder,
      evaluationHash,
      generatedAt: input.generatedAt.toISOString(),
    };

    // The report is validated against the shared contract before it is hashed
    // or stored. An immutable artifact is the wrong place to discover that a
    // field was the wrong shape (§47).
    assertCheckReport(report);

    const canonicalJson = canonicalizeJson(report);
    const reportHash = sha256Hex(canonicalJson);

    return {
      report,
      reportHash,
      evaluationHash,
      canonicalJson,
      determination,
      score,
      counts,
      orderedResults: [...ruleResults].sort(compareFindings),
    };
  }

  private engineInfo(input: BuildReportInput): CheckReport['engine'] {
    return {
      ruleEngineName: input.evaluation.engine.engineName,
      ruleEngineVersion: input.evaluation.engine.engineVersion,
      ruleSchemaVersion: input.evaluation.engine.ruleSchemaVersion,
      factSchemaVersion: input.evaluation.engine.factSchemaVersion,
      orchestratorVersion: CHECK_ORCHESTRATOR_VERSION,
    };
  }

  /**
   * One engine result, projected onto the report.
   *
   * Severity, blocking and evaluation mode come from the *snapshot*, not from
   * the engine's echo of them: the standard version the check captured is the
   * authority on how serious its own rules are.
   */
  private toReportResult(result: RuleEvaluationResult, rule: SnapshotRule): ReportRuleResult {
    const violations = result.violations.map(toReportViolation);
    return {
      ruleCode: result.ruleCode,
      category: rule.category ?? 'GENERAL',
      severity: rule.severity,
      blocking: rule.blocking,
      evaluationMode: rule.evaluationMode,
      outcome: result.outcome,
      reasonCode: result.reasonCode,
      evidenceLevel: result.evidenceLevel,
      requiresReview: result.requiresReview,
      displayOrder: rule.displayOrder,
      ...(rule.titleEn !== null ? { titleEn: rule.titleEn } : {}),
      ...(rule.titleAr !== null ? { titleAr: rule.titleAr } : {}),
      ...(rule.guidanceEn !== null ? { guidanceEn: rule.guidanceEn } : {}),
      ...(rule.guidanceAr !== null ? { guidanceAr: rule.guidanceAr } : {}),
      ...(result.operator !== undefined ? { operator: result.operator } : {}),
      counts: result.counts,
      totalViolationCount: result.totalViolationCount,
      // The stored list may be capped; the total says what was really found,
      // so a report never pretends to be exhaustive when it is not (§45).
      returnedViolationCount: violations.length,
      truncated: result.truncated,
      violations,
    };
  }
}

function toReportViolation(violation: RuleEvaluationResult['violations'][number]): ReportViolation {
  const location = violation.location;
  return {
    reasonCode: violation.reasonCode,
    ...(location?.nodeId !== undefined ? { nodeId: location.nodeId } : {}),
    ...(location?.path !== undefined ? { path: location.path } : {}),
    ...(location?.elementType !== undefined ? { elementType: location.elementType } : {}),
    ...(location?.sectionKey !== undefined ? { sectionKey: location.sectionKey } : {}),
    ...(location?.ordinal !== undefined ? { ordinal: location.ordinal } : {}),
    // Only when the extractor genuinely knew it. Structural DOCX analysis
    // does not paginate, and an invented page number is worse than none (§85).
    ...(location?.page !== undefined ? { page: location.page } : {}),
    ...(violation.expected?.value !== undefined ? { expectedValue: violation.expected.value } : {}),
    ...(violation.expected?.unit !== undefined ? { expectedUnit: violation.expected.unit } : {}),
    ...(violation.actual.value !== undefined ? { actualValue: violation.actual.value } : {}),
    ...(violation.actual.unit !== undefined ? { actualUnit: violation.actual.unit } : {}),
    ...(violation.tolerance !== undefined ? { tolerance: violation.tolerance } : {}),
  };
}

/** Every counter the report carries, in one pass. */
function countOf(results: readonly ReportRuleResult[]): ReportCounts {
  const counts: ReportCounts = {
    totalRules: results.length,
    passedRules: 0,
    failedRules: 0,
    notApplicableRules: 0,
    reviewRequiredRules: 0,
    indeterminateRules: 0,
    errorRules: 0,
    blockingFailures: 0,
    criticalFailures: 0,
    majorFailures: 0,
    minorFailures: 0,
    infoFailures: 0,
    totalViolations: 0,
    returnedViolations: 0,
    truncatedRules: 0,
  };

  const mutable = counts as { -readonly [K in keyof ReportCounts]: ReportCounts[K] };
  for (const result of results) {
    mutable.totalViolations += result.totalViolationCount;
    mutable.returnedViolations += result.returnedViolationCount;
    if (result.truncated) mutable.truncatedRules += 1;
    // Review is a property of the rule, not an outcome: an AI-assisted rule
    // that nobody has resolved is counted here whatever the engine returned.
    if (result.requiresReview) mutable.reviewRequiredRules += 1;

    switch (result.outcome) {
      case 'PASS':
        mutable.passedRules += 1;
        break;
      case 'NOT_APPLICABLE':
        mutable.notApplicableRules += 1;
        break;
      case 'INDETERMINATE':
        mutable.indeterminateRules += 1;
        break;
      case 'ERROR':
        mutable.errorRules += 1;
        break;
      case 'FAIL':
        mutable.failedRules += 1;
        if (result.blocking) mutable.blockingFailures += 1;
        if (result.severity === 'CRITICAL') mutable.criticalFailures += 1;
        if (result.severity === 'MAJOR') mutable.majorFailures += 1;
        if (result.severity === 'MINOR') mutable.minorFailures += 1;
        if (result.severity === 'INFO') mutable.infoFailures += 1;
        break;
    }
  }
  return counts;
}
