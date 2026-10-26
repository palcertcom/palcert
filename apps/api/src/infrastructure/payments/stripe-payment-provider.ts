import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import {
  PaymentDisputeStatus,
  PaymentEventKind,
  PaymentFailureKind,
  PaymentObjectKind,
  PaymentProviderError,
  PaymentProviderPort,
  PaymentRefundReason,
  type CreateTopUpSessionRequest,
  type PaymentProviderCapabilities,
  type ProviderPaymentState,
  type ProviderRefundState,
  type RefundPaymentRequest,
  type TopUpSession,
  type VerifiedPaymentEvent,
} from '@palcert/contracts';
import { ApiConfigService } from '../../config/api-config.service';

export const STRIPE_PAYMENT_PROVIDER = 'stripe';

/**
 * The Stripe adapter (§35, §36, §39, §88, §90, §140).
 *
 * **This is the only file in PalCert that may know a Stripe event name.**
 * Everything it returns is PalCert vocabulary; everything it accepts is a
 * PalCert concept. That boundary is what makes a regional provider — which
 * PalCert will need, because Stripe cannot onboard merchants everywhere it
 * intends to operate — an additional class rather than a rewrite of the
 * ledger, the holds, the pricing and the refunds.
 *
 * Two further decisions live here. Checkout is **provider-hosted**: the
 * customer's card details are entered on Stripe's page and never touch a
 * PalCert server, which is what keeps PalCert outside the card-data boundary
 * entirely (§38, §90). And the API version is **pinned in code** rather than
 * inherited from the account, so someone upgrading the account default in a
 * dashboard cannot silently change what these requests mean.
 */
@Injectable()
export class StripePaymentProvider extends PaymentProviderPort {
  private readonly client: Stripe;
  private readonly apiVersion: string;
  private readonly webhookSecret: string;

  constructor(private readonly config: ApiConfigService) {
    super();
    const settings = this.config.stripe;
    if (settings.secretKey === undefined) {
      throw new Error('STRIPE_SECRET_KEY is required to construct the Stripe payment provider.');
    }
    this.apiVersion = settings.apiVersion;
    this.webhookSecret = settings.webhookSecret ?? '';

    this.client = new Stripe(settings.secretKey, {
      // Pinned, not inherited (§140).
      apiVersion: settings.apiVersion as Stripe.LatestApiVersion,
      timeout: settings.timeoutMs,
      maxNetworkRetries: 0,
      ...(settings.baseUrl === undefined
        ? {}
        : {
            host: hostOf(settings.baseUrl),
            protocol: protocolOf(settings.baseUrl),
            port: portOf(settings.baseUrl),
          }),
    });
  }

  getCapabilities(): PaymentProviderCapabilities {
    return {
      provider: STRIPE_PAYMENT_PROVIDER,
      apiVersion: this.apiVersion,
      supportsHostedCheckout: true,
      supportsPartialRefunds: true,
      supportedCurrencies: this.config.payments.enabledCurrencies,
    };
  }

  /**
   * Create a hosted Checkout Session for one top-up.
   *
   * `price_data` is built from PalCert's own persisted amount, never from
   * anything the browser sent (§43). The metadata carries opaque identifiers
   * only — no document title, no name, no organization data (§46).
   */
  async createTopUpSession(request: CreateTopUpSessionRequest): Promise<TopUpSession> {
    const session = await this.call(() =>
      this.client.checkout.sessions.create(
        {
          mode: 'payment',
          success_url: request.successUrl,
          cancel_url: request.cancelUrl,
          // Stripe reads amounts in the smallest currency unit, which is
          // exactly what PalCert stores — so there is no conversion here, and
          // deliberately no `* 100` (§5).
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: request.currency.toLowerCase(),
                unit_amount: Number(request.amountMinor),
                product_data: { name: 'PalCert Balance top-up' },
              },
            },
          ],
          client_reference_id: request.topUpId,
          metadata: {
            palcertTopUpId: request.topUpId,
            palcertUserId: request.ownerUserId,
          },
          expires_at: Math.floor(request.expiresAt.getTime() / 1000),
          ...(request.locale === undefined ? {} : { locale: stripeLocale(request.locale) }),
        },
        { idempotencyKey: request.idempotencyKey },
      ),
    );

    if (session.url === null) {
      throw new PaymentProviderError(
        PaymentFailureKind.INVALID_REQUEST,
        'the provider returned a checkout session with no hosted page',
      );
    }

    return {
      providerSessionId: session.id,
      checkoutUrl: session.url,
      expiresAt: new Date(session.expires_at * 1000),
    };
  }

  /**
   * The provider's current truth about a payment.
   *
   * Used both to verify a webhook's claim and to reconcile a top-up nobody
   * heard about. `paid` is deliberately strict: `payment_status === 'paid'`
   * and nothing looser, because a session that is merely `complete` may still
   * be awaiting an asynchronous payment method.
   */
  async retrievePayment(params: {
    readonly providerSessionId: string | null;
    readonly providerPaymentId: string | null;
  }): Promise<ProviderPaymentState> {
    if (params.providerSessionId !== null) {
      const session = await this.call(() =>
        this.client.checkout.sessions.retrieve(params.providerSessionId!),
      );
      return {
        providerSessionId: session.id,
        providerPaymentId: idOf(session.payment_intent),
        paid: session.payment_status === 'paid',
        cancelled: session.status === 'expired' && session.payment_status !== 'paid',
        expired: session.status === 'expired',
        currency: upperOrNull(session.currency),
        amountMinor: minorOrNull(session.amount_total),
        clientReference: session.client_reference_id ?? null,
      };
    }

    if (params.providerPaymentId !== null) {
      const intent = await this.call(() =>
        this.client.paymentIntents.retrieve(params.providerPaymentId!),
      );
      return {
        providerSessionId: null,
        providerPaymentId: intent.id,
        paid: intent.status === 'succeeded',
        cancelled: intent.status === 'canceled',
        expired: false,
        currency: intent.currency.toUpperCase(),
        amountMinor: BigInt(intent.amount_received > 0 ? intent.amount_received : intent.amount),
        clientReference: intent.metadata?.['palcertTopUpId'] ?? null,
      };
    }

    throw new PaymentProviderError(
      PaymentFailureKind.INVALID_REQUEST,
      'a payment lookup needs either a session or a payment identifier',
    );
  }

  async refundPayment(request: RefundPaymentRequest): Promise<ProviderRefundState> {
    const refund = await this.call(() =>
      this.client.refunds.create(
        {
          payment_intent: request.providerPaymentId,
          amount: Number(request.amountMinor),
          ...(stripeRefundReason(request.reason) === undefined
            ? {}
            : { reason: stripeRefundReason(request.reason) }),
          metadata: { palcertRefundId: request.refundId },
        },
        { idempotencyKey: request.idempotencyKey },
      ),
    );

    return {
      providerRefundId: refund.id,
      succeeded: refund.status === 'succeeded',
      failed: refund.status === 'failed' || refund.status === 'canceled',
      pending: refund.status === 'pending' || refund.status === 'requires_action',
      amountMinor: BigInt(refund.amount),
      currency: refund.currency.toUpperCase(),
      // A stable code, never the provider's prose (§82).
      failureCode: refund.failure_reason === undefined ? null : String(refund.failure_reason),
    };
  }

  /**
   * Verify a webhook against the **raw** body and translate it.
   *
   * `constructEvent` computes an HMAC over the exact bytes Stripe sent. Any
   * middleware that parsed and re-serialized the body first would change those
   * bytes and every signature would fail — which is why the raw-body path has
   * its own regression test rather than being assumed (§48).
   */
  verifyAndParseWebhook(params: {
    readonly rawBody: Buffer;
    readonly signatureHeader: string | undefined;
  }): VerifiedPaymentEvent {
    if (params.signatureHeader === undefined || params.signatureHeader === '') {
      throw new PaymentProviderError(
        PaymentFailureKind.SIGNATURE_INVALID,
        'the request carried no provider signature',
      );
    }

    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(
        params.rawBody,
        params.signatureHeader,
        this.webhookSecret,
      );
    } catch {
      // Deliberately no cause and no provider text: a signature failure
      // message is attacker-visible and must not echo anything back (§82).
      throw new PaymentProviderError(
        PaymentFailureKind.SIGNATURE_INVALID,
        'the webhook signature did not verify',
      );
    }

    return this.translate(event);
  }

  async checkAvailability(): Promise<{ ok: boolean; message?: string }> {
    try {
      // The cheapest authenticated call there is. A failure here means the
      // payment feature is degraded — never that PalCert is down (§110).
      await this.client.balance.retrieve();
      return { ok: true };
    } catch {
      return { ok: false, message: 'the payment provider is unreachable' };
    }
  }

  // -------------------------------------------------------------------------
  // Translation — the only place Stripe's vocabulary exists
  // -------------------------------------------------------------------------

  /**
   * Stripe event → PalCert event (§87, §88).
   *
   * Anything not listed is `UNSUPPORTED`: valid, signed, acknowledged, and of
   * no financial consequence. Stripe adds event types regularly and PalCert
   * must not throw because one arrived (§123).
   */
  private translate(event: Stripe.Event): VerifiedPaymentEvent {
    const base = {
      providerEventId: event.id,
      providerEventType: event.type,
      occurredAt: new Date(event.created * 1000),
      // Only a dispute overrides this: every other event is already about the
      // payment itself.
      relatedPaymentId: null as string | null,
    };

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          ...base,
          // A completed session is not necessarily a paid one: an
          // asynchronous method can complete the session and settle later.
          kind:
            session.payment_status === 'paid'
              ? PaymentEventKind.PAYMENT_SUCCEEDED
              : PaymentEventKind.UNSUPPORTED,
          objectKind: PaymentObjectKind.TOP_UP,
          providerObjectId: session.id,
          clientReference: session.client_reference_id ?? null,
          currency: upperOrNull(session.currency),
          amountMinor: minorOrNull(session.amount_total),
          disputeStatus: null,
        };
      }

      case 'checkout.session.async_payment_failed': {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          ...base,
          kind: PaymentEventKind.PAYMENT_FAILED,
          objectKind: PaymentObjectKind.TOP_UP,
          providerObjectId: session.id,
          clientReference: session.client_reference_id ?? null,
          currency: upperOrNull(session.currency),
          amountMinor: minorOrNull(session.amount_total),
          disputeStatus: null,
        };
      }

      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          ...base,
          kind: PaymentEventKind.PAYMENT_EXPIRED,
          objectKind: PaymentObjectKind.TOP_UP,
          providerObjectId: session.id,
          clientReference: session.client_reference_id ?? null,
          currency: null,
          amountMinor: null,
          disputeStatus: null,
        };
      }

      case 'payment_intent.payment_failed': {
        const intent = event.data.object as Stripe.PaymentIntent;
        return {
          ...base,
          kind: PaymentEventKind.PAYMENT_FAILED,
          objectKind: PaymentObjectKind.TOP_UP,
          providerObjectId: intent.id,
          clientReference: intent.metadata?.['palcertTopUpId'] ?? null,
          currency: intent.currency.toUpperCase(),
          amountMinor: BigInt(intent.amount),
          disputeStatus: null,
        };
      }

      case 'payment_intent.canceled': {
        const intent = event.data.object as Stripe.PaymentIntent;
        return {
          ...base,
          kind: PaymentEventKind.PAYMENT_CANCELLED,
          objectKind: PaymentObjectKind.TOP_UP,
          providerObjectId: intent.id,
          clientReference: intent.metadata?.['palcertTopUpId'] ?? null,
          currency: intent.currency.toUpperCase(),
          amountMinor: BigInt(intent.amount),
          disputeStatus: null,
        };
      }

      case 'refund.updated':
      case 'charge.refund.updated': {
        const refund = event.data.object as Stripe.Refund;
        return {
          ...base,
          kind:
            refund.status === 'succeeded'
              ? PaymentEventKind.REFUND_SUCCEEDED
              : refund.status === 'failed' || refund.status === 'canceled'
                ? PaymentEventKind.REFUND_FAILED
                : PaymentEventKind.UNSUPPORTED,
          objectKind: PaymentObjectKind.REFUND,
          providerObjectId: refund.id,
          clientReference: refund.metadata?.['palcertRefundId'] ?? null,
          currency: refund.currency.toUpperCase(),
          amountMinor: BigInt(refund.amount),
          disputeStatus: null,
        };
      }

      case 'charge.dispute.created': {
        const dispute = event.data.object as Stripe.Dispute;
        return {
          ...base,
          kind: PaymentEventKind.PAYMENT_DISPUTED,
          objectKind: PaymentObjectKind.DISPUTE,
          providerObjectId: dispute.id,
          clientReference: null,
          currency: dispute.currency.toUpperCase(),
          amountMinor: BigInt(dispute.amount),
          disputeStatus: PaymentDisputeStatus.OPEN,
          // The payment being clawed back. PalCert files the chargeback
          // against the top-up, so the link is resolved here rather than
          // guessed at in core finance (§84).
          relatedPaymentId: idOf(dispute.payment_intent),
        };
      }

      case 'charge.dispute.closed': {
        const dispute = event.data.object as Stripe.Dispute;
        const won = dispute.status === 'won';
        return {
          ...base,
          // Only a win returns the money. A lost dispute leaves the debit in
          // place, which is the financial reality (§84).
          kind: won ? PaymentEventKind.DISPUTE_REVERSED : PaymentEventKind.UNSUPPORTED,
          objectKind: PaymentObjectKind.DISPUTE,
          providerObjectId: dispute.id,
          clientReference: null,
          currency: dispute.currency.toUpperCase(),
          amountMinor: BigInt(dispute.amount),
          disputeStatus: won ? PaymentDisputeStatus.WON : PaymentDisputeStatus.LOST,
          relatedPaymentId: idOf(dispute.payment_intent),
        };
      }

      default:
        return {
          ...base,
          kind: PaymentEventKind.UNSUPPORTED,
          objectKind: PaymentObjectKind.UNKNOWN,
          providerObjectId: null,
          clientReference: null,
          currency: null,
          amountMinor: null,
          disputeStatus: null,
        };
    }
  }

  /**
   * Run a provider call and translate its failure.
   *
   * The message PalCert keeps is its own: a Stripe error can carry request
   * ids and object details, and none of that belongs in a log line or an
   * error shown to an operator (§82).
   */
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw translateError(error);
    }
  }
}

/** The events PalCert subscribes to. Documented, and deliberately short (§89). */
export const REQUIRED_STRIPE_WEBHOOK_EVENTS: readonly string[] = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'refund.updated',
  'charge.dispute.created',
  'charge.dispute.closed',
];

function translateError(error: unknown): PaymentProviderError {
  if (!(error instanceof Stripe.errors.StripeError)) {
    return new PaymentProviderError(PaymentFailureKind.UNKNOWN, 'the payment provider call failed');
  }

  switch (error.type) {
    case 'StripeConnectionError':
      return new PaymentProviderError(
        PaymentFailureKind.UNAVAILABLE,
        'the payment provider was unreachable',
      );
    case 'StripeAPIError':
      return new PaymentProviderError(
        PaymentFailureKind.RETRYABLE,
        'the payment provider reported an internal error',
      );
    case 'StripeRateLimitError':
      return new PaymentProviderError(
        PaymentFailureKind.RATE_LIMITED,
        'the provider rate-limited PalCert',
      );
    case 'StripeAuthenticationError':
      return new PaymentProviderError(
        PaymentFailureKind.AUTHENTICATION,
        'the payment provider rejected PalCert’s credential',
      );
    case 'StripeInvalidRequestError':
      if (error.code === 'resource_missing') {
        return new PaymentProviderError(PaymentFailureKind.NOT_FOUND, 'no such provider object');
      }
      if (error.code === 'charge_already_refunded') {
        return new PaymentProviderError(
          PaymentFailureKind.ALREADY_REFUNDED,
          'that payment has already been fully refunded',
        );
      }
      return new PaymentProviderError(
        PaymentFailureKind.INVALID_REQUEST,
        'the payment provider rejected the request',
      );
    default:
      return new PaymentProviderError(
        PaymentFailureKind.UNKNOWN,
        'the payment provider call failed',
      );
  }
}

/** PalCert's refund reasons are richer than Stripe's three; the rest map to none. */
function stripeRefundReason(
  reason: PaymentRefundReason,
): 'duplicate' | 'fraudulent' | 'requested_by_customer' | undefined {
  switch (reason) {
    case PaymentRefundReason.DUPLICATE:
      return 'duplicate';
    case PaymentRefundReason.FRAUDULENT:
      return 'fraudulent';
    case PaymentRefundReason.REQUESTED_BY_CUSTOMER:
      return 'requested_by_customer';
    default:
      return undefined;
  }
}

/** Stripe's hosted page speaks both of PalCert's languages. */
function stripeLocale(locale: string): Stripe.Checkout.SessionCreateParams.Locale {
  return locale.startsWith('ar') ? 'auto' : 'en';
}

/**
 * A provider field that may be null, absent, or present.
 *
 * Stripe omits fields it has nothing to say about, so a `=== null` check
 * misses `undefined` entirely — and the difference between "not paid" and a
 * thrown TypeError inside webhook processing is a payment that never gets
 * credited.
 */
function upperOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toUpperCase();
}

function minorOrNull(value: number | null | undefined): bigint | null {
  return value === null || value === undefined ? null : BigInt(value);
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : value.id;
}

function hostOf(baseUrl: string): string {
  return new URL(baseUrl).hostname;
}

function protocolOf(baseUrl: string): 'http' | 'https' {
  return new URL(baseUrl).protocol === 'http:' ? 'http' : 'https';
}

function portOf(baseUrl: string): number {
  const url = new URL(baseUrl);
  return url.port === '' ? (url.protocol === 'http:' ? 80 : 443) : Number(url.port);
}
