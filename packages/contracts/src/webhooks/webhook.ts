import { NotificationType } from '../notifications/notification.js';

/**
 * Phase 17 vocabularies.
 *
 * The governing rule of the phase, worth restating where it will be read:
 *
 *     a webhook is an external projection of an authoritative DomainEvent.
 *     it never becomes the authoritative record itself.
 *
 * Nothing here may be consulted to decide whether a submission was approved or
 * whether a certificate is valid. Phase 14 and Phase 15 keep that authority,
 * and Phase 16's DomainEvent remains the only business-event source.
 */

/**
 * The public event vocabulary (§8).
 *
 * Deliberately not the internal `NotificationType`. An external contract that
 * was literally an internal enum would make every internal rename a breaking
 * change for every integrator, and would invite adding an internal-only type
 * to it by accident.
 */
export const WebhookEventType = {
  SUBMISSION_READY: 'submission.ready',
  SUBMISSION_REVISION_READY: 'submission.revision_ready',
  SUBMISSION_UNDER_REVIEW: 'submission.under_review',
  SUBMISSION_APPROVED: 'submission.approved',
  SUBMISSION_REJECTED: 'submission.rejected',
  SUBMISSION_REVISION_REQUESTED: 'submission.revision_requested',
  SUBMISSION_COMMENT_ADDED: 'submission.comment_added',
  CERTIFICATE_ISSUED: 'certificate.issued',
  CERTIFICATE_REVOKED: 'certificate.revoked',
} as const;

export type WebhookEventType = (typeof WebhookEventType)[keyof typeof WebhookEventType];

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = Object.values(WebhookEventType);

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The internal event types that are projected outward as webhooks.
 *
 * The nine Phase 16 submission and certificate types, exactly. Certificate
 * attestation events are deliberately *not* here: they are emitted with
 * `webhook_eligible = false`, because publishing them to an institution's
 * integrations is a separate product decision with its own public contract,
 * and nobody has made it. Adding a type here is that decision.
 */
export const WEBHOOK_PROJECTED_NOTIFICATION_TYPES: readonly NotificationType[] = [
  NotificationType.SUBMISSION_READY,
  NotificationType.SUBMISSION_REVISION_READY,
  NotificationType.SUBMISSION_UNDER_REVIEW,
  NotificationType.SUBMISSION_APPROVED,
  NotificationType.SUBMISSION_REJECTED,
  NotificationType.SUBMISSION_REVISION_REQUESTED,
  NotificationType.SUBMISSION_COMMENT_ADDED,
  NotificationType.CERTIFICATE_ISSUED,
  NotificationType.CERTIFICATE_REVOKED,
];

/**
 * Internal event type → public event type.
 *
 * Total over {@link WEBHOOK_PROJECTED_NOTIFICATION_TYPES}. A projected type
 * without a public counterpart fails the exhaustiveness test rather than
 * silently producing no webhook.
 */
export const WEBHOOK_EVENT_TYPE_OF: Readonly<Partial<Record<NotificationType, WebhookEventType>>> =
  {
    [NotificationType.SUBMISSION_READY]: WebhookEventType.SUBMISSION_READY,
    [NotificationType.SUBMISSION_REVISION_READY]: WebhookEventType.SUBMISSION_REVISION_READY,
    [NotificationType.SUBMISSION_UNDER_REVIEW]: WebhookEventType.SUBMISSION_UNDER_REVIEW,
    [NotificationType.SUBMISSION_APPROVED]: WebhookEventType.SUBMISSION_APPROVED,
    [NotificationType.SUBMISSION_REJECTED]: WebhookEventType.SUBMISSION_REJECTED,
    [NotificationType.SUBMISSION_REVISION_REQUESTED]:
      WebhookEventType.SUBMISSION_REVISION_REQUESTED,
    [NotificationType.SUBMISSION_COMMENT_ADDED]: WebhookEventType.SUBMISSION_COMMENT_ADDED,
    [NotificationType.CERTIFICATE_ISSUED]: WebhookEventType.CERTIFICATE_ISSUED,
    [NotificationType.CERTIFICATE_REVOKED]: WebhookEventType.CERTIFICATE_REVOKED,
  };

/**
 * The public envelope's schema version (§9).
 *
 * Independent of `DOMAIN_EVENT_SCHEMA_VERSION`: the internal payload and the
 * external contract change for different reasons and at different times, and
 * tying them together would force a breaking external change whenever an
 * internal one happened.
 */
export const WEBHOOK_SCHEMA_VERSION = 1;

/** Endpoint lifecycle (§16). DISABLED is terminal in Phase 17. */
export const WebhookEndpointStatus = {
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
} as const;

export type WebhookEndpointStatus =
  (typeof WebhookEndpointStatus)[keyof typeof WebhookEndpointStatus];

/** Configuration version lifecycle (amendment §4). */
export const WebhookConfigStatus = {
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  RETIRED: 'RETIRED',
  SUPERSEDED: 'SUPERSEDED',
} as const;

export type WebhookConfigStatus = (typeof WebhookConfigStatus)[keyof typeof WebhookConfigStatus];

/** What a delivery is for. TEST has no event and may never be a replay source. */
export const WebhookDeliveryKind = {
  ORIGINAL: 'ORIGINAL',
  REPLAY: 'REPLAY',
  TEST: 'TEST',
} as const;

export type WebhookDeliveryKind = (typeof WebhookDeliveryKind)[keyof typeof WebhookDeliveryKind];

export const WebhookDeliveryStatus = {
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  DELIVERED: 'DELIVERED',
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  FAILED_PERMANENT: 'FAILED_PERMANENT',
  SKIPPED: 'SKIPPED',
} as const;

export type WebhookDeliveryStatus =
  (typeof WebhookDeliveryStatus)[keyof typeof WebhookDeliveryStatus];

/** Why a delivery was deliberately not sent. A skip is not a failure. */
export const WebhookSkipReason = {
  /** The endpoint is paused or disabled (§54, gate §5). */
  ENDPOINT_INACTIVE: 'ENDPOINT_INACTIVE',
  /** The subscription was removed before this attempt (§55, gate §4). */
  UNSUBSCRIBED: 'UNSUBSCRIBED',
} as const;

export type WebhookSkipReason = (typeof WebhookSkipReason)[keyof typeof WebhookSkipReason];

export const WebhookAttemptOutcome = {
  SUCCEEDED: 'SUCCEEDED',
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  FAILED_PERMANENT: 'FAILED_PERMANENT',
} as const;

export type WebhookAttemptOutcome =
  (typeof WebhookAttemptOutcome)[keyof typeof WebhookAttemptOutcome];

/**
 * Normalized failure codes (§63).
 *
 * A remote endpoint's own words never reach a stored column or a log line: a
 * bounce or an error page routinely echoes the request back, and these rows
 * are read by support. The code carries the meaning.
 */
export const WebhookErrorCode = {
  // Transport — nothing was said about the message.
  DNS_TEMPORARY_FAILURE: 'DNS_TEMPORARY_FAILURE',
  CONNECT_TIMEOUT: 'CONNECT_TIMEOUT',
  CONNECTION_RESET: 'CONNECTION_RESET',
  TLS_INTERRUPTED: 'TLS_INTERRUPTED',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  // The receiver answered, and the answer is retryable.
  HTTP_RETRYABLE: 'HTTP_RETRYABLE',
  // The receiver answered, and asking again cannot change it.
  HTTP_PERMANENT: 'HTTP_PERMANENT',
  REDIRECT_REFUSED: 'REDIRECT_REFUSED',
  ENDPOINT_GONE: 'ENDPOINT_GONE',
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  // PalCert refused to make the request at all.
  DESTINATION_NOT_PUBLIC: 'DESTINATION_NOT_PUBLIC',
  DESTINATION_UNRESOLVABLE: 'DESTINATION_UNRESOLVABLE',
  TLS_IDENTITY_INVALID: 'TLS_IDENTITY_INVALID',
  URL_POLICY_VIOLATION: 'URL_POLICY_VIOLATION',
  CONFIG_INTEGRITY_MISMATCH: 'WEBHOOK_CONFIG_INTEGRITY_MISMATCH',
  CONFIG_SUPERSEDED: 'CONFIG_SUPERSEDED',
  ENCRYPTION_KEY_UNAVAILABLE: 'ENCRYPTION_KEY_UNAVAILABLE',
  CHALLENGE_MISMATCH: 'CHALLENGE_MISMATCH',
  // The organization disabled the endpoint; PalCert does not talk to it at all.
  ENDPOINT_DISABLED: 'ENDPOINT_DISABLED',
  // PalCert stopped between claiming the delivery and hearing back.
  WORKER_INTERRUPTED: 'WORKER_INTERRUPTED',
} as const;

export type WebhookErrorCode = (typeof WebhookErrorCode)[keyof typeof WebhookErrorCode];

export const WEBHOOK_ERROR_CODES: readonly WebhookErrorCode[] = Object.values(WebhookErrorCode);

/**
 * Which failures are worth asking again about (§62, §63).
 *
 * The distinction is the whole of the retry policy: a connection that timed
 * out says nothing about the request, while a 404 will not start existing
 * because PalCert asked again in twelve hours.
 */
export const RETRYABLE_WEBHOOK_ERRORS: readonly WebhookErrorCode[] = [
  WebhookErrorCode.DNS_TEMPORARY_FAILURE,
  WebhookErrorCode.CONNECT_TIMEOUT,
  WebhookErrorCode.CONNECTION_RESET,
  WebhookErrorCode.TLS_INTERRUPTED,
  WebhookErrorCode.REQUEST_TIMEOUT,
  WebhookErrorCode.HTTP_RETRYABLE,
  WebhookErrorCode.WORKER_INTERRUPTED,
];

export function isRetryableWebhookError(code: WebhookErrorCode): boolean {
  return RETRYABLE_WEBHOOK_ERRORS.includes(code);
}

/** The delivery-level ladder (§65). Bounded: nothing retries for ever. */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [
  60_000, // 1 minute
  300_000, // 5 minutes
  1_800_000, // 30 minutes
  7_200_000, // 2 hours
  43_200_000, // 12 hours
  86_400_000, // 24 hours
];

export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;

export function nextWebhookRetryDelayMs(attemptNumber: number): number | null {
  if (attemptNumber < 1) return WEBHOOK_RETRY_DELAYS_MS[0] ?? null;
  return WEBHOOK_RETRY_DELAYS_MS[attemptNumber - 1] ?? null;
}

/** Bounds on a `Retry-After` a remote endpoint asks for (§64, §36). */
export const RETRY_AFTER_MIN_MS = 60_000;
export const RETRY_AFTER_MAX_MS = 86_400_000;

/**
 * Parse a `Retry-After` header safely.
 *
 * Clamped, because the value comes from the endpoint: without a ceiling a
 * receiver could schedule PalCert's next attempt years away, and without a
 * floor it could ask to be hammered.
 */
export function parseRetryAfterMs(header: string | undefined, nowMs: number): number | null {
  if (header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;

  if (/^\d{1,9}$/.test(trimmed)) {
    return clampRetryAfter(Number(trimmed) * 1000);
  }

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;
  return clampRetryAfter(asDate - nowMs);
}

function clampRetryAfter(ms: number): number {
  if (!Number.isFinite(ms)) return RETRY_AFTER_MIN_MS;
  return Math.min(Math.max(ms, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

/** Management operations that carry durable idempotency (gate §9). */
export const WebhookManagementOperationType = {
  CREATE_ENDPOINT: 'CREATE_ENDPOINT',
  UPDATE_URL: 'UPDATE_URL',
  VERIFY_CONFIG: 'VERIFY_CONFIG',
  TEST_ENDPOINT: 'TEST_ENDPOINT',
  ROTATE_SECRET: 'ROTATE_SECRET',
  REPLAY_DELIVERY: 'REPLAY_DELIVERY',
} as const;

export type WebhookManagementOperationType =
  (typeof WebhookManagementOperationType)[keyof typeof WebhookManagementOperationType];

/** The two operations whose response carries a secret exactly once (§73). */
export const SECRET_BEARING_OPERATIONS: readonly WebhookManagementOperationType[] = [
  WebhookManagementOperationType.CREATE_ENDPOINT,
  WebhookManagementOperationType.ROTATE_SECRET,
];

export function isSecretBearingOperation(operation: WebhookManagementOperationType): boolean {
  return SECRET_BEARING_OPERATIONS.includes(operation);
}

/** Ten logical endpoints per organization (§48). */
export const MAX_WEBHOOK_ENDPOINTS_PER_ORGANIZATION = 10;

/** How long a lost creation/rotation response stays recoverable (amendment §1). */
export const WEBHOOK_SECRET_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Signing secrets: 32 bytes, presented as `whsec_<base64url>` (§20). */
export const WEBHOOK_SIGNING_SECRET_BYTES = 32;
export const WEBHOOK_SIGNING_SECRET_PREFIX = 'whsec_';

/** Verification challenges: 32 bytes, fresh per network attempt, never stored (§43). */
export const WEBHOOK_CHALLENGE_BYTES = 32;

/** The header a receiver must echo to prove it holds the endpoint (§43). */
export const WEBHOOK_CHALLENGE_HEADER = 'palcert-webhook-challenge';

/**
 * Request headers PalCert sets, and nothing else (§22, §23).
 *
 * Lowercase because that is how Node presents a received header, and a
 * comparison that depended on the casing a receiver echoed back would work
 * until the day a proxy normalized it.
 *
 * `PalCert-Event-Id` is absent from control messages on purpose: a
 * verification or test message projects no event, and sending an id that
 * referred to nothing would invite a receiver to record it as one.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'palcert-signature';
export const WEBHOOK_EVENT_TYPE_HEADER = 'palcert-event-type';
export const WEBHOOK_EVENT_ID_HEADER = 'palcert-event-id';
export const WEBHOOK_DELIVERY_ID_HEADER = 'palcert-delivery-id';

/**
 * Which HTTP answers are worth asking about again (§62, §35).
 *
 * Stated as two closed lists rather than "5xx is retryable, 4xx is not",
 * because the interesting cases are the exceptions: 408, 425 and 429 are 4xx
 * answers that explicitly mean "later", and 501 and 505 are 5xx answers that
 * will not change however long PalCert waits.
 */
const RETRYABLE_HTTP_STATUSES: readonly number[] = [408, 425, 429];

const PERMANENT_HTTP_STATUSES: readonly number[] = [
  400, 401, 403, 404, 405, 410, 411, 413, 414, 415, 422, 501, 505,
];

/**
 * Classify a receiver's status code.
 *
 * A 3xx is never retried and never followed: PalCert does not accept a new
 * destination from the response to a request it has already validated against
 * its own policy (§28).
 */
export function classifyWebhookHttpStatus(status: number): 'SUCCESS' | 'RETRYABLE' | 'PERMANENT' {
  if (status >= 200 && status < 300) return 'SUCCESS';
  if (status >= 300 && status < 400) return 'PERMANENT';
  if (RETRYABLE_HTTP_STATUSES.includes(status)) return 'RETRYABLE';
  if (PERMANENT_HTTP_STATUSES.includes(status)) return 'PERMANENT';
  if (status >= 500 && status < 600) return 'RETRYABLE';
  // Anything outside the ranges HTTP defines is a receiver PalCert cannot
  // reason about. Treated as permanent, because retrying a nonsense answer
  // six times over a day is not going to make sense of it.
  return 'PERMANENT';
}
