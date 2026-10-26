import { CreditClass, CreditHoldPurpose } from '@palcert/contracts';
import { API } from './support/auth-client';
import { fundBalance, ledgerTotal } from './support/finance-client';
import { createUser } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';
import { CreditHoldService } from '../src/modules/finance/services/credit-hold.service';
import { TenantPrismaService } from '../src/infrastructure/tenant/tenant-prisma.service';

/**
 * Credit holds and the concurrency invariant (§162 items 15–20, §163).
 *
 * The test that matters most is `two racing holds cannot overspend`. Everything
 * else here is lifecycle; that one is the reason holds exist at all.
 *
 * These exercise the internal services rather than an HTTP route, deliberately:
 * §144 forbids wiring payment into `POST /checks` in this phase, and inventing
 * a public "create a hold" endpoint would be building Phase 11's surface early.
 * These are the exact methods Phase 11 will call (§145).
 */
describe('Credit holds (e2e)', () => {
  let context: TestContext;
  let customer: Awaited<ReturnType<typeof createUser>>;
  let holds: CreditHoldService;
  let tenant: TenantPrismaService;

  beforeAll(async () => {
    context = await createTestContext();
    holds = context.app.get(CreditHoldService);
    tenant = context.app.get(TenantPrismaService);
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    customer = await createUser(context, 'student@example.com');
  });

  function hold(amountMinor: bigint, idempotencyKey?: string) {
    return tenant.withUser(customer.userId, (tx) =>
      holds.create(tx, {
        ownerUserId: customer.userId,
        currency: 'USD',
        creditClass: CreditClass.CASH,
        amountMinor,
        purpose: CreditHoldPurpose.SERVICE,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }),
    );
  }

  function capture(holdId: string) {
    return tenant.withUser(customer.userId, (tx) => holds.capture(tx, holdId));
  }

  function release(holdId: string) {
    return tenant.withUser(customer.userId, (tx) => holds.release(tx, holdId));
  }

  it('reserves credit without spending it', async () => {
    await fundBalance(context, customer.client, '2000');

    const created = await hold(300n);
    expect(created.status).toBe('ACTIVE');

    const balance = await customer.client.get(`${API}/balance`);
    expect(balance.body.available).toEqual({ currency: 'USD', minorUnits: '1700' });
    expect(balance.body.reserved).toEqual({ currency: 'USD', minorUnits: '300' });
    // Reserved is not spent: the ledger is untouched.
    expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
  });

  it('refuses a hold larger than the available balance', async () => {
    await fundBalance(context, customer.client, '500');

    await expect(hold(600n)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(await context.adminDb.creditHold.count()).toBe(0);
  });

  it('counts an existing hold against a second one', async () => {
    // Availability is balance minus holds, not balance (§17).
    await fundBalance(context, customer.client, '500');
    await hold(400n);

    await expect(hold(200n)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('returns the same hold for a retried request', async () => {
    // §19: a retry must not reserve twice.
    await fundBalance(context, customer.client, '2000');

    const first = await hold(300n, 'retry-me');
    const second = await hold(300n, 'retry-me');

    expect(second.id).toBe(first.id);
    expect(await context.adminDb.creditHold.count()).toBe(1);
    expect((await customer.client.get(`${API}/balance`)).body.reserved.minorUnits).toBe('300');
  });

  it('spends the money when captured', async () => {
    await fundBalance(context, customer.client, '2000');
    const created = await hold(300n);

    await capture(created.id);

    const balance = await customer.client.get(`${API}/balance`);
    expect(balance.body.available).toEqual({ currency: 'USD', minorUnits: '1700' });
    expect(balance.body.reserved).toEqual({ currency: 'USD', minorUnits: '0' });
    expect(await ledgerTotal(context, customer.userId)).toBe(1700n);

    const entries = await context.adminDb.creditLedgerEntry.findMany({
      where: { entryType: 'SERVICE_CHARGE' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amountMinorSigned).toBe(-300n);
  });

  it('treats a repeated capture as the same charge, not a second one', async () => {
    // §20: at-least-once delivery makes a repeated capture normal.
    await fundBalance(context, customer.client, '2000');
    const created = await hold(300n);

    const first = await capture(created.id);
    const second = await capture(created.id);

    expect(second.entryId).toBe(first.entryId);
    expect(second.alreadyCaptured).toBe(true);
    expect(
      await context.adminDb.creditLedgerEntry.count({ where: { entryType: 'SERVICE_CHARGE' } }),
    ).toBe(1);
    expect(await ledgerTotal(context, customer.userId)).toBe(1700n);
  });

  it('restores availability when released, and writes no charge', async () => {
    await fundBalance(context, customer.client, '2000');
    const created = await hold(300n);

    await release(created.id);

    const balance = await customer.client.get(`${API}/balance`);
    expect(balance.body.available).toEqual({ currency: 'USD', minorUnits: '2000' });
    expect(balance.body.reserved).toEqual({ currency: 'USD', minorUnits: '0' });
    // Nothing was spent, so nothing is in the ledger (§21).
    expect(
      await context.adminDb.creditLedgerEntry.count({ where: { entryType: 'SERVICE_CHARGE' } }),
    ).toBe(0);
  });

  it('is idempotent when released twice', async () => {
    await fundBalance(context, customer.client, '2000');
    const created = await hold(300n);

    const first = await release(created.id);
    const second = await release(created.id);

    expect(first.released).toBe(true);
    expect(second.alreadyReleased).toBe(true);
  });

  it('never lets a captured hold be released', async () => {
    // §21: the money moved and the service was delivered. Releasing it
    // afterwards would give away both.
    await fundBalance(context, customer.client, '2000');
    const created = await hold(300n);
    await capture(created.id);

    await expect(release(created.id)).rejects.toMatchObject({
      code: 'CREDIT_HOLD_NOT_ACTIVE',
    });
    expect(await ledgerTotal(context, customer.userId)).toBe(1700n);
  });

  it('never lets a released hold be captured', async () => {
    await fundBalance(context, customer.client, '2000');
    const created = await hold(300n);
    await release(created.id);

    await expect(capture(created.id)).rejects.toMatchObject({
      code: 'CREDIT_HOLD_NOT_ACTIVE',
    });
    expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
  });

  it('expires a stale hold and gives the money back', async () => {
    // §22: an abandoned request must not lock a customer's money up forever.
    await fundBalance(context, customer.client, '2000');
    const created = await hold(300n);

    context.clock.advanceMinutes(30);
    const expired = await tenant.withPlatformAdmin(
      { actorUserId: customer.userId, reason: 'test: expire due holds' },
      (tx) => holds.expireDue(tx),
    );

    expect(expired).toBe(1);
    const balance = await customer.client.get(`${API}/balance`);
    expect(balance.body.available).toEqual({ currency: 'USD', minorUnits: '2000' });
    expect(
      (await context.adminDb.creditHold.findUniqueOrThrow({ where: { id: created.id } })).status,
    ).toBe('EXPIRED');
    // Expiry is not a charge.
    expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
  });

  it('expires idempotently', async () => {
    await fundBalance(context, customer.client, '2000');
    await hold(300n);
    context.clock.advanceMinutes(30);

    const sweep = () =>
      tenant.withPlatformAdmin(
        { actorUserId: customer.userId, reason: 'test: expire due holds' },
        (tx) => holds.expireDue(tx),
      );

    expect(await sweep()).toBe(1);
    expect(await sweep()).toBe(0);
  });

  describe('concurrency (§18, §163)', () => {
    it('lets only one of two racing holds win when the balance covers one', async () => {
      // The invariant the whole design exists for: $5 available, two
      // simultaneous $4 requests, and exactly one may succeed.
      await fundBalance(context, customer.client, '500');

      const results = await Promise.allSettled([hold(400n), hold(400n)]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'INSUFFICIENT_BALANCE',
      });

      // And the balance is not overdrawn.
      const balance = await customer.client.get(`${API}/balance`);
      expect(balance.body.reserved).toEqual({ currency: 'USD', minorUnits: '400' });
      expect(balance.body.available).toEqual({ currency: 'USD', minorUnits: '100' });
    });

    it('survives many racing holds without ever overspending', async () => {
      // Ten simultaneous $3 requests against $10: at most three may win.
      await fundBalance(context, customer.client, '1000');

      const results = await Promise.allSettled(Array.from({ length: 10 }, () => hold(300n)));
      const won = results.filter((result) => result.status === 'fulfilled').length;

      expect(won).toBeLessThanOrEqual(3);
      const balance = await customer.client.get(`${API}/balance`);
      expect(BigInt(balance.body.available.minorUnits)).toBeGreaterThanOrEqual(0n);
      expect(BigInt(balance.body.reserved.minorUnits)).toBe(BigInt(won) * 300n);
    });

    it('charges once when two captures race the same hold', async () => {
      // §127, §163: capture vs capture.
      await fundBalance(context, customer.client, '2000');
      const created = await hold(300n);

      await Promise.allSettled([capture(created.id), capture(created.id)]);

      expect(
        await context.adminDb.creditLedgerEntry.count({ where: { entryType: 'SERVICE_CHARGE' } }),
      ).toBe(1);
      expect(await ledgerTotal(context, customer.userId)).toBe(1700n);
    });

    it('never both charges and refunds when release races capture', async () => {
      // §163: release vs capture. Whichever wins, the outcome must be
      // internally consistent — never a charge *and* a restored balance.
      await fundBalance(context, customer.client, '2000');
      const created = await hold(300n);

      await Promise.allSettled([capture(created.id), release(created.id)]);

      const finalHold = await context.adminDb.creditHold.findUniqueOrThrow({
        where: { id: created.id },
      });
      const charges = await context.adminDb.creditLedgerEntry.count({
        where: { entryType: 'SERVICE_CHARGE' },
      });

      if (finalHold.status === 'CAPTURED') {
        expect(charges).toBe(1);
        expect(await ledgerTotal(context, customer.userId)).toBe(1700n);
      } else {
        expect(finalHold.status).toBe('RELEASED');
        expect(charges).toBe(0);
        expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
      }
    });
  });
});
