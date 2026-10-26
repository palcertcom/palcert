/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: contracts/schemas/check-report.schema.json
 * Regenerate: pnpm --filter @palcert/contracts run generate:evaluation
 *
 * Editing this by hand would reintroduce exactly the drift the generation step
 * exists to prevent.
 */
/**
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "Sha256Hex".
 */
export type Sha256Hex = string;
/**
 * A standard's content hash, which carries its algorithm prefix.
 *
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "ContentHash".
 */
export type ContentHash = string;
/**
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "Uuid".
 */
export type Uuid = string;
/**
 * An exact decimal. Never a JSON number: binary floating point cannot represent 0.1, and a score that a reader recomputes must match to the digit.
 *
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "DecimalString".
 */
export type DecimalString = string;
/**
 * What PalCert concluded, on its own axis and never merged with processing status. INDETERMINATE is not a soft FAIL: it means the evidence could not decide, and turning that into a failure would blame a document for what PalCert could not read.
 *
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "ComplianceDetermination".
 */
export type ComplianceDetermination =
  'COMPLIANT' | 'NON_COMPLIANT' | 'REVIEW_REQUIRED' | 'INDETERMINATE';
/**
 * Identifies the semantic evaluation: the same document, standard and engine versions producing the same outcomes hash identically, regardless of when the check ran or what it was called.
 */
export type Sha256Hex1 = string;

/**
 * The immutable machine report a completed check produces.
 *
 * It is deliberately language-neutral: codes, typed values, and the rule titles and guidance the standard's author wrote in both languages. No sentence in it depends on the reader's UI language, because one artifact must mean the same thing to everyone who verifies it later.
 *
 * It carries every identity needed to reproduce the outcome — the document version and its digest, the standard version and its content hash, the analysis and its artifact digest, and the analyzer and engine versions — so a result recorded today can still be explained after both have been replaced.
 */
export interface PalCertCheckReport {
  [k: string]: unknown;
}
/**
 * Snapshot of the standard's owner, so a historical report renders without joining live organization tables. Public catalogue fields only.
 *
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "ReportOrganization".
 */
export interface ReportOrganization {
  organizationId: Uuid;
  displayName: string;
  verificationStatus?: 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
}
/**
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "ReportStandard".
 */
export interface ReportStandard {
  standardId: Uuid;
  standardVersionId: Uuid;
  code: string;
  nameEn: string;
  nameAr: string;
  versionLabel: string;
  contentHash: ContentHash;
  canonicalizationVersion: number;
  ruleSchemaVersion: number;
  documentTypeId?: Uuid;
  documentTypeName?: string;
}
/**
 * The exact version checked. No filename: it is user content and the report is an integrity record, not a copy of the document.
 *
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "ReportDocument".
 */
export interface ReportDocument {
  documentId: Uuid;
  documentVersionId: Uuid;
  versionNumber: number;
  sha256: Sha256Hex;
  format: 'DOCX' | 'PDF';
  sizeBytes?: number;
}
/**
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "ReportAnalysis".
 */
export interface ReportAnalysis {
  analysisId: Uuid;
  analyzerName: string;
  analyzerVersion: string;
  factSchemaVersion: number;
  analysisSchemaVersion: number;
  artifactSha256: Sha256Hex;
  factCount?: number;
  /**
   * @maxItems 100
   */
  warningCodes?: string[];
}
/**
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "ReportEngine".
 */
export interface ReportEngine {
  ruleEngineName: string;
  ruleEngineVersion: string;
  ruleSchemaVersion: number;
  factSchemaVersion: number;
  /**
   * The check orchestrator's own semantic version. Changing how a determination or a score is computed changes this, independently of the rule engine.
   */
  orchestratorVersion: string;
}
/**
 * The deterministic compliance score. AI-assisted and manual rules never contribute: a number nobody could reproduce from the evidence would be a number PalCert cannot defend.
 *
 * `value` is null when no deterministic rule with a positive weight was resolved — which is different from zero, and must never render as 0%.
 *
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "ReportScore".
 */
export interface ReportScore {
  value: DecimalString | null;
  /**
   * How much of the scorable deterministic weight was actually resolved. 1 means every scorable rule produced a verdict.
   */
  coverage: DecimalString | null;
  /**
   * True only when no deterministic rule was left unresolved. A partial score must never be presented as authoritative.
   */
  complete: boolean;
  passedWeight: DecimalString;
  evaluatedWeight: DecimalString;
  unresolvedWeight: DecimalString;
}
/**
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "ReportCounts".
 */
export interface ReportCounts {
  totalRules: number;
  passedRules: number;
  failedRules: number;
  notApplicableRules: number;
  reviewRequiredRules: number;
  indeterminateRules: number;
  errorRules: number;
  blockingFailures: number;
  criticalFailures: number;
  majorFailures: number;
  minorFailures: number;
  infoFailures: number;
  totalViolations: number;
  returnedViolations: number;
  truncatedRules: number;
}
/**
 * One rule, as evaluated. Titles and guidance are copied from the standard snapshot so a historical report never needs to read a private organization table to render.
 *
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "ReportRuleResult".
 */
export interface ReportRuleResult {
  ruleCode: string;
  category: string;
  severity: 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL';
  blocking: boolean;
  evaluationMode: 'DETERMINISTIC' | 'AI_ASSISTED' | 'MANUAL';
  outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'INDETERMINATE' | 'ERROR';
  reasonCode: string;
  evidenceLevel: 'NONE' | 'DETERMINISTIC' | 'ADVISORY' | 'AI_PROVISIONAL' | 'HUMAN_CONFIRMED';
  requiresReview: boolean;
  displayOrder: number;
  titleEn?: string;
  titleAr?: string;
  guidanceEn?: string;
  guidanceAr?: string;
  operator?: string;
  counts: {
    matchedFacts: number;
    evaluatedFacts: number;
    passedFacts: number;
    failedFacts: number;
    indeterminateFacts: number;
  };
  totalViolationCount: number;
  returnedViolationCount: number;
  truncated: boolean;
  /**
   * @maxItems 1000
   */
  violations: ReportViolation[];
}
/**
 * One failing observation. Values are bounded: an actual value may legitimately be '11 pt', but it must never become an excuse to copy a whole sensitive text field into a report (§87).
 *
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "ReportViolation".
 */
export interface ReportViolation {
  reasonCode: string;
  nodeId?: string;
  /**
   * @maxItems 32
   */
  path?: string[];
  elementType?: string;
  sectionKey?: string;
  ordinal?: number;
  /**
   * Present only when the extractor genuinely knew it. Structural DOCX analysis never does, and never invents one.
   */
  page?: number;
  expectedValue?: string;
  expectedUnit?: string;
  actualValue?: string;
  actualUnit?: string;
  tolerance?: DecimalString;
}
/**
 * The complete immutable report. Hashing is over the canonical form of this object at `reportCanonicalizationVersion`; nothing outside it contributes to `reportHash`.
 *
 * This interface was referenced by `PalCertCheckReport`'s JSON-Schema
 * via the `definition` "CheckReport".
 */
export interface CheckReport {
  reportSchemaVersion: number;
  reportCanonicalizationVersion: number;
  checkId: Uuid;
  checkRunId: Uuid;
  ownerUserId: Uuid;
  document: ReportDocument;
  organization: ReportOrganization;
  standard: ReportStandard;
  analysis: ReportAnalysis;
  engine: ReportEngine;
  determination: ComplianceDetermination;
  score: ReportScore;
  counts: ReportCounts;
  /**
   * @maxItems 1000
   */
  ruleResults: ReportRuleResult[];
  evaluationHash: Sha256Hex1;
  generatedAt: string;
}
