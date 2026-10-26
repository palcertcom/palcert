import { API } from './support/auth-client';
import { BalanceService } from '../src/modules/finance/services/balance.service';
import { CreditHoldService } from '../src/modules/finance/services/credit-hold.service';
import { TenantPrismaService } from '../src/infrastructure/tenant/tenant-prisma.service';
import { CreditClass, CreditHoldPurpose } from '@palcert/contracts';
import {
  createTopUp,
  deliverWebhook,
  drainPaymentJobs,
  fundBalance,
  ledgerOf,
  ledgerTotal,
  paymentSucceeded,
  sessionIdFor,
} from './support/finance-client';
import { createUser, signInGlobalRole } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * The golden financial journey (§161, §162).
 *
 * One customer, from an empty balance to a captured and refunded service fee,
 * through the real endpoints and the real worker. Every amount is asserted
 * exactly, in minor units, because "approximately twenty dollars" is not a
 * thing a financial system may be.
 *
 * The single most important assertion is the one in the middle: after the
 * browser comes back from checkout, **the balance is still zero**. Credit
 * appears only once PalCert has verified the payment with the provider (§40).
 */
describe('The PalCert Balance journey (e2e)', () => {
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

  it('runs the whole journey, exactly', async () => {
    // --- a new customer has nothing ---------------------------------------
    const empty = await customer.client.get(`${API}/balance`);
    expect(empty.status).toBe(200);
    expect(empty.body.available).toEqual({ currency: 'USD', minorUnits: '0' });
    expect(empty.body.reserved).toEqual({ currency: 'USD', minorUnits: '0' });
    expect(empty.body.cash).toEqual({ currency: 'USD', minorUnits: '0' });
    expect(empty.body.promotional).toEqual({ currency: 'USD', minorUnits: '0' });

    // --- they ask to add $20 ----------------------------------------------
    const created = await createTopUp(customer.client, '2000');
    expect(created.status).toBe(201);
    expect(created.body.topUp.status).toBe('PENDING');
    expect(created.body.topUp.amount).toEqual({ currency: 'USD', minorUnits: '2000' });
    // A provider-hosted page: PalCert never sees a card (§38, §39).
    expect(created.body.checkoutUrl).toMatch(/^https:\/\//);
    const topUpId = created.body.topUp.id as string;

    // --- the browser comes back. This must change nothing ------------------
    const afterRedirect = await customer.client.get(`${API}/balance/top-ups/${topUpId}`);
    expect(afterRedirect.body.status).toBe('PENDING');
    const stillEmpty = await customer.client.get(`${API}/balance`);
    expect(stillEmpty.body.available).toEqual({ currency: 'USD', minorUnits: '0' });
    expect(await ledgerTotal(context, customer.userId)).toBe(0n);

    // --- the provider confirms, and only now is credit created -------------
    context.paymentProvider.paymentState = 'paid';
    const delivered = await deliverWebhook(
      context,
      paymentSucceeded({
        eventId: 'evt_journey_1',
        sessionId: sessionIdFor(topUpId),
        topUpId,
        amountMinorUnits: '2000',
      }),
    );
    expect(delivered.status).toBe(200);
    await drainPaymentJobs(context);

    const funded = await customer.client.get(`${API}/balance`);
    expect(funded.body.available).toEqual({ currency: 'USD', minorUnits: '2000' });
    expect(funded.body.cash).toEqual({ currency: 'USD', minorUnits: '2000' });
    expect((await customer.client.get(`${API}/balance/top-ups/${topUpId}`)).body.status).toBe(
      'SUCCEEDED',
    );

    // --- a $3 service reserves credit without spending it ------------------
    const hold = await createServiceHold(context, customer.userId, 300n);
    const reserved = await customer.client.get(`${API}/balance`);
    expect(reserved.body.available).toEqual({ currency: 'USD', minorUnits: '1700' });
    expect(reserved.body.reserved).toEqual({ currency: 'USD', minorUnits: '300' });
    // Reserved is not spent: the ledger has not moved.
    expect(await ledgerTotal(context, customer.userId)).toBe(2000n);

    // --- capturing it spends the money -------------------------------------
    const captured = await captureHold(context, customer.userId, hold);
    const spent = await customer.client.get(`${API}/balance`);
    expect(spent.body.available).toEqual({ currency: 'USD', minorUnits: '1700' });
    expect(spent.body.reserved).toEqual({ currency: 'USD', minorUnits: '0' });
    expect(await ledgerTotal(context, customer.userId)).toBe(1700n);

    // --- refunding the service fee returns it ------------------------------
    await context.app
      .get(BalanceService)
      .refundServiceCharge({ ownerUserId: customer.userId, ledgerEntryId: captured.entryId });

    const refunded = await customer.client.get(`${API}/balance`);
    expect(refunded.body.available).toEqual({ currency: 'USD', minorUnits: '2000' });
    expect(await ledgerTotal(context, customer.userId)).toBe(2000n);

    // --- and the history reads as a person would expect --------------------
    const entries = await ledgerOf(context, customer.userId);
    expect(entries.map((entry) => entry.entryType)).toEqual([
      'TOP_UP_CREDIT',
      'SERVICE_CHARGE',
      'SERVICE_REFUND',
    ]);
    expect(entries.map((entry) => entry.amountMinorSigned)).toEqual([2000n, -300n, 300n]);
    // The refund points at the charge it corrects; the charge is untouched (§13).
    expect(entries[2]!.reversalOfEntryId).toBe(entries[1]!.id);
    expect(entries[1]!.amountMinorSigned).toBe(-300n);
  });

  it('rebuilds the balance from the ledger alone', async () => {
    // §128: the proof that the ledger really is the authority. If replaying
    // every entry from zero did not equal the API's answer, the API would be
    // reading something else.
    await fundBalance(context, customer.client, '2000');
    const hold = await createServiceHold(context, customer.userId, 725n);
    await captureHold(context, customer.userId, hold);

    const api = await customer.client.get(`${API}/balance`);
    const replayed = await ledgerTotal(context, customer.userId);

    expect(replayed).toBe(1275n);
    expect(api.body.cash.minorUnits).toBe(replayed.toString());
  });

  it('shows a transaction history without exposing internal accounting ids', async () => {
    // §63, §64.
    await fundBalance(context, customer.client, '2000');

    const history = await customer.client.get(`${API}/balance/transactions`);
    expect(history.status).toBe(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0].entryType).toBe('TOP_UP_CREDIT');
    expect(history.body.items[0].amount).toEqual({ currency: 'USD', minorUnits: '2000' });

    const serialized = JSON.stringify(history.body);
    const accounts = await context.adminDb.customerCreditAccount.findMany();
    for (const account of accounts) {
      expect(serialized).not.toContain(account.id);
    }
    expect(serialized).not.toMatch(/accountId|providerSessionId|providerPaymentId/);
  });

  it('pages the history with the limit the web client sends (?limit=25)', async () => {
    // Regression: the query string's "25" was refused as "not an integer".
    await fundBalance(context, customer.client, '2000');

    const page = await customer.client.get(`${API}/balance/transactions?limit=25`);
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).toBeNull();

    await fundBalance(context, customer.client, '500');
    const first = await customer.client.get(`${API}/balance/transactions?limit=1`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await customer.client.get(
      `${API}/balance/transactions?limit=1&cursor=${first.body.nextCursor as string}`,
    );
    expect(second.status).toBe(200);
    // Newest first: the 5.00 top-up, then the 20.00 one. Entries carry no id.
    expect(first.body.items[0].amount.minorUnits).toBe('500');
    expect(second.body.items[0].amount.minorUnits).toBe('2000');

    // The bounds still hold.
    for (const bad of ['0', '101', '2.5', 'abc']) {
      const refused = await customer.client.get(`${API}/balance/transactions?limit=${bad}`);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('runs the journey for an Arabic customer too', async () => {
    // §115: money is the same; the words around it are not.
    const arabic = await createUser(context, 'arabic@example.com', 'ar');
    await fundBalance(context, arabic.client, '2000');

    const funded = await arabic.client.get(`${API}/balance`);
    expect(funded.status).toBe(200);
    // Amounts are canonical and locale-free on the wire; formatting is the
    // UI's job (§114).
    expect(funded.body.available).toEqual({ currency: 'USD', minorUnits: '2000' });
  });

  it('lets finance see a customer balance, and support see only the payment', async () => {
    // §78, §135: support answers "where is my top-up?" and can move nothing.
    await fundBalance(context, customer.client, '2000');
    const finance = await signInGlobalRole(context, 'finance@example.com', 'PALCERT_FINANCE');
    const support = await signInGlobalRole(context, 'support@example.com', 'PALCERT_SUPPORT');

    const financeBalance = await finance.get(
      `${API}/admin/finance/customers/${customer.userId}/balance`,
    );
    expect(financeBalance.status).toBe(200);
    expect(financeBalance.body.cash).toEqual({ currency: 'USD', minorUnits: '2000' });

    const supportPayments = await support.get(
      `${API}/admin/finance/customers/${customer.userId}/payments`,
    );
    expect(supportPayments.status).toBe(200);

    // The ledger is finance's, and moving money is finance's.
    expect(
      (await support.get(`${API}/admin/finance/customers/${customer.userId}/balance`)).status,
    ).toBe(403);
    expect(
      (
        await support.post(`${API}/admin/finance/adjustments`, {
          ownerUserId: customer.userId,
          currency: 'USD',
          creditClass: 'CASH',
          amountMinorUnits: '10000',
          reasonCode: 'GOODWILL',
          idempotencyKey: 'support-should-not-be-able-to',
        })
      ).status,
    ).toBe(403);
    expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
  });
});

// ---------------------------------------------------------------------------

/**
 * Reserve and capture through the internal services Phase 11 will call.
 *
 * Deliberately not through an HTTP route: §144 forbids wiring payment into
 * `POST /checks` in this phase, and inventing a public "create a hold"
 * endpoint would be building Phase 11's surface early. These are the same
 * methods Phase 11 will use (§145).
 */
async function createServiceHold(
  context: TestContext,
  ownerUserId: string,
  amountMinor: bigint,
): Promise<string> {
  const holds = context.app.get(CreditHoldService);
  const tenant = context.app.get(TenantPrismaService);
  return tenant.withUser(ownerUserId, async (tx) => {
    const hold = await holds.create(tx, {
      ownerUserId,
      currency: 'USD',
      creditClass: CreditClass.CASH,
      amountMinor,
      purpose: CreditHoldPurpose.SERVICE,
    });
    return hold.id;
  });
}

async function captureHold(
  context: TestContext,
  ownerUserId: string,
  holdId: string,
): Promise<{ entryId: string }> {
  const holds = context.app.get(CreditHoldService);
  const tenant = context.app.get(TenantPrismaService);
  return tenant.withUser(ownerUserId, (tx) => holds.capture(tx, holdId));
}
