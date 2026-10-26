import type {
  PaymentDisputeStatus,
  PaymentEventKind,
  PaymentObjectKind,
  PaymentRefundReason,
} from './payments.js';

/**
 * The payment provider port (§34–§36).
 *
 * Business logic imports this and nothing from a vendor SDK. The reason is
 * concrete rather than aesthetic: Stripe cannot onboard merchants in every
 * country PalCert intends to serve, so a regional provider is a foreseeable
 * requirement rather than a hypothetical one. When it arrives it must be a new
 * class behind this interface — not a change to the ledger, the balance, the
 * holds, the pricing or the refunds.
 *
 * Everything crossing this boundary is either a PalCert concept or an opaque
 * provider identifier. No provider event name, no SDK type, and no secret.
 */

export interface PaymentProviderCapabilities {
  /** The configured provider's stable name, e.g. `stripe`, `fake`. */
  readonly provider: string;
  /** The provider API version this adapter is pinned to (§139, §140). */
  readonly apiVersion: string;
  readonly supportsHostedCheckout: boolean;
  readonly supportsPartialRefunds: boolean;
  /** Currencies the provider will accept in this deployment. */
  readonly supportedCurrencies: readonly string[];
}

/** What PalCert asks for when a customer wants to add credit. */
export interface CreateTopUpSessionRequest {
  /** PalCert's own top-up id. Becomes the provider's client reference. */
  readonly topUpId: string;
  /** Opaque; used only to correlate. Never a name or an email (§46). */
  readonly ownerUserId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly expiresAt: Date;
  /** Stable per operation, so a network retry cannot create a second session (§44). */
  readonly idempotencyKey: string;
  /** BCP 47 tag for the hosted page, when the provider supports one. */
  readonly locale?: string | undefined;
}

export interface TopUpSession {
  readonly providerSessionId: string;
  /**
   * The hosted page. Short-lived and sensitive: handed to the authenticated
   * customer and never logged or persisted (§92).
   */
  readonly checkoutUrl: string;
  readonly expiresAt: Date;
}

/** The provider's own view of a payment, as PalCert needs to verify it (§55). */
export interface ProviderPaymentState {
  readonly providerSessionId: string | null;
  readonly providerPaymentId: string | null;
  /** True only when the provider says the money is actually captured. */
  readonly paid: boolean;
  readonly cancelled: boolean;
  readonly expired: boolean;
  readonly currency: string | null;
  readonly amountMinor: bigint | null;
  /** PalCert's top-up id as the provider echoed it back. */
  readonly clientReference: string | null;
}

export interface RefundPaymentRequest {
  readonly refundId: string;
  /** The provider payment being refunded, from the original top-up. */
  readonly providerPaymentId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly reason: PaymentRefundReason;
  readonly idempotencyKey: string;
}

export interface ProviderRefundState {
  readonly providerRefundId: string;
  readonly succeeded: boolean;
  readonly failed: boolean;
  readonly pending: boolean;
  readonly amountMinor: bigint | null;
  readonly currency: string | null;
  /** A stable code, never provider prose. */
  readonly failureCode: string | null;
}

/**
 * One verified provider event, already translated into PalCert's vocabulary.
 *
 * The adapter has done the signature check and the mapping. Core finance
 * receives a fact about a payment, not a webhook.
 */
export interface VerifiedPaymentEvent {
  readonly providerEventId: string;
  /** The provider's own type string. Recorded for support; never branched on. */
  readonly providerEventType: string;
  readonly kind: PaymentEventKind;
  readonly objectKind: PaymentObjectKind;
  /** The provider object this concerns: session, payment intent, refund or dispute. */
  readonly providerObjectId: string | null;
  /** PalCert's own id, when the provider carried it back. */
  readonly clientReference: string | null;
  /**
   * The payment this event concerns, when the event is *about* something else.
   *
   * A dispute names itself, not the payment it claws back — but PalCert files
   * the chargeback against the top-up, so the adapter resolves the link once
   * rather than leaving core finance to guess at it (§84).
   */
  readonly relatedPaymentId: string | null;
  readonly currency: string | null;
  readonly amountMinor: bigint | null;
  readonly disputeStatus: PaymentDisputeStatus | null;
  /** When the provider says it happened, for ordering diagnostics only (§53). */
  readonly occurredAt: Date;
}

/**
 * Why a provider call failed, in PalCert's terms.
 *
 * `RETRYABLE` distinguishes a provider having a bad minute from a request the
 * provider will never accept — the difference between waiting and telling
 * someone.
 */
export const PaymentFailureKind = {
  RETRYABLE: 'RETRYABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  AUTHENTICATION: 'AUTHENTICATION',
  INVALID_REQUEST: 'INVALID_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_REFUNDED: 'ALREADY_REFUNDED',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  UNAVAILABLE: 'UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
} as const;

export type PaymentFailureKind = (typeof PaymentFailureKind)[keyof typeof PaymentFailureKind];

/**
 * A provider failure.
 *
 * Carries a kind and a short message that has already been stripped of
 * anything the provider might have echoed back — a message is shown to
 * operators and must not become a channel for card data or a secret (§82).
 */
export class PaymentProviderError extends Error {
  constructor(
    readonly kind: PaymentFailureKind,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }

  get retryable(): boolean {
    return (
      this.kind === PaymentFailureKind.RETRYABLE ||
      this.kind === PaymentFailureKind.RATE_LIMITED ||
      this.kind === PaymentFailureKind.UNAVAILABLE
    );
  }
}

/**
 * The one boundary between PalCert and a payment company.
 *
 * An abstract class rather than an interface so Nest can inject it by token
 * and so a provider cannot be half-implemented — exactly as `AIProviderPort`
 * works (ADR-0054).
 */
export abstract class PaymentProviderPort {
  abstract getCapabilities(): PaymentProviderCapabilities;

  /** Create a provider-hosted checkout for one top-up. */
  abstract createTopUpSession(request: CreateTopUpSessionRequest): Promise<TopUpSession>;

  /** The provider's current truth about a payment. Used to verify and to reconcile. */
  abstract retrievePayment(params: {
    readonly providerSessionId: string | null;
    readonly providerPaymentId: string | null;
  }): Promise<ProviderPaymentState>;

  abstract refundPayment(request: RefundPaymentRequest): Promise<ProviderRefundState>;

  /**
   * Verify a webhook's signature against the **raw** body and translate it.
   *
   * Takes a Buffer, not a parsed object, because a signature covers bytes: any
   * middleware that reparsed and re-serialized the body would silently break
   * verification, which is why the raw-body path has its own regression test
   * (§48).
   */
  abstract verifyAndParseWebhook(params: {
    readonly rawBody: Buffer;
    readonly signatureHeader: string | undefined;
  }): VerifiedPaymentEvent;

  /** A liveness probe for the payment feature alone, never for the platform (§110). */
  abstract checkAvailability(): Promise<{ ok: boolean; message?: string }>;
}
