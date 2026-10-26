import { API } from './support/auth-client';
import {
  createTopUp,
  deliverWebhook,
  drainPaymentJobs,
  ledgerOf,
  ledgerTotal,
  paymentFailed,
  paymentSucceeded,
  sessionIdFor,
} from './support/finance-client';
import { createUser } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';
import { PaymentEventService } from '../src/modules/finance/services/payment-event.service';

/**
 * Adding credit (§162 items 1–14, §124, §125).
 *
 * Everything here circles one question: **when does money appear?** The answer
 * must be "when, and only when, PalCert has verified it with the provider" —
 * not when a browser came back, not when an unsigned request arrived, and not
 * once per delivery of the same event.
 */
describe('PalCert Balance top-ups (e2e)', () => {
  let context: TestContext;
  let customer: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    customer = await createUser(context, 'student@example.com');
  });

  describe('creating one', () => {
    it('starts a new customer at zero', async () => {
      const response = await customer.client.get(`${API}/balance`);
      expect(response.status).toBe(200);
      expect(response.body.available).toEqual({ currency: 'USD', minorUnits: '0' });
      expect(await ledgerTotal(context, customer.userId)).toBe(0n);
    });

    it('creates a provider-hosted checkout session', async () => {
      const response = await createTopUp(customer.client, '2000');

      expect(response.status).toBe(201);
      expect(response.body.checkoutUrl).toMatch(/^https:\/\//);
      // PalCert asked the provider for exactly what it recorded (§43).
      const [session] = context.paymentProvider.sessions;
      expect(session?.amountMinor).toBe(2000n);
      expect(session?.currency).toBe('USD');
    });

    it('sends the provider only opaque identifiers', async () => {
      // §46: no name, no email, no document title.
      await createTopUp(customer.client, '2000');
      const [session] = context.paymentProvider.sessions;

      expect(session?.ownerUserId).toBe(customer.userId);
      const serialized = JSON.stringify(session, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      expect(serialized).not.toContain('student@example.com');
    });

    it('refuses an amount outside the server’s own bounds', async () => {
      // §43: the range is the server's, and a client cannot argue with it.
      const tooSmall = await createTopUp(customer.client, '1');
      expect(tooSmall.status).toBe(422);
      expect(tooSmall.body.error.code).toBe('TOPUP_AMOUNT_OUT_OF_RANGE');

      const tooLarge = await createTopUp(customer.client, '999999999');
      expect(tooLarge.status).toBe(422);
      expect(await context.adminDb.balanceTopUp.count()).toBe(0);
    });

    it('refuses a currency this deployment does not transact in', async () => {
      const response = await createTopUp(customer.client, '2000', 'JOD');
      // JOD is a known currency but not enabled here, so it is refused rather
      // than silently converted (§6).
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('CURRENCY_NOT_SUPPORTED');
    });

    it('returns the same top-up for a retried request', async () => {
      // §44: a network retry must not open a second checkout the customer
      // could also pay.
      const first = await createTopUp(customer.client, '2000', 'USD', 'retry-me');
      const second = await createTopUp(customer.client, '2000', 'USD', 'retry-me');

      expect(first.body.topUp.id).toBe(second.body.topUp.id);
      expect(await context.adminDb.balanceTopUp.count()).toBe(1);
      // And the provider saw one session, not two.
      expect(context.paymentProvider.sessions).toHaveLength(1);
    });

    it('gives each provider operation its own idempotency key', async () => {
      // §45: a key is scoped to one operation on one object.
      await createTopUp(customer.client, '2000');
      const topUp = await context.adminDb.balanceTopUp.findFirstOrThrow();
      expect(context.paymentProvider.idempotencyKeys).toEqual([`topup:${topUp.id}:create:v1`]);
    });
  });

  describe('crediting it', () => {
    async function pendingTopUp(amount = '2000'): Promise<string> {
      const created = await createTopUp(customer.client, amount);
      return created.body.topUp.id as string;
    }

    it('does not credit because the browser came back', async () => {
      // §40, §58. The single most important test in the phase.
      const topUpId = await pendingTopUp();

      const status = await customer.client.get(`${API}/balance/top-ups/${topUpId}`);
      expect(status.body.status).toBe('PENDING');
      expect((await customer.client.get(`${API}/balance`)).body.available.minorUnits).toBe('0');
      expect(await ledgerTotal(context, customer.userId)).toBe(0n);
    });

    it('credits once on a verified provider success', async () => {
      const topUpId = await pendingTopUp();
      context.paymentProvider.paymentState = 'paid';

      const response = await deliverWebhook(
        context,
        paymentSucceeded({
          eventId: 'evt_1',
          sessionId: sessionIdFor(topUpId),
          topUpId,
          amountMinorUnits: '2000',
        }),
      );
      expect(response.status).toBe(200);
      await drainPaymentJobs(context);

      expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
      const entries = await ledgerOf(context, customer.userId);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.entryType).toBe('TOP_UP_CREDIT');
      expect(entries[0]?.creditClass).toBe('CASH');
    });

    it('credits once however many times the same event is delivered', async () => {
      // §124: ten deliveries, one financial effect.
      const topUpId = await pendingTopUp();
      context.paymentProvider.paymentState = 'paid';
      const event = paymentSucceeded({
        eventId: 'evt_repeat',
        sessionId: sessionIdFor(topUpId),
        topUpId,
        amountMinorUnits: '2000',
      });

      for (let delivery = 0; delivery < 10; delivery += 1) {
        const response = await deliverWebhook(context, event);
        // Every delivery is acknowledged, so the provider stops retrying.
        expect(response.status).toBe(200);
        await drainPaymentJobs(context);
      }

      expect(await context.adminDb.paymentProviderEvent.count()).toBe(1);
      expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
      expect(await context.adminDb.creditLedgerEntry.count()).toBe(1);
    });

    it('credits once when two identical deliveries arrive at the same time', async () => {
      // §163: webhook vs webhook. A provider retrying while its first attempt
      // is still in flight is the ordinary case, not the exotic one, and two
      // concurrent inserts of the same event id must not become two credits.
      const topUpId = await pendingTopUp();
      context.paymentProvider.paymentState = 'paid';
      const event = paymentSucceeded({
        eventId: 'evt_concurrent',
        sessionId: sessionIdFor(topUpId),
        topUpId,
        amountMinorUnits: '2000',
      });

      const responses = await Promise.all([
        deliverWebhook(context, event),
        deliverWebhook(context, event),
      ]);
      // Both are acknowledged: the loser of the race is a duplicate, which is
      // a no-op, not a failure the provider should retry.
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      await drainPaymentJobs(context);

      expect(await context.adminDb.paymentProviderEvent.count()).toBe(1);
      expect(await context.adminDb.creditLedgerEntry.count()).toBe(1);
      expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
    });

    it('has no financial effect at all without a valid signature', async () => {
      // §49: a 400, and nothing written anywhere.
      const topUpId = await pendingTopUp();
      context.paymentProvider.paymentState = 'paid';
      context.paymentProvider.signatureValid = false;

      const response = await deliverWebhook(
        context,
        paymentSucceeded({
          eventId: 'evt_forged',
          sessionId: sessionIdFor(topUpId),
          topUpId,
          amountMinorUnits: '2000',
        }),
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
      expect(await context.adminDb.paymentProviderEvent.count()).toBe(0);
      expect(await ledgerTotal(context, customer.userId)).toBe(0n);
    });

    it('refuses a webhook with no signature header at all', async () => {
      const topUpId = await pendingTopUp();
      const response = await deliverWebhook(
        context,
        paymentSucceeded({
          eventId: 'evt_unsigned',
          sessionId: sessionIdFor(topUpId),
          topUpId,
          amountMinorUnits: '2000',
        }),
        { signature: null },
      );

      expect(response.status).toBe(400);
      expect(await ledgerTotal(context, customer.userId)).toBe(0n);
    });

    it('does not credit when the provider reports a different amount', async () => {
      // §56: PalCert expected $20 and the provider says $9. Neither number is
      // safe to act on, so it stops.
      const topUpId = await pendingTopUp();
      context.paymentProvider.paymentState = 'paid';
      context.paymentProvider.reportedAmountMinor = 900n;

      await deliverWebhook(
        context,
        paymentSucceeded({
          eventId: 'evt_mismatch',
          sessionId: sessionIdFor(topUpId),
          topUpId,
          amountMinorUnits: '900',
        }),
      );
      await drainPaymentJobs(context);

      const topUp = await context.adminDb.balanceTopUp.findUniqueOrThrow({
        where: { id: topUpId },
      });
      expect(topUp.status).toBe('RECONCILIATION_REQUIRED');
      expect(topUp.failureCode).toBe('PAYMENT_AMOUNT_MISMATCH');
      expect(await ledgerTotal(context, customer.userId)).toBe(0n);
    });

    it('does not credit when the provider reports a different currency', async () => {
      // §57: expected USD, provider says EUR. Crediting USD would be inventing
      // an exchange rate PalCert has no business inventing (§6).
      const topUpId = await pendingTopUp();
      context.paymentProvider.paymentState = 'paid';
      context.paymentProvider.reportedCurrency = 'EUR';

      await deliverWebhook(
        context,
        paymentSucceeded({
          eventId: 'evt_currency',
          sessionId: sessionIdFor(topUpId),
          topUpId,
          amountMinorUnits: '2000',
          currency: 'EUR',
        }),
      );
      await drainPaymentJobs(context);

      const topUp = await context.adminDb.balanceTopUp.findUniqueOrThrow({
        where: { id: topUpId },
      });
      expect(topUp.status).toBe('RECONCILIATION_REQUIRED');
      expect(topUp.failureCode).toBe('PAYMENT_CURRENCY_MISMATCH');
      expect(await ledgerTotal(context, customer.userId)).toBe(0n);
    });

    it('writes no compensating entry when a payment simply fails', async () => {
      // §59: nothing was credited, so there is nothing to reverse.
      const topUpId = await pendingTopUp();
      context.paymentProvider.paymentState = 'cancelled';

      await deliverWebhook(
        context,
        paymentFailed({ eventId: 'evt_failed', sessionId: sessionIdFor(topUpId), topUpId }),
      );
      await drainPaymentJobs(context);

      expect(await ledgerTotal(context, customer.userId)).toBe(0n);
      expect(await context.adminDb.creditLedgerEntry.count()).toBe(0);
    });

    it('acknowledges an event it has no use for, and changes nothing', async () => {
      // §123: a provider adding an event type must not break the endpoint.
      const response = await deliverWebhook(context, {
        id: 'evt_unknown',
        type: 'invoice.some_new_thing',
        kind: 'UNSUPPORTED' as never,
      });

      expect(response.status).toBe(200);
      const [event] = await context.adminDb.paymentProviderEvent.findMany();
      expect(event?.processingStatus).toBe('IGNORED');
      expect(await ledgerTotal(context, customer.userId)).toBe(0n);
    });
  });

  describe('reconciliation', () => {
    it('credits a payment whose webhook never arrived', async () => {
      // §60: the missed webhook. Without this the balance simply never goes up
      // and nobody finds out.
      const created = await createTopUp(customer.client, '2000');
      const topUpId = created.body.topUp.id as string;
      context.paymentProvider.paymentState = 'paid';

      // Older than the reconciliation threshold.
      context.clock.advanceMinutes(10);
      const outcome = await context.app.get(PaymentEventService).reconcileOpenTopUps();

      expect(outcome.credited).toBe(1);
      expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
      expect(
        (await context.adminDb.balanceTopUp.findUniqueOrThrow({ where: { id: topUpId } })).status,
      ).toBe('SUCCEEDED');
    });

    it('credits once when a webhook and reconciliation race', async () => {
      // §61, §127: both paths converge on one credit.
      const created = await createTopUp(customer.client, '2000');
      const topUpId = created.body.topUp.id as string;
      context.paymentProvider.paymentState = 'paid';
      context.clock.advanceMinutes(10);

      await deliverWebhook(
        context,
        paymentSucceeded({
          eventId: 'evt_race',
          sessionId: sessionIdFor(topUpId),
          topUpId,
          amountMinorUnits: '2000',
        }),
      );

      // Deliberately concurrent.
      await Promise.all([
        drainPaymentJobs(context),
        context.app.get(PaymentEventService).reconcileOpenTopUps(),
      ]);

      expect(await context.adminDb.creditLedgerEntry.count()).toBe(1);
      expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
    });

    it('leaves a payment nobody paid alone', async () => {
      await createTopUp(customer.client, '2000');
      context.paymentProvider.paymentState = 'unpaid';
      context.clock.advanceMinutes(10);

      const outcome = await context.app.get(PaymentEventService).reconcileOpenTopUps();

      expect(outcome.credited).toBe(0);
      expect(await ledgerTotal(context, customer.userId)).toBe(0n);
    });
  });

  describe('event ordering', () => {
    it('does not let a late failure take credit away', async () => {
      // §125: "later" is not "newer". Once money exists, a stale event about
      // the same payment must not remove it.
      const created = await createTopUp(customer.client, '2000');
      const topUpId = created.body.topUp.id as string;
      context.paymentProvider.paymentState = 'paid';

      await deliverWebhook(
        context,
        paymentSucceeded({
          eventId: 'evt_ok',
          sessionId: sessionIdFor(topUpId),
          topUpId,
          amountMinorUnits: '2000',
        }),
      );
      await drainPaymentJobs(context);
      expect(await ledgerTotal(context, customer.userId)).toBe(2000n);

      // The old failure turns up afterwards.
      await deliverWebhook(
        context,
        paymentFailed({ eventId: 'evt_stale', sessionId: sessionIdFor(topUpId), topUpId }),
      );
      await drainPaymentJobs(context);

      const topUp = await context.adminDb.balanceTopUp.findUniqueOrThrow({
        where: { id: topUpId },
      });
      expect(topUp.status).toBe('SUCCEEDED');
      expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
    });
  });
});
