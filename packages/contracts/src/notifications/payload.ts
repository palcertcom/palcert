import {
  DomainAggregateType,
  DomainEventSourceType,
  NotificationType,
  type DomainEventSourceType as SourceType,
} from './notification.js';

/**
 * What a domain event is allowed to carry (§11).
 *
 * The rule is a whitelist, not a blacklist, and it is short on purpose.
 * Identifiers a fan-out worker needs to resolve recipients and build a link,
 * plus the decision status. Nothing else.
 *
 * Explicitly absent, and asserted absent by a sentinel test: document text,
 * filename, title, report findings or body, review comment body, email
 * address, display name, verification code, certificate number, certificate
 * claim, storage key, balance, payment data, AI output, SmartFix manifest.
 *
 * The reason is not squeamishness. An event payload survives in a database,
 * in a backup, and in whatever an incident-response export produces; anything
 * written here is written for a long time, to an audience nobody chose.
 */

/** Every Phase 16 payload carries these, derived from authoritative rows. */
interface BaseEventPayload {
  readonly submissionId?: string;
  readonly submissionRevisionId?: string;
  readonly revisionNumber?: number;
  readonly certificateId?: string;
  readonly institutionDecisionStatus?: string;
  readonly attestationRequestId?: string;
  readonly attestationId?: string;
  readonly reminderStage?: number;
}

export interface SubmissionReadyPayload extends BaseEventPayload {
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly revisionNumber: number;
}

export interface SubmissionDecisionPayload extends BaseEventPayload {
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly institutionDecisionStatus: string;
}

export interface SubmissionCommentPayload extends BaseEventPayload {
  readonly submissionId: string;
  readonly submissionRevisionId: string;
}

export interface CertificatePayload extends BaseEventPayload {
  readonly certificateId: string;
  readonly submissionId: string;
}

export interface AttestationRequestPayload extends BaseEventPayload {
  readonly attestationRequestId: string;
}

export interface AttestationRecordPayload extends BaseEventPayload {
  readonly attestationRequestId: string;
  readonly attestationId: string;
}

export interface AttestationReminderPayload extends AttestationRecordPayload {
  /** Days before expiry this reminder stands for; 0 is the expiry itself. */
  readonly reminderStage: number;
}

export type DomainEventPayload =
  | SubmissionReadyPayload
  | SubmissionDecisionPayload
  | SubmissionCommentPayload
  | CertificatePayload
  | AttestationRequestPayload
  | AttestationRecordPayload
  | AttestationReminderPayload;

/**
 * Keys a payload may contain, by event type.
 *
 * Enforced by `assertSafeEventPayload` rather than trusted, so a field added
 * to an emitter without being added here fails a test instead of reaching a
 * durable row.
 */
export const ALLOWED_PAYLOAD_KEYS: Readonly<Record<NotificationType, readonly string[]>> = {
  [NotificationType.SUBMISSION_READY]: ['submissionId', 'submissionRevisionId', 'revisionNumber'],
  [NotificationType.SUBMISSION_REVISION_READY]: [
    'submissionId',
    'submissionRevisionId',
    'revisionNumber',
  ],
  [NotificationType.SUBMISSION_UNDER_REVIEW]: [
    'submissionId',
    'submissionRevisionId',
    'institutionDecisionStatus',
  ],
  [NotificationType.SUBMISSION_APPROVED]: [
    'submissionId',
    'submissionRevisionId',
    'institutionDecisionStatus',
  ],
  [NotificationType.SUBMISSION_REJECTED]: [
    'submissionId',
    'submissionRevisionId',
    'institutionDecisionStatus',
  ],
  [NotificationType.SUBMISSION_REVISION_REQUESTED]: [
    'submissionId',
    'submissionRevisionId',
    'institutionDecisionStatus',
  ],
  [NotificationType.SUBMISSION_COMMENT_ADDED]: ['submissionId', 'submissionRevisionId'],
  [NotificationType.CERTIFICATE_ISSUED]: ['certificateId', 'submissionId'],
  [NotificationType.CERTIFICATE_REVOKED]: ['certificateId', 'submissionId'],
  [NotificationType.ATTESTATION_SUBMITTED]: ['attestationRequestId'],
  [NotificationType.ATTESTATION_READY_FOR_REVIEW]: ['attestationRequestId'],
  [NotificationType.ATTESTATION_INFORMATION_REQUESTED]: ['attestationRequestId'],
  [NotificationType.ATTESTATION_INFORMATION_PROVIDED]: ['attestationRequestId'],
  [NotificationType.ATTESTATION_APPROVED]: ['attestationRequestId', 'attestationId'],
  [NotificationType.ATTESTATION_REJECTED]: ['attestationRequestId'],
  [NotificationType.ATTESTATION_REVOKED]: ['attestationRequestId', 'attestationId'],
  [NotificationType.ATTESTATION_EXPIRING]: [
    'attestationRequestId',
    'attestationId',
    'reminderStage',
  ],
  [NotificationType.ATTESTATION_EXPIRED]: [
    'attestationRequestId',
    'attestationId',
    'reminderStage',
  ],
  // An identifier only. The amount, the reference and the method are read
  // from the request itself when the copy is rendered for its recipient, so
  // the durable event log never holds money or a bank reference.
  [NotificationType.MANUAL_TOPUP_SUBMITTED]: ['manualTopUpRequestId'],
  [NotificationType.MANUAL_TOPUP_APPROVED]: ['manualTopUpRequestId'],
  [NotificationType.MANUAL_TOPUP_REJECTED]: ['manualTopUpRequestId'],
  [NotificationType.WITHDRAWAL_PENDING_REVIEW]: ['withdrawalRequestId'],
  [NotificationType.WITHDRAWAL_SUBMITTED]: ['withdrawalRequestId'],
  [NotificationType.WITHDRAWAL_APPROVED]: ['withdrawalRequestId'],
  [NotificationType.WITHDRAWAL_REJECTED]: ['withdrawalRequestId'],
  [NotificationType.WITHDRAWAL_PAID]: ['withdrawalRequestId'],
  [NotificationType.WITHDRAWAL_FAILED]: ['withdrawalRequestId'],
};

/** The source row each event type is derived from (hardening §3). */
export const EVENT_SOURCE_TYPE: Readonly<Record<NotificationType, SourceType>> = {
  [NotificationType.SUBMISSION_READY]: DomainEventSourceType.SUBMISSION_REVISION,
  [NotificationType.SUBMISSION_REVISION_READY]: DomainEventSourceType.SUBMISSION_REVISION,
  [NotificationType.SUBMISSION_UNDER_REVIEW]: DomainEventSourceType.SUBMISSION_DECISION_EVENT,
  [NotificationType.SUBMISSION_APPROVED]: DomainEventSourceType.SUBMISSION_DECISION_EVENT,
  [NotificationType.SUBMISSION_REJECTED]: DomainEventSourceType.SUBMISSION_DECISION_EVENT,
  [NotificationType.SUBMISSION_REVISION_REQUESTED]: DomainEventSourceType.SUBMISSION_DECISION_EVENT,
  [NotificationType.SUBMISSION_COMMENT_ADDED]: DomainEventSourceType.SUBMISSION_COMMENT,
  [NotificationType.CERTIFICATE_ISSUED]: DomainEventSourceType.CERTIFICATE_EVENT,
  [NotificationType.CERTIFICATE_REVOKED]: DomainEventSourceType.CERTIFICATE_EVENT,
  [NotificationType.ATTESTATION_SUBMITTED]: DomainEventSourceType.ATTESTATION_REQUEST_EVENT,
  [NotificationType.ATTESTATION_READY_FOR_REVIEW]: DomainEventSourceType.ATTESTATION_REQUEST_EVENT,
  [NotificationType.ATTESTATION_INFORMATION_REQUESTED]:
    DomainEventSourceType.ATTESTATION_REQUEST_EVENT,
  [NotificationType.ATTESTATION_INFORMATION_PROVIDED]:
    DomainEventSourceType.ATTESTATION_REQUEST_EVENT,
  [NotificationType.ATTESTATION_APPROVED]: DomainEventSourceType.ATTESTATION_REQUEST_EVENT,
  [NotificationType.ATTESTATION_REJECTED]: DomainEventSourceType.ATTESTATION_REQUEST_EVENT,
  [NotificationType.ATTESTATION_REVOKED]: DomainEventSourceType.ATTESTATION_REQUEST_EVENT,
  [NotificationType.ATTESTATION_EXPIRING]: DomainEventSourceType.ATTESTATION_REMINDER,
  [NotificationType.ATTESTATION_EXPIRED]: DomainEventSourceType.ATTESTATION_REMINDER,
  [NotificationType.MANUAL_TOPUP_SUBMITTED]: DomainEventSourceType.MANUAL_TOPUP_REQUEST_EVENT,
  [NotificationType.MANUAL_TOPUP_APPROVED]: DomainEventSourceType.MANUAL_TOPUP_REQUEST_EVENT,
  [NotificationType.MANUAL_TOPUP_REJECTED]: DomainEventSourceType.MANUAL_TOPUP_REQUEST_EVENT,
  [NotificationType.WITHDRAWAL_PENDING_REVIEW]: DomainEventSourceType.WITHDRAWAL_REQUEST_EVENT,
  [NotificationType.WITHDRAWAL_SUBMITTED]: DomainEventSourceType.WITHDRAWAL_REQUEST_EVENT,
  [NotificationType.WITHDRAWAL_APPROVED]: DomainEventSourceType.WITHDRAWAL_REQUEST_EVENT,
  [NotificationType.WITHDRAWAL_REJECTED]: DomainEventSourceType.WITHDRAWAL_REQUEST_EVENT,
  [NotificationType.WITHDRAWAL_PAID]: DomainEventSourceType.WITHDRAWAL_REQUEST_EVENT,
  [NotificationType.WITHDRAWAL_FAILED]: DomainEventSourceType.WITHDRAWAL_REQUEST_EVENT,
};

/** What the event is about, and therefore what a deep link opens (hardening §2). */
export const EVENT_AGGREGATE_TYPE: Readonly<Record<NotificationType, DomainAggregateType>> = {
  [NotificationType.SUBMISSION_READY]: DomainAggregateType.OFFICIAL_SUBMISSION,
  [NotificationType.SUBMISSION_REVISION_READY]: DomainAggregateType.OFFICIAL_SUBMISSION,
  [NotificationType.SUBMISSION_UNDER_REVIEW]: DomainAggregateType.OFFICIAL_SUBMISSION,
  [NotificationType.SUBMISSION_APPROVED]: DomainAggregateType.OFFICIAL_SUBMISSION,
  [NotificationType.SUBMISSION_REJECTED]: DomainAggregateType.OFFICIAL_SUBMISSION,
  [NotificationType.SUBMISSION_REVISION_REQUESTED]: DomainAggregateType.OFFICIAL_SUBMISSION,
  [NotificationType.SUBMISSION_COMMENT_ADDED]: DomainAggregateType.OFFICIAL_SUBMISSION,
  [NotificationType.CERTIFICATE_ISSUED]: DomainAggregateType.COMPLIANCE_CERTIFICATE,
  [NotificationType.CERTIFICATE_REVOKED]: DomainAggregateType.COMPLIANCE_CERTIFICATE,
  [NotificationType.ATTESTATION_SUBMITTED]: DomainAggregateType.ATTESTATION_REQUEST,
  [NotificationType.ATTESTATION_READY_FOR_REVIEW]: DomainAggregateType.ATTESTATION_REQUEST,
  [NotificationType.ATTESTATION_INFORMATION_REQUESTED]: DomainAggregateType.ATTESTATION_REQUEST,
  [NotificationType.ATTESTATION_INFORMATION_PROVIDED]: DomainAggregateType.ATTESTATION_REQUEST,
  [NotificationType.ATTESTATION_APPROVED]: DomainAggregateType.ATTESTATION_REQUEST,
  [NotificationType.ATTESTATION_REJECTED]: DomainAggregateType.ATTESTATION_REQUEST,
  [NotificationType.ATTESTATION_REVOKED]: DomainAggregateType.ATTESTATION_REQUEST,
  [NotificationType.ATTESTATION_EXPIRING]: DomainAggregateType.ATTESTATION_REQUEST,
  [NotificationType.ATTESTATION_EXPIRED]: DomainAggregateType.ATTESTATION_REQUEST,
  [NotificationType.MANUAL_TOPUP_SUBMITTED]: DomainAggregateType.MANUAL_TOPUP_REQUEST,
  [NotificationType.MANUAL_TOPUP_APPROVED]: DomainAggregateType.MANUAL_TOPUP_REQUEST,
  [NotificationType.MANUAL_TOPUP_REJECTED]: DomainAggregateType.MANUAL_TOPUP_REQUEST,
  [NotificationType.WITHDRAWAL_PENDING_REVIEW]: DomainAggregateType.WITHDRAWAL_REQUEST,
  [NotificationType.WITHDRAWAL_SUBMITTED]: DomainAggregateType.WITHDRAWAL_REQUEST,
  [NotificationType.WITHDRAWAL_APPROVED]: DomainAggregateType.WITHDRAWAL_REQUEST,
  [NotificationType.WITHDRAWAL_REJECTED]: DomainAggregateType.WITHDRAWAL_REQUEST,
  [NotificationType.WITHDRAWAL_PAID]: DomainAggregateType.WITHDRAWAL_REQUEST,
  [NotificationType.WITHDRAWAL_FAILED]: DomainAggregateType.WITHDRAWAL_REQUEST,
};

/**
 * Names that must never be payload keys, whatever the event type.
 *
 * The allowlist above already refuses them; this is the second line, and it
 * exists because the two fail in different ways. A key missing from the
 * allowlist is a mistake; a key matching this pattern is a leak.
 */
const FORBIDDEN_PAYLOAD_KEY =
  /(email|name|title|filename|file_name|body|comment|text|verificationCode|certificateNumber|claim|hash|key|bucket|token|secret|amount|balance|price|manifest|finding|violation|prompt|response)/i;

export function assertSafeEventPayload(
  eventType: NotificationType,
  payload: Readonly<Record<string, unknown>>,
): void {
  const allowed = ALLOWED_PAYLOAD_KEYS[eventType];
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      throw new Error(`domain event ${eventType} may not carry ${key}`);
    }
    if (FORBIDDEN_PAYLOAD_KEY.test(key)) {
      throw new Error(`domain event payload key ${key} is forbidden`);
    }
  }
}
