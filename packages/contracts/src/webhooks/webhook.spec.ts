import { describe, expect, it } from 'vitest';

import { NOTIFICATION_TYPES, NotificationType } from '../notifications/notification.js';
import {
  ALLOWED_WEBHOOK_DATA_KEYS,
  assertSafeWebhookPayload,
  buildWebhookEnvelope,
  buildWebhookTestBody,
  buildWebhookVerificationBody,
  canonicalWebhookBody,
  isWebhookControlName,
  publicWebhookEventType,
  WEBHOOK_CONTROL_NAMES,
  webhookBodyHash,
} from './envelope.js';
import {
  classifyWebhookHttpStatus,
  isRetryableWebhookError,
  isWebhookEventType,
  nextWebhookRetryDelayMs,
  parseRetryAfterMs,
  RETRY_AFTER_MAX_MS,
  RETRY_AFTER_MIN_MS,
  WEBHOOK_EVENT_TYPE_OF,
  WEBHOOK_PROJECTED_NOTIFICATION_TYPES,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_SCHEMA_VERSION,
  WebhookErrorCode,
  WebhookEventType,
} from './webhook.js';

describe('webhook event vocabulary', () => {
  it('maps every internal notification type to a public event type', () => {
    for (const internal of WEBHOOK_PROJECTED_NOTIFICATION_TYPES) {
      expect(isWebhookEventType(publicWebhookEventType(internal))).toBe(true);
    }
    expect(Object.keys(WEBHOOK_EVENT_TYPE_OF)).toHaveLength(
      WEBHOOK_PROJECTED_NOTIFICATION_TYPES.length,
    );
  });

  it('projects no attestation event outward', () => {
    for (const internal of NOTIFICATION_TYPES) {
      if (!internal.startsWith('ATTESTATION_')) continue;
      expect(WEBHOOK_PROJECTED_NOTIFICATION_TYPES).not.toContain(internal);
      expect(() => publicWebhookEventType(internal)).toThrow();
    }
  });

  it('keeps the public vocabulary distinct from the internal one', () => {
    // A public type that happened to equal an internal enum value would let an
    // internal rename escape into an integrator's switch statement.
    for (const publicType of WEBHOOK_EVENT_TYPES) {
      expect((NOTIFICATION_TYPES as readonly string[]).includes(publicType)).toBe(false);
      expect(publicType).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  it('never lets a control name collide with a business event', () => {
    for (const name of WEBHOOK_CONTROL_NAMES) {
      expect(isWebhookEventType(name)).toBe(false);
      expect(isWebhookControlName(name)).toBe(true);
    }
    expect(WEBHOOK_CONTROL_NAMES).toEqual(['webhook.endpoint_verification', 'webhook.test']);
  });

  it('gives every public event type a data allowlist', () => {
    for (const type of WEBHOOK_EVENT_TYPES) {
      expect(ALLOWED_WEBHOOK_DATA_KEYS[type].length).toBeGreaterThan(0);
    }
  });

  it('allows only the five identifier fields anywhere in the vocabulary', () => {
    const everyKey = new Set(Object.values(ALLOWED_WEBHOOK_DATA_KEYS).flat());
    expect([...everyKey].sort()).toEqual([
      'certificateId',
      'institutionDecisionStatus',
      'revisionNumber',
      'submissionId',
      'submissionRevisionId',
    ]);
  });
});

describe('webhook payload safety', () => {
  it('accepts the identifiers an integrator needs', () => {
    expect(() =>
      assertSafeWebhookPayload(WebhookEventType.SUBMISSION_APPROVED, {
        submissionId: 'sub',
        submissionRevisionId: 'rev',
        institutionDecisionStatus: 'APPROVED',
      }),
    ).not.toThrow();
  });

  it('refuses a key that is merely not on the list', () => {
    expect(() =>
      assertSafeWebhookPayload(WebhookEventType.SUBMISSION_APPROVED, { reviewerId: 'usr' }),
    ).toThrow(/may not carry reviewerId/);
  });

  it('refuses every field the phase forbids exporting', () => {
    for (const key of [
      'ownerUserId',
      'submitterEmail',
      'displayName',
      'documentTitle',
      'filename',
      'documentText',
      'findings',
      'reportBody',
      'commentBody',
      'aiOutput',
      'smartFixManifest',
      'verificationCode',
      'certificateNumber',
      'certificateCapability',
      'qrCode',
      'storageKey',
      'signedUrl',
      'amountMinor',
    ]) {
      expect(() =>
        assertSafeWebhookPayload(WebhookEventType.CERTIFICATE_ISSUED, { [key]: 'x' }),
      ).toThrow();
    }
  });
});

describe('webhook envelope', () => {
  const occurredAt = new Date('2026-09-17T10:00:00.000Z');

  const envelope = buildWebhookEnvelope({
    webhookEventId: 'whe_1',
    type: WebhookEventType.SUBMISSION_APPROVED,
    occurredAt,
    organizationId: 'org_1',
    data: {
      submissionId: 'sub_1',
      submissionRevisionId: 'rev_1',
      institutionDecisionStatus: 'APPROVED',
    },
  });

  it('carries exactly the six public fields', () => {
    expect(Object.keys(envelope).sort()).toEqual([
      'data',
      'id',
      'occurredAt',
      'organizationId',
      'schemaVersion',
      'type',
    ]);
    expect(envelope.schemaVersion).toBe(WEBHOOK_SCHEMA_VERSION);
    expect(envelope.occurredAt).toBe('2026-09-17T10:00:00.000Z');
  });

  it('identifies the event, not the delivery, so a receiver can deduplicate', () => {
    // A replay is a different delivery of the same business fact. Its body is
    // byte-identical; only the PalCert-Delivery-Id header differs. A receiver
    // keying idempotency on the envelope id must not apply the approval twice.
    const replayBody = canonicalWebhookBody(
      buildWebhookEnvelope({
        webhookEventId: 'whe_1',
        type: WebhookEventType.SUBMISSION_APPROVED,
        occurredAt,
        organizationId: 'org_1',
        data: envelope.data,
      }),
    );
    expect(replayBody).toBe(canonicalWebhookBody(envelope));
  });

  it('refuses to build an envelope the allowlist would reject', () => {
    expect(() =>
      buildWebhookEnvelope({
        webhookEventId: 'whe_2',
        type: WebhookEventType.SUBMISSION_APPROVED,
        occurredAt,
        organizationId: 'org_1',
        data: { submitterEmail: 'a@b.test' },
      }),
    ).toThrow();
  });

  it('canonicalizes to the same bytes regardless of key insertion order', () => {
    const reordered = {
      data: envelope.data,
      organizationId: envelope.organizationId,
      schemaVersion: envelope.schemaVersion,
      occurredAt: envelope.occurredAt,
      type: envelope.type,
      id: envelope.id,
    };
    const body = canonicalWebhookBody(envelope);
    expect(canonicalWebhookBody(reordered as typeof envelope)).toBe(body);
    expect(webhookBodyHash(body)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('control bodies', () => {
  const occurredAt = new Date('2026-09-17T10:00:00.000Z');

  it('sends a verification challenge and nothing that identifies anyone', () => {
    const body = buildWebhookVerificationBody('nonce', occurredAt);
    expect(Object.keys(body).sort()).toEqual(['challenge', 'occurredAt', 'schemaVersion', 'type']);
    expect(body.type).toBe('webhook.endpoint_verification');
    // This goes to a URL nobody has yet proved they own — possibly one typed
    // wrongly. It must be safe to have sent to a stranger.
    expect(canonicalWebhookBody(body)).not.toContain('org');
  });

  it('builds a test body from the stored timestamp so retries stay byte-identical', () => {
    const first = buildWebhookTestBody(occurredAt);
    const second = buildWebhookTestBody(occurredAt);
    expect(Object.keys(first).sort()).toEqual(['occurredAt', 'schemaVersion', 'type']);
    expect(canonicalWebhookBody(first)).toBe(canonicalWebhookBody(second));
    expect(first.type).toBe('webhook.test');
  });

  it('carries no business identifier in a test body', () => {
    expect(canonicalWebhookBody(buildWebhookTestBody(occurredAt))).toBe(
      '{"occurredAt":"2026-09-17T10:00:00.000Z","schemaVersion":1,"type":"webhook.test"}',
    );
  });
});

describe('webhook retry policy', () => {
  it('gives every attempt but the last a delay, and the last none', () => {
    for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      const delay = nextWebhookRetryDelayMs(attempt);
      expect(delay).not.toBeNull();
      expect(delay as number).toBeGreaterThan(0);
    }
    expect(nextWebhookRetryDelayMs(WEBHOOK_MAX_ATTEMPTS)).toBeNull();
  });

  it('separates the errors worth retrying from the ones that will not change', () => {
    expect(isRetryableWebhookError(WebhookErrorCode.REQUEST_TIMEOUT)).toBe(true);
    expect(isRetryableWebhookError(WebhookErrorCode.CONNECT_TIMEOUT)).toBe(true);
    expect(isRetryableWebhookError(WebhookErrorCode.HTTP_RETRYABLE)).toBe(true);
    expect(isRetryableWebhookError(WebhookErrorCode.WORKER_INTERRUPTED)).toBe(true);
    expect(isRetryableWebhookError(WebhookErrorCode.HTTP_PERMANENT)).toBe(false);
    expect(isRetryableWebhookError(WebhookErrorCode.ENDPOINT_GONE)).toBe(false);
  });

  it('never retries a destination PalCert refused to contact', () => {
    // Retrying a refusal would turn a policy decision into a schedule of
    // repeated attempts to reach somewhere PalCert has already said it will
    // not go.
    for (const code of [
      WebhookErrorCode.DESTINATION_NOT_PUBLIC,
      WebhookErrorCode.DESTINATION_UNRESOLVABLE,
      WebhookErrorCode.TLS_IDENTITY_INVALID,
      WebhookErrorCode.URL_POLICY_VIOLATION,
      WebhookErrorCode.REDIRECT_REFUSED,
      WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH,
      WebhookErrorCode.CONFIG_SUPERSEDED,
    ]) {
      expect(isRetryableWebhookError(code)).toBe(false);
    }
  });

  it('classifies the status codes the phase names', () => {
    for (const status of [200, 201, 202, 204]) {
      expect(classifyWebhookHttpStatus(status)).toBe('SUCCESS');
    }
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(classifyWebhookHttpStatus(status)).toBe('RETRYABLE');
    }
    for (const status of [
      301, 302, 307, 308, 400, 401, 403, 404, 405, 410, 411, 413, 414, 415, 422,
    ]) {
      expect(classifyWebhookHttpStatus(status)).toBe('PERMANENT');
    }
  });

  it('clamps a receiver-supplied Retry-After into PalCert’s own bounds', () => {
    const now = Date.UTC(2026, 8, 17, 10, 0, 0);
    expect(parseRetryAfterMs('1', now)).toBe(RETRY_AFTER_MIN_MS);
    expect(parseRetryAfterMs('999999999', now)).toBe(RETRY_AFTER_MAX_MS);
    expect(parseRetryAfterMs(undefined, now)).toBeNull();
    expect(parseRetryAfterMs('not-a-number', now)).toBeNull();
  });
});

describe('phase boundaries', () => {
  it('leaves the internal notification vocabulary untouched', () => {
    // Phase 17 projects Phase 16 events outward; it does not add a channel to
    // them. A WEBHOOK member appearing here would mean a webhook had become a
    // notification, and therefore an authority.
    expect(NotificationType.SUBMISSION_APPROVED).toBe('SUBMISSION_APPROVED');
    expect(NOTIFICATION_TYPES.some((type) => type.includes('WEBHOOK'))).toBe(false);
    // And the projected set is still exactly the nine Phase 16 types.
    expect(WEBHOOK_PROJECTED_NOTIFICATION_TYPES).toHaveLength(9);
  });
});
