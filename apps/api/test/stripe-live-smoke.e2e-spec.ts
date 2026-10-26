import { PaymentProviderError } from '@palcert/contracts';
import { StripePaymentProvider } from '../src/infrastructure/payments/stripe-payment-provider';
import type { ApiConfigService } from '../src/config/api-config.service';

/**
 * The optional live Stripe smoke test (Phase 10 carry-forward, §139).
 *
 * Skipped unless `PALCERT_LIVE_STRIPE_TEST=1` **and** a Stripe key is present,
 * so normal CI needs no credential and Phase 11's paid-check suites never
 * touch a payment provider at all — a check is bought with PalCert Balance,
 * and that is the whole point of §1.
 *
 * What it proves is the one thing a local mock server cannot: that PalCert's
 * requests are shaped the way the real API expects. It creates a Checkout
 * Session in **test mode** for a synthetic $1 top-up with obviously fake
 * metadata, reads it back, and stops. It charges nothing — a Checkout Session
 * is an intent, and nobody enters a card — and it creates no refund, no
 * customer and no product.
 *
 * The key is guarded twice: the test refuses to run against a live-mode key,
 * because `sk_live_` is not a credential any automated test should hold.
 */

const KEY = process.env['STRIPE_SECRET_KEY'];
const LIVE = process.env['PALCERT_LIVE_STRIPE_TEST'] === '1' && KEY !== undefined;
const describeLive = LIVE ? describe : describe.skip;

describeLive('Stripe live smoke test (test mode)', () => {
  function provider(): StripePaymentProvider {
    if (KEY !== undefined && !KEY.startsWith('sk_test_')) {
      // Not a skip: running this against real money would be a mistake worth
      // failing loudly over.
      throw new Error('PALCERT_LIVE_STRIPE_TEST requires a Stripe test-mode key (sk_test_…)');
    }

    const config = {
      payments: {
        enabled: true,
        provider: 'stripe',
        successUrl: 'https://palcert.example/en/balance/payment-return',
        cancelUrl: 'https://palcert.example/en/balance/payment-cancelled',
        topUpSessionTtlSeconds: 1_800,
        providerTimeoutMs: 30_000,
      },
      stripe: {
        secretKey: KEY,
        webhookSecret: 'whsec_not_used_by_this_test_but_required_by_the_shape',
        apiVersion: process.env['STRIPE_API_VERSION'] ?? '2026-08-26.dahlia',
        baseUrl: undefined,
      },
    } as unknown as ApiConfigService;
    return new StripePaymentProvider(config);
  }

  it('creates and reads back a test-mode checkout session', async () => {
    const topUpId = `live-smoke-${Date.now()}`;
    const stripe = provider();

    const session = await stripe.createTopUpSession({
      topUpId,
      ownerUserId: '00000000-0000-0000-0000-000000000000',
      currency: 'USD',
      // One dollar, in minor units, exactly as PalCert holds it.
      amountMinor: 100n,
      successUrl: 'https://palcert.example/en/balance/payment-return',
      cancelUrl: 'https://palcert.example/en/balance/payment-cancelled',
      expiresAt: new Date(Date.now() + 30 * 60 * 1_000),
      idempotencyKey: `live-smoke:${topUpId}`,
    });

    expect(session.providerSessionId).toMatch(/^cs_test_/);
    expect(session.checkoutUrl).toMatch(/^https:\/\//);

    // Read it back: unpaid, because nobody has entered a card and this test
    // will never ask anybody to.
    const state = await stripe.retrievePayment({
      providerSessionId: session.providerSessionId,
      providerPaymentId: null,
    });
    expect(state.paid).toBe(false);
    expect(state.currency).toBe('USD');
    expect(state.amountMinor).toBe(100n);
    expect(state.clientReference).toBe(topUpId);
  }, 60_000);

  it('reports a credential Stripe rejects as an authentication failure', async () => {
    const stripe = new StripePaymentProvider({
      payments: { providerTimeoutMs: 30_000 },
      stripe: {
        secretKey: 'sk_test_obviously_not_a_real_key_0000000000',
        webhookSecret: 'whsec_unused_but_required_by_the_shape_0000',
        apiVersion: process.env['STRIPE_API_VERSION'] ?? '2026-08-26.dahlia',
        baseUrl: undefined,
      },
    } as unknown as ApiConfigService);

    await expect(
      stripe.retrievePayment({ providerSessionId: 'cs_test_nonexistent', providerPaymentId: null }),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  }, 60_000);

  it('reports availability without moving any money', async () => {
    await expect(provider().checkAvailability()).resolves.toMatchObject({ ok: true });
  }, 60_000);
});
