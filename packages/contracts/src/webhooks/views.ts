import type {
  WebhookAttemptOutcome,
  WebhookConfigStatus,
  WebhookDeliveryKind,
  WebhookDeliveryStatus,
  WebhookEndpointStatus,
  WebhookErrorCode,
  WebhookEventType,
  WebhookSkipReason,
} from './webhook.js';

/**
 * What an organization administrator sees of one endpoint.
 *
 * The signing secret is not here, and not in any read model. It is shown once,
 * in the response to the operation that created it, and after that PalCert
 * holds only its ciphertext — a "reveal current secret" route would turn every
 * read of this screen into a credential disclosure, and would make the audit
 * question "who has seen this secret?" unanswerable.
 */
export interface WebhookEndpointView {
  readonly id: string;
  readonly organizationId: string;
  readonly description: string;
  readonly status: WebhookEndpointStatus;
  /**
   * Where the *active* configuration sends, as far as a request can see it.
   *
   * Scheme, host and port, and not the path. The full URL is sealed under the
   * keyring and only the worker's system context can open it — a route that
   * decrypted it for a screen would be the one hole in an authority boundary
   * this phase spent four migrations building. An administrator who needs to
   * check the path saves a new configuration; the one they typed is the one
   * PalCert sends to, and its integrity is proved on every attempt.
   */
  readonly destination: string;
  readonly subscribedEventTypes: readonly WebhookEventType[];
  readonly configVersion: number;
  readonly configStatus: WebhookConfigStatus;
  readonly verifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * A configuration that has been saved but not yet proved reachable.
   *
   * Surfaced as its own object rather than folded into the fields above,
   * because the two answer different questions: "where are events going right
   * now" and "what is waiting to take over once the endpoint answers". A UI
   * that conflated them would tell an administrator their new URL was live
   * before anything had been sent to it.
   */
  readonly pendingConfig: WebhookPendingConfigView | null;
}

export interface WebhookPendingConfigView {
  readonly configVersionId: string;
  readonly destination: string;
  readonly subscribedEventTypes: readonly WebhookEventType[];
  readonly configVersion: number;
  readonly status: WebhookConfigStatus;
  readonly lastVerificationError: WebhookErrorCode | null;
  readonly lastVerificationAt: string | null;
  readonly createdAt: string;
}

/**
 * The one and only time a signing secret is returned (§ secret handling).
 *
 * Returned by create, by rotate and by the idempotent repeat of either within
 * the recovery window — an HTTP write is not proof the client received it, so
 * a retried request with the same idempotency key answers with the same
 * secret rather than a 409. Outside the window it is gone, and rotating again
 * is the only way forward.
 */
export interface WebhookSecretRevealView {
  readonly endpointId: string;
  readonly configVersion: number;
  /** `whsec_`-prefixed. Shown once; never stored in plaintext by PalCert. */
  readonly signingSecret: string;
  /** When this reveal stops being repeatable. */
  readonly recoverableUntil: string;
}

/*
 * There is deliberately no `previousSecretValidUntil` here.
 *
 * Phase 17 has no time-based dual-secret acceptance window, and a field
 * documenting one would be a guarantee PalCert does not make. What actually
 * keeps a rotation safe is that an automatic delivery keeps the configuration
 * it was created with: a receiver accepts the previous secret until
 * `WebhookRotationPendingView.unsettledOldConfigDeliveries` reaches zero, which
 * is a fact about real traffic rather than a clock.
 */

/**
 * One delivery: an event, an endpoint, and what became of the attempt to
 * project it.
 *
 * Deliberately carries no response body and no response headers from the
 * receiver. PalCert normalizes what happened into `errorCode`; storing the
 * receiver's own output would mean storing whatever a third-party server
 * chose to put in it, in PalCert's database, under an organization's tenancy.
 */
export interface WebhookDeliveryView {
  readonly id: string;
  readonly endpointId: string;
  /**
   * Null for a control message.
   *
   * A TEST delivery projects no event, so it has no event type — and saying so
   * is the honest answer. Declaring this non-null and returning null anyway
   * would make every consumer's type a lie about the one delivery kind that
   * behaves differently.
   */
  readonly eventType: WebhookEventType | null;
  readonly kind: WebhookDeliveryKind;
  readonly status: WebhookDeliveryStatus;
  readonly skipReason: WebhookSkipReason | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly lastErrorCode: WebhookErrorCode | null;
  readonly responseStatusCode: number | null;
  /** The delivery this one replays, when it is a replay. */
  readonly replayOfDeliveryId: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

/** One network attempt. The delivery above is the sum of these. */
export interface WebhookAttemptView {
  readonly id: string;
  readonly deliveryId: string;
  readonly attemptNumber: number;
  /** Null while the attempt is still open — a request that has not come back. */
  readonly outcome: WebhookAttemptOutcome | null;
  readonly errorCode: WebhookErrorCode | null;
  readonly responseStatusCode: number | null;
  readonly durationMs: number | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** One real verification handshake, as support and the administrator see it. */
export interface WebhookVerificationAttemptView {
  readonly id: string;
  readonly operationId: string;
  readonly configVersionId: string;
  readonly attemptNumber: number;
  readonly outcome: WebhookAttemptOutcome | null;
  readonly errorCode: WebhookErrorCode | null;
  readonly responseStatusCode: number | null;
  readonly durationMs: number | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/**
 * One configuration an endpoint has had.
 *
 * Immutable, so the list is the endpoint's history rather than a log of edits.
 * The destination is the host and port the version was saved with; the sealed
 * URL is never part of a read model.
 */
export interface WebhookConfigVersionView {
  readonly id: string;
  readonly endpointId: string;
  readonly configVersion: number;
  readonly status: WebhookConfigStatus;
  readonly destination: string;
  readonly lastVerificationError: WebhookErrorCode | null;
  readonly lastVerificationAt: string | null;
  readonly createdAt: string;
  readonly verifiedAt: string | null;
  readonly retiredAt: string | null;
}

/**
 * How much traffic is still bound to a configuration that is no longer current.
 *
 * The number a receiver watches during a secret rotation: an automatic delivery
 * keeps the configuration it was created with, so the previous secret has to
 * stay accepted until this reaches zero. Manual replay uses the current
 * verified configuration and is therefore not counted here.
 */
export interface WebhookRotationPendingView {
  readonly endpointId: string;
  readonly currentConfigVersion: number | null;
  readonly unsettledOldConfigDeliveries: number;
}

/** A durable management intent, for support and for idempotent repeats. */
export interface WebhookOperationView {
  readonly id: string;
  readonly operation: string;
  readonly endpointId: string | null;
  readonly configVersionId: string | null;
  readonly deliveryId: string | null;
  readonly settledAt: string | null;
  readonly settledErrorCode: WebhookErrorCode | null;
  readonly createdAt: string;
}

/** The result of asking PalCert to verify a pending configuration. */
export interface WebhookVerificationRequestView {
  readonly operationId: string;
  readonly endpointId: string;
  readonly configVersionId: string;
  readonly configVersion: number;
  readonly status: WebhookConfigStatus;
}
