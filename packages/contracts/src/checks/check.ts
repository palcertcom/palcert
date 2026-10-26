/**
 * Document checks: the first end-to-end PalCert workflow.
 *
 * A check binds one user, one immutable document version, one immutable
 * published standard version and one compatible analysis, and produces one
 * immutable report. Everything here is about keeping those bindings honest.
 */

/**
 * Where a check is in its *processing*.
 *
 * Deliberately separate from what PalCert concluded. "The check finished" and
 * "the document complies" are different questions, and merging them would make
 * a perfectly successful check that found ten failures look like a failure of
 * PalCert (§6, §7).
 */
export const CheckStatus = {
  /** Created and its dependencies captured; nothing has run yet. */
  CREATED: 'CREATED',
  /** The document's analysis has not finished. The check is parked, not polling. */
  WAITING_ANALYSIS: 'WAITING_ANALYSIS',
  /** The rule engine is running. */
  EVALUATING: 'EVALUATING',
  /** Results are in; the immutable report is being built and stored. */
  GENERATING_REPORT: 'GENERATING_REPORT',
  /** A report exists. Terminal, and the only state with a determination. */
  COMPLETED: 'COMPLETED',
  /** PalCert could not run the check. Terminal, and never a compliance verdict. */
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type CheckStatus = (typeof CheckStatus)[keyof typeof CheckStatus];

/** Every status, for API validation and documentation. */
export const CHECK_STATUSES: readonly CheckStatus[] = Object.values(CheckStatus);

export const CHECK_STATUS_TRANSITIONS: Readonly<Record<CheckStatus, readonly CheckStatus[]>> = {
  CREATED: ['WAITING_ANALYSIS', 'EVALUATING', 'FAILED', 'CANCELLED'],
  WAITING_ANALYSIS: ['EVALUATING', 'FAILED', 'CANCELLED'],
  // Re-entrant: an at-least-once delivery may re-claim a run it already holds.
  EVALUATING: ['EVALUATING', 'GENERATING_REPORT', 'WAITING_ANALYSIS', 'FAILED', 'CANCELLED'],
  GENERATING_REPORT: ['GENERATING_REPORT', 'COMPLETED', 'EVALUATING', 'FAILED'],
  // A completed check is history. Re-running means a new run, never a rewrite.
  COMPLETED: [],
  // A failed check may be retried, which starts a new run rather than reviving
  // the old one; the check itself goes back to the beginning of processing.
  FAILED: ['WAITING_ANALYSIS', 'EVALUATING'],
  CANCELLED: [],
};

export function canTransitionCheck(from: CheckStatus, to: CheckStatus): boolean {
  return CHECK_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Statuses a check never moves out of again.
 *
 * FAILED is deliberately absent. A failed check has stopped, but a retry
 * legitimately starts a new run from it (§63); treating it as terminal would
 * make the retry silently do nothing. "Nothing is in flight" is a different
 * question, and `isCheckSettled` answers that one.
 */
export const TERMINAL_CHECK_STATUSES: readonly CheckStatus[] = [
  CheckStatus.COMPLETED,
  CheckStatus.CANCELLED,
];

/** Statuses with no work in flight: finished, one way or another. */
export const SETTLED_CHECK_STATUSES: readonly CheckStatus[] = [
  CheckStatus.COMPLETED,
  CheckStatus.FAILED,
  CheckStatus.CANCELLED,
];

export function isCheckSettled(status: CheckStatus): boolean {
  return SETTLED_CHECK_STATUSES.includes(status);
}

export function isCheckTerminal(status: CheckStatus): boolean {
  return TERMINAL_CHECK_STATUSES.includes(status);
}

/** One technical attempt at evaluating a check. */
export const CheckRunStatus = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;

export type CheckRunStatus = (typeof CheckRunStatus)[keyof typeof CheckRunStatus];

export const CHECK_RUN_TRANSITIONS: Readonly<Record<CheckRunStatus, readonly CheckRunStatus[]>> = {
  PENDING: ['RUNNING', 'FAILED'],
  RUNNING: ['RUNNING', 'SUCCEEDED', 'FAILED'],
  // A succeeded run is evidence. An engine upgrade produces another run.
  SUCCEEDED: [],
  FAILED: [],
};

export function canTransitionCheckRun(from: CheckRunStatus, to: CheckRunStatus): boolean {
  return CHECK_RUN_TRANSITIONS[from].includes(to);
}

/**
 * What PalCert concluded — the other axis entirely (§7).
 *
 * `INDETERMINATE` is not a soft failure. It means the deterministic evidence
 * could not decide, and reporting that as NON_COMPLIANT would blame a document
 * for what PalCert could not read.
 */
export const ComplianceDetermination = {
  COMPLIANT: 'COMPLIANT',
  NON_COMPLIANT: 'NON_COMPLIANT',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  INDETERMINATE: 'INDETERMINATE',
} as const;

export type ComplianceDetermination =
  (typeof ComplianceDetermination)[keyof typeof ComplianceDetermination];

export const COMPLIANCE_DETERMINATIONS: readonly ComplianceDetermination[] =
  Object.values(ComplianceDetermination);

/** Why a check could not run. Never a stack trace, never a rule outcome (§64). */
export const CheckFailureCode = {
  /** The document's analysis failed permanently. */
  DOCUMENT_ANALYSIS_FAILED: 'DOCUMENT_ANALYSIS_FAILED',
  /** The published snapshot did not hash to the version's recorded contentHash. */
  STANDARD_SNAPSHOT_INTEGRITY_FAILED: 'STANDARD_SNAPSHOT_INTEGRITY_FAILED',
  /** The stored artifact did not match the analysis's recorded digest. */
  ANALYSIS_ARTIFACT_INTEGRITY_FAILED: 'ANALYSIS_ARTIFACT_INTEGRITY_FAILED',
  /** The artifact did not satisfy the shared analysis contract. */
  ANALYSIS_ARTIFACT_INVALID: 'ANALYSIS_ARTIFACT_INVALID',
  /** The rule engine was unreachable, timed out, or returned malformed output. */
  RULE_ENGINE_FAILED: 'RULE_ENGINE_FAILED',
  REPORT_GENERATION_FAILED: 'REPORT_GENERATION_FAILED',
  REPORT_STORAGE_FAILED: 'REPORT_STORAGE_FAILED',
  /**
   * The reservation that paid for this check expired before it finished
   * (Phase 11 §26, §116).
   *
   * Permanent, and permanent is the point: retrying would either do the work
   * for nothing or re-take money against whatever balance the customer
   * happens to have now. The check fails, the reservation is released, and
   * nothing is charged.
   */
  SERVICE_RESERVATION_EXPIRED: 'SERVICE_RESERVATION_EXPIRED',
  /** Anything unanticipated. Transient by default. */
  CHECK_ENGINE_ERROR: 'CHECK_ENGINE_ERROR',
} as const;

export type CheckFailureCode = (typeof CheckFailureCode)[keyof typeof CheckFailureCode];

/**
 * Failures the same inputs would reproduce exactly, so retrying is waste.
 *
 * Everything else is infrastructure, and an infrastructure failure must never
 * become a compliance verdict (§108).
 */
export const PERMANENT_CHECK_FAILURES: readonly CheckFailureCode[] = [
  CheckFailureCode.DOCUMENT_ANALYSIS_FAILED,
  CheckFailureCode.STANDARD_SNAPSHOT_INTEGRITY_FAILED,
  CheckFailureCode.ANALYSIS_ARTIFACT_INTEGRITY_FAILED,
  CheckFailureCode.ANALYSIS_ARTIFACT_INVALID,
  CheckFailureCode.SERVICE_RESERVATION_EXPIRED,
];

export function isPermanentCheckFailure(code: CheckFailureCode): boolean {
  return PERMANENT_CHECK_FAILURES.includes(code);
}

/**
 * Whether a standard may be chosen by someone outside its organization.
 *
 * The default is PRIVATE and existing standards stay PRIVATE: exposing an
 * institution's standard to the world is a deliberate act, never a migration
 * side effect (§16).
 */
export const StandardCheckAvailability = {
  PRIVATE: 'PRIVATE',
  PUBLIC_CHECKABLE: 'PUBLIC_CHECKABLE',
} as const;

export type StandardCheckAvailability =
  (typeof StandardCheckAvailability)[keyof typeof StandardCheckAvailability];

/** The orchestrator's own semantic version, distinct from the rule engine's. */
export const CHECK_ORCHESTRATOR_VERSION = '1';

/** The report schema and canonicalization this release produces (§42, §78). */
export const REPORT_SCHEMA_VERSION = 1;
export const REPORT_CANONICALIZATION_VERSION = 1;

/** Deterministic identity for a check evaluation job. */
export function checkRunJobKey(checkRunId: string): string {
  return `CHECK_EVALUATION:${checkRunId}`;
}
