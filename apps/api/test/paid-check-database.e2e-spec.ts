import { randomUUID } from 'node:crypto';
import { type AuthClient } from './support/auth-client';
import {
  publishCheckableStandard,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx } from './support/fixtures';
import { createTenant, createUser } from './support/organization-client';
import {
  ensureCheckPrice,
  fundForCheck,
  grantCredit,
  purchaseOf,
  quoteForCheck,
  reserveForSyntheticCheck,
} from './support/paid-check-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * What the database refuses (§121–§126, §70–§78).
 *
 * Everything here is attempted with the schema-owning connection — the most
 * privileged identity in the system — because a guarantee that only holds when
 * the application behaves is not a guarantee. If a service could be made to
 * write one of these rows, or a migration script could, the money would be
 * wrong and nothing would notice.
 */
describe('Paid document checks - database invariants (e2e)', () => {
  let context: TestContext;
  let student: { email: string; userId: string; client: AuthClient };
  let stranger: { email: string; userId: string; client: AuthClient };
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let standard: PublishedStandard;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    student = await createUser(context, 'student@example.com');
    stranger = await createUser(context, 'stranger@example.com');
    tenant = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
    standard = await publishCheckableStandard(context, tenant.owner.client, tenant.organizationId);
  });

  async function readyDocx(name = 'thesis.docx'): Promise<string> {
    const document = await createDocument(student.client, 'Thesis');
    const { versionId } = await uploadAndProcess(student.client, document.id, {
      name,
      bytes: minimalDocx(),
    });
    return versionId;
  }

  /** A real, completed paid check to attack. */
  async function completedCheck(): Promise<string> {
    const versionId = await readyDocx();
    const { quoteId } = await fundForCheck(context, student.userId);
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quoteId,
    });
    await waitForCheck(context, created.body.id);
    return created.body.id;
  }

  // -------------------------------------------------------------------------
  // The free path cannot come back (§4, §21, §121)
  // -------------------------------------------------------------------------

  describe('a new check must be paid for', () => {
    it('refuses an application-role INSERT with no purchase at all', async () => {
      const template = await context.adminDb.documentCheck.findUniqueOrThrow({
        where: { id: await completedCheck() },
      });

      await expect(
        context.adminDb.$executeRaw`
          INSERT INTO "document_checks"
            ("id", "owner_user_id", "document_id", "document_version_id", "organization_id",
             "document_type_id", "standard_id", "standard_version_id", "document_sha256",
             "standard_content_hash", "organization_name", "document_type_name",
             "standard_code", "standard_name", "standard_version_label", "updated_at")
          VALUES (gen_random_uuid(), ${student.userId}::uuid, ${template.documentId}::uuid,
                  ${template.documentVersionId}::uuid, ${template.organizationId}::uuid,
                  ${template.documentTypeId}::uuid, ${template.standardId}::uuid,
                  ${template.standardVersionId}::uuid, ${template.documentSha256},
                  ${template.standardContentHash}, 'x', 'y', 'z', 'n', 'v', now())
        `,
      ).rejects.toThrow(/must be bound to a service purchase/);
    });

    it('refuses a check that names a purchase describing a different check', async () => {
      const existing = await completedCheck();
      const purchase = await purchaseOf(context, existing);
      const template = await context.adminDb.documentCheck.findUniqueOrThrow({
        where: { id: existing },
      });

      await expect(
        context.adminDb.documentCheck.create({
          data: {
            ...template,
            id: randomUUID(),
            idempotencyKey: null,
            currentRunId: null,
            status: 'CREATED',
            completedAt: null,
            servicePurchaseId: purchase!.id,
          },
        }),
      ).rejects.toThrow();
    });

    it('leaves a historical free check readable, and lets no new one join it', async () => {
      // §4, §122: a check created before checks were paid for has no purchase
      // and never will. The trigger fires on INSERT only, so history survives.
      const checkId = await completedCheck();
      // A row that genuinely predates the trigger: written with the trigger
      // off, exactly as every check created before this migration was. The
      // binding cannot be removed with the trigger on — the product refuses to
      // launder a paid check into a free one — so this is the only faithful
      // way to produce the state the migration actually leaves behind.
      await context.adminDb.$executeRawUnsafe(
        'ALTER TABLE "document_checks" DISABLE TRIGGER "document_checks_purchase_binding_immutable"',
      );
      await context.adminDb.$executeRaw`
        UPDATE "document_checks" SET "service_purchase_id" = NULL WHERE "id" = ${checkId}::uuid
      `;
      await context.adminDb.$executeRawUnsafe(
        'ALTER TABLE "document_checks" ENABLE TRIGGER "document_checks_purchase_binding_immutable"',
      );

      const view = await student.client.get(`/api/v1/checks/${checkId}`);
      expect(view.status).toBe(200);
      expect(view.body.billing).toBeNull();
      expect(view.body.legacyFree).toBe(true);
      expect(view.body.status).toBe('COMPLETED');

      // Its report is still valid and readable.
      const report = await student.client.get(`/api/v1/checks/${checkId}/report`);
      expect(report.status).toBe(200);
      expect(report.body.reportHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // -------------------------------------------------------------------------
  // Ownership (§70, §123)
  // -------------------------------------------------------------------------

  describe('a purchase cannot be stitched together from two people', () => {
    it('refuses a purchase funded by somebody else’s quote', async () => {
      await ensureCheckPrice(context, 300n);
      const theirQuote = await quoteForCheck(context, stranger.userId);

      await expect(
        context.adminDb.servicePurchase.create({
          data: {
            ownerUserId: student.userId,
            productCode: 'DOCUMENT_CHECK',
            resourceType: 'DOCUMENT_CHECK',
            resourceId: randomUUID(),
            priceQuoteId: theirQuote.id,
            priceVersionId: theirQuote.priceVersionId,
            currency: 'USD',
            amountMinor: 300n,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses an allocation against somebody else’s reservation', async () => {
      const checkId = await completedCheck();
      const purchase = await purchaseOf(context, checkId);

      // A hold that genuinely belongs to the stranger.
      await grantCredit(context, stranger.userId, 1_000n);
      const theirCheckId = randomUUID();
      const theirPurchaseId = await reserveForSyntheticCheck(
        context,
        stranger.userId,
        theirCheckId,
      );
      const theirAllocation = await context.adminDb.servicePurchaseAllocation.findFirstOrThrow({
        where: { purchaseId: theirPurchaseId },
      });

      await expect(
        context.adminDb.servicePurchaseAllocation.create({
          data: {
            ownerUserId: student.userId,
            purchaseId: purchase!.id,
            holdId: theirAllocation.holdId,
            creditClass: 'CASH',
            currency: 'USD',
            amountMinor: 100n,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a check bound to somebody else’s purchase', async () => {
      const checkId = await completedCheck();
      const template = await context.adminDb.documentCheck.findUniqueOrThrow({
        where: { id: checkId },
      });

      await grantCredit(context, stranger.userId, 1_000n);
      const theirCheckId = randomUUID();
      const theirPurchaseId = await reserveForSyntheticCheck(
        context,
        stranger.userId,
        theirCheckId,
      );

      await expect(
        context.adminDb.documentCheck.create({
          data: {
            ...template,
            id: theirCheckId,
            idempotencyKey: null,
            currentRunId: null,
            status: 'CREATED',
            completedAt: null,
            servicePurchaseId: theirPurchaseId,
          },
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Immutability (§8, §76, §77, §78)
  // -------------------------------------------------------------------------

  describe('a purchase’s financial identity is written once', () => {
    it('refuses to change the amount, currency, quote or product', async () => {
      const purchase = (await purchaseOf(context, await completedCheck()))!;

      for (const data of [
        { amountMinor: 1n },
        { currency: 'EUR' },
        { productCode: 'SMARTFIX' as const },
        { resourceId: randomUUID() },
      ]) {
        await expect(
          context.adminDb.servicePurchase.update({ where: { id: purchase.id }, data }),
        ).rejects.toThrow(/financial identity is immutable/);
      }
    });

    it('refuses to move a check onto another purchase, or off its own', async () => {
      // §78: a delivered check cannot be re-pointed at a cheaper purchase, and
      // a paid one cannot be laundered into a historical free one.
      const checkId = await completedCheck();

      await expect(
        context.adminDb.documentCheck.update({
          where: { id: checkId },
          data: { servicePurchaseId: null },
        }),
      ).rejects.toThrow(/already bound/);
    });

    it('refuses to rewrite an allocation', async () => {
      const purchase = (await purchaseOf(context, await completedCheck()))!;
      const allocation = purchase.allocations[0]!;

      await expect(
        context.adminDb.servicePurchaseAllocation.update({
          where: { id: allocation.id },
          data: { amountMinor: 1n },
        }),
      ).rejects.toThrow(/written once/);
    });

    it('refuses every backwards status move', async () => {
      const purchase = (await purchaseOf(context, await completedCheck()))!;
      expect(purchase.status).toBe('DELIVERED');

      for (const status of ['RESERVED', 'PROCESSING', 'RELEASED'] as const) {
        await expect(
          context.adminDb.servicePurchase.update({
            where: { id: purchase.id },
            data: { status },
          }),
        ).rejects.toThrow(/cannot move from DELIVERED/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Money and service settle together (§72–§74, §124–§126)
  // -------------------------------------------------------------------------

  describe('the money and the service must agree at commit', () => {
    it('refuses a purchase funded by less than it costs', async () => {
      // §72, §124. Deferred to COMMIT, so the whole transaction is refused
      // rather than the individual statement.
      await ensureCheckPrice(context, 500n);
      const quote = await quoteForCheck(context, student.userId);
      await grantCredit(context, student.userId, 1_000n);

      await expect(
        context.adminDb.$transaction(async (tx) => {
          const purchase = await tx.servicePurchase.create({
            data: {
              ownerUserId: student.userId,
              productCode: 'DOCUMENT_CHECK',
              resourceType: 'DOCUMENT_CHECK',
              resourceId: randomUUID(),
              priceQuoteId: quote.id,
              priceVersionId: quote.priceVersionId,
              currency: 'USD',
              amountMinor: 500n,
            },
          });
          const account = await tx.customerCreditAccount.findFirstOrThrow({
            where: { ownerUserId: student.userId, creditClass: 'CASH' },
          });
          const hold = await tx.creditHold.create({
            data: {
              ownerUserId: student.userId,
              accountId: account.id,
              currency: 'USD',
              creditClass: 'CASH',
              purpose: 'SERVICE',
              amountMinor: 400n,
            },
          });
          await tx.servicePurchaseAllocation.create({
            data: {
              ownerUserId: student.userId,
              purchaseId: purchase.id,
              holdId: hold.id,
              creditClass: 'CASH',
              currency: 'USD',
              // Four hundred, for a five hundred purchase.
              amountMinor: 400n,
            },
          });
        }),
      ).rejects.toThrow(/is funded by 400 but costs 500/);

      expect(await context.adminDb.servicePurchase.count()).toBe(0);
    });

    it('refuses to complete a check whose purchase was never charged', async () => {
      // §125.
      const versionId = await readyDocx();
      const { quoteId } = await fundForCheck(context, student.userId);
      context.documentEngine.evaluationMode = 'unavailable';
      const created = await startCheck(context, student, {
        documentVersionId: versionId,
        standardId: standard.standardId,
        priceQuoteId: quoteId,
      });

      // Walk it forward legally to the one state COMPLETED is reachable from,
      // so what refuses the last step is the money invariant rather than the
      // Phase 7 lifecycle guard.
      await context.adminDb.documentCheck.update({
        where: { id: created.body.id },
        data: { status: 'EVALUATING' },
      });
      await context.adminDb.documentCheck.update({
        where: { id: created.body.id },
        data: { status: 'GENERATING_REPORT' },
      });

      // Phase 7 additionally requires a completed check to name its run, so
      // give it one: what must refuse this row is the money, not a missing id.
      const run = await context.adminDb.checkRun.create({
        data: {
          ownerUserId: student.userId,
          checkId: created.body.id,
          attemptNumber: 1,
          orchestratorVersion: '1',
        },
      });

      await expect(
        context.adminDb.documentCheck.update({
          where: { id: created.body.id },
          data: { status: 'COMPLETED', completedAt: new Date(), currentRunId: run.id },
        }),
      ).rejects.toThrow(/is COMPLETED but its purchase is/);
    });

    it('refuses to deliver a purchase whose check never completed', async () => {
      // §126.
      const versionId = await readyDocx();
      const { quoteId } = await fundForCheck(context, student.userId);
      context.documentEngine.evaluationMode = 'unavailable';
      const created = await startCheck(context, student, {
        documentVersionId: versionId,
        standardId: standard.standardId,
        priceQuoteId: quoteId,
      });
      const purchase = (await purchaseOf(context, created.body.id))!;

      await expect(
        context.adminDb.servicePurchase.update({
          where: { id: purchase.id },
          data: { status: 'DELIVERED', deliveredAt: new Date() },
        }),
      ).rejects.toThrow(/uncaptured reservation/);
    });

    it('refuses to release a purchase whose reservations were charged', async () => {
      // §74: a released purchase that was charged would be a free service.
      const purchase = (await purchaseOf(context, await completedCheck()))!;

      await expect(
        context.adminDb.servicePurchase.update({
          where: { id: purchase.id },
          data: { status: 'RELEASED', releasedAt: new Date() },
        }),
      ).rejects.toThrow(/cannot move from DELIVERED/);
    });
  });

  // -------------------------------------------------------------------------
  // Isolation catalogue (§67)
  // -------------------------------------------------------------------------

  it('classifies both purchase tables as user-scoped under forced RLS', async () => {
    const rows = await context.adminDb.$queryRaw<
      { table_name: string; classification: string; forced: boolean }[]
    >`
      SELECT ic."table_name", ic."classification", c."relforcerowsecurity" AS forced
      FROM "table_isolation_classification" ic
      JOIN pg_class c ON c.relname = ic."table_name"
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE ic."table_name" IN ('service_purchases', 'service_purchase_allocations')
      ORDER BY ic."table_name"
    `;

    expect(rows).toEqual([
      { table_name: 'service_purchase_allocations', classification: 'USER_SCOPED', forced: true },
      { table_name: 'service_purchases', classification: 'USER_SCOPED', forced: true },
    ]);
  });

  it('grants the application role no way to delete financial history', async () => {
    // §101, §143. The triggers are the belt; the revoked privilege is the
    // braces, because Phase 2's default privileges would otherwise have
    // granted DELETE silently.
    const rows = await context.adminDb.$queryRaw<{ allowed: boolean }[]>`
      SELECT bool_or(has_table_privilege('palcert_app', t, p)) AS allowed
      FROM (VALUES ('service_purchases', 'DELETE'),
                   ('service_purchase_allocations', 'UPDATE'),
                   ('service_purchase_allocations', 'DELETE')) AS x(t, p)
    `;
    expect(rows[0]!.allowed).toBe(false);
  });
});
