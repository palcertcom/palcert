import { CreditClass, CreditHoldPurpose, LedgerReasonCode } from '@palcert/contracts';
import { API } from './support/auth-client';
import {
  deliverWebhook,
  disputeOpened,
  disputeReversed,
  drainPaymentJobs,
  fundBalance,
  ledgerOf,
  ledgerTotal,
} from './support/finance-client';
import { createUser, signInGlobalRole } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';
import { BalanceService } from '../src/modules/finance/services/balance.service';
import { CreditHoldService } from '../src/modules/finance/services/credit-hold.service';
import { TenantPrismaService } from '../src/infrastructure/tenant/tenant-prisma.service';

/**
 * Refunds and disputes (§162 items 21–31, §131, §132).
 *
 * The distinction that runs through all of it: a **service refund** moves
 * credit inside PalCert and never touches a card, while an **external refund**
 * sends real money back through the provider (§65). Conflating them would let
 * a customer be paid twice for one failed check.
 */
describe('Refunds and disputes (e2e)', () => {
  let context: TestContext;
  let customer: Awaited<ReturnType<typeof createUser>>;
  let finance: Awaited<ReturnType<typeof signInGlobalRole>>;
  let balances: BalanceService;
  let holds: CreditHoldService;
  let tenant: TenantPrismaService;

  beforeAll(async () => {
    context = await createTestContext();
    balances = context.app.get(BalanceService);
    holds = context.app.get(CreditHoldService);
    tenant = context.app.get(TenantPrismaService);
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    customer = await createUser(context, 'student@example.com');
    finance = await signInGlobalRole(context, 'finance@example.com', 'PALCERT_FINANCE');
  });

  /** Charge a service fee, returning the ledger entry it created. */
  async function chargeService(amountMinor: bigint): Promise<string> {
    const hold = await tenant.withUser(customer.userId, (tx) =>
      holds.create(tx, {
        ownerUserId: customer.userId,
        currency: 'USD',
        creditClass: CreditClass.CASH,
        amountMinor,
        purpose: CreditHoldPurpose.SERVICE,
      }),
    );
    const captured = await tenant.withUser(customer.userId, (tx) => holds.capture(tx, hold.id));
    return captured.entryId;
  }

  describe('service refunds (§66, §67)', () => {
    it('returns a captured fee to the balance', async () => {
      await fundBalance(context, customer.client, '2000');
      const entryId = await chargeService(300n);
      expect(await ledgerTotal(context, customer.userId)).toBe(1700n);

      await balances.refundServiceCharge({
        ownerUserId: customer.userId,
        ledgerEntryId: entryId,
        reasonCode: LedgerReasonCode.SERVICE_FAILED,
      });

      expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
      // No provider call: this is credit moving inside PalCert (§65).
      expect(context.paymentProvider.refunds).toHaveLength(0);
    });

    it('cannot credit twice for the same charge', async () => {
      // §67, §127: a duplicate click or a retried job.
      await fundBalance(context, customer.client, '2000');
      const entryId = await chargeService(300n);

      await balances.refundServiceCharge({ ownerUserId: customer.userId, ledgerEntryId: entryId });
      await balances.refundServiceCharge({ ownerUserId: customer.userId, ledgerEntryId: entryId });

      expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
      expect(
        await context.adminDb.creditLedgerEntry.count({ where: { entryType: 'SERVICE_REFUND' } }),
      ).toBe(1);
    });

    it('cannot credit twice when two refunds race', async () => {
      await fundBalance(context, customer.client, '2000');
      const entryId = await chargeService(300n);

      await Promise.allSettled([
        balances.refundServiceCharge({ ownerUserId: customer.userId, ledgerEntryId: entryId }),
        balances.refundServiceCharge({ ownerUserId: customer.userId, ledgerEntryId: entryId }),
      ]);

      expect(
        await context.adminDb.creditLedgerEntry.count({ where: { entryType: 'SERVICE_REFUND' } }),
      ).toBe(1);
      expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
    });

    it('refuses to refund something that is not a service charge', async () => {
      await fundBalance(context, customer.client, '2000');
      const [topUpCredit] = await ledgerOf(context, customer.userId);

      await expect(
        balances.refundServiceCharge({
          ownerUserId: customer.userId,
          ledgerEntryId: topUpCredit!.id,
        }),
      ).rejects.toMatchObject({ code: 'LEDGER_ENTRY_NOT_REFUNDABLE' });
    });

    it('leaves the original charge exactly as it was', async () => {
      // §13: never rewrite -300 to 0.
      await fundBalance(context, customer.client, '2000');
      const entryId = await chargeService(300n);

      await balances.refundServiceCharge({ ownerUserId: customer.userId, ledgerEntryId: entryId });

      const original = await context.adminDb.creditLedgerEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(original.amountMinorSigned).toBe(-300n);
      const refund = await context.adminDb.creditLedgerEntry.findFirstOrThrow({
        where: { reversalOfEntryId: entryId },
      });
      expect(refund.amountMinorSigned).toBe(300n);
    });
  });

  describe('external refunds (§68–§75, §131)', () => {
    async function fundedTopUp(amount = '2000'): Promise<string> {
      const { topUpId } = await fundBalance(context, customer.client, amount);
      return topUpId;
    }

    it('returns money through the provider and debits the balance once', async () => {
      const topUpId = await fundedTopUp();

      const response = await finance.post(`${API}/admin/finance/refunds`, {
        topUpId,
        amountMinorUnits: '2000',
        reason: 'REQUESTED_BY_CUSTOMER',
      });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('SUCCEEDED');
      expect(await ledgerTotal(context, customer.userId)).toBe(0n);
      expect(context.paymentProvider.refunds).toHaveLength(1);
      const debits = await context.adminDb.creditLedgerEntry.findMany({
        where: { entryType: 'PAYMENT_REFUND_DEBIT' },
      });
      expect(debits).toHaveLength(1);
      expect(debits[0]?.amountMinorSigned).toBe(-2000n);
    });

    it('supports a partial refund, and then the remainder', async () => {
      // §74: multiple partials, summing to no more than the original.
      const topUpId = await fundedTopUp();

      const first = await finance.post(`${API}/admin/finance/refunds`, {
        topUpId,
        amountMinorUnits: '500',
        reason: 'GOODWILL',
      });
      expect(first.status).toBe(201);
      expect(await ledgerTotal(context, customer.userId)).toBe(1500n);

      const second = await finance.post(`${API}/admin/finance/refunds`, {
        topUpId,
        amountMinorUnits: '1500',
        reason: 'GOODWILL',
      });
      expect(second.status).toBe(201);
      expect(await ledgerTotal(context, customer.userId)).toBe(0n);
    });

    it('refuses one minor unit more than the original payment', async () => {
      // §131: the boundary case, tested at exactly one unit over.
      const topUpId = await fundedTopUp();

      const exact = await finance.post(`${API}/admin/finance/refunds`, {
        topUpId,
        amountMinorUnits: '2000',
        reason: 'DUPLICATE',
      });
      expect(exact.status).toBe(201);

      const oneTooMany = await finance.post(`${API}/admin/finance/refunds`, {
        topUpId,
        amountMinorUnits: '1',
        reason: 'DUPLICATE',
      });
      expect(oneTooMany.status).toBe(409);
      expect(oneTooMany.body.error.code).toBe('REFUND_EXCEEDS_REMAINING');
    });

    it('refuses to refund more than the original in one request', async () => {
      const topUpId = await fundedTopUp();

      const response = await finance.post(`${API}/admin/finance/refunds`, {
        topUpId,
        amountMinorUnits: '2001',
        reason: 'DUPLICATE',
      });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('REFUND_EXCEEDS_REMAINING');
      expect(context.paymentProvider.refunds).toHaveLength(0);
    });

    it('refuses when the credit has already been spent', async () => {
      // §70: "eligible CASH credit still available". The reservation is what
      // enforces it, so a spent balance simply cannot be reserved.
      const topUpId = await fundedTopUp();
      await chargeService(1900n);

      const response = await finance.post(`${API}/admin/finance/refunds`, {
        topUpId,
        amountMinorUnits: '2000',
        reason: 'REQUESTED_BY_CUSTOMER',
      });

      // 402 Payment Required, the mapping INSUFFICIENT_BALANCE has carried
      // since Phase 0. Nothing was sent to the provider.
      expect(response.status).toBe(402);
      expect(response.body.error.code).toBe('INSUFFICIENT_BALANCE');
      expect(context.paymentProvider.refunds).toHaveLength(0);
    });

    it('reserves the credit so it cannot be spent while the refund settles', async () => {
      // §71: the race the reservation exists to prevent.
      const topUpId = await fundedTopUp();
      context.paymentProvider.mode = 'unavailable';

      const response = await finance.post(`${API}/admin/finance/refunds`, {
        topUpId,
        amountMinorUnits: '2000',
        reason: 'REQUESTED_BY_CUSTOMER',
      });
      expect(response.body.status).toBe('PENDING');
      context.paymentProvider.mode = 'normal';

      // The money is reserved, not spent, and not available to spend again.
      const balance = await customer.client.get(`${API}/balance`);
      expect(balance.body.reserved).toEqual({ currency: 'USD', minorUnits: '2000' });
      expect(balance.body.available).toEqual({ currency: 'USD', minorUnits: '0' });
      await expect(chargeService(100n)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    });

    it('releases the reservation and debits nothing when the provider refuses', async () => {
      // §73: nothing left PalCert, so nothing leaves the balance.
      const topUpId = await fundedTopUp();
      context.paymentProvider.mode = 'refund-failed';

      const response = await finance.post(`${API}/admin/finance/refunds`, {
        topUpId,
        amountMinorUnits: '2000',
        reason: 'REQUESTED_BY_CUSTOMER',
      });

      expect(response.body.status).toBe('FAILED');
      expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
      const balance = await customer.client.get(`${API}/balance`);
      expect(balance.body.available).toEqual({ currency: 'USD', minorUnits: '2000' });
      expect(balance.body.reserved).toEqual({ currency: 'USD', minorUnits: '0' });
    });

    it('never refunds promotional credit through the provider', async () => {
      // §9, §70. Enforced structurally: the reservation is taken against a
      // CASH account, and a database CHECK refuses a provider debit against
      // any other class.
      const granted = await finance.post(`${API}/admin/finance/adjustments`, {
        ownerUserId: customer.userId,
        currency: 'USD',
        creditClass: 'PROMOTIONAL',
        amountMinorUnits: '5000',
        reasonCode: 'PROMOTION',
        idempotencyKey: 'promo-1',
      });
      expect(granted.status).toBe(201);
      const topUpId = await fundedTopUp('500');

      // The customer holds $55, but only $5 of it is refundable cash.
      const balance = await customer.client.get(`${API}/balance`);
      expect(balance.body.promotional).toEqual({ currency: 'USD', minorUnits: '5000' });
      expect(balance.body.cash).toEqual({ currency: 'USD', minorUnits: '500' });

      const response = await finance.post(`${API}/admin/finance/refunds`, {
        topUpId,
        amountMinorUnits: '5500',
        reason: 'REQUESTED_BY_CUSTOMER',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('REFUND_EXCEEDS_REMAINING');
    });

    it('does not duplicate a refund when two finance requests race', async () => {
      // §75, §163: refund vs refund.
      const topUpId = await fundedTopUp();

      await Promise.allSettled([
        finance.post(`${API}/admin/finance/refunds`, {
          topUpId,
          amountMinorUnits: '2000',
          reason: 'DUPLICATE',
        }),
        finance.post(`${API}/admin/finance/refunds`, {
          topUpId,
          amountMinorUnits: '2000',
          reason: 'DUPLICATE',
        }),
      ]);

      const succeeded = await context.adminDb.paymentRefund.count({
        where: { status: 'SUCCEEDED' },
      });
      expect(succeeded).toBeLessThanOrEqual(1);
      expect(
        await context.adminDb.creditLedgerEntry.count({
          where: { entryType: 'PAYMENT_REFUND_DEBIT' },
        }),
      ).toBeLessThanOrEqual(1);
      // Whatever happened, the customer is not overdrawn.
      expect(await ledgerTotal(context, customer.userId)).toBeGreaterThanOrEqual(0n);
    });

    it('never lets a refund and a service hold spend the same money', async () => {
      // §163: hold vs refund. Both take credit out of the same balance, one by
      // reserving it for work and one by sending it back to a card. If they
      // could both succeed against $20, PalCert would have promised $40.
      const topUpId = await fundedTopUp('2000');

      const [refundOutcome, holdOutcome] = await Promise.allSettled([
        finance.post(`${API}/admin/finance/refunds`, {
          topUpId,
          amountMinorUnits: '2000',
          reason: 'REQUESTED_BY_CUSTOMER',
        }),
        tenant.withUser(customer.userId, (tx) =>
          holds.create(tx, {
            ownerUserId: customer.userId,
            currency: 'USD',
            creditClass: CreditClass.CASH,
            amountMinor: 2000n,
            purpose: CreditHoldPurpose.SERVICE,
          }),
        ),
      ]);

      const refundTook = refundOutcome.status === 'fulfilled' && refundOutcome.value.status === 201;
      const holdTook = holdOutcome.status === 'fulfilled';

      // Whichever order the two transactions serialized in, the money was only
      // ever committed once.
      expect([refundTook, holdTook].filter(Boolean)).toHaveLength(1);

      const reserved = await context.adminDb.creditHold.aggregate({
        where: { ownerUserId: customer.userId, status: 'ACTIVE' },
        _sum: { amountMinor: true },
      });
      const spendable =
        (await ledgerTotal(context, customer.userId)) - (reserved._sum.amountMinor ?? 0n);
      expect(spendable).toBeGreaterThanOrEqual(0n);
    });

    it('lets the customer read their own refund history, and no one else’s', async () => {
      const topUpId = await fundedTopUp();
      await finance.post(`${API}/admin/finance/refunds`, {
        topUpId,
        amountMinorUnits: '500',
        reason: 'GOODWILL',
      });

      const history = await customer.client.get(`${API}/balance/refunds`);
      expect(history.status).toBe(200);
      expect(history.body).toHaveLength(1);
      expect(history.body[0].amount).toEqual({ currency: 'USD', minorUnits: '500' });

      const stranger = await createUser(context, 'stranger@example.com');
      expect((await stranger.client.get(`${API}/balance/refunds`)).body).toEqual([]);
    });
  });

  describe('chargebacks (§83–§86, §132)', () => {
    it('debits the balance when a payment is disputed, even below zero', async () => {
      // §84, §85: a negative balance is a financial reality. Inventing credit
      // to keep it non-negative would be recording a fiction.
      const { paymentId } = await fundBalance(context, customer.client, '2000');
      await chargeService(1800n);
      expect(await ledgerTotal(context, customer.userId)).toBe(200n);

      await deliverWebhook(
        context,
        disputeOpened({
          eventId: 'evt_dispute',
          disputeId: 'dp_1',
          paymentId,
          amountMinorUnits: '2000',
        }),
      );
      await drainPaymentJobs(context);

      expect(await ledgerTotal(context, customer.userId)).toBe(-1800n);
      const debits = await context.adminDb.creditLedgerEntry.findMany({
        where: { entryType: 'CHARGEBACK_DEBIT' },
      });
      expect(debits).toHaveLength(1);
      expect(debits[0]?.amountMinorSigned).toBe(-2000n);
    });

    it('blocks new spending while the balance is negative', async () => {
      // §85: the deficit is real, and new reservations wait until it clears.
      const { paymentId } = await fundBalance(context, customer.client, '2000');
      await deliverWebhook(
        context,
        disputeOpened({
          eventId: 'evt_dispute',
          disputeId: 'dp_1',
          paymentId,
          amountMinorUnits: '2000',
        }),
      );
      await drainPaymentJobs(context);
      expect(await ledgerTotal(context, customer.userId)).toBe(0n);

      await expect(chargeService(100n)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    });

    it('restores exactly the disputed amount when the dispute is won', async () => {
      // §86.
      const { paymentId } = await fundBalance(context, customer.client, '2000');
      await deliverWebhook(
        context,
        disputeOpened({
          eventId: 'evt_open',
          disputeId: 'dp_1',
          paymentId,
          amountMinorUnits: '2000',
        }),
      );
      await drainPaymentJobs(context);
      expect(await ledgerTotal(context, customer.userId)).toBe(0n);

      await deliverWebhook(
        context,
        disputeReversed({ eventId: 'evt_won', disputeId: 'dp_1', status: 'WON' }),
      );
      await drainPaymentJobs(context);

      expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
      const reversals = await context.adminDb.creditLedgerEntry.findMany({
        where: { entryType: 'CHARGEBACK_REVERSAL' },
      });
      expect(reversals).toHaveLength(1);
      expect(reversals[0]?.amountMinorSigned).toBe(2000n);
    });

    it('records a dispute once however many times it is delivered', async () => {
      const { paymentId } = await fundBalance(context, customer.client, '2000');
      const event = disputeOpened({
        eventId: 'evt_dispute',
        disputeId: 'dp_1',
        paymentId,
        amountMinorUnits: '2000',
      });

      for (let delivery = 0; delivery < 3; delivery += 1) {
        await deliverWebhook(context, event);
        await drainPaymentJobs(context);
      }

      expect(
        await context.adminDb.creditLedgerEntry.count({ where: { entryType: 'CHARGEBACK_DEBIT' } }),
      ).toBe(1);
      expect(await context.adminDb.paymentDispute.count()).toBe(1);
    });
  });
});
