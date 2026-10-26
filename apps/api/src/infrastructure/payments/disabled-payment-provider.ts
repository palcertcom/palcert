import { Injectable } from '@nestjs/common';
import { AppError, PalCertErrorCode, PaymentProviderPort } from '@palcert/contracts';
import type {
  CreateTopUpSessionRequest,
  PaymentProviderCapabilities,
  ProviderPaymentState,
  ProviderRefundState,
  RefundPaymentRequest,
  TopUpSession,
  VerifiedPaymentEvent,
} from '@palcert/contracts';

/**
 * What PalCert talks to when it talks to nobody (Phase 20 Checkpoint 7).
 *
 * `PAYMENTS_ENABLED=false` is a supported deployment: an installation that
 * sells nothing still issues certificates, runs checks and shows balances, and
 * §111 says so. Until this checkpoint the provider factory ignored the flag
 * and constructed the configured adapter anyway, so a deployment that had
 * disabled payments still had to hold a Stripe secret key — and, without one,
 * the API refused to boot. A feature switch that requires the credentials of
 * the feature it switches off is not a feature switch.
 *
 * So this stands in. It needs no credential, opens no client and reaches no
 * network, and every operation answers with the same deliberate contract:
 * `PAYMENTS_DISABLED`, HTTP 503. That is a decision the caller can act on,
 * which a thrown `TypeError` from a half-configured SDK is not.
 *
 * Three things it deliberately does **not** do. It does not touch the ledger:
 * disabling payments is a statement about what can happen next, never about
 * what already happened, so historical top-ups, purchases and paid checks stay
 * exactly as they are and stay readable. It does not pretend to succeed —
 * there is no "fake success" path here, because a double that confirms
 * payments which never happened is the failure mode the fake adapter is
 * already forbidden from causing in production. And it does not claim
 * capabilities: `getCapabilities()` reports a provider that supports nothing,
 * so anything reasoning about capabilities sees the truth rather than an
 * absence.
 */
@Injectable()
export class DisabledPaymentProvider extends PaymentProviderPort {
  /**
   * Named rather than inlined, so every refusal carries the same code, status
   * and wording. An operator reading logs should not have to work out whether
   * two different messages mean the same thing.
   */
  private refuse(operation: string): never {
    throw new AppError(PalCertErrorCode.PAYMENTS_DISABLED, {
      message: 'Payments are not enabled in this installation.',
      details: { operation },
    });
  }

  getCapabilities(): PaymentProviderCapabilities {
    return {
      provider: 'disabled',
      apiVersion: 'n/a',
      supportsHostedCheckout: false,
      supportsPartialRefunds: false,
      supportedCurrencies: [],
    };
  }

  createTopUpSession(_request: CreateTopUpSessionRequest): Promise<TopUpSession> {
    this.refuse('createTopUpSession');
  }

  retrievePayment(_params: {
    readonly providerSessionId: string | null;
    readonly providerPaymentId: string | null;
  }): Promise<ProviderPaymentState> {
    this.refuse('retrievePayment');
  }

  refundPayment(_request: RefundPaymentRequest): Promise<ProviderRefundState> {
    this.refuse('refundPayment');
  }

  /**
   * A webhook arriving at a deployment with payments off is refused, not
   * parsed. Verification needs the signing secret, and a deployment that has
   * disabled payments has no reason to hold one — so the only honest answer is
   * that this installation does not accept payment events.
   */
  verifyAndParseWebhook(_params: {
    readonly rawBody: Buffer;
    readonly signatureHeader: string | undefined;
  }): VerifiedPaymentEvent {
    this.refuse('verifyAndParseWebhook');
  }

  /**
   * Not an outage. Readiness must stay green on a deployment that has
   * deliberately turned payments off, so this reports the truth — reachable,
   * because there is nothing to reach — rather than a failure that would take
   * the whole instance out of the load balancer.
   */
  checkAvailability(): Promise<{ ok: boolean; message?: string }> {
    return Promise.resolve({ ok: true, message: 'payments are disabled in this installation' });
  }
}
