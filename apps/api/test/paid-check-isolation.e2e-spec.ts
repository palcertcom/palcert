import { API, type AuthClient } from './support/auth-client';
import {
  publishCheckableStandard,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx } from './support/fixtures';
import { createTenant, createUser, signInGlobalRole } from './support/organization-client';
import { fundForCheck, purchaseOf } from './support/paid-check-client';
import { TenantPrismaService } from '../src/infrastructure/tenant/tenant-prisma.service';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Who may see what a check cost (§67–§69, §129–§131).
 *
 * Two boundaries, and the second is the one that would be easy to get wrong.
 *
 * A customer's purchase is theirs, like their documents and their balance. And
 * the **institution whose standard was checked against** gets nothing at all:
 * not the price, not the balance, not whether the check was charged. All
 * document-check revenue is PalCert's (§2), and an institution that could see
 * a student's spending would learn who checked against its standard — which
 * Phase 7 spent a whole phase making impossible.
 */
describe('Paid document checks - isolation (e2e)', () => {
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

  async function paidCheck(): Promise<string> {
    const document = await createDocument(student.client, 'Thesis');
    const { versionId } = await uploadAndProcess(student.client, document.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
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
  // Another customer (§68)
  // -------------------------------------------------------------------------

  it('shows one customer nothing of another’s purchase, with the real ids', async () => {
    const checkId = await paidCheck();
    const purchase = await purchaseOf(context, checkId);

    // The check itself, by its genuine id.
    const check = await stranger.client.get(`${API}/checks/${checkId}`);
    expect(check.status).toBe(404);
    expect(check.body.error.code).toBe('CHECK_NOT_FOUND');

    // And the cancel route, which moves money.
    const cancel = await stranger.client.post(`${API}/checks/${checkId}/cancel`, {});
    expect(cancel.status).toBe(404);

    // The purchase row is invisible to their connection, not merely filtered.
    const visible = await context.app
      .get(TenantPrismaService)
      .withUser(stranger.userId, (tx) =>
        tx.servicePurchase.findUnique({ where: { id: purchase!.id } }),
      );
    expect(visible).toBeNull();

    const allocations = await context.app
      .get(TenantPrismaService)
      .withUser(stranger.userId, (tx) =>
        tx.servicePurchaseAllocation.findMany({ where: { purchaseId: purchase!.id } }),
      );
    expect(allocations).toEqual([]);
  });

  it('lets a customer see their own billing and no one else’s', async () => {
    const checkId = await paidCheck();

    const mine = await student.client.get(`${API}/checks`);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].billing.status).toBe('DELIVERED');

    const theirs = await stranger.client.get(`${API}/checks`);
    expect(theirs.body.items).toEqual([]);
    expect(JSON.stringify(theirs.body)).not.toContain(checkId);
  });

  // -------------------------------------------------------------------------
  // The institution (§69, §129)
  // -------------------------------------------------------------------------

  it('tells the organization whose standard was used absolutely nothing about the money', async () => {
    const checkId = await paidCheck();
    const purchase = await purchaseOf(context, checkId);

    // Routes that would name the student's money at all are refused outright.
    for (const path of [
      `${API}/checks/${checkId}`,
      `${API}/admin/finance/customers/${student.userId}/purchases`,
      `${API}/admin/finance/customers/${student.userId}/balance`,
      `${API}/admin/finance/customers/${student.userId}/payments`,
    ]) {
      const response = await tenant.owner.client.get(path);
      expect([403, 404]).toContain(response.status);
    }

    // The organization owner is also a person with a PalCert Balance of their
    // own, so these answer — about them, and about nobody else.
    const ownBalance = await tenant.owner.client.get(`${API}/balance`);
    expect(ownBalance.status).toBe(200);
    expect(ownBalance.body.available.minorUnits).toBe('0');

    const ownChecks = await tenant.owner.client.get(`${API}/checks`);
    expect(ownChecks.body.items).toEqual([]);
    expect(JSON.stringify(ownChecks.body)).not.toContain(checkId);

    const ownTransactions = await tenant.owner.client.get(`${API}/balance/transactions`);
    expect(ownTransactions.body.items).toEqual([]);

    // Nothing about the check reaches the organization's own view of its
    // standard either — no counter, no revenue, no purchase.
    const standardView = await tenant.owner.client.get(
      `${API}/organizations/${tenant.organizationId}/standards/${standard.standardId}`,
    );
    const body = JSON.stringify(standardView.body);
    expect(body).not.toContain(purchase!.id);
    expect(body).not.toMatch(/revenue|earning|payout|amountMinor|purchase/i);
  });

  it('gives no organization role any purchase permission at all', async () => {
    // Proven against the catalogue rather than the routes, so a future role
    // that quietly acquired one would be caught here (§69).
    const rows = await context.adminDb.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM "role_permissions" rp
      JOIN "roles" r ON r."id" = rp."role_id"
      JOIN "permissions" p ON p."id" = rp."permission_id"
      WHERE r."scope" = 'ORGANIZATION'
        AND (p."code" LIKE 'finance:%' OR p."code" LIKE 'pricing:%' OR p."code" LIKE 'balance:%')
    `;
    expect(rows[0]!.count).toBe(0n);
  });

  // -------------------------------------------------------------------------
  // PalCert staff (§130, §131)
  // -------------------------------------------------------------------------

  it('lets finance read a customer’s purchases, with the funding breakdown', async () => {
    const checkId = await paidCheck();
    const finance = await signInGlobalRole(context, 'finance@example.com', 'PALCERT_FINANCE');

    const purchases = await finance.get(
      `${API}/admin/finance/customers/${student.userId}/purchases`,
    );
    expect(purchases.status).toBe(200);
    expect(purchases.body).toHaveLength(1);
    expect(purchases.body[0]).toMatchObject({
      productCode: 'DOCUMENT_CHECK',
      resourceType: 'DOCUMENT_CHECK',
      resourceId: checkId,
      status: 'DELIVERED',
      charged: { currency: 'USD', minorUnits: '300' },
    });
    expect(purchases.body[0].allocations).toEqual([
      {
        creditClass: 'CASH',
        amount: { currency: 'USD', minorUnits: '300' },
        holdStatus: 'CAPTURED',
      },
    ]);
  });

  it('lets support read a purchase and change nothing', async () => {
    // §130: support answers "was I charged for that check?" and has none of
    // the authority to change the answer.
    await paidCheck();
    const support = await signInGlobalRole(context, 'support@example.com', 'PALCERT_SUPPORT');

    const purchases = await support.get(
      `${API}/admin/finance/customers/${student.userId}/purchases`,
    );
    expect(purchases.status).toBe(200);

    for (const [path, body] of [
      [
        `${API}/admin/finance/adjustments`,
        {
          ownerUserId: student.userId,
          currency: 'USD',
          creditClass: 'CASH',
          amountMinorUnits: '100',
          reasonCode: 'GOODWILL',
        },
      ],
      [
        `${API}/admin/finance/refunds`,
        { topUpId: student.userId, amountMinorUnits: '100', reason: 'REQUESTED_BY_CUSTOMER' },
      ],
    ] as const) {
      const refused = await support.post(path, body, {
        headers: { 'Idempotency-Key': 'support-should-not' },
      });
      expect(refused.status).toBe(403);
    }
  });

  it('exposes no internal financial identifier to the customer', async () => {
    // §50, §88: the purchase id is the only handle a customer gets. A hold id
    // or an account id would invite someone to act on it.
    const checkId = await paidCheck();
    const purchase = await purchaseOf(context, checkId);

    const view = await student.client.get(`${API}/checks/${checkId}`);
    const serialized = JSON.stringify(view.body);

    expect(view.body.billing.purchaseId).toBe(purchase!.id);
    for (const allocation of purchase!.allocations) {
      expect(serialized).not.toContain(allocation.holdId);
      expect(serialized).not.toContain(allocation.id);
    }
    expect(serialized).not.toMatch(/accountId|ledgerEntryId|priceVersionId|priceQuoteId/);
  });

  it('keeps billing out of the canonical report, so its hash is untouched', async () => {
    // §51, §102, §127: billing and compliance evidence are separate domains,
    // and a report issued before checks were paid for must still verify.
    const checkId = await paidCheck();
    const report = await context.adminDb.checkReport.findFirstOrThrow({ where: { checkId } });

    const artifact = await context.storage.getObjectBytes({
      zone: 'derived',
      key: report.artifactObjectKey,
      versionId: report.artifactObjectVersionId,
    });
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(artifact).digest('hex')).toBe(report.reportHash);

    const canonical = JSON.parse(artifact.toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(canonical)).not.toContain('billing');
    expect(artifact.toString('utf8')).not.toMatch(
      /price|purchase|hold|balance|charge|currency|minorUnits/i,
    );
  });
});
