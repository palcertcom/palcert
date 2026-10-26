import { API } from './support/auth-client';
import { createTopUp, fundBalance, ledgerTotal } from './support/finance-client';
import {
  createTenant,
  createUser,
  grantOrganizationRoleTo,
  signInGlobalRole,
} from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Who can see whose money (§79, §99, §133, §134, §135, §162 items 37–40).
 *
 * Every attack below uses a **real** identifier belonging to a real other
 * customer. A test with a random UUID would prove only that PalCert can fail
 * to find something that does not exist.
 *
 * The organization test is the one §134 calls mandatory, and it is the one a
 * university would care about most: an institution whose standard a student
 * checks against learns nothing about that student's money — not the balance,
 * not the payments, not that any exist.
 */
/** JSON for assertions. Prisma rows carry BigInt amounts, which JSON refuses. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  );
}

describe('Financial isolation (e2e)', () => {
  let context: TestContext;
  let alice: Awaited<ReturnType<typeof createUser>>;
  let bob: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    alice = await createUser(context, 'alice@example.com');
    bob = await createUser(context, 'bob@example.com');
  });

  describe('one customer cannot reach another’s money', () => {
    it('sees only its own balance', async () => {
      await fundBalance(context, alice.client, '2000');

      const bobBalance = await bob.client.get(`${API}/balance`);
      expect(bobBalance.status).toBe(200);
      expect(bobBalance.body.available).toEqual({ currency: 'USD', minorUnits: '0' });
      expect(await ledgerTotal(context, alice.userId)).toBe(2000n);
    });

    it('cannot read another customer’s top-up by its real id', async () => {
      const { topUpId } = await fundBalance(context, alice.client, '2000');

      const response = await bob.client.get(`${API}/balance/top-ups/${topUpId}`);

      // 404, never 403: the difference would confirm the id exists (§133).
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('TOPUP_NOT_FOUND');
    });

    it('sees none of another customer’s transactions', async () => {
      await fundBalance(context, alice.client, '2000');

      const history = await bob.client.get(`${API}/balance/transactions`);

      expect(history.status).toBe(200);
      expect(history.body.items).toEqual([]);
    });

    it('sees none of another customer’s holds or refunds', async () => {
      await fundBalance(context, alice.client, '2000');

      expect((await bob.client.get(`${API}/balance/holds`)).body).toEqual([]);
      expect((await bob.client.get(`${API}/balance/refunds`)).body).toEqual([]);
    });

    it('cannot make another customer’s money appear in its own ledger', async () => {
      // The composite ownership keys make this impossible at the database
      // level even if every application check were wrong (§149).
      await fundBalance(context, alice.client, '2000');
      const aliceAccount = await context.adminDb.customerCreditAccount.findFirstOrThrow({
        where: { ownerUserId: alice.userId },
      });

      await expect(
        context.adminDb.creditLedgerEntry.create({
          data: {
            ownerUserId: bob.userId,
            accountId: aliceAccount.id,
            currency: 'USD',
            creditClass: 'CASH',
            entryType: 'ADMIN_CREDIT',
            amountMinorSigned: 100000n,
          },
        }),
      ).rejects.toThrow();

      expect(await ledgerTotal(context, bob.userId)).toBe(0n);
      expect(await ledgerTotal(context, alice.userId)).toBe(2000n);
    });

    it('cannot reserve against another customer’s account', async () => {
      await fundBalance(context, alice.client, '2000');
      const aliceAccount = await context.adminDb.customerCreditAccount.findFirstOrThrow({
        where: { ownerUserId: alice.userId },
      });

      await expect(
        context.adminDb.creditHold.create({
          data: {
            ownerUserId: bob.userId,
            accountId: aliceAccount.id,
            currency: 'USD',
            creditClass: 'CASH',
            purpose: 'SERVICE',
            amountMinor: 2000n,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('an organization cannot reach a member’s money', () => {
    it('learns nothing about a member’s balance, payments or refunds', async () => {
      // §79, §134: mandatory, and true regardless of which standard the member
      // later checks against.
      const tenant = await createTenant(context, 'Islamic University of Gaza', 'owner@example.com');
      await grantOrganizationRoleTo(context, tenant, alice, 'ORGANIZATION_REVIEWER');
      await fundBalance(context, alice.client, '2000');

      // The owner is an administrator of the organization the student belongs
      // to, and still has no route to their money.
      const owner = tenant.owner.client;
      expect((await owner.get(`${API}/balance`)).body.available.minorUnits).toBe('0');
      expect(
        (await owner.get(`${API}/admin/finance/customers/${alice.userId}/balance`)).status,
      ).toBe(403);
      expect(
        (await owner.get(`${API}/admin/finance/customers/${alice.userId}/payments`)).status,
      ).toBe(403);

      // There is no organization-scoped financial route at all.
      const organizationScoped = await owner.get(
        `${API}/organizations/${tenant.organizationId}/balance`,
      );
      expect(organizationScoped.status).toBe(404);
    });

    it('gives an organization no financial permission of any kind', async () => {
      // The catalogue itself: no organization role holds a finance or pricing
      // permission, so there is nothing to misconfigure (§107).
      const organizationPermissions = await context.adminDb.$queryRaw<{ code: string }[]>`
        SELECT DISTINCT p."code"
        FROM "role_permissions" rp
        JOIN "roles" r ON r."id" = rp."role_id"
        JOIN "permissions" p ON p."id" = rp."permission_id"
        WHERE r."scope" = 'ORGANIZATION'
          AND (p."code" LIKE 'finance:%' OR p."code" LIKE 'pricing:%' OR p."code" LIKE 'balance:%')
      `;
      expect(organizationPermissions).toEqual([]);
    });
  });

  describe('platform roles', () => {
    it('lets finance adjust a balance, with a reason and an audit trail', async () => {
      // §76, §135.
      const finance = await signInGlobalRole(context, 'finance@example.com', 'PALCERT_FINANCE');

      const response = await finance.post(`${API}/admin/finance/adjustments`, {
        ownerUserId: alice.userId,
        currency: 'USD',
        creditClass: 'CASH',
        amountMinorUnits: '1500',
        reasonCode: 'GOODWILL',
        idempotencyKey: 'goodwill-1',
        note: 'Compensation for a failed check.',
      });

      expect(response.status).toBe(201);
      expect(await ledgerTotal(context, alice.userId)).toBe(1500n);

      const audit = await context.adminDb.auditEvent.findFirst({
        where: { action: 'ADMIN_CREDIT_CREATED' },
      });
      expect(audit).not.toBeNull();
      expect(audit?.actorUserId).not.toBeNull();
    });

    it('does not adjust twice for a repeated request', async () => {
      const finance = await signInGlobalRole(context, 'finance@example.com', 'PALCERT_FINANCE');
      const body = {
        ownerUserId: alice.userId,
        currency: 'USD',
        creditClass: 'CASH',
        amountMinorUnits: '1500',
        reasonCode: 'GOODWILL',
        idempotencyKey: 'goodwill-1',
      };

      await finance.post(`${API}/admin/finance/adjustments`, body);
      await finance.post(`${API}/admin/finance/adjustments`, body);

      expect(await ledgerTotal(context, alice.userId)).toBe(1500n);
      expect(await context.adminDb.creditLedgerEntry.count()).toBe(1);
    });

    it('refuses every financial mutation to support', async () => {
      // §78, §135: support must not be a path to moving money.
      const support = await signInGlobalRole(context, 'support@example.com', 'PALCERT_SUPPORT');
      await fundBalance(context, alice.client, '2000');
      const topUp = await context.adminDb.balanceTopUp.findFirstOrThrow();

      const attempts = [
        support.post(`${API}/admin/finance/adjustments`, {
          ownerUserId: alice.userId,
          currency: 'USD',
          creditClass: 'CASH',
          amountMinorUnits: '100000',
          reasonCode: 'GOODWILL',
          idempotencyKey: 'nope',
        }),
        support.post(`${API}/admin/finance/refunds`, {
          topUpId: topUp.id,
          amountMinorUnits: '2000',
          reason: 'GOODWILL',
        }),
        support.post(`${API}/admin/finance/prices`, {
          productCode: 'DOCUMENT_CHECK',
          currency: 'USD',
          amountMinorUnits: '1',
        }),
      ];
      for (const attempt of attempts) {
        expect((await attempt).status).toBe(403);
      }

      expect(await ledgerTotal(context, alice.userId)).toBe(2000n);
      expect(await context.adminDb.paymentRefund.count()).toBe(0);
    });

    it('refuses the ledger to an ordinary customer', async () => {
      await fundBalance(context, alice.client, '2000');

      expect(
        (await bob.client.get(`${API}/admin/finance/customers/${alice.userId}/balance`)).status,
      ).toBe(403);
      expect((await bob.client.get(`${API}/admin/finance/verify-ledger`)).status).toBe(403);
    });

    it('reports the financial invariants as consistent', async () => {
      // §153: the diagnostic that will matter most in production.
      const finance = await signInGlobalRole(context, 'finance@example.com', 'PALCERT_FINANCE');
      await fundBalance(context, alice.client, '2000');
      await fundBalance(context, bob.client, '1000');

      const report = await finance.get(`${API}/admin/finance/verify-ledger`);

      expect(report.status).toBe(200);
      expect(report.body.consistent).toBe(true);
      expect(report.body.findings).toEqual([]);
      expect(report.body.accountsChecked).toBeGreaterThan(0);
    });
  });

  describe('what the API never discloses', () => {
    it('never returns a provider session, payment id or secret', async () => {
      // §64, §92, §136.
      await fundBalance(context, alice.client, '2000');

      const serialized = JSON.stringify([
        (await alice.client.get(`${API}/balance`)).body,
        (await alice.client.get(`${API}/balance/transactions`)).body,
        (await alice.client.get(`${API}/balance/top-ups`)).body,
        (await alice.client.get(`${API}/balance/refunds`)).body,
      ]);

      expect(serialized).not.toMatch(/cs_fake_|pi_fake_|sk_|whsec_/);
      expect(serialized).not.toMatch(/providerSessionId|providerPaymentId|checkoutUrl/);
    });

    it('returns a checkout URL once, and never stores or logs it', async () => {
      // §92: short-lived and sensitive.
      const created = await createTopUp(alice.client, '2000');
      const checkoutUrl = created.body.checkoutUrl as string;
      expect(checkoutUrl).toMatch(/^https:\/\//);

      const stored = serialize([
        await context.adminDb.balanceTopUp.findMany(),
        await context.adminDb.auditEvent.findMany(),
        await context.adminDb.processingJob.findMany(),
      ]);
      expect(stored).not.toContain(checkoutUrl);

      // And reading the top-up back does not hand it out again.
      const read = await alice.client.get(`${API}/balance/top-ups/${created.body.topUp.id}`);
      expect(JSON.stringify(read.body)).not.toContain(checkoutUrl);
    });

    it('keeps no provider payload, only its digest', async () => {
      // §81: proof of what arrived, without keeping what arrived.
      await fundBalance(context, alice.client, '2000');

      const events = await context.adminDb.paymentProviderEvent.findMany();
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(serialize(events)).not.toMatch(/rawBody|signature|\bpayload\b/i);
    });
  });
});
