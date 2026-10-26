/**
 * Documents and document versions (Phase 5).
 *
 * A **Document** is a person's logical document — "my PhD thesis". A
 * **DocumentVersion** is one immutable uploaded file. The two are separate so
 * a re-upload is a new version beside the old one, never a change to it: a
 * report, certificate or submission that later references a version is
 * referencing exact bytes with an exact SHA-256, and those must still be the
 * same bytes years on.
 *
 * Documents are **user-private**. They are owned by the person who uploaded
 * them and are not organization-scoped, even after the owner chooses an
 * organization's standard to check against: PalCert's Private Check lets a
 * student inspect a thesis without the university knowing (ADR-0031). An
 * organization gains access only through an explicit, future Submission.
 */

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

export const DocumentFormat = {
  DOCX: 'DOCX',
  PDF: 'PDF',
} as const;

export type DocumentFormat = (typeof DocumentFormat)[keyof typeof DocumentFormat];

export const DOCUMENT_FORMATS: readonly DocumentFormat[] = Object.values(DocumentFormat);

/**
 * The upload allow-list, by lower-cased extension.
 *
 * Deliberately closed: `.doc`, `.docm`, `.rtf`, `.odt`, `.zip`, `.html` and
 * everything else are refused, however plausible. Each new format is an
 * explicit implementation with its own signature check and container policy,
 * never an addition to this map alone.
 */
export const SUPPORTED_UPLOAD_EXTENSIONS: Readonly<Record<string, DocumentFormat>> = {
  '.docx': DocumentFormat.DOCX,
  '.pdf': DocumentFormat.PDF,
};

/** The one content type PalCert reports for each format, whatever the browser sent. */
export const CANONICAL_MIME_TYPES: Readonly<Record<DocumentFormat, string>> = {
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  PDF: 'application/pdf',
};

/** Declared content types accepted as *advisory* for each format. */
export const ACCEPTED_DECLARED_MIME_TYPES: Readonly<Record<DocumentFormat, readonly string[]>> = {
  DOCX: [
    CANONICAL_MIME_TYPES.DOCX,
    // Browsers on some platforms cannot name OOXML and fall back to these.
    'application/octet-stream',
    'application/zip',
    'application/x-zip-compressed',
  ],
  PDF: [CANONICAL_MIME_TYPES.PDF, 'application/octet-stream', 'application/x-pdf'],
};

// ---------------------------------------------------------------------------
// Lifecycles
// ---------------------------------------------------------------------------

export const DocumentStatus = {
  ACTIVE: 'ACTIVE',
  /** Soft-deleted by the owner; physical deletion runs asynchronously. */
  DELETED: 'DELETED',
} as const;

export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

/**
 * A version's processing lifecycle.
 *
 * The workflow state changes; the content identity (bytes, SHA-256, size,
 * format, clean object) does not once set. The two are deliberately separate
 * columns and separate concerns (ADR-0038).
 */
export const DocumentVersionStatus = {
  /** Created; the browser holds an upload authorization for the quarantine object. */
  AWAITING_UPLOAD: 'AWAITING_UPLOAD',
  /** Finalized: the exact quarantine object version is recorded and a job is queued. */
  UPLOADED: 'UPLOADED',
  VALIDATING: 'VALIDATING',
  SCANNING: 'SCANNING',
  /** Every check passed; the clean object exists and is downloadable by the owner. */
  READY: 'READY',
  /** The content is unacceptable (type, container, macro, malware...). Final. */
  REJECTED: 'REJECTED',
  /** PalCert could not finish safely (scanner or storage outage). Retryable. */
  FAILED: 'FAILED',
  /** The upload authorization lapsed before finalize. Final. */
  UPLOAD_EXPIRED: 'UPLOAD_EXPIRED',
  /** The owner abandoned the upload before finalize. Final. */
  CANCELLED: 'CANCELLED',
} as const;

export type DocumentVersionStatus =
  (typeof DocumentVersionStatus)[keyof typeof DocumentVersionStatus];

export const DOCUMENT_VERSION_STATUSES: readonly DocumentVersionStatus[] =
  Object.values(DocumentVersionStatus);

/**
 * Every legal transition, in one place.
 *
 * Processing stages (UPLOADED → VALIDATING → SCANNING) may be re-entered from
 * themselves: a worker that dies mid-stage and is retried starts the stage
 * again, which is safe because every stage is idempotent. FAILED → UPLOADED
 * is the owner-initiated retry after an infrastructure failure, and is the
 * only way out of a terminal-looking state.
 */
export const DOCUMENT_VERSION_TRANSITIONS: Readonly<
  Record<DocumentVersionStatus, readonly DocumentVersionStatus[]>
> = {
  AWAITING_UPLOAD: ['UPLOADED', 'UPLOAD_EXPIRED', 'CANCELLED'],
  UPLOADED: ['VALIDATING', 'REJECTED', 'FAILED'],
  VALIDATING: ['VALIDATING', 'SCANNING', 'REJECTED', 'FAILED'],
  // A retried attempt starts over at validation, hence SCANNING → VALIDATING.
  SCANNING: ['SCANNING', 'VALIDATING', 'READY', 'REJECTED', 'FAILED'],
  READY: [],
  REJECTED: [],
  FAILED: ['UPLOADED'],
  UPLOAD_EXPIRED: [],
  CANCELLED: [],
};

export function canTransitionDocumentVersion(
  from: DocumentVersionStatus,
  to: DocumentVersionStatus,
): boolean {
  return DOCUMENT_VERSION_TRANSITIONS[from].includes(to);
}

/** States in which PalCert is still working on the version. */
export const PROCESSING_DOCUMENT_VERSION_STATUSES: readonly DocumentVersionStatus[] = [
  DocumentVersionStatus.UPLOADED,
  DocumentVersionStatus.VALIDATING,
  DocumentVersionStatus.SCANNING,
];

export const TERMINAL_DOCUMENT_VERSION_STATUSES: readonly DocumentVersionStatus[] = [
  DocumentVersionStatus.READY,
  DocumentVersionStatus.REJECTED,
  DocumentVersionStatus.UPLOAD_EXPIRED,
  DocumentVersionStatus.CANCELLED,
];

export const UploadSessionStatus = {
  CREATED: 'CREATED',
  FINALIZED: 'FINALIZED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

export type UploadSessionStatus = (typeof UploadSessionStatus)[keyof typeof UploadSessionStatus];

export const UPLOAD_SESSION_TRANSITIONS: Readonly<
  Record<UploadSessionStatus, readonly UploadSessionStatus[]>
> = {
  CREATED: ['FINALIZED', 'EXPIRED', 'CANCELLED'],
  FINALIZED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export function canTransitionUploadSession(
  from: UploadSessionStatus,
  to: UploadSessionStatus,
): boolean {
  return UPLOAD_SESSION_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Processing jobs
// ---------------------------------------------------------------------------

export const ProcessingJobType = {
  /** Validate, hash, scan and promote one document version. */
  DOCUMENT_INGEST: 'DOCUMENT_INGEST',
  /** Physically delete the objects of a soft-deleted document. */
  DOCUMENT_PURGE: 'DOCUMENT_PURGE',
  /** Read one READY DOCX version into an immutable analysis artifact. */
  DOCX_ANALYSIS: 'DOCX_ANALYSIS',
  /**
   * Read one READY PDF version into an immutable analysis artifact (§10).
   *
   * A separate job type rather than a `DOCX_ANALYSIS` carrying a PDF: the two
   * analyzers have different engines, different limits and different failure
   * modes, and an operator looking at the job ledger during an incident should
   * be able to see which of them is struggling without joining to the version.
   * Both are handled by the same orchestration, which is format-neutral.
   */
  PDF_ANALYSIS: 'PDF_ANALYSIS',
  /**
   * Copy one official submission's evidence into its immutable snapshot (§32).
   *
   * Durable because the copy is storage work that can fail halfway, and a
   * half-copied official handoff must never become visible to an institution.
   * The job carries only the revision id; everything it needs is on that row.
   */
  SUBMISSION_PREPARE: 'SUBMISSION_PREPARE',
  /** Phase 15: build and store one certificate's claim and artifact. */
  CERTIFICATE_ISSUE: 'CERTIFICATE_ISSUE',
  /**
   * Get one paid check moving, durably (Phase 11 §23).
   *
   * Written inside the transaction that reserves the customer's credit, so a
   * reservation can never exist without an intent to do the work it paid for
   * — which is exactly the gap the Phase 7 post-commit dispatch left open.
   */
  CHECK_PREPARE: 'CHECK_PREPARE',
  /** Evaluate one check run and produce its immutable report. */
  CHECK_EVALUATION: 'CHECK_EVALUATION',
  AI_REVIEW: 'AI_REVIEW',
  /** Validate, hash, scan and promote one organization guideline or template. */
  STANDARD_SOURCE_INGEST: 'STANDARD_SOURCE_INGEST',
  /** Read an organization's sources and produce rule proposals. */
  RULE_EXTRACTION: 'RULE_EXTRACTION',
  /** Act on one verified payment-provider event (Phase 10). */
  PAYMENT_EVENT: 'PAYMENT_EVENT',
  /** Ask the provider about payments PalCert heard nothing about. */
  PAYMENT_RECONCILIATION: 'PAYMENT_RECONCILIATION',
  /**
   * Turn one committed domain event into per-recipient notifications (Phase 16 §15).
   *
   * Written inside the transaction that produced the event, so an approval
   * that commits has a job that commits with it. The job carries only the
   * event id; who is told, and in what language, is resolved when it runs,
   * from authority as it stands then rather than as it stood at the event.
   */
  NOTIFICATION_FANOUT: 'NOTIFICATION_FANOUT',
  /**
   * Send one logical notification email (Phase 16 §42).
   *
   * Separate from fan-out because sending is the part that talks to something
   * outside PalCert, and so is the part that retries. One job per delivery
   * row, which is unique per (notification, channel).
   */
  NOTIFICATION_EMAIL_SEND: 'NOTIFICATION_EMAIL_SEND',
  /**
   * Validate, hash, scan and promote one uploaded certificate submitted for
   * attestation. The same pipeline as every other upload, with image formats.
   */
  ATTESTATION_ARTIFACT_INGEST: 'ATTESTATION_ARTIFACT_INGEST',
  /**
   * Move the money an institution's decision implies: capture and split the
   * reserved fee on approval, release it in full on rejection. Written inside
   * the decision's transaction, so a decision cannot commit without it.
   */
  ATTESTATION_PAYMENT: 'ATTESTATION_PAYMENT',
  /**
   * Validate and scan a receipt a person attached to a manual top-up. The
   * same artifact pipeline as attestations, so a receipt is never served
   * before it has been scanned.
   */
  MANUAL_TOPUP_RECEIPT_INGEST: 'MANUAL_TOPUP_RECEIPT_INGEST',
  /** Scan an uploaded payout proof before finance or the requester can open it. */
  WITHDRAWAL_PROOF_INGEST: 'WITHDRAWAL_PROOF_INGEST',
  /** Validate and scan a payment method's logo before anybody is shown it. */
  MANUAL_PAYMENT_METHOD_LOGO_INGEST: 'MANUAL_PAYMENT_METHOD_LOGO_INGEST',
  /**
   * Correct one document and start its recheck (Phase 12 §59).
   *
   * Written inside the transaction that reserves the customer's balance, so a
   * reservation can never exist without an intent to do the work it paid for.
   */
  SMARTFIX_EXECUTE: 'SMARTFIX_EXECUTE',
  /**
   * Decide whether a corrected document may be delivered, and charge for it.
   *
   * A separate job from the correction itself, because the recheck between
   * them is an ordinary check with its own queue, its own retries and its own
   * failures — and finalizing is what happens when that finishes (§97).
   */
  SMARTFIX_FINALIZE: 'SMARTFIX_FINALIZE',
  /**
   * Project one committed, webhook-eligible domain event outward (Phase 17).
   *
   * Written in the same transaction as the event, exactly as the notification
   * fan-out is. The job carries only the event id; which endpoints hear about
   * it is resolved when it runs, from the subscriptions as they stand then.
   */
  WEBHOOK_FANOUT: 'WEBHOOK_FANOUT',
  /**
   * Send one webhook body to one endpoint.
   *
   * Separate from fan-out because sending is the part that talks to a machine
   * PalCert does not control, and so is the part that retries, times out and
   * has to be bounded. One job per delivery row.
   */
  WEBHOOK_DELIVER: 'WEBHOOK_DELIVER',
  /**
   * Prove an endpoint configuration reaches somebody who wants it.
   *
   * Keyed by the organization's verification *intent* rather than by the
   * configuration, so an administrator who fixes their receiver can ask again:
   * a job keyed by the configuration would have succeeded once and refused to
   * run a second time.
   */
  WEBHOOK_ENDPOINT_VERIFY: 'WEBHOOK_ENDPOINT_VERIFY',
} as const;

export type ProcessingJobType = (typeof ProcessingJobType)[keyof typeof ProcessingJobType];

/**
 * Job lifecycle (ADR-0036, ADR-0037).
 *
 * PENDING is the outbox: the row was written in the same transaction as the
 * state it processes, and a dispatcher publishes it to the queue afterwards.
 * If Redis is down at that moment the row simply stays PENDING and is
 * published by the next sweep — nothing is lost and nobody re-uploads.
 */
export const ProcessingJobStatus = {
  PENDING: 'PENDING',
  DISPATCHED: 'DISPATCHED',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  RETRY_PENDING: 'RETRY_PENDING',
  DEAD: 'DEAD',
} as const;

export type ProcessingJobStatus = (typeof ProcessingJobStatus)[keyof typeof ProcessingJobStatus];

export const PROCESSING_JOB_TRANSITIONS: Readonly<
  Record<ProcessingJobStatus, readonly ProcessingJobStatus[]>
> = {
  PENDING: ['DISPATCHED', 'RUNNING', 'DEAD'],
  // Back to PENDING when the publish was lost (lease expired, never picked up).
  DISPATCHED: ['RUNNING', 'PENDING', 'DEAD'],
  RUNNING: ['SUCCEEDED', 'RETRY_PENDING', 'DEAD', 'PENDING'],
  RETRY_PENDING: ['DISPATCHED', 'RUNNING', 'DEAD', 'PENDING'],
  SUCCEEDED: [],
  // Operations or an owner retry can resurrect a dead job.
  DEAD: ['PENDING'],
};

export function canTransitionProcessingJob(
  from: ProcessingJobStatus,
  to: ProcessingJobStatus,
): boolean {
  return PROCESSING_JOB_TRANSITIONS[from].includes(to);
}

/**
 * The deterministic identity of one unit of work.
 *
 * A duplicate dispatch — the outbox sweep and the immediate publish racing, a
 * retried HTTP request, an at-least-once queue — produces the same key, so it
 * cannot produce a second effective job (ADR-0037).
 */
export function processingJobIdempotencyKey(type: ProcessingJobType, resourceId: string): string {
  return `${type}:${resourceId}`;
}

// ---------------------------------------------------------------------------
// Rejection and failure
// ---------------------------------------------------------------------------

/**
 * Why a version was REJECTED: the *content* is unacceptable. Never retried.
 *
 * These double as the user-facing error codes of the same name.
 */
export const DocumentRejectionCode = {
  FILE_EXTENSION_UNSUPPORTED: 'FILE_EXTENSION_UNSUPPORTED',
  FILE_TYPE_UNSUPPORTED: 'FILE_TYPE_UNSUPPORTED',
  FILE_TYPE_MISMATCH: 'FILE_TYPE_MISMATCH',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_EMPTY: 'FILE_EMPTY',
  FILE_CONTAINER_INVALID: 'FILE_CONTAINER_INVALID',
  FILE_ARCHIVE_UNSAFE: 'FILE_ARCHIVE_UNSAFE',
  FILE_MACRO_UNSUPPORTED: 'FILE_MACRO_UNSUPPORTED',
  FILE_EMBEDDED_OBJECT_UNSUPPORTED: 'FILE_EMBEDDED_OBJECT_UNSUPPORTED',
  FILE_EXTERNAL_CONTENT_UNSUPPORTED: 'FILE_EXTERNAL_CONTENT_UNSUPPORTED',
  FILE_MALWARE_DETECTED: 'FILE_MALWARE_DETECTED',
  FILE_CHECKSUM_MISMATCH: 'FILE_CHECKSUM_MISMATCH',
} as const;

export type DocumentRejectionCode =
  (typeof DocumentRejectionCode)[keyof typeof DocumentRejectionCode];

export const DOCUMENT_REJECTION_CODES: readonly DocumentRejectionCode[] =
  Object.values(DocumentRejectionCode);

/**
 * Why a version FAILED: PalCert could not finish, through no fault of the
 * document. Retried by policy, and retryable by the owner afterwards.
 */
export const DocumentFailureCode = {
  SCANNER_UNAVAILABLE: 'SCANNER_UNAVAILABLE',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  QUARANTINE_OBJECT_MISSING: 'QUARANTINE_OBJECT_MISSING',
  /** The staged object no longer matches the identity captured at finalize. */
  QUARANTINE_OBJECT_CHANGED: 'QUARANTINE_OBJECT_CHANGED',
  PROCESSING_TIMEOUT: 'PROCESSING_TIMEOUT',
  WORKER_ERROR: 'WORKER_ERROR',
} as const;

export type DocumentFailureCode = (typeof DocumentFailureCode)[keyof typeof DocumentFailureCode];

export const DOCUMENT_FAILURE_CODES: readonly DocumentFailureCode[] =
  Object.values(DocumentFailureCode);

// ---------------------------------------------------------------------------
// Audit actions
// ---------------------------------------------------------------------------

export const DocumentAuditAction = {
  DOCUMENT_CREATED: 'DOCUMENT_CREATED',
  DOCUMENT_UPDATED: 'DOCUMENT_UPDATED',
  DOCUMENT_DELETED: 'DOCUMENT_DELETED',
  DOCUMENT_VERSION_CREATED: 'DOCUMENT_VERSION_CREATED',
  UPLOAD_SESSION_CREATED: 'UPLOAD_SESSION_CREATED',
  UPLOAD_SESSION_CANCELLED: 'UPLOAD_SESSION_CANCELLED',
  UPLOAD_SESSION_EXPIRED: 'UPLOAD_SESSION_EXPIRED',
  UPLOAD_FINALIZED: 'UPLOAD_FINALIZED',
  DOCUMENT_VALIDATION_STARTED: 'DOCUMENT_VALIDATION_STARTED',
  DOCUMENT_SCAN_STARTED: 'DOCUMENT_SCAN_STARTED',
  DOCUMENT_VERSION_READY: 'DOCUMENT_VERSION_READY',
  DOCUMENT_VERSION_REJECTED: 'DOCUMENT_VERSION_REJECTED',
  DOCUMENT_VERSION_FAILED: 'DOCUMENT_VERSION_FAILED',
  DOCUMENT_VERSION_RETRIED: 'DOCUMENT_VERSION_RETRIED',
  DOCUMENT_VERSION_DOWNLOADED: 'DOCUMENT_VERSION_DOWNLOADED',
  DOCUMENT_VERSION_PURGED: 'DOCUMENT_VERSION_PURGED',
  /** Phase 6: one analysis of one version finished, one way or the other. */
  DOCUMENT_ANALYSIS_SUCCEEDED: 'DOCUMENT_ANALYSIS_SUCCEEDED',
  DOCUMENT_ANALYSIS_FAILED: 'DOCUMENT_ANALYSIS_FAILED',
  /** Phase 7: the check lifecycle. One event per check, never per rule (§83). */
  CHECK_CREATED: 'CHECK_CREATED',
  CHECK_WAITING_ANALYSIS: 'CHECK_WAITING_ANALYSIS',
  CHECK_EVALUATION_STARTED: 'CHECK_EVALUATION_STARTED',
  CHECK_COMPLETED: 'CHECK_COMPLETED',
  CHECK_FAILED: 'CHECK_FAILED',
  CHECK_RETRIED: 'CHECK_RETRIED',
  CHECK_REPORT_CREATED: 'CHECK_REPORT_CREATED',
  /**
   * Phase 7: an organization published a standard to the check catalogue, or
   * withdrew it. Recorded with a named actor because making an institution's
   * standard world-visible is a deliberate act (§99).
   */
  STANDARD_CHECK_AVAILABILITY_CHANGED: 'STANDARD_CHECK_AVAILABILITY_CHANGED',
  /**
   * Phase 8: the AI review lifecycle. One event per review, never per provider
   * call — invocation detail belongs in the invocation ledger, not in
   * thousands of audit rows (§103, §104). Never a prompt or a response (§103).
   */
  AI_CONSENT_GRANTED: 'AI_CONSENT_GRANTED',
  AI_CONSENT_WITHDRAWN: 'AI_CONSENT_WITHDRAWN',
  AI_REVIEW_REQUESTED: 'AI_REVIEW_REQUESTED',
  AI_REVIEW_COMPLETED: 'AI_REVIEW_COMPLETED',
  AI_REVIEW_FAILED: 'AI_REVIEW_FAILED',
  AI_REVIEW_CANCELLED: 'AI_REVIEW_CANCELLED',
} as const;

export type DocumentAuditAction = (typeof DocumentAuditAction)[keyof typeof DocumentAuditAction];

// ---------------------------------------------------------------------------
// API views
// ---------------------------------------------------------------------------

/** What the owner sees about one version. Storage keys and buckets never appear. */
export interface DocumentVersionView {
  readonly id: string;
  readonly documentId: string;
  readonly versionNumber: number;
  readonly status: DocumentVersionStatus;
  readonly originalFilename: string;
  readonly declaredMimeType: string | null;
  readonly detectedMimeType: string | null;
  readonly detectedFormat: DocumentFormat | null;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly rejectionCode: DocumentRejectionCode | null;
  readonly failureCode: DocumentFailureCode | null;
  /** True when the owner may ask PalCert to process the file again. */
  readonly retryable: boolean;
  readonly uploadExpiresAt: string | null;
  readonly createdAt: string;
  readonly uploadedAt: string | null;
  readonly validatedAt: string | null;
  readonly scannedAt: string | null;
  readonly readyAt: string | null;
  readonly rejectedAt: string | null;
  readonly failedAt: string | null;
}

export interface DocumentView {
  readonly id: string;
  readonly displayName: string;
  readonly status: DocumentStatus;
  readonly latestVersion: DocumentVersionView | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A short-lived upload authorization: bearer material, not a resource.
 *
 * The URL grants exactly one operation (PUT) on exactly one object for a few
 * minutes. It is never logged, never persisted, and never returned by any
 * read endpoint — only by the call that created the version or explicitly
 * re-requested an authorization.
 */
export interface UploadAuthorizationView {
  readonly method: 'PUT';
  readonly url: string;
  /** Headers the browser must send exactly as given. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

export interface CreateDocumentVersionResponse {
  readonly version: DocumentVersionView;
  readonly upload: UploadAuthorizationView;
}

export interface DownloadAuthorizationView {
  readonly method: 'GET';
  readonly url: string;
  readonly expiresAt: string;
  /** The sanitized user-facing filename the response will carry. */
  readonly filename: string;
}
