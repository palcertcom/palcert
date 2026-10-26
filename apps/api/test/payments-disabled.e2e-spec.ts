import { PaymentProviderPort, PalCertErrorCode } from '@palcert/contracts';
import { API, signIn } from './support/auth-client';
import { DisabledPaymentProvider } from '../src/infrastructure/payments/disabled-payment-provider';
import { createTopUp, fundBalance, ledgerOf, ledgerTotal } from './support/finance-client';
import { createUser, PASSWORD } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * An installation with payments switched off (Phase 20 Checkpoint 7).
 *
 * `PAYMENTS_ENABLED=false` is a supported deployment — §111 says balances stay
 * visible and existing credit stays spendable, and only topping up goes away.
 * The provider factory did not implement that. It constructed whatever
 * `PAYMENT_PROVIDER` named regardless of the flag, and since that defaults to
 * `stripe`, an installation that had never configured payments got the Stripe
 * adapter built during module initialization, which threw for want of a secret
 * key. The API did not start.
 *
 * So this suite is mostly one question asked several ways: **does the
 * application still work, and does the money still add up, when payments are
 * off and no provider credential exists anywhere?**
 *
 * It runs in two phases against one database. The first boots with payments
 * enabled and creates real history — a top-up paid through the provider double
 * and settled through the real webhook path. The second reboots the whole
 * application with payments disabled and no credentials, and asks what
 * happened to that history. Creating the fixture some other way would prove
 * less: the point is that records made while payments worked survive payments
 * being turned off.
 */

const CUSTOMER = 'payments-disabled-customer@example.com';

describe('An installation with payments disabled (e2e)', () => {
  let ownerUserId: string;
  let ledgerBefore: Awaited<ReturnType<typeof ledgerOf>>;
  let totalBefore: bigint;

  // --- phase 1: history, made while payments worked ------------------------
  describe('history created while payments were enabled', () => {
    let context: TestContext;

    beforeAll(async () => {
      context = await createTestContext();
      await resetState(context);
    });

    afterAll(async () => {
      await destroyTestContext(context);
    });

    it('funds a balance through the real payment path', async () => {
      const customer = await createUser(context, CUSTOMER);
      ownerUserId = customer.userId;

      await fundBalance(context, customer.client, '5000');

      const balance = await customer.client.get(`${API}/balance`);
      expect(balance.status).toBe(200);
      expect(balance.body.available).toEqual({ currency: 'USD', minorUnits: '5000' });

      ledgerBefore = await ledgerOf(context, ownerUserId);
      totalBefore = await ledgerTotal(context, ownerUserId);
      expect(ledgerBefore.length).toBeGreaterThan(0);
      expect(totalBefore).toBe(5000n);
    });
  });

  // --- phase 2: the same database, payments off ----------------------------
  describe('after payments are disabled', () => {
    let context: TestContext;

    beforeAll(async () => {
      // No `resetState` here, deliberately: the whole point is that phase
      // one's records are still there. And no Stripe credential is supplied —
      // the hermetic test environment sets none — so this is exactly the
      // deployment shape that used to refuse to boot.
      context = await createTestContext({
        PAYMENTS_ENABLED: 'false',
        PAYMENT_PROVIDER: 'stripe',
      });
    });

    afterAll(async () => {
      await destroyTestContext(context);
    });

    it('starts at all', () => {
      // If the module wiring were still wrong this suite would not reach its
      // first assertion — `beforeAll` would have thrown during boot. Asserting
      // it explicitly anyway, so the failure names the thing that failed.
      expect(context.app).toBeDefined();
    });

    it('resolves the disabled provider rather than constructing an adapter', () => {
      const provider = context.app.get(PaymentProviderPort);
      expect(provider).toBeInstanceOf(DisabledPaymentProvider);
    });

    it('keeps readiness green — a disabled feature is not an outage', async () => {
      const ready = await context.app.get(PaymentProviderPort).checkAvailability();
      expect(ready.ok).toBe(true);
    });

    it('still shows the balance the customer already had', async () => {
      const client = await signIn(context, CUSTOMER, PASSWORD);
      const balance = await client.get(`${API}/balance`);
      expect(balance.status).toBe(200);
      expect(balance.body.available).toEqual({ currency: 'USD', minorUnits: '5000' });
    });

    it('refuses a top-up with a deliberate contract, not a crash', async () => {
      const client = await signIn(context, CUSTOMER, PASSWORD);
      const response = await createTopUp(client, '2000');

      // 503 and a named code: a client can tell "this installation does not do
      // this" from "something broke", and so can an operator reading a log.
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe(PalCertErrorCode.PAYMENTS_DISABLED);
    });

    it('has not erased, mutated or reordered a single ledger entry', async () => {
      const after = await ledgerOf(context, ownerUserId);
      expect(after).toHaveLength(ledgerBefore.length);
      expect(after.map((entry) => entry.id)).toEqual(ledgerBefore.map((entry) => entry.id));
      expect(after.map((entry) => entry.amountMinorSigned)).toEqual(
        ledgerBefore.map((entry) => entry.amountMinorSigned),
      );
      expect(after.map((entry) => entry.entryType)).toEqual(
        ledgerBefore.map((entry) => entry.entryType),
      );
      expect(await ledgerTotal(context, ownerUserId)).toBe(totalBefore);
    });

    it('leaves the historical top-up readable', async () => {
      const topUps = await context.adminDb.balanceTopUp.findMany({ where: { ownerUserId } });
      expect(topUps.length).toBeGreaterThan(0);
      // Still settled. Turning payments off is a statement about what may
      // happen next, never a retroactive one about what already did.
      expect(topUps.some((topUp) => topUp.status === 'SUCCEEDED')).toBe(true);
    });

    it('refuses a payment webhook instead of parsing one it cannot verify', async () => {
      const provider = context.app.get(PaymentProviderPort);
      expect(() =>
        provider.verifyAndParseWebhook({
          rawBody: Buffer.from('{"type":"payment_intent.succeeded"}'),
          signatureHeader: 't=1,v1=whatever',
        }),
      ).toThrow(/Payments are not enabled/);
    });
  });
});
