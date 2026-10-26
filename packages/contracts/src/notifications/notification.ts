/**
 * Phase 16 vocabularies (§17, §40, §42, §43, and hardening §1).
 *
 * Every list here is closed, and closed in the *database* as a native enum —
 * not merely by TypeScript convention. An unknown value must be refused even
 * if application validation is bypassed, because the whole point of a
 * notification vocabulary is that clients cannot invent one.
 *
 * The governing principle of the phase, worth restating where it will be read:
 *
 *     a notification reports an authoritative event.
 *     it never becomes the authoritative record itself.
 *
 * "Submission approved" is reported here; its authority stays in Phase 14's
 * `SubmissionDecisionEvent`. "Certificate issued" is reported here; its
 * authority stays in Phase 15's `ComplianceCertificate` and `CertificateEvent`.
 * Nothing in this file may ever be consulted to decide whether a submission
 * was approved or a certificate is valid.
 */

/**
 * The nine workflow events Phase 16 recognises (§4, §17).
 *
 * One vocabulary serves both the domain event and the notification it
 * produces. Two parallel enums would be two things to keep in lockstep, and
 * the first drift between them would be a notification type with no event or
 * an event nothing listens to.
 */
export const NotificationType = {
  SUBMISSION_READY: 'SUBMISSION_READY',
  SUBMISSION_REVISION_READY: 'SUBMISSION_REVISION_READY',
  SUBMISSION_UNDER_REVIEW: 'SUBMISSION_UNDER_REVIEW',
  SUBMISSION_APPROVED: 'SUBMISSION_APPROVED',
  SUBMISSION_REJECTED: 'SUBMISSION_REJECTED',
  SUBMISSION_REVISION_REQUESTED: 'SUBMISSION_REVISION_REQUESTED',
  SUBMISSION_COMMENT_ADDED: 'SUBMISSION_COMMENT_ADDED',
  CERTIFICATE_ISSUED: 'CERTIFICATE_ISSUED',
  CERTIFICATE_REVOKED: 'CERTIFICATE_REVOKED',
  // Certificate attestation. The owner hears about every step of their own
  // request; the institution's reviewers hear when there is something to do.
  ATTESTATION_SUBMITTED: 'ATTESTATION_SUBMITTED',
  ATTESTATION_READY_FOR_REVIEW: 'ATTESTATION_READY_FOR_REVIEW',
  ATTESTATION_INFORMATION_REQUESTED: 'ATTESTATION_INFORMATION_REQUESTED',
  ATTESTATION_INFORMATION_PROVIDED: 'ATTESTATION_INFORMATION_PROVIDED',
  ATTESTATION_APPROVED: 'ATTESTATION_APPROVED',
  ATTESTATION_REJECTED: 'ATTESTATION_REJECTED',
  ATTESTATION_REVOKED: 'ATTESTATION_REVOKED',
  ATTESTATION_EXPIRING: 'ATTESTATION_EXPIRING',
  ATTESTATION_EXPIRED: 'ATTESTATION_EXPIRED',
  /** A person reported a transfer; PalCert finance should verify it. */
  MANUAL_TOPUP_SUBMITTED: 'MANUAL_TOPUP_SUBMITTED',
  /** Finance verified the transfer and credited the balance. */
  MANUAL_TOPUP_APPROVED: 'MANUAL_TOPUP_APPROVED',
  /** Finance could not verify the transfer. */
  MANUAL_TOPUP_REJECTED: 'MANUAL_TOPUP_REJECTED',
  // Withdrawals (ADR-0150). Finance reviewers hear about a new request; the
  // requester hears about every decision on their own request.
  WITHDRAWAL_PENDING_REVIEW: 'WITHDRAWAL_PENDING_REVIEW',
  WITHDRAWAL_SUBMITTED: 'WITHDRAWAL_SUBMITTED',
  WITHDRAWAL_APPROVED: 'WITHDRAWAL_APPROVED',
  WITHDRAWAL_REJECTED: 'WITHDRAWAL_REJECTED',
  WITHDRAWAL_PAID: 'WITHDRAWAL_PAID',
  WITHDRAWAL_FAILED: 'WITHDRAWAL_FAILED',
} as const;

export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export const NOTIFICATION_TYPES: readonly NotificationType[] = Object.values(NotificationType);

/** Declared as a function so it can be used before the constants that list it. */
function WITHDRAWAL_NOTIFICATION_TYPES_LIST(): NotificationType[] {
  return [
    NotificationType.WITHDRAWAL_PENDING_REVIEW,
    NotificationType.WITHDRAWAL_SUBMITTED,
    NotificationType.WITHDRAWAL_APPROVED,
    NotificationType.WITHDRAWAL_REJECTED,
    NotificationType.WITHDRAWAL_PAID,
    NotificationType.WITHDRAWAL_FAILED,
  ];
}

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** The authoritative row a domain event was derived from (hardening §3). */
export const DomainEventSourceType = {
  SUBMISSION_REVISION: 'SUBMISSION_REVISION',
  SUBMISSION_DECISION_EVENT: 'SUBMISSION_DECISION_EVENT',
  SUBMISSION_COMMENT: 'SUBMISSION_COMMENT',
  CERTIFICATE_EVENT: 'CERTIFICATE_EVENT',
  /** One entry in an attestation request's append-only history. */
  ATTESTATION_REQUEST_EVENT: 'ATTESTATION_REQUEST_EVENT',
  /** One expiry reminder stage recorded for one attestation. */
  ATTESTATION_REMINDER: 'ATTESTATION_REMINDER',
  /** One entry in a manual top-up request's append-only history. */
  MANUAL_TOPUP_REQUEST_EVENT: 'MANUAL_TOPUP_REQUEST_EVENT',
  WITHDRAWAL_REQUEST_EVENT: 'WITHDRAWAL_REQUEST_EVENT',
} as const;

export type DomainEventSourceType =
  (typeof DomainEventSourceType)[keyof typeof DomainEventSourceType];

/**
 * What the event is *about*, which is also what a deep link points at
 * (hardening §2).
 *
 * Kept because it earns its place: the aggregate id is the id the destination
 * route needs, and it is not otherwise derivable from the payload — a
 * decision's source row names a revision, while the page a person opens is
 * the submission.
 */
export const DomainAggregateType = {
  OFFICIAL_SUBMISSION: 'OFFICIAL_SUBMISSION',
  COMPLIANCE_CERTIFICATE: 'COMPLIANCE_CERTIFICATE',
  ATTESTATION_REQUEST: 'ATTESTATION_REQUEST',
  MANUAL_TOPUP_REQUEST: 'MANUAL_TOPUP_REQUEST',
  WITHDRAWAL_REQUEST: 'WITHDRAWAL_REQUEST',
} as const;

export type DomainAggregateType = (typeof DomainAggregateType)[keyof typeof DomainAggregateType];

/**
 * The event payload contract version (§12).
 *
 * Consumers fail explicitly on a version they do not understand rather than
 * guessing at a shape. A payload that changes meaning changes this number.
 */
export const DOMAIN_EVENT_SCHEMA_VERSION = 1;

/** Phase 16 delivers on exactly two channels (§40). */
export const NotificationChannel = {
  IN_APP: 'IN_APP',
  EMAIL: 'EMAIL',
} as const;

export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

/** The life of one logical email delivery (§42). */
export const NotificationDeliveryStatus = {
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  DELIVERED: 'DELIVERED',
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  FAILED_PERMANENT: 'FAILED_PERMANENT',
  SKIPPED: 'SKIPPED',
} as const;

export type NotificationDeliveryStatus =
  (typeof NotificationDeliveryStatus)[keyof typeof NotificationDeliveryStatus];

/**
 * Why an email was deliberately not sent (§43, and hardening §5).
 *
 * A skip is not a failure: nothing went wrong, and nothing should be retried.
 * The reason is recorded because "no email arrived" is a support question, and
 * answering it should not require reading anyone's mail.
 */
export const NotificationSkipReason = {
  /** The user turned this optional type off before the job ran (§72). */
  PREFERENCE_DISABLED: 'PREFERENCE_DISABLED',
  /** No verified address at delivery time (§25). */
  NO_VERIFIED_EMAIL: 'NO_VERIFIED_EMAIL',
  /** The reviewer lost the permission or the membership (§22, §65). */
  AUTHORIZATION_REVOKED: 'AUTHORIZATION_REVOKED',
  /** The deployment has email switched off entirely (§115). */
  CHANNEL_DISABLED: 'CHANNEL_DISABLED',
  /** The account is not in a state PalCert sends workflow mail to. */
  ACCOUNT_INELIGIBLE: 'ACCOUNT_INELIGIBLE',
} as const;

export type NotificationSkipReason =
  (typeof NotificationSkipReason)[keyof typeof NotificationSkipReason];

/** How one attempt ended (§44). Append-only history, never edited (§45). */
export const NotificationAttemptOutcome = {
  SUCCEEDED: 'SUCCEEDED',
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  FAILED_PERMANENT: 'FAILED_PERMANENT',
} as const;

export type NotificationAttemptOutcome =
  (typeof NotificationAttemptOutcome)[keyof typeof NotificationAttemptOutcome];

/**
 * The one type a person may not switch off (§70, §164).
 *
 * A revocation is a material change to the validity of a certificate somebody
 * may already have shown an employer. Letting that arrive only as a badge in
 * an inbox they have no reason to open would be PalCert deciding, on their
 * behalf, that they did not need to know.
 *
 * Everything else is optional, because everything else is news they can find
 * when they next sign in.
 */
export const MANDATORY_EMAIL_NOTIFICATION_TYPES: readonly NotificationType[] = [
  NotificationType.CERTIFICATE_REVOKED,
  // For the same reason: somebody may already have shown the attestation to
  // an employer, and they must not learn it was withdrawn from the employer.
  NotificationType.ATTESTATION_REVOKED,
];

export function isMandatoryEmailType(type: NotificationType): boolean {
  return MANDATORY_EMAIL_NOTIFICATION_TYPES.includes(type);
}

/** Workflow email is on unless a person turns an optional type off (§69). */
export const DEFAULT_EMAIL_ENABLED = true;

export function defaultEmailEnabled(_type: NotificationType): boolean {
  // Deliberately uniform: a missing preference row means the product default
  // for every type, so a new user needs no rows at all (§74).
  return DEFAULT_EMAIL_ENABLED;
}

/**
 * The recipient rule, in one place (§18).
 *
 * `ORGANIZATION_REVIEWERS` resolves to the organization's members who hold
 * `submission:review:read` *at the moment of resolution*, and again at the
 * moment of delivery. `SUBMISSION_OWNER` and `CERTIFICATE_OWNER` resolve to
 * the authoritative owner recorded on the source row — never to anything a
 * client sent.
 */
export const NotificationAudience = {
  ORGANIZATION_REVIEWERS: 'ORGANIZATION_REVIEWERS',
  SUBMISSION_OWNER: 'SUBMISSION_OWNER',
  CERTIFICATE_OWNER: 'CERTIFICATE_OWNER',
  /** The user who asked for the attestation. */
  ATTESTATION_OWNER: 'ATTESTATION_OWNER',
  /** Members who hold `attestation:request:review` in the organization, now. */
  ATTESTATION_REVIEWERS: 'ATTESTATION_REVIEWERS',
  /** The person who reported a manual transfer. */
  MANUAL_TOPUP_OWNER: 'MANUAL_TOPUP_OWNER',
  /**
   * PalCert staff who hold `finance:manual-topup:review` through a platform
   * (GLOBAL) role, now. Platform-scoped: no organization is involved, and an
   * organization role can never place anybody in it.
   */
  PLATFORM_FINANCE_REVIEWERS: 'PLATFORM_FINANCE_REVIEWERS',
  /** The person who requested a withdrawal, whatever its scope. */
  WITHDRAWAL_OWNER: 'WITHDRAWAL_OWNER',
  /** PalCert staff holding finance:withdrawal:review through a GLOBAL role. */
  WITHDRAWAL_FINANCE_REVIEWERS: 'WITHDRAWAL_FINANCE_REVIEWERS',
} as const;

export type NotificationAudience = (typeof NotificationAudience)[keyof typeof NotificationAudience];

export const NOTIFICATION_AUDIENCE: Readonly<Record<NotificationType, NotificationAudience>> = {
  [NotificationType.SUBMISSION_READY]: NotificationAudience.ORGANIZATION_REVIEWERS,
  [NotificationType.SUBMISSION_REVISION_READY]: NotificationAudience.ORGANIZATION_REVIEWERS,
  [NotificationType.SUBMISSION_UNDER_REVIEW]: NotificationAudience.SUBMISSION_OWNER,
  [NotificationType.SUBMISSION_APPROVED]: NotificationAudience.SUBMISSION_OWNER,
  [NotificationType.SUBMISSION_REJECTED]: NotificationAudience.SUBMISSION_OWNER,
  [NotificationType.SUBMISSION_REVISION_REQUESTED]: NotificationAudience.SUBMISSION_OWNER,
  [NotificationType.SUBMISSION_COMMENT_ADDED]: NotificationAudience.SUBMISSION_OWNER,
  [NotificationType.CERTIFICATE_ISSUED]: NotificationAudience.CERTIFICATE_OWNER,
  [NotificationType.CERTIFICATE_REVOKED]: NotificationAudience.CERTIFICATE_OWNER,
  [NotificationType.ATTESTATION_SUBMITTED]: NotificationAudience.ATTESTATION_OWNER,
  [NotificationType.ATTESTATION_READY_FOR_REVIEW]: NotificationAudience.ATTESTATION_REVIEWERS,
  [NotificationType.ATTESTATION_INFORMATION_REQUESTED]: NotificationAudience.ATTESTATION_OWNER,
  [NotificationType.ATTESTATION_INFORMATION_PROVIDED]: NotificationAudience.ATTESTATION_REVIEWERS,
  [NotificationType.ATTESTATION_APPROVED]: NotificationAudience.ATTESTATION_OWNER,
  [NotificationType.ATTESTATION_REJECTED]: NotificationAudience.ATTESTATION_OWNER,
  [NotificationType.ATTESTATION_REVOKED]: NotificationAudience.ATTESTATION_OWNER,
  [NotificationType.ATTESTATION_EXPIRING]: NotificationAudience.ATTESTATION_OWNER,
  [NotificationType.ATTESTATION_EXPIRED]: NotificationAudience.ATTESTATION_OWNER,
  [NotificationType.MANUAL_TOPUP_SUBMITTED]: NotificationAudience.PLATFORM_FINANCE_REVIEWERS,
  [NotificationType.MANUAL_TOPUP_APPROVED]: NotificationAudience.MANUAL_TOPUP_OWNER,
  [NotificationType.MANUAL_TOPUP_REJECTED]: NotificationAudience.MANUAL_TOPUP_OWNER,
  [NotificationType.WITHDRAWAL_PENDING_REVIEW]: NotificationAudience.WITHDRAWAL_FINANCE_REVIEWERS,
  [NotificationType.WITHDRAWAL_SUBMITTED]: NotificationAudience.WITHDRAWAL_OWNER,
  [NotificationType.WITHDRAWAL_APPROVED]: NotificationAudience.WITHDRAWAL_OWNER,
  [NotificationType.WITHDRAWAL_REJECTED]: NotificationAudience.WITHDRAWAL_OWNER,
  [NotificationType.WITHDRAWAL_PAID]: NotificationAudience.WITHDRAWAL_OWNER,
  [NotificationType.WITHDRAWAL_FAILED]: NotificationAudience.WITHDRAWAL_OWNER,
};

/** Audiences resolved from an organization's current reviewers, not from a row's owner. */
export const REVIEWER_AUDIENCES: readonly NotificationAudience[] = [
  NotificationAudience.ORGANIZATION_REVIEWERS,
  NotificationAudience.ATTESTATION_REVIEWERS,
  NotificationAudience.PLATFORM_FINANCE_REVIEWERS,
  NotificationAudience.WITHDRAWAL_FINANCE_REVIEWERS,
];

/**
 * Reviewer audiences resolved from PalCert's own staff rather than from an
 * organization's members. Their events carry no organization at all.
 */
export const PLATFORM_AUDIENCES: readonly NotificationAudience[] = [
  NotificationAudience.PLATFORM_FINANCE_REVIEWERS,
  NotificationAudience.WITHDRAWAL_FINANCE_REVIEWERS,
];

export function isPlatformAudience(audience: NotificationAudience): boolean {
  return PLATFORM_AUDIENCES.includes(audience);
}

/** Event types that happen to no organization, and so carry a null organization id. */
export const PLATFORM_SCOPED_NOTIFICATION_TYPES: readonly NotificationType[] = [
  NotificationType.MANUAL_TOPUP_SUBMITTED,
  NotificationType.MANUAL_TOPUP_APPROVED,
  NotificationType.MANUAL_TOPUP_REJECTED,
  ...WITHDRAWAL_NOTIFICATION_TYPES_LIST(),
];

/** The manual top-up types, whose copy carries top-up facts. */
export const MANUAL_TOPUP_NOTIFICATION_TYPES: readonly NotificationType[] = [
  NotificationType.MANUAL_TOPUP_SUBMITTED,
  NotificationType.MANUAL_TOPUP_APPROVED,
  NotificationType.MANUAL_TOPUP_REJECTED,
];

export function isManualTopUpNotificationType(type: NotificationType): boolean {
  return MANUAL_TOPUP_NOTIFICATION_TYPES.includes(type);
}

/** The withdrawal types, whose copy carries withdrawal facts (never a destination). */
export const WITHDRAWAL_NOTIFICATION_TYPES: readonly NotificationType[] =
  WITHDRAWAL_NOTIFICATION_TYPES_LIST();

export function isWithdrawalNotificationType(type: NotificationType): boolean {
  return WITHDRAWAL_NOTIFICATION_TYPES.includes(type);
}

export function isPlatformScopedNotificationType(type: NotificationType): boolean {
  return PLATFORM_SCOPED_NOTIFICATION_TYPES.includes(type);
}

export function isReviewerAudience(audience: NotificationAudience): boolean {
  return REVIEWER_AUDIENCES.includes(audience);
}

/** The permission that makes somebody a member of a reviewer audience. */
export const REVIEWER_AUDIENCE_PERMISSION: Readonly<Partial<Record<NotificationAudience, string>>> =
  {
    [NotificationAudience.ORGANIZATION_REVIEWERS]: 'submission:review:read',
    [NotificationAudience.ATTESTATION_REVIEWERS]: 'attestation:request:review',
    [NotificationAudience.PLATFORM_FINANCE_REVIEWERS]: 'finance:manual-topup:review',
    [NotificationAudience.WITHDRAWAL_FINANCE_REVIEWERS]: 'finance:withdrawal:review',
  };

/**
 * The retry ladder for one email delivery (§57).
 *
 * Bounded, and deliberately long at the end: a provider outage measured in
 * hours should not turn into a permanently failed notification, but nothing
 * retries for ever. Exhausting the ladder is a dead letter an operator can
 * inspect, not a loop.
 */
export const EMAIL_RETRY_DELAYS_MS: readonly number[] = [
  60_000, // 1 minute
  300_000, // 5 minutes
  1_800_000, // 30 minutes
  7_200_000, // 2 hours
  43_200_000, // 12 hours
];

export const EMAIL_MAX_ATTEMPTS = EMAIL_RETRY_DELAYS_MS.length + 1;

/** The delay before attempt `attemptNumber + 1`, or null when the ladder ends. */
export function nextEmailRetryDelayMs(attemptNumber: number): number | null {
  if (attemptNumber < 1) return EMAIL_RETRY_DELAYS_MS[0] ?? null;
  return EMAIL_RETRY_DELAYS_MS[attemptNumber - 1] ?? null;
}

/**
 * How a provider failure is classified (§56).
 *
 * The distinction is the whole of the retry policy: a connection that timed
 * out says nothing about the address, while a mailbox that does not exist will
 * not start existing because PalCert asked again twelve hours later.
 */
export const EmailFailureCode = {
  /** Connection, timeout, TLS negotiation, DNS, provider 4xx. */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  /** SMTP permanent 5xx that is about the message or the transaction. */
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  /** SMTP permanent 5xx naming the recipient. */
  RECIPIENT_REJECTED: 'RECIPIENT_REJECTED',
  /** The deployment's own configuration is wrong; retrying cannot fix it. */
  CONFIGURATION_REJECTED: 'CONFIGURATION_REJECTED',
  /**
   * PalCert stopped between claiming the delivery and hearing back (§58).
   *
   * Not `PROVIDER_UNAVAILABLE`: that says the relay did something, and it did
   * not — the worker died. An operator reading the attempt history should be
   * able to tell "the relay refused us" from "we never finished asking".
   *
   * Retryable, and deliberately so. The relay may have accepted the message
   * before the crash, so a retry can duplicate externally; that is the
   * at-least-once limitation this phase accepts rather than the alternative,
   * which is somebody never being told.
   */
  WORKER_INTERRUPTED: 'WORKER_INTERRUPTED',
} as const;

export type EmailFailureCode = (typeof EmailFailureCode)[keyof typeof EmailFailureCode];

export const PERMANENT_EMAIL_FAILURES: readonly EmailFailureCode[] = [
  EmailFailureCode.PROVIDER_REJECTED,
  EmailFailureCode.RECIPIENT_REJECTED,
  EmailFailureCode.CONFIGURATION_REJECTED,
];

export function isPermanentEmailFailure(code: EmailFailureCode): boolean {
  return PERMANENT_EMAIL_FAILURES.includes(code);
}
