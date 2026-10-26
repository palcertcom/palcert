import type { ComplianceDetermination } from '../checks/check.js';
import type { DocumentFormat } from '../documents/document.js';
import type {
  InstitutionDecisionStatus,
  SubmissionCommentSide,
  SubmissionDecisionReason,
  SubmissionDisplayStatus,
  SubmissionEventSource,
  SubmissionFailureCode,
  SubmissionProcessingStatus,
} from './submission.js';

/**
 * What the API returns about an official submission.
 *
 * Two audiences read these shapes and they are not the same audience, so the
 * views are separate types rather than one type with optional fields. The
 * author's view may name their own document and check; the organization's view
 * must not, because an id it is handed is an id it can try — and the private
 * routes that would answer are the ones this whole phase exists to keep shut.
 */

/**
 * The technical result, copied at submission time for queue display (§84).
 *
 * A convenience, never an authority: the report snapshot and its hash remain
 * the truth, and a reviewer who wants certainty reads the report. Copied
 * because a queue of two hundred submissions should not fetch two hundred
 * report artifacts to render a column.
 */
export interface SubmissionTechnicalSummaryView {
  readonly determination: ComplianceDetermination;
  /** Decimal string, or null when the score could not be computed (§14). */
  readonly score: string | null;
  readonly scoreCoverage: string | null;
  readonly scoreComplete: boolean;
  readonly totalRules: number;
  readonly passedRules: number;
  readonly failedRules: number;
  readonly reviewRequiredRules: number;
  readonly indeterminateRules: number;
  readonly notApplicableRules: number;
}

/** The rules a revision was measured against, as the reviewer sees them. */
export interface SubmissionStandardView {
  readonly standardId: string;
  readonly standardVersionId: string;
  readonly standardCode: string;
  readonly standardName: string;
  readonly standardVersionLabel: string;
  readonly standardContentHash: string;
}

/**
 * The minimum identity a reviewer needs to know whose work this is (§85).
 *
 * Display name and email, and nothing else. No MFA state, no sessions, no IP
 * addresses, no security events, no billing, no account recovery — an official
 * submission shares a document, not a person's account (§87).
 */
export interface SubmitterIdentityView {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string;
}

/** One immutable handoff, as its author sees it. */
export interface SubmissionRevisionView {
  readonly id: string;
  readonly submissionId: string;
  readonly revisionNumber: number;

  readonly processingStatus: SubmissionProcessingStatus;
  readonly failureCode: SubmissionFailureCode | null;
  /** True when a failed preparation may be attempted again. */
  readonly retryable: boolean;

  /**
   * Null while the snapshot is still being prepared: an organization has not
   * been told anything yet, so there is no institution decision to report.
   */
  readonly institutionDecisionStatus: InstitutionDecisionStatus | null;

  readonly documentVersionId: string;
  readonly documentVersionNumber: number;
  readonly documentSha256: string;
  readonly documentFormat: DocumentFormat;

  readonly checkId: string;
  readonly reportId: string;
  readonly reportHash: string;
  readonly evaluationHash: string;

  readonly standard: SubmissionStandardView;
  readonly technical: SubmissionTechnicalSummaryView;

  readonly evidenceHash: string | null;

  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly reviewStartedAt: string | null;
  readonly decidedAt: string | null;
}

/** The long-lived case, as its author sees it. */
export interface OfficialSubmissionView {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly documentTypeId: string;
  readonly documentTypeName: string;
  readonly documentId: string;
  readonly documentName: string;

  /** The revision an organization would act on, or null while preparing. */
  readonly currentRevision: SubmissionRevisionView | null;
  readonly revisionCount: number;
  /** Derived, never stored: no revision means nothing was ever submitted. */
  readonly displayStatus: SubmissionDisplayStatus;

  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One row of the organization's review queue.
 *
 * Contains only what a reviewer needs to triage, and nothing that would let
 * them reach past the submission: no document version id, no check id, no
 * report id, no analysis id, no storage key. The organization's route into the
 * evidence is the submission's own download and report endpoints, and there is
 * no second way in.
 */
export interface SubmissionQueueEntryView {
  readonly submissionId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly documentTypeId: string;
  readonly documentTypeName: string;
  readonly institutionDecisionStatus: InstitutionDecisionStatus;
  readonly technical: SubmissionTechnicalSummaryView;
  readonly standardCode: string;
  readonly standardVersionLabel: string;
  readonly submitter: SubmitterIdentityView;
  readonly submittedAt: string;
  readonly decidedAt: string | null;
}

/** The organization's view of one revision it received. */
export interface OrganizationSubmissionRevisionView {
  readonly id: string;
  readonly submissionId: string;
  readonly revisionNumber: number;
  readonly institutionDecisionStatus: InstitutionDecisionStatus;
  readonly documentFormat: DocumentFormat;
  readonly documentSha256: string;
  readonly reportHash: string;
  readonly evaluationHash: string;
  readonly evidenceHash: string;
  readonly standard: SubmissionStandardView;
  readonly technical: SubmissionTechnicalSummaryView;
  readonly submittedAt: string;
  readonly reviewStartedAt: string | null;
  readonly decidedAt: string | null;
  /** False once a newer revision supersedes it: history, not a work item. */
  readonly isCurrent: boolean;
}

/** The organization's view of one case, with its whole revision history. */
export interface OrganizationSubmissionView {
  readonly id: string;
  readonly organizationId: string;
  readonly documentTypeId: string;
  readonly documentTypeName: string;
  readonly submitter: SubmitterIdentityView;
  readonly currentRevisionId: string;
  readonly revisions: readonly OrganizationSubmissionRevisionView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One entry in the append-only institution decision history (§43). */
export interface SubmissionDecisionEventView {
  readonly id: string;
  readonly submissionRevisionId: string;
  /**
   * Whether a person at the institution did this, or PalCert's own workflow.
   *
   * Shown, not inferred: a reader must be able to tell "the university has not
   * looked at this yet" from "the university decided", and an event with no
   * actor could mean either if the source were left implicit.
   */
  readonly eventSource: SubmissionEventSource;
  /** Null for the first event: nothing preceded SUBMITTED. */
  readonly fromStatus: InstitutionDecisionStatus | null;
  readonly toStatus: InstitutionDecisionStatus;
  readonly reasonCode: SubmissionDecisionReason | null;
  /** The reviewer, or null for the SUBMITTED event the system writes. */
  readonly actorUserId: string | null;
  readonly createdAt: string;
}

/** One immutable review comment (§66). Plain text, bounded, never HTML. */
export interface SubmissionCommentView {
  readonly id: string;
  readonly submissionRevisionId: string;
  readonly authorSide: SubmissionCommentSide;
  readonly authorUserId: string;
  readonly body: string;
  readonly createdAt: string;
}

/**
 * What the author is told will be shared, before they share it (§21, §86).
 *
 * Computed by the server rather than written into the UI, so the disclosure
 * and the thing actually handed over cannot drift apart: this is generated
 * from the same submission the button creates.
 */
export interface SubmissionDisclosureView {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly documentTypeName: string;
  readonly documentVersionNumber: number;
  readonly documentFormat: DocumentFormat;
  readonly standard: SubmissionStandardView;
  readonly technical: SubmissionTechnicalSummaryView;
  readonly submitter: SubmitterIdentityView;
  /** Stable keys the UI localizes. Never prose from the server. */
  readonly shared: readonly string[];
  readonly notShared: readonly string[];
}

/** What an official submission discloses, as stable keys the UI localizes. */
export const SUBMISSION_SHARED_ITEMS: readonly string[] = [
  'SUBMITTED_DOCUMENT_VERSION',
  'TECHNICAL_REPORT',
  'TECHNICAL_DETERMINATION',
  'DETERMINISTIC_SCORE_AND_FINDINGS',
  'STANDARD_AND_VERSION',
  'SUBMITTER_IDENTITY',
];

/**
 * What it does not (§21, §22, §23, §24).
 *
 * Listed explicitly rather than left to inference, because "we only share what
 * you submit" is a promise a person cannot verify and a list is one they can.
 */
export const SUBMISSION_NOT_SHARED_ITEMS: readonly string[] = [
  'OTHER_DOCUMENT_VERSIONS',
  'OTHER_CHECKS',
  'AI_REVIEW',
  'SMARTFIX_PLAN_AND_MANIFEST',
  'BALANCE_AND_PAYMENTS',
  'UNRELATED_FILES',
];
