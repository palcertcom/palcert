/**
 * Document analysis: the derived, immutable result of reading one version.
 *
 * A `DocumentAnalysis` is not a document and not a check. It is the record
 * that *this analyzer version*, reading *these exact bytes*, produced *this
 * artifact* — and it exists so that a compliance result recorded in Phase 7
 * can still be explained after the analyzer has been rewritten twice
 * (ADR-0041).
 *
 * Nothing here carries document content. The facts and the structural model
 * live in the private artifact in derived object storage; the database keeps
 * identity, integrity and counters.
 */

/**
 * The analysis lifecycle.
 *
 * Deliberately smaller than the version lifecycle: analysis has no content
 * verdict to deliver. It either produced an artifact or it did not.
 */
export const DocumentAnalysisStatus = {
  /** Recorded, queued, not yet started. */
  PENDING: 'PENDING',
  /** A worker holds it. */
  RUNNING: 'RUNNING',
  /** An artifact exists and is immutable from here on. */
  SUCCEEDED: 'SUCCEEDED',
  /** Terminal. The failure code says whether another attempt could help. */
  FAILED: 'FAILED',
} as const;

export type DocumentAnalysisStatus =
  (typeof DocumentAnalysisStatus)[keyof typeof DocumentAnalysisStatus];

export const DOCUMENT_ANALYSIS_TRANSITIONS: Readonly<
  Record<DocumentAnalysisStatus, readonly DocumentAnalysisStatus[]>
> = {
  // Re-entrant: an at-least-once delivery may re-claim a job it already holds.
  PENDING: ['RUNNING', 'FAILED'],
  RUNNING: ['RUNNING', 'SUCCEEDED', 'FAILED'],
  // A successful analysis is immutable. A new analyzer version means a new
  // row, never a rewritten one (§7).
  SUCCEEDED: [],
  // Retrying a failed analysis creates a new row too, so its record of what
  // went wrong survives.
  FAILED: [],
};

export function canTransitionDocumentAnalysis(
  from: DocumentAnalysisStatus,
  to: DocumentAnalysisStatus,
): boolean {
  return DOCUMENT_ANALYSIS_TRANSITIONS[from].includes(to);
}

/** Analyzers PalCert can run. DOCX today; PDF arrives in Phase 13. */
export const AnalyzerName = {
  DOCX: 'palcert-docx',
} as const;

export type AnalyzerName = (typeof AnalyzerName)[keyof typeof AnalyzerName];

/**
 * Why an analysis failed.
 *
 * Split the way retries need it: a `DOCUMENT_*` code describes the document
 * and will fail identically for ever, so it is never retried. An
 * `ENGINE_*` code describes the infrastructure and is (§91).
 */
export const DocumentAnalysisFailureCode = {
  /** The stored object did not match the version's recorded SHA-256 (§5). */
  DOCUMENT_SOURCE_INTEGRITY_FAILED: 'DOCUMENT_SOURCE_INTEGRITY_FAILED',
  /** The package or its XML cannot be read. */
  DOCUMENT_INVALID: 'DOCUMENT_INVALID',
  /** A WordprocessingML profile PalCert does not support. */
  DOCUMENT_PROFILE_UNSUPPORTED: 'DOCUMENT_PROFILE_UNSUPPORTED',
  /**
   * The document is encrypted and needs a password (Phase 13 §19).
   *
   * PalCert does not collect one, does not try the empty owner password, and
   * never brute-forces. The check fails and nothing is charged — the same
   * bytes will need the same password on the third attempt, so this is
   * permanent rather than transient.
   */
  DOCUMENT_PASSWORD_REQUIRED: 'DOCUMENT_PASSWORD_REQUIRED',
  /** Encrypted with a scheme PalCert will not open (Phase 13 §19). */
  DOCUMENT_ENCRYPTION_UNSUPPORTED: 'DOCUMENT_ENCRYPTION_UNSUPPORTED',
  /** The document exceeded a documented analyzer limit (§80). */
  DOCUMENT_TOO_COMPLEX: 'DOCUMENT_TOO_COMPLEX',
  /** The analyzer service was unreachable or erroring. */
  ENGINE_UNAVAILABLE: 'ENGINE_UNAVAILABLE',
  /** Analysis exceeded its time budget (§82). */
  ENGINE_TIMEOUT: 'ENGINE_TIMEOUT',
  /** Derived object storage could not be read or written. */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  /** The artifact did not survive its own integrity check. */
  ARTIFACT_INVALID: 'ARTIFACT_INVALID',
  /** Anything unanticipated. Transient by default: an unknown error is not
   * evidence that the user's document is bad. */
  ENGINE_ERROR: 'ENGINE_ERROR',
} as const;

export type DocumentAnalysisFailureCode =
  (typeof DocumentAnalysisFailureCode)[keyof typeof DocumentAnalysisFailureCode];

/** Failures that the same bytes would produce again, so retrying is waste. */
export const PERMANENT_ANALYSIS_FAILURES: readonly DocumentAnalysisFailureCode[] = [
  DocumentAnalysisFailureCode.DOCUMENT_SOURCE_INTEGRITY_FAILED,
  DocumentAnalysisFailureCode.DOCUMENT_INVALID,
  DocumentAnalysisFailureCode.DOCUMENT_PROFILE_UNSUPPORTED,
  DocumentAnalysisFailureCode.DOCUMENT_TOO_COMPLEX,
  DocumentAnalysisFailureCode.DOCUMENT_PASSWORD_REQUIRED,
  DocumentAnalysisFailureCode.DOCUMENT_ENCRYPTION_UNSUPPORTED,
];

export function isPermanentAnalysisFailure(code: DocumentAnalysisFailureCode): boolean {
  return PERMANENT_ANALYSIS_FAILURES.includes(code);
}

/**
 * The compatibility identity of an analysis (§8).
 *
 * Two analyses are interchangeable only if all four agree. Anything else is a
 * different reading of the document and deserves its own row, so a Phase 7
 * check can always name exactly what produced its facts.
 */
export interface AnalysisCompatibilityKey {
  readonly documentVersionId: string;
  readonly analyzerName: string;
  readonly analyzerVersion: string;
  readonly factSchemaVersion: number;
}

export function analysisCompatibilityKey(key: AnalysisCompatibilityKey): string {
  return [
    key.documentVersionId,
    key.analyzerName,
    key.analyzerVersion,
    String(key.factSchemaVersion),
  ].join(':');
}

/** Counters safe to store in the database and to show an operator (§113). */
export interface DocumentAnalysisSummary {
  readonly factCount: number;
  readonly warningCount: number;
  readonly paragraphCount: number;
  readonly runCount: number;
  readonly tableCount: number;
  readonly sectionCount: number;
  readonly figureCount: number;
  readonly equationCount: number;
  readonly noteCount: number;
  readonly commentCount: number;
  readonly bodyWordCount: number;
  readonly headingCount: number;
}

/**
 * What an analysis looks like to the API.
 *
 * Note what is absent: no object key, no bucket, no artifact URL. The artifact
 * is an internal implementation detail and no ordinary user route exposes it
 * (§94, §119).
 */
export interface DocumentAnalysisView {
  readonly id: string;
  readonly documentVersionId: string;
  readonly status: DocumentAnalysisStatus;
  readonly analyzerName: string;
  readonly analyzerVersion: string;
  readonly factSchemaVersion: number;
  readonly analysisSchemaVersion: number;
  readonly factCount: number | null;
  readonly warningCount: number | null;
  readonly warningCodes: readonly string[];
  readonly failureCode: DocumentAnalysisFailureCode | null;
  readonly retryable: boolean;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
}
