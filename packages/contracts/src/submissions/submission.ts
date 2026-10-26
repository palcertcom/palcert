/**
 * Official submission to an organization (Phase 14).
 *
 * The distinction this whole module exists to hold apart:
 *
 * ```
 * PRIVATE PALCERT CHECK  ≠  OFFICIAL INSTITUTION SUBMISSION
 * ```
 *
 * A check is a private technical measurement of the author's own work. A
 * submission is an explicit act by that author handing one exact checked
 * document, and the report that goes with it, to one organization. Owning the
 * standard a document was checked against grants an organization nothing —
 * not the document, not the check, not the report, not the analysis, not the
 * AI review, not SmartFix, not a single number about the author's money
 * (ADR-0031, ADR-0051).
 *
 * Two further separations are load-bearing and are kept apart everywhere in
 * this file:
 *
 * - **Processing is not decision.** Copying bytes can fail; that is a
 *   `SubmissionProcessingStatus`, and it is never an institution rejection.
 * - **Technical compliance is not an institution decision.** PalCert measures;
 *   the institution decides. `NON_COMPLIANT` + `APPROVED` and `COMPLIANT` +
 *   `REJECTED` are both representable, and neither dimension rewrites the
 *   other.
 */

/**
 * How far the snapshot preparation has got.
 *
 * Purely technical, and deliberately not part of the institution's vocabulary:
 * a storage outage must never arrive at a reviewer as a rejection, and a
 * reviewer must never be shown a submission whose evidence is still being
 * copied.
 */
export const SubmissionProcessingStatus = {
  /** Snapshots are being copied and verified. Invisible to the organization. */
  PREPARING: 'PREPARING',
  /** Snapshots exist, verified byte for byte. The organization may see it. */
  READY: 'READY',
  /** Preparation could not complete. No official handoff occurred. */
  FAILED: 'FAILED',
} as const;

export type SubmissionProcessingStatus =
  (typeof SubmissionProcessingStatus)[keyof typeof SubmissionProcessingStatus];

export const SUBMISSION_PROCESSING_STATUSES: readonly SubmissionProcessingStatus[] = Object.values(
  SubmissionProcessingStatus,
);

/**
 * Where the institution's own decision stands.
 *
 * A fixed vocabulary of five, and nothing that smuggles a technical verdict
 * into it: there is no `PASSED`, no `FAILED`, no `TECHNICALLY_APPROVED`, and
 * there never will be, because PalCert's measurement lives in
 * `ComplianceDetermination` and this is the human's answer.
 *
 * `NOT_SUBMITTED` is not here on purpose: it is the absence of a revision, and
 * the UI derives it rather than storing a row that claims something happened.
 */
export const InstitutionDecisionStatus = {
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  REVISION_REQUESTED: 'REVISION_REQUESTED',
} as const;

export type InstitutionDecisionStatus =
  (typeof InstitutionDecisionStatus)[keyof typeof InstitutionDecisionStatus];

export const INSTITUTION_DECISION_STATUSES: readonly InstitutionDecisionStatus[] =
  Object.values(InstitutionDecisionStatus);

/**
 * The state a submission is in when no revision exists at all.
 *
 * Derived for display, never stored (§4). A submission case without a revision
 * is not a thing an organization has been told about.
 */
export const NOT_SUBMITTED = 'NOT_SUBMITTED' as const;

/** What the UI shows, which is the stored status or the derived absence. */
export type SubmissionDisplayStatus = InstitutionDecisionStatus | typeof NOT_SUBMITTED;

/**
 * Decisions that end the institution's involvement with a revision.
 *
 * Phase 14 has no reopening and no appeals: a future phase may design that
 * workflow deliberately, and until it does, an approval or a rejection is the
 * institution's last word on those exact bytes (§47).
 */
export const TERMINAL_DECISION_STATUSES: readonly InstitutionDecisionStatus[] = [
  InstitutionDecisionStatus.APPROVED,
  InstitutionDecisionStatus.REJECTED,
];

export function isTerminalDecision(status: InstitutionDecisionStatus): boolean {
  return TERMINAL_DECISION_STATUSES.includes(status);
}

/**
 * The decision state machine (§46).
 *
 * `REVISION_REQUESTED` is terminal *for this revision* and not for the case:
 * the revision keeps that status for ever, and the author's answer is a new
 * revision rather than a rewrite of this one (§48).
 */
const TRANSITIONS: Readonly<
  Record<InstitutionDecisionStatus, readonly InstitutionDecisionStatus[]>
> = {
  SUBMITTED: [
    InstitutionDecisionStatus.UNDER_REVIEW,
    InstitutionDecisionStatus.APPROVED,
    InstitutionDecisionStatus.REJECTED,
    InstitutionDecisionStatus.REVISION_REQUESTED,
  ],
  UNDER_REVIEW: [
    InstitutionDecisionStatus.APPROVED,
    InstitutionDecisionStatus.REJECTED,
    InstitutionDecisionStatus.REVISION_REQUESTED,
  ],
  APPROVED: [],
  REJECTED: [],
  REVISION_REQUESTED: [],
};

export function allowedDecisionTransitions(
  from: InstitutionDecisionStatus,
): readonly InstitutionDecisionStatus[] {
  return TRANSITIONS[from];
}

export function isValidDecisionTransition(
  from: InstitutionDecisionStatus,
  to: InstitutionDecisionStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Whether a decision requires the reviewer to say why (§70).
 *
 * A rejection and a revision request are things the author must act on, and an
 * institution that cannot be bothered to say why has not really told them
 * anything. An approval needs no justification.
 */
export function decisionRequiresComment(status: InstitutionDecisionStatus): boolean {
  return (
    status === InstitutionDecisionStatus.REJECTED ||
    status === InstitutionDecisionStatus.REVISION_REQUESTED
  );
}

/**
 * Stable reason codes for filtering (§111).
 *
 * Deliberately administrative rather than academic: PalCert cannot define what
 * "insufficient novelty" means across every institution on earth, and pretending
 * to would put PalCert's name on a judgement it did not make. The free-text
 * comment carries the institution's own reasoning.
 */
export const SubmissionDecisionReason = {
  TECHNICAL_CORRECTIONS_REQUIRED: 'TECHNICAL_CORRECTIONS_REQUIRED',
  DOCUMENT_INCOMPLETE: 'DOCUMENT_INCOMPLETE',
  ADMINISTRATIVE_REQUIREMENT: 'ADMINISTRATIVE_REQUIREMENT',
  OTHER: 'OTHER',
} as const;

export type SubmissionDecisionReason =
  (typeof SubmissionDecisionReason)[keyof typeof SubmissionDecisionReason];

export const SUBMISSION_DECISION_REASONS: readonly SubmissionDecisionReason[] =
  Object.values(SubmissionDecisionReason);

/** Why a snapshot preparation stopped. Technical only; never a decision. */
export const SubmissionFailureCode = {
  /** The source document no longer matches the digest the check recorded. */
  SUBMISSION_SOURCE_INTEGRITY_FAILED: 'SUBMISSION_SOURCE_INTEGRITY_FAILED',
  /** The stored report artifact does not match its recorded hash. */
  SUBMISSION_REPORT_INTEGRITY_FAILED: 'SUBMISSION_REPORT_INTEGRITY_FAILED',
  /** Object storage could not be read or written. */
  SUBMISSION_SNAPSHOT_STORAGE_FAILED: 'SUBMISSION_SNAPSHOT_STORAGE_FAILED',
  /** Anything else. Transient by default: unknown is not the user's fault. */
  SUBMISSION_PREPARATION_FAILED: 'SUBMISSION_PREPARATION_FAILED',
} as const;

export type SubmissionFailureCode =
  (typeof SubmissionFailureCode)[keyof typeof SubmissionFailureCode];

export const SUBMISSION_FAILURE_CODES: readonly SubmissionFailureCode[] =
  Object.values(SubmissionFailureCode);

/**
 * Failures the same evidence would produce again, so retrying is waste.
 *
 * An integrity mismatch means the bytes are not what the check measured, and
 * they will not become so on the third attempt. A storage outage might.
 */
export const PERMANENT_SUBMISSION_FAILURES: readonly SubmissionFailureCode[] = [
  SubmissionFailureCode.SUBMISSION_SOURCE_INTEGRITY_FAILED,
  SubmissionFailureCode.SUBMISSION_REPORT_INTEGRITY_FAILED,
];

export function isPermanentSubmissionFailure(code: SubmissionFailureCode): boolean {
  return PERMANENT_SUBMISSION_FAILURES.includes(code);
}

/**
 * Who caused a decision event (§5).
 *
 * The first transition — `null → SUBMITTED` — is not a human institution
 * decision. Nobody at the organization did anything; PalCert finished copying
 * the evidence and told them it exists. Every later transition is a person at
 * the institution exercising the institution's authority.
 *
 * The distinction is a stored column rather than an inference from a null
 * actor, because "no actor" and "the system acted" are different claims and
 * the history is the authority for what happened (§42, §45).
 */
export const SubmissionEventSource = {
  /** PalCert's preparation workflow. Only ever `null → SUBMITTED`. */
  SYSTEM: 'SYSTEM',
  /** A named, authenticated reviewer at the receiving organization. */
  ORGANIZATION: 'ORGANIZATION',
} as const;

export type SubmissionEventSource =
  (typeof SubmissionEventSource)[keyof typeof SubmissionEventSource];

export const SUBMISSION_EVENT_SOURCES: readonly SubmissionEventSource[] =
  Object.values(SubmissionEventSource);

/** Who wrote a comment. Phase 14 models the institution side only (§68). */
export const SubmissionCommentSide = {
  ORGANIZATION: 'ORGANIZATION',
} as const;

export type SubmissionCommentSide =
  (typeof SubmissionCommentSide)[keyof typeof SubmissionCommentSide];

/** A review comment is plain text, bounded, and never HTML (§66). */
export const SUBMISSION_COMMENT_MAX_LENGTH = 4000;
