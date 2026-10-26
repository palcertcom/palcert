import { fundBalance, ledgerTotal } from './support/finance-client';
import { createUser } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * The guarantees the database keeps, whatever the application does (§164, §102).
 *
 * Application-only immutability is a convention, and a convention is what a
 * future refactor quietly breaks. Everything below is asserted against the
 * database directly — through the schema-owning connection, which is the most
 * privileged access PalCert has — so a passing test means the guarantee holds
 * even for code that has not been written yet.
 */
describe('Financial database invariants (e2e)', () => {
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

  describe('the ledger is append-only (§12, §129)', () => {
    it('refuses an UPDATE, even from the owning role', async () => {
      await fundBalance(context, customer.client, '2000');
      const entry = await context.adminDb.creditLedgerEntry.findFirstOrThrow();

      await expect(
        context.adminDb.creditLedgerEntry.update({
          where: { id: entry.id },
          data: { amountMinorSigned: 999999n },
        }),
      ).rejects.toThrow(/append-only/);

      const unchanged = await context.adminDb.creditLedgerEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      expect(unchanged.amountMinorSigned).toBe(2000n);
    });

    it('refuses a DELETE, even from the owning role', async () => {
      await fundBalance(context, customer.client, '2000');
      const entry = await context.adminDb.creditLedgerEntry.findFirstOrThrow();

      await expect(
        context.adminDb.creditLedgerEntry.delete({ where: { id: entry.id } }),
      ).rejects.toThrow(/append-only/);

      expect(await ledgerTotal(context, customer.userId)).toBe(2000n);
    });

    it('refuses a raw SQL UPDATE too', async () => {
      // Not just the ORM: a trigger, so a hand-written query is refused as
      // well. This is the version an incident-response script would hit.
      await fundBalance(context, customer.client, '2000');

      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE "credit_ledger_entries" SET "amount_minor_signed" = 1`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('grants the application role no UPDATE or DELETE at all', async () => {
      // Belt and braces: the trigger is the guarantee, and the missing grant
      // means the application could not even attempt it (§151).
      const grants = await context.adminDb.$queryRaw<{ privilege_type: string }[]>`
        SELECT "privilege_type"
        FROM information_schema.table_privileges
        WHERE table_name = 'credit_ledger_entries' AND grantee = 'palcert_app'
      `;
      const kinds = grants.map((grant) => grant.privilege_type).sort();
      expect(kinds).toEqual(['INSERT', 'SELECT']);
    });
  });

  describe('values that cannot be stored (§100)', () => {
    async function account(): Promise<{ id: string }> {
      await fundBalance(context, customer.client, '2000');
      return context.adminDb.customerCreditAccount.findFirstOrThrow({
        where: { ownerUserId: customer.userId },
      });
    }

    it('refuses a zero-amount entry', async () => {
      const acct = await account();
      await expect(
        context.adminDb.creditLedgerEntry.create({
          data: {
            ownerUserId: customer.userId,
            accountId: acct.id,
            currency: 'USD',
            creditClass: 'CASH',
            entryType: 'ADMIN_CREDIT',
            amountMinorSigned: 0n,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses an entry whose sign contradicts its type', async () => {
      // A positive SERVICE_CHARGE would hand the customer money.
      const acct = await account();
      await expect(
        context.adminDb.creditLedgerEntry.create({
          data: {
            ownerUserId: customer.userId,
            accountId: acct.id,
            currency: 'USD',
            creditClass: 'CASH',
            entryType: 'SERVICE_CHARGE',
            amountMinorSigned: 300n,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses promotional credit into a cash account', async () => {
      // §9: what makes "promotional credit is never withdrawable" structural.
      const acct = await account();
      await expect(
        context.adminDb.creditLedgerEntry.create({
          data: {
            ownerUserId: customer.userId,
            accountId: acct.id,
            currency: 'USD',
            creditClass: 'CASH',
            entryType: 'PROMOTIONAL_CREDIT',
            amountMinorSigned: 500n,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a provider refund debit against promotional credit', async () => {
      // §70: the other half of the same guarantee.
      const promotional = await context.adminDb.customerCreditAccount.create({
        data: { ownerUserId: customer.userId, currency: 'USD', creditClass: 'PROMOTIONAL' },
      });
      await expect(
        context.adminDb.creditLedgerEntry.create({
          data: {
            ownerUserId: customer.userId,
            accountId: promotional.id,
            currency: 'USD',
            creditClass: 'PROMOTIONAL',
            entryType: 'PAYMENT_REFUND_DEBIT',
            amountMinorSigned: -100n,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses an entry whose currency disagrees with its account', async () => {
      const acct = await account();
      await expect(
        context.adminDb.creditLedgerEntry.create({
          data: {
            ownerUserId: customer.userId,
            accountId: acct.id,
            currency: 'EUR',
            creditClass: 'CASH',
            entryType: 'ADMIN_CREDIT',
            amountMinorSigned: 500n,
          },
        }),
      ).rejects.toThrow(/does not match account/);
    });

    it('refuses a reversal that moves the same way as the entry it corrects', async () => {
      // §13: a "reversal" that added money to a credit would be a second gift.
      await fundBalance(context, customer.client, '2000');
      const original = await context.adminDb.creditLedgerEntry.findFirstOrThrow();

      await expect(
        context.adminDb.creditLedgerEntry.create({
          data: {
            ownerUserId: customer.userId,
            accountId: original.accountId,
            currency: 'USD',
            creditClass: 'CASH',
            entryType: 'ADMIN_CREDIT',
            amountMinorSigned: 500n,
            reversalOfEntryId: original.id,
          },
        }),
      ).rejects.toThrow(/opposite direction/);
    });

    it('refuses a non-positive hold', async () => {
      const acct = await account();
      for (const amount of [0n, -100n]) {
        await expect(
          context.adminDb.creditHold.create({
            data: {
              ownerUserId: customer.userId,
              accountId: acct.id,
              currency: 'USD',
              creditClass: 'CASH',
              purpose: 'SERVICE',
              amountMinor: amount,
            },
          }),
        ).rejects.toThrow();
      }
    });
  });

  describe('lifecycles that cannot be reversed (§101, §102)', () => {
    it('refuses to un-capture a hold', async () => {
      await fundBalance(context, customer.client, '2000');
      const acct = await context.adminDb.customerCreditAccount.findFirstOrThrow();
      const entry = await context.adminDb.creditLedgerEntry.create({
        data: {
          ownerUserId: customer.userId,
          accountId: acct.id,
          currency: 'USD',
          creditClass: 'CASH',
          entryType: 'SERVICE_CHARGE',
          amountMinorSigned: -300n,
        },
      });
      const hold = await context.adminDb.creditHold.create({
        data: {
          ownerUserId: customer.userId,
          accountId: acct.id,
          currency: 'USD',
          creditClass: 'CASH',
          purpose: 'SERVICE',
          amountMinor: 300n,
          status: 'CAPTURED',
          capturedAt: new Date(),
          capturedEntryId: entry.id,
        },
      });

      await expect(
        context.adminDb.creditHold.update({
          where: { id: hold.id },
          data: {
            status: 'RELEASED',
            releasedAt: new Date(),
            capturedAt: null,
            capturedEntryId: null,
          },
        }),
      ).rejects.toThrow(/already CAPTURED/);
    });

    it('refuses to move a hold to another account or amount', async () => {
      await fundBalance(context, customer.client, '2000');
      const acct = await context.adminDb.customerCreditAccount.findFirstOrThrow();
      const hold = await context.adminDb.creditHold.create({
        data: {
          ownerUserId: customer.userId,
          accountId: acct.id,
          currency: 'USD',
          creditClass: 'CASH',
          purpose: 'SERVICE',
          amountMinor: 300n,
        },
      });

      await expect(
        context.adminDb.creditHold.update({
          where: { id: hold.id },
          data: { amountMinor: 1900n },
        }),
      ).rejects.toThrow(/identity is immutable/);
    });

    it('refuses to change a top-up’s amount or currency', async () => {
      await fundBalance(context, customer.client, '2000');
      const topUp = await context.adminDb.balanceTopUp.findFirstOrThrow();

      await expect(
        context.adminDb.balanceTopUp.update({
          where: { id: topUp.id },
          data: { amountMinor: 999999n },
        }),
      ).rejects.toThrow(/financial identity is immutable/);
      await expect(
        context.adminDb.balanceTopUp.update({ where: { id: topUp.id }, data: { currency: 'EUR' } }),
      ).rejects.toThrow(/financial identity is immutable/);
    });

    it('refuses to un-succeed a top-up', async () => {
      // §125: a late "failed" event must never take credit away.
      await fundBalance(context, customer.client, '2000');
      const topUp = await context.adminDb.balanceTopUp.findFirstOrThrow();

      await expect(
        context.adminDb.balanceTopUp.update({
          where: { id: topUp.id },
          data: { status: 'FAILED' },
        }),
      ).rejects.toThrow(/has succeeded/);
    });

    it('refuses to rebind a credited top-up to a different ledger entry', async () => {
      // The last line of defence behind the webhook/reconciliation race.
      await fundBalance(context, customer.client, '2000');
      const topUp = await context.adminDb.balanceTopUp.findFirstOrThrow();
      const acct = await context.adminDb.customerCreditAccount.findFirstOrThrow();
      const other = await context.adminDb.creditLedgerEntry.create({
        data: {
          ownerUserId: customer.userId,
          accountId: acct.id,
          currency: 'USD',
          creditClass: 'CASH',
          entryType: 'ADMIN_CREDIT',
          amountMinorSigned: 1n,
        },
      });

      await expect(
        context.adminDb.balanceTopUp.update({
          where: { id: topUp.id },
          data: { creditEntryId: other.id },
        }),
      ).rejects.toThrow(/already been credited/);
    });

    it('refuses to bind one provider payment to two top-ups (§103)', async () => {
      const { paymentId } = await fundBalance(context, customer.client, '2000');
      const second = await context.adminDb.balanceTopUp.create({
        data: {
          ownerUserId: customer.userId,
          currency: 'USD',
          amountMinor: 500n,
          provider: 'fake',
          status: 'PENDING',
        },
      });

      await expect(
        context.adminDb.balanceTopUp.update({
          where: { id: second.id },
          data: { providerPaymentId: paymentId },
        }),
      ).rejects.toThrow();
    });
  });

  describe('an entry cannot be attached to somebody else (§164)', () => {
    it('refuses an entry whose owner is not the account’s owner', async () => {
      // The composite foreign key is what makes this impossible rather than
      // merely wrong: there is no (ownerUserId, accountId) pair to point at.
      await fundBalance(context, customer.client, '2000');
      const acct = await context.adminDb.customerCreditAccount.findFirstOrThrow({
        where: { ownerUserId: customer.userId },
      });
      const stranger = await createUser(context, 'stranger@example.com');

      await expect(
        context.adminDb.$executeRaw`
          INSERT INTO "credit_ledger_entries"
            ("id", "owner_user_id", "account_id", "currency", "credit_class",
             "entry_type", "amount_minor_signed")
          VALUES (gen_random_uuid(), ${stranger.userId}::uuid, ${acct.id}::uuid,
                  'USD', 'CASH', 'ADMIN_CREDIT', 100)
        `,
      ).rejects.toThrow();

      expect(
        await context.adminDb.creditLedgerEntry.count({
          where: { ownerUserId: stranger.userId },
        }),
      ).toBe(0);
    });

    it('refuses a hold taken against somebody else’s account', async () => {
      await fundBalance(context, customer.client, '2000');
      const acct = await context.adminDb.customerCreditAccount.findFirstOrThrow({
        where: { ownerUserId: customer.userId },
      });
      const stranger = await createUser(context, 'stranger2@example.com');

      await expect(
        context.adminDb.$executeRaw`
          INSERT INTO "credit_holds"
            ("id", "owner_user_id", "account_id", "currency", "credit_class",
             "purpose", "amount_minor")
          VALUES (gen_random_uuid(), ${stranger.userId}::uuid, ${acct.id}::uuid,
                  'USD', 'CASH', 'SERVICE', 100)
        `,
      ).rejects.toThrow();
    });
  });

  describe('an active price is immutable in the database, not just the service (§164)', () => {
    /** An in-force price, created directly so this proves the DDL, not a service. */
    async function activePrice() {
      return context.adminDb.priceVersion.create({
        data: {
          productCode: 'DOCUMENT_CHECK',
          currency: 'USD',
          marketCode: 'GLOBAL',
          amountMinor: 100n,
          status: 'ACTIVE',
          activatedAt: new Date(),
        },
      });
    }

    it('refuses to change an active price’s amount from raw SQL', async () => {
      const active = await activePrice();

      await expect(
        context.adminDb.$executeRaw`
          UPDATE "price_versions" SET "amount_minor" = 1 WHERE "id" = ${active.id}::uuid
        `,
      ).rejects.toThrow(/ACTIVE/);

      const unchanged = await context.adminDb.priceVersion.findUniqueOrThrow({
        where: { id: active.id },
      });
      expect(unchanged.amountMinor).toBe(active.amountMinor);
    });

    it('refuses a second active price for the same product, currency and market', async () => {
      const active = await activePrice();

      await expect(
        context.adminDb.priceVersion.create({
          data: {
            productCode: active.productCode,
            currency: active.currency,
            marketCode: active.marketCode,
            amountMinor: 999n,
            status: 'ACTIVE',
            activatedAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('provider events (§51, §102)', () => {
    it('refuses a duplicate provider event id', async () => {
      await fundBalance(context, customer.client, '2000');
      const event = await context.adminDb.paymentProviderEvent.findFirstOrThrow();

      await expect(
        context.adminDb.paymentProviderEvent.create({
          data: {
            provider: event.provider,
            providerEventId: event.providerEventId,
            providerEventType: 'x.y',
            eventKind: 'PAYMENT_SUCCEEDED',
            objectKind: 'TOP_UP',
            payloadSha256: 'a'.repeat(64),
            occurredAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses to rewrite what a provider said', async () => {
      await fundBalance(context, customer.client, '2000');
      const event = await context.adminDb.paymentProviderEvent.findFirstOrThrow();

      await expect(
        context.adminDb.paymentProviderEvent.update({
          where: { id: event.id },
          data: { payloadSha256: 'b'.repeat(64) },
        }),
      ).rejects.toThrow(/receipt and cannot be rewritten/);
    });
  });

  describe('isolation catalogue (§147, §148)', () => {
    it('classifies every finance table', async () => {
      const rows = await context.adminDb.$queryRaw<
        { table_name: string; classification: string; tenant_column: string | null }[]
      >`
        SELECT "table_name", "classification", "tenant_column"
        FROM "table_isolation_classification"
        WHERE "table_name" IN (
          'customer_credit_accounts', 'credit_ledger_entries', 'credit_holds',
          'price_quotes', 'balance_topups', 'payment_refunds', 'payment_disputes',
          'service_products', 'price_versions', 'payment_provider_events'
        )
        ORDER BY "table_name"
      `;
      expect(rows).toHaveLength(10);

      // Compared wholesale so a wrong classification names itself in the diff.
      // Customer money is the person's, exactly like a document (§97); pricing
      // is PalCert's, and a provider event is an external system's (§98).
      const actual = Object.fromEntries(
        rows.map((row) => [row.table_name, `${row.classification}:${row.tenant_column ?? '-'}`]),
      );
      expect(actual).toEqual({
        customer_credit_accounts: 'USER_SCOPED:owner_user_id',
        credit_ledger_entries: 'USER_SCOPED:owner_user_id',
        credit_holds: 'USER_SCOPED:owner_user_id',
        price_quotes: 'USER_SCOPED:owner_user_id',
        balance_topups: 'USER_SCOPED:owner_user_id',
        payment_refunds: 'USER_SCOPED:owner_user_id',
        payment_disputes: 'USER_SCOPED:owner_user_id',
        service_products: 'SYSTEM:-',
        price_versions: 'SYSTEM:-',
        payment_provider_events: 'SYSTEM:-',
      });
    });

    it('forces row-level security on every user-scoped finance table', async () => {
      const rows = await context.adminDb.$queryRaw<
        { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`
        SELECT c."relname", c."relrowsecurity", c."relforcerowsecurity"
        FROM pg_class c
        JOIN pg_namespace n ON n."oid" = c."relnamespace"
        WHERE n."nspname" = 'public'
          AND c."relname" IN (
            'customer_credit_accounts', 'credit_ledger_entries', 'credit_holds',
            'price_quotes', 'balance_topups', 'payment_refunds', 'payment_disputes'
          )
      `;
      expect(rows).toHaveLength(7);
      // FORCE matters as much as ENABLE: without it the table owner bypasses
      // its own policies, and the owner is who migrations run as.
      const unprotected = rows
        .filter((row) => !row.relrowsecurity || !row.relforcerowsecurity)
        .map((row) => row.relname);
      expect(unprotected).toEqual([]);
    });
  });
});
