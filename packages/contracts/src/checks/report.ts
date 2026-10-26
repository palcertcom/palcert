import { createHash } from 'node:crypto';
import type { CheckReport } from './report.generated.js';
import { REPORT_CANONICALIZATION_VERSION } from './check.js';

/**
 * Canonicalizing and hashing a report (§42, §43, §78).
 *
 * A report hash is only worth having if two people who serialize the same
 * report get the same bytes. `JSON.stringify` does not give that: key order
 * follows insertion, and a refactor that builds an object differently changes
 * the hash of a report whose meaning never moved.
 *
 * So canonicalization is RFC 8785 (JCS): object keys sorted by their UTF-16
 * code units, no insignificant whitespace, and — the part that matters most
 * here — **no JSON numbers anywhere in the report**. Every numeric value in
 * the report schema is either an integer or a decimal string, which sidesteps
 * JCS's number formatting rules entirely and keeps the canonical form stable
 * across languages.
 *
 * The version is stored with every hash. If this behaviour ever has to change,
 * it changes under a new version number and old reports keep verifying against
 * the rules they were written under (§78).
 */

/** RFC 8785 canonical JSON, for the value model the report schema allows. */
export function canonicalizeJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    // The report schema carries every non-integer as a decimal string, so a
    // fractional number here means something was built wrong. Failing loudly
    // is better than silently hashing a float whose rendering differs between
    // runtimes.
    if (!Number.isInteger(value)) {
      throw new Error('canonical report values must not contain fractional numbers');
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error('canonical report values must not contain unsafe integers');
    }
    return value.toString();
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // Undefined members are absent, not null: the schema distinguishes them.
      .filter(([, item]) => item !== undefined)
      // RFC 8785 sorts by UTF-16 code unit, which is what the default
      // comparison on JavaScript strings already does.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${serialize(item)}`).join(',')}}`;
  }
  throw new Error(`canonical report values must not contain ${typeof value}`);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The hash of the complete report record. */
export function computeReportHash(report: CheckReport): string {
  if (report.reportCanonicalizationVersion !== REPORT_CANONICALIZATION_VERSION) {
    throw new Error(
      `cannot hash a report canonicalized at version ${report.reportCanonicalizationVersion}`,
    );
  }
  return sha256Hex(canonicalizeJson(report));
}

/**
 * The semantic evaluation, as opposed to the report record (§43).
 *
 * Two hashes exist because two different questions are asked of them. "Is this
 * the same report?" changes when the check id or the generation time changes.
 * "Did the engine reach the same conclusion?" must not — re-running the same
 * document against the same standard with the same engine has to be provably
 * identical even though it is a different check.
 *
 * So the evaluation hash covers the inputs' identities and the outcomes, and
 * deliberately excludes the check id, the run id, the owner and the timestamp.
 */
export interface EvaluationHashInput {
  readonly documentSha256: string;
  readonly standardContentHash: string;
  readonly analysisArtifactSha256: string;
  readonly analyzerName: string;
  readonly analyzerVersion: string;
  readonly factSchemaVersion: number;
  readonly ruleEngineName: string;
  readonly ruleEngineVersion: string;
  readonly ruleSchemaVersion: number;
  readonly orchestratorVersion: string;
  readonly determination: string;
  readonly score: string | null;
  readonly scoreCoverage: string | null;
  readonly results: readonly {
    readonly ruleCode: string;
    readonly outcome: string;
    readonly reasonCode: string;
    readonly requiresReview: boolean;
    readonly totalViolationCount: number;
  }[];
}

export function computeEvaluationHash(input: EvaluationHashInput): string {
  const canonical = {
    analysisArtifactSha256: input.analysisArtifactSha256,
    analyzerName: input.analyzerName,
    analyzerVersion: input.analyzerVersion,
    determination: input.determination,
    documentSha256: input.documentSha256,
    factSchemaVersion: input.factSchemaVersion,
    orchestratorVersion: input.orchestratorVersion,
    // Sorted by rule code so the hash cannot depend on evaluation order.
    results: [...input.results]
      .map((result) => ({
        outcome: result.outcome,
        reasonCode: result.reasonCode,
        requiresReview: result.requiresReview,
        ruleCode: result.ruleCode,
        totalViolationCount: result.totalViolationCount,
      }))
      .sort((left, right) =>
        left.ruleCode < right.ruleCode ? -1 : left.ruleCode > right.ruleCode ? 1 : 0,
      ),
    ruleEngineName: input.ruleEngineName,
    ruleEngineVersion: input.ruleEngineVersion,
    ruleSchemaVersion: input.ruleSchemaVersion,
    score: input.score,
    scoreCoverage: input.scoreCoverage,
    standardContentHash: input.standardContentHash,
  };
  return sha256Hex(canonicalizeJson(canonical));
}

/**
 * Deterministic finding order for reports and lists (§49, §77).
 *
 * Fixed here so that the stored report, the API and the UI all agree, and so
 * that nothing depends on database insertion order or worker timing.
 */
export const FINDING_RANK: Readonly<Record<string, number>> = {
  BLOCKING_FAILURE: 0,
  CRITICAL_FAILURE: 1,
  MAJOR_FAILURE: 2,
  MINOR_FAILURE: 3,
  INFO_FAILURE: 4,
  REVIEW_REQUIRED: 5,
  INDETERMINATE: 6,
  PASSED: 7,
  NOT_APPLICABLE: 8,
};

export interface RankableResult {
  readonly outcome: string;
  readonly severity: string;
  readonly blocking: boolean;
  readonly requiresReview: boolean;
  readonly displayOrder: number;
  readonly ruleCode: string;
}

export function findingRank(result: RankableResult): number {
  if (result.outcome === 'FAIL') {
    if (result.blocking) return FINDING_RANK.BLOCKING_FAILURE!;
    return (
      {
        CRITICAL: FINDING_RANK.CRITICAL_FAILURE!,
        MAJOR: FINDING_RANK.MAJOR_FAILURE!,
        MINOR: FINDING_RANK.MINOR_FAILURE!,
        INFO: FINDING_RANK.INFO_FAILURE!,
      }[result.severity] ?? FINDING_RANK.MINOR_FAILURE!
    );
  }
  if (result.requiresReview) return FINDING_RANK.REVIEW_REQUIRED!;
  if (result.outcome === 'INDETERMINATE' || result.outcome === 'ERROR') {
    return FINDING_RANK.INDETERMINATE!;
  }
  if (result.outcome === 'NOT_APPLICABLE') return FINDING_RANK.NOT_APPLICABLE!;
  return FINDING_RANK.PASSED!;
}

/** Compare two results for display: rank, then the standard's own order. */
export function compareFindings(left: RankableResult, right: RankableResult): number {
  const rank = findingRank(left) - findingRank(right);
  if (rank !== 0) return rank;
  if (left.displayOrder !== right.displayOrder) return left.displayOrder - right.displayOrder;
  return left.ruleCode < right.ruleCode ? -1 : left.ruleCode > right.ruleCode ? 1 : 0;
}
