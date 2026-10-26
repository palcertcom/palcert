import type { DocumentFormat } from '../documents/document.js';
import type { ServiceBillingView } from '../finance/views.js';
import type { CheckFailureCode, CheckStatus, ComplianceDetermination } from './check.js';

/**
 * What the API returns. Deliberately complete enough that the browser never
 * recomputes compliance (§91): the determination, the score and the counts are
 * decided once, server-side, and everyone reads the same answer.
 */

/** A standard as the public catalogue shows it. Safe fields only (§20). */
export interface CatalogueOrganizationView {
  readonly id: string;
  readonly displayName: string;
  readonly slug: string;
  readonly verificationStatus: 'VERIFIED';
  readonly standardCount: number;
}

export interface CatalogueDocumentTypeView {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly nameAr: string | null;
  readonly systemCategory: string;
  readonly standardCount: number;
}

export interface CatalogueStandardView {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly documentTypeId: string;
  readonly documentTypeName: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  /** The exact version a check would bind to. */
  readonly standardVersionId: string;
  readonly versionLabel: string;
  readonly ruleCount: number;
  readonly effectiveFrom: string | null;
}

export interface CheckScoreView {
  readonly value: string | null;
  readonly display: number | null;
  readonly coverage: string | null;
  readonly complete: boolean;
}

export interface CheckSummaryCounts {
  readonly totalRules: number;
  readonly passedRules: number;
  readonly failedRules: number;
  readonly notApplicableRules: number;
  readonly reviewRequiredRules: number;
  readonly indeterminateRules: number;
  readonly blockingFailures: number;
  readonly criticalFailures: number;
  readonly majorFailures: number;
  readonly minorFailures: number;
  readonly infoFailures: number;
  readonly totalViolations: number;
}

export interface DocumentCheckView {
  readonly id: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly documentVersionNumber: number;
  readonly documentName: string;
  /** The format PalCert detected from the bytes in Phase 5 (§83). */
  readonly documentFormat: DocumentFormat | null;
  /**
   * What the PDF analyzer observed about the document itself (Phase 13 §153).
   *
   * `null` for a DOCX, and for a PDF whose analysis has not settled. These are
   * counters and classifications only — never a title, a filename or any
   * extracted text (§107) — and they exist because a PDF user needs three
   * things a DOCX user never sees: whether their pages had readable text,
   * whether the file declares its structure, and that PalCert does not
   * correct PDFs.
   */
  readonly pdfDocument: PdfDocumentView | null;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly documentTypeName: string;
  readonly standardId: string;
  readonly standardCode: string;
  readonly standardName: string;
  readonly standardVersionId: string;
  readonly standardVersionLabel: string;
  readonly status: CheckStatus;
  readonly determination: ComplianceDetermination | null;
  readonly score: CheckScoreView | null;
  readonly counts: CheckSummaryCounts | null;
  readonly failureCode: CheckFailureCode | null;
  readonly retryable: boolean;
  readonly reportId: string | null;
  readonly currentRunId: string | null;
  /**
   * What this check cost and where that money currently stands (Phase 11 §89).
   *
   * `null` for a check created before checks were paid for. Those remain
   * readable for ever, and PalCert does not invent a purchase for them — so
   * `billing === null` together with `legacyFree === true` is the honest
   * description of a historical check, and the only way to get one.
   */
  readonly billing: ServiceBillingView | null;
  /** True exactly when this check predates paid checks and carries no purchase. */
  readonly legacyFree: boolean;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
}

export interface CheckViolationView {
  readonly id: string;
  readonly reasonCode: string;
  readonly nodeId: string | null;
  readonly path: readonly string[];
  readonly elementType: string | null;
  readonly sectionKey: string | null;
  readonly ordinal: number | null;
  /** Absent for structural DOCX analysis, which does not know pages (§52). */
  readonly page: number | null;
  readonly expectedValue: string | null;
  readonly expectedUnit: string | null;
  readonly actualValue: string | null;
  readonly actualUnit: string | null;
  readonly tolerance: string | null;
}

export interface CheckRuleResultView {
  readonly id: string;
  readonly ruleCode: string;
  readonly category: string;
  readonly severity: string;
  readonly blocking: boolean;
  readonly evaluationMode: string;
  readonly outcome: string;
  readonly reasonCode: string;
  readonly requiresReview: boolean;
  readonly displayOrder: number;
  readonly titleEn: string | null;
  readonly titleAr: string | null;
  readonly guidanceEn: string | null;
  readonly guidanceAr: string | null;
  readonly matchedFactCount: number;
  readonly evaluatedFactCount: number;
  readonly passedFactCount: number;
  readonly failedFactCount: number;
  readonly indeterminateFactCount: number;
  readonly totalViolationCount: number;
  readonly returnedViolationCount: number;
  readonly violationsTruncated: boolean;
  /** Present on the detail route; omitted from list pages. */
  readonly violations?: readonly CheckViolationView[];
}

/** Counters and classifications from a PDF analysis. No document content. */
export interface PdfDocumentView {
  readonly textLayer: 'NATIVE_TEXT' | 'IMAGE_ONLY' | 'HYBRID' | 'EMPTY_OR_UNKNOWN';
  readonly tagged: boolean;
  readonly pageCount: number;
  readonly imageOnlyPages: number;
  readonly nativeTextPages: number;
}

export interface CheckReportMetadataView {
  readonly id: string;
  readonly checkId: string;
  readonly checkRunId: string;
  readonly reportSchemaVersion: number;
  readonly reportCanonicalizationVersion: number;
  readonly reportHash: string;
  readonly evaluationHash: string;
  readonly createdAt: string;
}
