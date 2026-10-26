import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PaymentFailureKind, PaymentProviderError, PaymentRefundReason } from '@palcert/contracts';
import type { ApiConfigService } from '../../config/api-config.service';
import { REQUIRED_STRIPE_WEBHOOK_EVENTS, StripePaymentProvider } from './stripe-payment-provider';

/**
 * The Stripe adapter, against a controlled mock server (§137, §165).
 *
 * No live key, no network, and no sandbox someone else operates — so these run
 * in ordinary CI and fail for real reasons rather than because a third party
 * was slow. What they prove is the adapter's side of the contract: that it
 * sends idempotency keys, asks for hosted checkout, verifies signatures over
 * raw bytes, translates provider vocabulary into PalCert's, and turns every
 * failure into a PalCert failure kind rather than leaking an SDK error.
 */

const WEBHOOK_SECRET = 'whsec_test_secret_value_for_adapter_tests';

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | undefined>;
  readonly body: string;
}

describe('StripePaymentProvider', () => {
  let server: Server;
  let baseUrl: string;
  let requests: RecordedRequest[];
  let respond: (request: RecordedRequest) => { status: number; body: unknown };

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const recorded: RecordedRequest = {
          method: request.method ?? 'GET',
          url: request.url ?? '',
          headers: request.headers as Record<string, string | undefined>,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        requests.push(recorded);
        const result = respond(recorded);
        response.writeHead(result.status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
    respond = () => ({ status: 200, body: {} });
  });

  function provider(): StripePaymentProvider {
    return new StripePaymentProvider({
      stripe: {
        secretKey: 'sk_test_adapter',
        webhookSecret: WEBHOOK_SECRET,
        apiVersion: '2026-08-26.dahlia',
        baseUrl,
        timeoutMs: 5_000,
      },
      payments: { enabledCurrencies: ['USD'] },
    } as unknown as ApiConfigService);
  }

  describe('creating a checkout session', () => {
    it('asks for a hosted page and passes the idempotency key', async () => {
      respond = () => ({
        status: 200,
        body: {
          id: 'cs_test_1',
          object: 'checkout.session',
          url: 'https://checkout.stripe.com/c/pay/cs_test_1',
          expires_at: 1_800_000_000,
        },
      });

      const session = await provider().createTopUpSession({
        topUpId: 'topup-1',
        ownerUserId: 'user-1',
        currency: 'USD',
        amountMinor: 2000n,
        successUrl: 'https://palcert.test/return',
        cancelUrl: 'https://palcert.test/cancel',
        expiresAt: new Date('2027-01-15T00:00:00.000Z'),
        idempotencyKey: 'topup:topup-1:create:v1',
      });

      expect(session.providerSessionId).toBe('cs_test_1');
      expect(session.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_1');

      const [request] = requests;
      // §44, §45: the key travels with the request.
      expect(request?.headers['idempotency-key']).toBe('topup:topup-1:create:v1');
      // §39: hosted checkout, which is what keeps card data away from PalCert.
      expect(request?.body).toContain('mode=payment');
      // §4, §5: the amount goes as minor units, with no conversion at all.
      // The amount goes through untouched: no `* 100`, no rounding, no float.
      expect(request?.body).toContain('[price_data][unit_amount]=2000');
      expect(request?.body).toContain('[price_data][currency]=usd');
      // §46: opaque ids only.
      expect(request?.body).toContain('client_reference_id=topup-1');
      expect(request?.body).toContain('palcertUserId');
    });

    it('pins the API version rather than inheriting the account default', async () => {
      // §140: an account-level upgrade in a dashboard must not silently change
      // what these requests mean.
      respond = () => ({
        status: 200,
        body: { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', expires_at: 1 },
      });

      await provider().createTopUpSession(baseRequest());

      expect(requests[0]?.headers['stripe-version']).toBe('2026-08-26.dahlia');
      expect(provider().getCapabilities().apiVersion).toBe('2026-08-26.dahlia');
    });

    it('reports a session with no hosted page as an invalid request', async () => {
      respond = () => ({ status: 200, body: { id: 'cs_1', url: null, expires_at: 1 } });

      await expect(provider().createTopUpSession(baseRequest())).rejects.toMatchObject({
        kind: PaymentFailureKind.INVALID_REQUEST,
      });
    });

    it('translates a rate limit into a retryable failure', async () => {
      respond = () => ({
        status: 429,
        body: { error: { type: 'rate_limit_error', message: 'Too many requests' } },
      });

      const error = await provider()
        .createTopUpSession(baseRequest())
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PaymentProviderError);
      expect((error as PaymentProviderError).kind).toBe(PaymentFailureKind.RATE_LIMITED);
      expect((error as PaymentProviderError).retryable).toBe(true);
    });

    it('translates a server error into a retryable failure', async () => {
      respond = () => ({
        status: 500,
        body: { error: { type: 'api_error', message: 'Something went wrong' } },
      });

      const error = await provider()
        .createTopUpSession(baseRequest())
        .catch((caught: unknown) => caught);

      expect((error as PaymentProviderError).kind).toBe(PaymentFailureKind.RETRYABLE);
      expect((error as PaymentProviderError).retryable).toBe(true);
    });

    it('translates a rejected credential into an authentication failure', async () => {
      respond = () => ({
        status: 401,
        body: { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } },
      });

      const error = await provider()
        .createTopUpSession(baseRequest())
        .catch((caught: unknown) => caught);

      expect((error as PaymentProviderError).retryable).toBe(false);
    });

    it('never lets a provider message reach PalCert’s error', async () => {
      // §82: an error is shown to operators and must not become a channel for
      // whatever the provider echoed back.
      respond = () => ({
        status: 400,
        body: {
          error: {
            type: 'invalid_request_error',
            message: 'card 4242424242424242 for alice@example.com was declined',
          },
        },
      });

      const error = (await provider()
        .createTopUpSession(baseRequest())
        .catch((caught: unknown) => caught)) as PaymentProviderError;

      expect(error.message).not.toContain('4242424242424242');
      expect(error.message).not.toContain('alice@example.com');
    });
  });

  describe('retrieving a payment', () => {
    it('reports paid only when the provider says paid', async () => {
      respond = () => ({
        status: 200,
        body: {
          id: 'cs_1',
          object: 'checkout.session',
          status: 'complete',
          // Complete but not paid: an asynchronous method may still settle.
          payment_status: 'unpaid',
          currency: 'usd',
          amount_total: 2000,
          client_reference_id: 'topup-1',
          payment_intent: 'pi_1',
        },
      });

      const state = await provider().retrievePayment({
        providerSessionId: 'cs_1',
        providerPaymentId: null,
      });

      expect(state.paid).toBe(false);
      expect(state.amountMinor).toBe(2000n);
      expect(state.currency).toBe('USD');
      expect(state.clientReference).toBe('topup-1');
      expect(state.providerPaymentId).toBe('pi_1');
    });

    it('reports a genuinely paid session as paid', async () => {
      respond = () => ({
        status: 200,
        body: {
          id: 'cs_1',
          object: 'checkout.session',
          status: 'complete',
          payment_status: 'paid',
          currency: 'usd',
          amount_total: 2000,
          client_reference_id: 'topup-1',
          payment_intent: 'pi_1',
        },
      });

      const state = await provider().retrievePayment({
        providerSessionId: 'cs_1',
        providerPaymentId: null,
      });
      expect(state.paid).toBe(true);
    });

    it('reports the provider’s own amount and currency, for PalCert to check', async () => {
      // §165: the adapter's job is to say what the provider says, in minor
      // units and an uppercase code. Deciding whether that matches what
      // PalCert asked for is the caller's, and it cannot decide without this.
      respond = () => ({
        status: 200,
        body: {
          id: 'cs_1',
          object: 'checkout.session',
          status: 'complete',
          payment_status: 'paid',
          currency: 'eur',
          amount_total: 2499,
          client_reference_id: 'topup-1',
          payment_intent: 'pi_1',
        },
      });

      const state = await provider().retrievePayment({
        providerSessionId: 'cs_1',
        providerPaymentId: null,
      });
      expect(state).toMatchObject({
        paid: true,
        amountMinor: 2499n,
        currency: 'EUR',
        clientReference: 'topup-1',
        providerPaymentId: 'pi_1',
      });
    });

    it('translates a missing object into NOT_FOUND', async () => {
      respond = () => ({
        status: 404,
        body: {
          error: {
            type: 'invalid_request_error',
            code: 'resource_missing',
            message: 'No such session',
          },
        },
      });

      const error = await provider()
        .retrievePayment({ providerSessionId: 'cs_missing', providerPaymentId: null })
        .catch((caught: unknown) => caught);

      expect((error as PaymentProviderError).kind).toBe(PaymentFailureKind.NOT_FOUND);
    });
  });

  describe('refunding', () => {
    it('sends the amount and its own idempotency key', async () => {
      respond = () => ({
        status: 200,
        body: {
          id: 're_1',
          object: 'refund',
          status: 'succeeded',
          amount: 500,
          currency: 'usd',
        },
      });

      const state = await provider().refundPayment({
        refundId: 'refund-1',
        providerPaymentId: 'pi_1',
        currency: 'USD',
        amountMinor: 500n,
        reason: PaymentRefundReason.REQUESTED_BY_CUSTOMER,
        idempotencyKey: 'refund:refund-1:create:v1',
      });

      expect(state.succeeded).toBe(true);
      expect(state.amountMinor).toBe(500n);
      const [request] = requests;
      // §45: a refund's key is its own, never a top-up's.
      expect(request?.headers['idempotency-key']).toBe('refund:refund-1:create:v1');
      expect(request?.body).toContain('amount=500');
      expect(request?.body).toContain('payment_intent=pi_1');
      expect(request?.body).toContain('reason=requested_by_customer');
    });

    it('reports a failed refund as failed rather than throwing', async () => {
      respond = () => ({
        status: 200,
        body: {
          id: 're_1',
          object: 'refund',
          status: 'failed',
          amount: 500,
          currency: 'usd',
          failure_reason: 'expired_or_canceled_card',
        },
      });

      const state = await provider().refundPayment(baseRefund());

      expect(state.failed).toBe(true);
      expect(state.succeeded).toBe(false);
      expect(state.failureCode).toBe('expired_or_canceled_card');
    });

    it('translates an already-refunded charge into its own failure kind', async () => {
      respond = () => ({
        status: 400,
        body: {
          error: {
            type: 'invalid_request_error',
            code: 'charge_already_refunded',
            message: 'Charge has already been refunded.',
          },
        },
      });

      const error = await provider()
        .refundPayment(baseRefund())
        .catch((caught: unknown) => caught);

      expect((error as PaymentProviderError).kind).toBe(PaymentFailureKind.ALREADY_REFUNDED);
    });

    it('maps PalCert reasons Stripe does not have onto no reason at all', async () => {
      // PalCert's vocabulary is richer than Stripe's three values. Inventing a
      // mapping would file a goodwill refund as fraud.
      respond = () => ({
        status: 200,
        body: { id: 're_1', object: 'refund', status: 'succeeded', amount: 500, currency: 'usd' },
      });

      await provider().refundPayment({ ...baseRefund(), reason: PaymentRefundReason.GOODWILL });

      expect(requests[0]?.body).not.toContain('reason=');
    });
  });

  describe('webhook signatures', () => {
    function signed(
      payload: string,
      secret = WEBHOOK_SECRET,
      timestamp = Math.floor(Date.now() / 1000),
    ): string {
      const signature = createHmac('sha256', secret)
        .update(`${timestamp}.${payload}`)
        .digest('hex');
      return `t=${timestamp},v1=${signature}`;
    }

    const event = (type: string, object: Record<string, unknown>): string =>
      JSON.stringify({
        id: 'evt_1',
        object: 'event',
        type,
        created: 1_700_000_000,
        data: { object },
      });

    it('accepts a correctly signed event and translates it', async () => {
      const payload = event('checkout.session.completed', {
        id: 'cs_1',
        payment_status: 'paid',
        currency: 'usd',
        amount_total: 2000,
        client_reference_id: 'topup-1',
      });

      const verified = provider().verifyAndParseWebhook({
        rawBody: Buffer.from(payload, 'utf8'),
        signatureHeader: signed(payload),
      });

      expect(verified.kind).toBe('PAYMENT_SUCCEEDED');
      expect(verified.providerObjectId).toBe('cs_1');
      expect(verified.clientReference).toBe('topup-1');
      expect(verified.amountMinor).toBe(2000n);
      expect(verified.currency).toBe('USD');
    });

    it('gives a redelivered event the same identity, so it can be deduplicated', () => {
      // §165: the adapter does not itself deduplicate — that is the ingestion
      // layer's unique index. What it must do is be *deterministic*, so that
      // two deliveries of the same bytes are recognisably the same event
      // rather than two events PalCert would act on twice.
      const payload = event('checkout.session.completed', {
        id: 'cs_1',
        payment_status: 'paid',
        currency: 'usd',
        amount_total: 2000,
        client_reference_id: 'topup-1',
      });
      const header = signed(payload);

      const first = provider().verifyAndParseWebhook({
        rawBody: Buffer.from(payload, 'utf8'),
        signatureHeader: header,
      });
      const second = provider().verifyAndParseWebhook({
        rawBody: Buffer.from(payload, 'utf8'),
        signatureHeader: header,
      });

      expect(second.providerEventId).toBe(first.providerEventId);
      expect(second).toEqual(first);
    });

    it('refuses an event signed with the wrong secret', async () => {
      const payload = event('checkout.session.completed', { id: 'cs_1', payment_status: 'paid' });

      expect(() =>
        provider().verifyAndParseWebhook({
          rawBody: Buffer.from(payload, 'utf8'),
          signatureHeader: signed(payload, 'whsec_a_different_secret_entirely'),
        }),
      ).toThrow(PaymentProviderError);
    });

    it('refuses an event whose body was altered after signing', async () => {
      // The precise failure §48 exists to prevent: middleware that reparses and
      // re-serializes the body changes the bytes, and the HMAC no longer matches.
      const payload = event('checkout.session.completed', { id: 'cs_1', payment_status: 'paid' });
      const signature = signed(payload);
      // What a JSON body-parser plus re-serializer actually does to the bytes:
      // same object, different characters. The HMAC covers the characters.
      const reserialized = JSON.stringify(JSON.parse(payload), null, 2);

      expect(reserialized).not.toBe(payload);
      expect(JSON.parse(reserialized)).toEqual(JSON.parse(payload));
      expect(() =>
        provider().verifyAndParseWebhook({
          rawBody: Buffer.from(reserialized, 'utf8'),
          signatureHeader: signature,
        }),
      ).toThrow(/did not verify/);
    });

    it('refuses an event with no signature header', async () => {
      const payload = event('checkout.session.completed', { id: 'cs_1' });

      expect(() =>
        provider().verifyAndParseWebhook({
          rawBody: Buffer.from(payload, 'utf8'),
          signatureHeader: undefined,
        }),
      ).toThrow(/no provider signature/);
    });

    it('never echoes provider text in a signature failure', async () => {
      // §82, §136: the message is attacker-visible.
      const payload = event('checkout.session.completed', { id: 'cs_1' });
      const error = (() => {
        try {
          provider().verifyAndParseWebhook({
            rawBody: Buffer.from(payload, 'utf8'),
            signatureHeader: 't=1,v1=deadbeef',
          });
          return null;
        } catch (caught) {
          return caught as Error;
        }
      })();

      expect(error?.message).toBe('the webhook signature did not verify');
      expect(error?.message).not.toContain(WEBHOOK_SECRET);
    });

    it('treats a completed-but-unpaid session as nothing to act on', async () => {
      const payload = event('checkout.session.completed', {
        id: 'cs_1',
        payment_status: 'unpaid',
      });

      const verified = provider().verifyAndParseWebhook({
        rawBody: Buffer.from(payload, 'utf8'),
        signatureHeader: signed(payload),
      });

      expect(verified.kind).toBe('UNSUPPORTED');
    });

    it('translates a dispute, carrying the payment it claws back', async () => {
      // §84: PalCert files the chargeback against the top-up, so the adapter
      // resolves dispute → payment rather than leaving core finance to guess.
      const payload = event('charge.dispute.created', {
        id: 'dp_1',
        amount: 2000,
        currency: 'usd',
        status: 'needs_response',
        payment_intent: 'pi_1',
      });

      const verified = provider().verifyAndParseWebhook({
        rawBody: Buffer.from(payload, 'utf8'),
        signatureHeader: signed(payload),
      });

      expect(verified.kind).toBe('PAYMENT_DISPUTED');
      expect(verified.relatedPaymentId).toBe('pi_1');
      expect(verified.amountMinor).toBe(2000n);
    });

    it('treats a lost dispute as no reversal', async () => {
      // Only a win returns the money; a loss leaves the debit in place (§84).
      const payload = event('charge.dispute.closed', {
        id: 'dp_1',
        amount: 2000,
        currency: 'usd',
        status: 'lost',
        payment_intent: 'pi_1',
      });

      const verified = provider().verifyAndParseWebhook({
        rawBody: Buffer.from(payload, 'utf8'),
        signatureHeader: signed(payload),
      });

      expect(verified.kind).toBe('UNSUPPORTED');
      expect(verified.disputeStatus).toBe('LOST');
    });

    it('acknowledges an event type PalCert has no use for', async () => {
      // §123: Stripe adds event types regularly, and PalCert must not throw.
      const payload = event('invoice.payment_succeeded', { id: 'in_1' });

      const verified = provider().verifyAndParseWebhook({
        rawBody: Buffer.from(payload, 'utf8'),
        signatureHeader: signed(payload),
      });

      expect(verified.kind).toBe('UNSUPPORTED');
      expect(verified.objectKind).toBe('UNKNOWN');
    });

    it('does not assume any ordering between events', async () => {
      // §53: a translated event is a statement about one object at one moment,
      // with no dependence on what came before.
      const succeeded = event('checkout.session.completed', {
        id: 'cs_1',
        payment_status: 'paid',
        amount_total: 2000,
        currency: 'usd',
      });
      const failed = event('payment_intent.payment_failed', {
        id: 'pi_1',
        amount: 2000,
        currency: 'usd',
      });

      const later = provider().verifyAndParseWebhook({
        rawBody: Buffer.from(failed, 'utf8'),
        signatureHeader: signed(failed),
      });
      const earlier = provider().verifyAndParseWebhook({
        rawBody: Buffer.from(succeeded, 'utf8'),
        signatureHeader: signed(succeeded),
      });

      expect(later.kind).toBe('PAYMENT_FAILED');
      expect(earlier.kind).toBe('PAYMENT_SUCCEEDED');
    });
  });

  describe('the documented subscription set (§89)', () => {
    it('names only the events PalCert actually needs', () => {
      expect([...REQUIRED_STRIPE_WEBHOOK_EVENTS].sort()).toEqual([
        'charge.dispute.closed',
        'charge.dispute.created',
        'checkout.session.async_payment_failed',
        'checkout.session.async_payment_succeeded',
        'checkout.session.completed',
        'checkout.session.expired',
        'payment_intent.canceled',
        'payment_intent.payment_failed',
        'refund.updated',
      ]);
    });
  });

  function baseRequest() {
    return {
      topUpId: 'topup-1',
      ownerUserId: 'user-1',
      currency: 'USD',
      amountMinor: 2000n,
      successUrl: 'https://palcert.test/return',
      cancelUrl: 'https://palcert.test/cancel',
      expiresAt: new Date('2027-01-15T00:00:00.000Z'),
      idempotencyKey: 'topup:topup-1:create:v1',
    };
  }

  function baseRefund() {
    return {
      refundId: 'refund-1',
      providerPaymentId: 'pi_1',
      currency: 'USD',
      amountMinor: 500n,
      reason: PaymentRefundReason.REQUESTED_BY_CUSTOMER,
      idempotencyKey: 'refund:refund-1:create:v1',
    };
  }
});
