import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  PaymentDisputeStatus,
  PaymentEventKind,
  PaymentFailureKind,
  PaymentObjectKind,
  PaymentProviderError,
  PaymentProviderPort,
  type CreateTopUpSessionRequest,
  type PaymentProviderCapabilities,
  type ProviderPaymentState,
  type ProviderRefundState,
  type RefundPaymentRequest,
  type TopUpSession,
  type VerifiedPaymentEvent,
} from '@palcert/contracts';

export const FAKE_PAYMENT_PROVIDER = 'fake';

/**
 * A deterministic payment provider, for tests only (§35).
 *
 * It exists so the suites can exercise every financial path — success,
 * decline, duplicate webhook, out-of-order event, amount mismatch, refund
 * failure, chargeback — without a network, a merchant account or a bill, and
 * without the flakiness of a sandbox someone else operates.
 *
 * It must never serve a real user, and configuration validation refuses it in
 * production. The reason is sharper than for the AI double: this one confirms
 * payments that never happened. Letting it serve production would credit real
 * balances against no money at all.
 */
@Injectable()
export class FakePaymentProvider extends PaymentProviderPort {
  /** How the next provider call behaves. Tests set this. */
  mode:
    | 'normal'
    | 'unavailable'
    | 'rate-limited'
    | 'invalid-request'
    | 'not-found'
    | 'refund-failed'
    | 'already-refunded' = 'normal';

  /** What `retrievePayment` reports. Tests drive the reconciliation paths with it. */
  paymentState: 'unpaid' | 'paid' | 'cancelled' | 'expired' = 'unpaid';
  /** Overridden to exercise the mismatch paths (§56, §57). */
  reportedAmountMinor: bigint | null = null;
  reportedCurrency: string | null = null;

  /** Whether a webhook signature is accepted. */
  signatureValid = true;

  readonly sessions: CreateTopUpSessionRequest[] = [];
  readonly refunds: RefundPaymentRequest[] = [];
  /** Every idempotency key it was given, so tests can assert §44 and §45. */
  readonly idempotencyKeys: string[] = [];

  private readonly sessionsById = new Map<string, CreateTopUpSessionRequest>();

  getCapabilities(): PaymentProviderCapabilities {
    return {
      provider: FAKE_PAYMENT_PROVIDER,
      apiVersion: 'fake-1',
      supportsHostedCheckout: true,
      supportsPartialRefunds: true,
      supportedCurrencies: ['USD', 'EUR', 'ILS', 'JOD', 'JPY'],
    };
  }

  async createTopUpSession(request: CreateTopUpSessionRequest): Promise<TopUpSession> {
    this.maybeFail();
    this.idempotencyKeys.push(request.idempotencyKey);

    // Idempotent like the real thing: the same key returns the same session
    // rather than opening a second one the customer could also pay (§44).
    const existing = this.sessions.find((entry) => entry.idempotencyKey === request.idempotencyKey);
    if (existing !== undefined) {
      return {
        providerSessionId: sessionIdFor(existing.topUpId),
        checkoutUrl: `https://fake-checkout.test/${sessionIdFor(existing.topUpId)}`,
        expiresAt: existing.expiresAt,
      };
    }

    this.sessions.push(request);
    this.sessionsById.set(sessionIdFor(request.topUpId), request);
    return {
      providerSessionId: sessionIdFor(request.topUpId),
      checkoutUrl: `https://fake-checkout.test/${sessionIdFor(request.topUpId)}`,
      expiresAt: request.expiresAt,
    };
  }

  async retrievePayment(params: {
    readonly providerSessionId: string | null;
    readonly providerPaymentId: string | null;
  }): Promise<ProviderPaymentState> {
    this.maybeFail();
    const sessionId = params.providerSessionId;
    const request = sessionId === null ? undefined : this.sessionsById.get(sessionId);

    return {
      providerSessionId: sessionId,
      providerPaymentId:
        params.providerPaymentId ??
        (this.paymentState === 'paid' && sessionId !== null ? paymentIdFor(sessionId) : null),
      paid: this.paymentState === 'paid',
      cancelled: this.paymentState === 'cancelled',
      expired: this.paymentState === 'expired',
      currency: this.reportedCurrency ?? request?.currency ?? null,
      amountMinor: this.reportedAmountMinor ?? request?.amountMinor ?? null,
      clientReference: request?.topUpId ?? null,
    };
  }

  async refundPayment(request: RefundPaymentRequest): Promise<ProviderRefundState> {
    this.maybeFail();
    this.idempotencyKeys.push(request.idempotencyKey);

    const existing = this.refunds.find((entry) => entry.idempotencyKey === request.idempotencyKey);
    if (existing !== undefined) {
      // Same key, same refund. A duplicate finance click must not send money
      // twice (§75).
      return {
        providerRefundId: refundIdFor(existing.refundId),
        succeeded: true,
        failed: false,
        pending: false,
        amountMinor: existing.amountMinor,
        currency: existing.currency,
        failureCode: null,
      };
    }
    this.refunds.push(request);

    if (this.mode === 'refund-failed') {
      return {
        providerRefundId: refundIdFor(request.refundId),
        succeeded: false,
        failed: true,
        pending: false,
        amountMinor: request.amountMinor,
        currency: request.currency,
        failureCode: 'PROVIDER_DECLINED',
      };
    }

    return {
      providerRefundId: refundIdFor(request.refundId),
      succeeded: true,
      failed: false,
      pending: false,
      amountMinor: request.amountMinor,
      currency: request.currency,
      failureCode: null,
    };
  }

  /**
   * Verify and translate a webhook.
   *
   * The double's "signature" is a flag rather than an HMAC, because what the
   * financial suites need to prove is what happens *after* verification —
   * dedupe, ordering, exactly-once credit. The real HMAC path is proven
   * against the Stripe adapter's own tests (§165).
   */
  verifyAndParseWebhook(params: {
    readonly rawBody: Buffer;
    readonly signatureHeader: string | undefined;
  }): VerifiedPaymentEvent {
    if (!this.signatureValid || params.signatureHeader === undefined) {
      throw new PaymentProviderError(
        PaymentFailureKind.SIGNATURE_INVALID,
        'the webhook signature did not verify',
      );
    }

    // Parsed from the raw bytes, exactly as the real adapter does, so a test
    // that mutates the body still breaks in the same place.
    const payload = JSON.parse(params.rawBody.toString('utf8')) as FakeWebhookPayload;

    return {
      providerEventId: payload.id,
      providerEventType: payload.type,
      kind: payload.kind,
      objectKind: payload.objectKind ?? PaymentObjectKind.TOP_UP,
      providerObjectId: payload.objectId ?? null,
      clientReference: payload.clientReference ?? null,
      relatedPaymentId: payload.relatedPaymentId ?? null,
      currency: payload.currency ?? null,
      amountMinor: payload.amountMinor === undefined ? null : BigInt(payload.amountMinor),
      disputeStatus: payload.disputeStatus ?? null,
      occurredAt: new Date(payload.occurredAt ?? Date.now()),
    };
  }

  async checkAvailability(): Promise<{ ok: boolean; message?: string }> {
    return this.mode === 'unavailable' ? { ok: false, message: 'unavailable' } : { ok: true };
  }

  reset(): void {
    this.mode = 'normal';
    this.paymentState = 'unpaid';
    this.reportedAmountMinor = null;
    this.reportedCurrency = null;
    this.signatureValid = true;
    this.sessions.length = 0;
    this.refunds.length = 0;
    this.idempotencyKeys.length = 0;
    this.sessionsById.clear();
  }

  private maybeFail(): void {
    switch (this.mode) {
      case 'unavailable':
        throw new PaymentProviderError(
          PaymentFailureKind.UNAVAILABLE,
          'the payment provider is unreachable',
        );
      case 'rate-limited':
        throw new PaymentProviderError(PaymentFailureKind.RATE_LIMITED, 'rate limited', 1);
      case 'invalid-request':
        throw new PaymentProviderError(
          PaymentFailureKind.INVALID_REQUEST,
          'the provider rejected the request',
        );
      case 'not-found':
        throw new PaymentProviderError(PaymentFailureKind.NOT_FOUND, 'no such provider object');
      case 'already-refunded':
        throw new PaymentProviderError(
          PaymentFailureKind.ALREADY_REFUNDED,
          'that payment has already been fully refunded',
        );
      default:
        break;
    }
  }
}

/** The body shape the double's webhooks use. Tests build these directly. */
export interface FakeWebhookPayload {
  readonly id: string;
  readonly type: string;
  readonly kind: PaymentEventKind;
  readonly objectKind?: PaymentObjectKind;
  readonly objectId?: string;
  readonly clientReference?: string;
  readonly currency?: string;
  /** A string, so a test cannot accidentally prove float-safe behaviour. */
  readonly amountMinor?: string;
  readonly disputeStatus?: PaymentDisputeStatus;
  /** The payment a dispute claws back (§84). */
  readonly relatedPaymentId?: string;
  readonly occurredAt?: number;
}

/**
 * Deterministic provider identifiers.
 *
 * Derived from PalCert's own ids rather than random, so a test can predict
 * them and so replaying the same top-up produces the same session id — which
 * is what makes the duplicate-webhook suites meaningful.
 */
function sessionIdFor(topUpId: string): string {
  return `cs_fake_${digest(topUpId)}`;
}

function paymentIdFor(sessionId: string): string {
  return `pi_fake_${digest(sessionId)}`;
}

function refundIdFor(refundId: string): string {
  return `re_fake_${digest(refundId)}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/** A unique provider event id, for tests that need one. */
export function fakeEventId(): string {
  return `evt_fake_${randomUUID()}`;
}
