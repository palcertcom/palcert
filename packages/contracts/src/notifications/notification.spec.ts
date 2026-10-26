import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMAIL_ENABLED,
  DOMAIN_EVENT_SCHEMA_VERSION,
  DomainAggregateType,
  DomainEventSourceType,
  EMAIL_MAX_ATTEMPTS,
  EMAIL_RETRY_DELAYS_MS,
  EmailFailureCode,
  MANDATORY_EMAIL_NOTIFICATION_TYPES,
  NOTIFICATION_AUDIENCE,
  NOTIFICATION_TYPES,
  NotificationAttemptOutcome,
  NotificationAudience,
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationSkipReason,
  NotificationType,
  isMandatoryEmailType,
  isNotificationType,
  isPermanentEmailFailure,
  nextEmailRetryDelayMs,
} from './notification';
import {
  ALLOWED_PAYLOAD_KEYS,
  EVENT_AGGREGATE_TYPE,
  EVENT_SOURCE_TYPE,
  assertSafeEventPayload,
} from './payload';

describe('the Phase 16 notification vocabulary', () => {
  it('recognises exactly the approved workflow events', () => {
    // Closed on purpose (§17): a client cannot invent a tenth, and neither can
    // a future service that forgets this list exists.
    expect([...NOTIFICATION_TYPES].sort()).toEqual(
      [
        'ATTESTATION_APPROVED',
        'ATTESTATION_EXPIRED',
        'ATTESTATION_EXPIRING',
        'ATTESTATION_INFORMATION_PROVIDED',
        'ATTESTATION_INFORMATION_REQUESTED',
        'ATTESTATION_READY_FOR_REVIEW',
        'ATTESTATION_REJECTED',
        'ATTESTATION_REVOKED',
        'ATTESTATION_SUBMITTED',
        'CERTIFICATE_ISSUED',
        'CERTIFICATE_REVOKED',
        'MANUAL_TOPUP_APPROVED',
        'MANUAL_TOPUP_REJECTED',
        'MANUAL_TOPUP_SUBMITTED',
        'SUBMISSION_APPROVED',
        'SUBMISSION_COMMENT_ADDED',
        'SUBMISSION_READY',
        'SUBMISSION_REJECTED',
        'SUBMISSION_REVISION_READY',
        'SUBMISSION_REVISION_REQUESTED',
        'SUBMISSION_UNDER_REVIEW',
        'WITHDRAWAL_APPROVED',
        'WITHDRAWAL_FAILED',
        'WITHDRAWAL_PAID',
        'WITHDRAWAL_PENDING_REVIEW',
        'WITHDRAWAL_REJECTED',
        'WITHDRAWAL_SUBMITTED',
      ].sort(),
    );
    // Nine from Phase 16, nine from certificate attestation, three from
    // manual top-ups, six from withdrawals.
    expect(NOTIFICATION_TYPES).toHaveLength(27);
    expect(isNotificationType('SUBMISSION_APPROVED')).toBe(true);
    expect(isNotificationType('MARKETING_BLAST')).toBe(false);
  });

  it('routes every type to exactly one audience', () => {
    // §18: the recipient rule is data, not a chain of ifs scattered across
    // services, so it can be read in one place and tested in one place.
    for (const type of NOTIFICATION_TYPES) {
      expect([type, NOTIFICATION_AUDIENCE[type]]).not.toEqual([type, undefined]);
    }
    expect(NOTIFICATION_AUDIENCE.SUBMISSION_READY).toBe(
      NotificationAudience.ORGANIZATION_REVIEWERS,
    );
    expect(NOTIFICATION_AUDIENCE.SUBMISSION_REVISION_READY).toBe(
      NotificationAudience.ORGANIZATION_REVIEWERS,
    );
    // Everything a decision produces goes to the person whose submission it is.
    for (const type of [
      NotificationType.SUBMISSION_UNDER_REVIEW,
      NotificationType.SUBMISSION_APPROVED,
      NotificationType.SUBMISSION_REJECTED,
      NotificationType.SUBMISSION_REVISION_REQUESTED,
      NotificationType.SUBMISSION_COMMENT_ADDED,
    ]) {
      expect([type, NOTIFICATION_AUDIENCE[type]]).toEqual([
        type,
        NotificationAudience.SUBMISSION_OWNER,
      ]);
    }
    for (const type of [
      NotificationType.CERTIFICATE_ISSUED,
      NotificationType.CERTIFICATE_REVOKED,
    ]) {
      expect([type, NOTIFICATION_AUDIENCE[type]]).toEqual([
        type,
        NotificationAudience.CERTIFICATE_OWNER,
      ]);
    }
  });

  it('names a source row and an aggregate for every type', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect([type, EVENT_SOURCE_TYPE[type]]).not.toEqual([type, undefined]);
      expect([type, EVENT_AGGREGATE_TYPE[type]]).not.toEqual([type, undefined]);
    }
    // Hardening §3: the decision events derive from the decision row, not from
    // the revision, so a replayed decision cannot acquire a new identity.
    expect(EVENT_SOURCE_TYPE.SUBMISSION_APPROVED).toBe(
      DomainEventSourceType.SUBMISSION_DECISION_EVENT,
    );
    expect(EVENT_SOURCE_TYPE.SUBMISSION_READY).toBe(DomainEventSourceType.SUBMISSION_REVISION);
    expect(EVENT_SOURCE_TYPE.SUBMISSION_COMMENT_ADDED).toBe(
      DomainEventSourceType.SUBMISSION_COMMENT,
    );
    expect(EVENT_SOURCE_TYPE.CERTIFICATE_REVOKED).toBe(DomainEventSourceType.CERTIFICATE_EVENT);
    // Hardening §2: the aggregate is what a deep link opens.
    expect(EVENT_AGGREGATE_TYPE.SUBMISSION_APPROVED).toBe(DomainAggregateType.OFFICIAL_SUBMISSION);
    expect(EVENT_AGGREGATE_TYPE.CERTIFICATE_ISSUED).toBe(
      DomainAggregateType.COMPLIANCE_CERTIFICATE,
    );
  });

  it('carries a schema version consumers can refuse', () => {
    // §12: an unknown version is an explicit failure, never a guess at shape.
    expect(DOMAIN_EVENT_SCHEMA_VERSION).toBe(1);
    expect(Number.isInteger(DOMAIN_EVENT_SCHEMA_VERSION)).toBe(true);
  });

  it('delivers on exactly two channels', () => {
    expect(Object.values(NotificationChannel).sort()).toEqual(['EMAIL', 'IN_APP']);
  });

  it('keeps the delivery, skip and attempt vocabularies closed', () => {
    expect(Object.values(NotificationDeliveryStatus).sort()).toEqual([
      'DELIVERED',
      'FAILED_PERMANENT',
      'FAILED_RETRYABLE',
      'PENDING',
      'SENDING',
      'SKIPPED',
    ]);
    expect(Object.values(NotificationSkipReason).sort()).toEqual([
      'ACCOUNT_INELIGIBLE',
      'AUTHORIZATION_REVOKED',
      'CHANNEL_DISABLED',
      'NO_VERIFIED_EMAIL',
      'PREFERENCE_DISABLED',
    ]);
    expect(Object.values(NotificationAttemptOutcome).sort()).toEqual([
      'FAILED_PERMANENT',
      'FAILED_RETRYABLE',
      'SUCCEEDED',
    ]);
  });
});

describe('email preference policy', () => {
  it('makes revocation the only kind of type nobody can switch off', () => {
    // §70, §164: a material change to the validity of a certificate somebody
    // may already have shown an employer. An attestation is shown to
    // employers in exactly the same way, so its revocation is mandatory too.
    expect(MANDATORY_EMAIL_NOTIFICATION_TYPES).toEqual([
      NotificationType.CERTIFICATE_REVOKED,
      NotificationType.ATTESTATION_REVOKED,
    ]);
    expect(isMandatoryEmailType(NotificationType.CERTIFICATE_REVOKED)).toBe(true);
    expect(isMandatoryEmailType(NotificationType.ATTESTATION_REVOKED)).toBe(true);
    // And everything else optional, including the issuance of the same
    // certificate: good news can wait for the next sign-in.
    for (const type of NOTIFICATION_TYPES.filter(
      (candidate) =>
        candidate !== NotificationType.CERTIFICATE_REVOKED &&
        candidate !== NotificationType.ATTESTATION_REVOKED,
    )) {
      expect([type, isMandatoryEmailType(type)]).toEqual([type, false]);
    }
  });

  it('defaults workflow email on', () => {
    // §69, §74: a missing row means the product default, so a new account
    // needs no preference rows at all.
    expect(DEFAULT_EMAIL_ENABLED).toBe(true);
  });
});

describe('the email retry ladder', () => {
  it('climbs and then stops', () => {
    // §57: bounded. Long at the end so an outage measured in hours does not
    // become a permanently failed notification, but never a loop.
    expect(EMAIL_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 43_200_000]);
    expect(EMAIL_MAX_ATTEMPTS).toBe(6);
    expect(nextEmailRetryDelayMs(1)).toBe(60_000);
    expect(nextEmailRetryDelayMs(5)).toBe(43_200_000);
    expect(nextEmailRetryDelayMs(6)).toBeNull();
    expect(nextEmailRetryDelayMs(99)).toBeNull();
  });

  it('retries an outage and refuses to retry a rejection', () => {
    // §56: the distinction is the whole policy. A timeout says nothing about
    // the address; a mailbox that does not exist will not start existing.
    expect(isPermanentEmailFailure(EmailFailureCode.PROVIDER_UNAVAILABLE)).toBe(false);
    expect(isPermanentEmailFailure(EmailFailureCode.RECIPIENT_REJECTED)).toBe(true);
    expect(isPermanentEmailFailure(EmailFailureCode.PROVIDER_REJECTED)).toBe(true);
    expect(isPermanentEmailFailure(EmailFailureCode.CONFIGURATION_REJECTED)).toBe(true);
  });
});

describe('domain event payload safety', () => {
  it('accepts exactly the identifiers each event needs', () => {
    assertSafeEventPayload(NotificationType.SUBMISSION_READY, {
      submissionId: 's',
      submissionRevisionId: 'r',
      revisionNumber: 1,
    });
    assertSafeEventPayload(NotificationType.CERTIFICATE_REVOKED, {
      certificateId: 'c',
      submissionId: 's',
    });
  });

  it('refuses anything private, whatever it is called', () => {
    // §11, §189: an event payload outlives the request that made it, in
    // backups and in incident exports. The allowlist is the first line and
    // the name check is the second.
    for (const leak of [
      { documentName: 'thesis.docx' },
      { commentBody: 'please widen the margin' },
      { verificationCode: 'ABCD' },
      { certificateNumber: 'PC-AAAA' },
      { ownerEmail: 'author@example.com' },
      { claimHash: 'a'.repeat(64) },
      { objectKey: 'organizations/x/y' },
      { amountMinor: 300 },
    ]) {
      expect(() => assertSafeEventPayload(NotificationType.SUBMISSION_APPROVED, leak)).toThrow();
    }
  });

  it('refuses a key that is safe for another event type', () => {
    // The allowlist is per type, so a certificate id cannot ride along on a
    // submission comment.
    expect(() =>
      assertSafeEventPayload(NotificationType.SUBMISSION_COMMENT_ADDED, {
        submissionId: 's',
        submissionRevisionId: 'r',
        certificateId: 'c',
      }),
    ).toThrow();
  });

  it('never allows a payload key that trips its own name check', () => {
    // Guards the allowlist against itself: a future maintainer adding a
    // plausible-looking key to ALLOWED_PAYLOAD_KEYS fails here.
    for (const [type, keys] of Object.entries(ALLOWED_PAYLOAD_KEYS)) {
      for (const key of keys) {
        expect(() =>
          assertSafeEventPayload(type as NotificationType, { [key]: 'value' }),
        ).not.toThrow();
      }
    }
  });
});
