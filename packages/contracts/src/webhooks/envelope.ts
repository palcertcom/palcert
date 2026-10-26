import { canonicalizeJson, sha256Hex } from '../checks/report.js';
import type { NotificationType } from '../notifications/notification.js';
import { WEBHOOK_EVENT_TYPE_OF, WEBHOOK_SCHEMA_VERSION, WebhookEventType } from './webhook.js';

/**
 * The public webhook envelope (§17, §19).
 *
 * Six fields and no room for a seventh. An integrator parses this shape and
 * nothing more, which is what lets PalCert add an event type without breaking
 * a receiver that has never heard of it.
 *
 * `id` is the WebhookEvent's id, *not* the delivery's. It is deliberately
 * stable across a retry and across a manual replay, because it is what a
 * receiver deduplicates on (§37): delivery is at-least-once, so a receiver
 * that keyed idempotency on something which changed per attempt would apply
 * the same approval twice. Which attempt this is arrives in the
 * `PalCert-Delivery-Id` header, where it belongs — it is transport, not the
 * business fact.
 */
export interface WebhookEventEnvelope {
  readonly id: string;
  readonly type: WebhookEventType;
  readonly schemaVersion: number;
  readonly occurredAt: string;
  readonly organizationId: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Control message type names (§22, §76).
 *
 * Not members of `WebhookEventType`, and asserted distinct from it, because a
 * receiver switching on `type` must be able to tell "PalCert is checking this
 * endpoint" from "a submission was approved" without consulting a second
 * field. They are not subscribable: nobody opts in or out of them, and no
 * DomainEvent produces one.
 */
export const WEBHOOK_ENDPOINT_VERIFICATION_TYPE = 'webhook.endpoint_verification';
export const WEBHOOK_TEST_TYPE = 'webhook.test';

export type WebhookControlName =
  typeof WEBHOOK_ENDPOINT_VERIFICATION_TYPE | typeof WEBHOOK_TEST_TYPE;

export const WEBHOOK_CONTROL_NAMES: readonly WebhookControlName[] = [
  WEBHOOK_ENDPOINT_VERIFICATION_TYPE,
  WEBHOOK_TEST_TYPE,
];

export function isWebhookControlName(value: string): value is WebhookControlName {
  return (WEBHOOK_CONTROL_NAMES as readonly string[]).includes(value);
}

/**
 * The verification body (§21, §43).
 *
 * Carries a nonce and nothing else. This message goes to a URL that has not
 * yet proved anybody at the other end wants to hear from PalCert, so it must
 * be safe to have sent to a wrong address typed by mistake — which means no
 * organization id, no identifiers, nothing that says who PalCert is talking
 * about.
 */
export interface WebhookVerificationBody {
  readonly type: typeof WEBHOOK_ENDPOINT_VERIFICATION_TYPE;
  readonly schemaVersion: number;
  readonly challenge: string;
  readonly occurredAt: string;
}

/**
 * The test body (§20).
 *
 * Three fields, and `occurredAt` is the delivery's immutable
 * `controlOccurredAt` rather than the current time. A test delivery is
 * durable and retried, and its bytes are verified against a stored hash
 * before every attempt; a body that re-read the clock would fail its own
 * integrity check on the second attempt.
 */
export interface WebhookTestBody {
  readonly type: typeof WEBHOOK_TEST_TYPE;
  readonly schemaVersion: number;
  readonly occurredAt: string;
}

/**
 * What each public event may carry in `data` (§18).
 *
 * A strict subset of what the internal Phase 16 payload carries, and the same
 * discipline: identifiers an integrator needs to call back into the API, plus
 * the decision status. No document text, no filename, no comment body, no
 * email address, no display name, no verification code, no certificate
 * number, no storage key, no money, no AI output.
 *
 * A webhook body leaves PalCert's control the moment it is sent. It is
 * written to somebody else's logs, kept for as long as they keep logs, and
 * read by whoever can read those. That is the whole argument for this list
 * being short.
 *
 * The event's own identity is not in here: it is the envelope's `id`.
 */
export const ALLOWED_WEBHOOK_DATA_KEYS: Readonly<Record<WebhookEventType, readonly string[]>> = {
  [WebhookEventType.SUBMISSION_READY]: ['submissionId', 'submissionRevisionId', 'revisionNumber'],
  [WebhookEventType.SUBMISSION_REVISION_READY]: [
    'submissionId',
    'submissionRevisionId',
    'revisionNumber',
  ],
  [WebhookEventType.SUBMISSION_UNDER_REVIEW]: [
    'submissionId',
    'submissionRevisionId',
    'institutionDecisionStatus',
  ],
  [WebhookEventType.SUBMISSION_APPROVED]: [
    'submissionId',
    'submissionRevisionId',
    'institutionDecisionStatus',
  ],
  [WebhookEventType.SUBMISSION_REJECTED]: [
    'submissionId',
    'submissionRevisionId',
    'institutionDecisionStatus',
  ],
  [WebhookEventType.SUBMISSION_REVISION_REQUESTED]: [
    'submissionId',
    'submissionRevisionId',
    'institutionDecisionStatus',
  ],
  [WebhookEventType.SUBMISSION_COMMENT_ADDED]: ['submissionId', 'submissionRevisionId'],
  [WebhookEventType.CERTIFICATE_ISSUED]: ['certificateId', 'submissionId'],
  [WebhookEventType.CERTIFICATE_REVOKED]: ['certificateId', 'submissionId'],
};

/**
 * Names that must never appear in `data`, whatever the event type.
 *
 * Second line of defence, as in Phase 16: a key missing from the allowlist is
 * a mistake, a key matching this is a leak. The two are worth distinguishing
 * because they call for different reactions from whoever reads the failure.
 */
const FORBIDDEN_WEBHOOK_DATA_KEY =
  /(email|name|title|filename|file_name|body|comment|text|verificationCode|certificateNumber|capability|claim|hash|key|bucket|token|secret|signature|challenge|amount|balance|price|manifest|finding|violation|prompt|response)/i;

export function assertSafeWebhookPayload(
  type: WebhookEventType,
  data: Readonly<Record<string, unknown>>,
): void {
  const allowed = ALLOWED_WEBHOOK_DATA_KEYS[type];
  if (allowed === undefined) {
    throw new Error(`unknown webhook event type ${type}`);
  }
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) {
      throw new Error(`webhook event ${type} may not carry ${key}`);
    }
    if (FORBIDDEN_WEBHOOK_DATA_KEY.test(key)) {
      throw new Error(`webhook data key ${key} is forbidden`);
    }
  }
}

/** Project an internal Phase 16 event type onto the public vocabulary (§8). */
export function publicWebhookEventType(internal: NotificationType): WebhookEventType {
  const mapped = WEBHOOK_EVENT_TYPE_OF[internal];
  if (mapped === undefined) {
    throw new Error(`no public webhook event type for ${internal}`);
  }
  return mapped;
}

export interface BuildWebhookEnvelopeInput {
  /** The WebhookEvent's id. Stable across retries and replays (§37). */
  readonly webhookEventId: string;
  readonly type: WebhookEventType;
  readonly occurredAt: Date;
  readonly organizationId: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Build the envelope, refusing anything the allowlist does not permit.
 *
 * The check runs here rather than at the send site so there is exactly one
 * way to produce a body, and therefore no way to produce one that skipped the
 * check (§19: no second serialization path).
 */
export function buildWebhookEnvelope(input: BuildWebhookEnvelopeInput): WebhookEventEnvelope {
  assertSafeWebhookPayload(input.type, input.data);
  return {
    id: input.webhookEventId,
    type: input.type,
    schemaVersion: WEBHOOK_SCHEMA_VERSION,
    occurredAt: input.occurredAt.toISOString(),
    organizationId: input.organizationId,
    data: input.data,
  };
}

export function buildWebhookVerificationBody(
  challenge: string,
  occurredAt: Date,
): WebhookVerificationBody {
  return {
    type: WEBHOOK_ENDPOINT_VERIFICATION_TYPE,
    schemaVersion: WEBHOOK_SCHEMA_VERSION,
    challenge,
    occurredAt: occurredAt.toISOString(),
  };
}

/** `controlOccurredAt` is the delivery's stored, immutable timestamp (§20). */
export function buildWebhookTestBody(controlOccurredAt: Date): WebhookTestBody {
  return {
    type: WEBHOOK_TEST_TYPE,
    schemaVersion: WEBHOOK_SCHEMA_VERSION,
    occurredAt: controlOccurredAt.toISOString(),
  };
}

export type WebhookBody = WebhookEventEnvelope | WebhookVerificationBody | WebhookTestBody;

/**
 * The exact bytes that are sent, and therefore the exact bytes that are
 * signed (§19, §23).
 *
 * RFC 8785 canonicalization, reused from Phase 7's report hashing rather than
 * reimplemented: a second canonicalizer would be a second set of rules about
 * key order and number formatting, and the two would eventually disagree
 * about something — at which point a signature PalCert computed would not
 * verify against the body PalCert sent.
 *
 * There is no separate "signed view" of a body. A receiver who verifies the
 * signature has verified everything they were sent, which is the only
 * property that makes checking it worth anything.
 */
export function canonicalWebhookBody(body: WebhookBody): string {
  return canonicalizeJson(body);
}

/** SHA-256 of the canonical body, stored so every retry can prove it matches. */
export function webhookBodyHash(body: string): string {
  return sha256Hex(body);
}
