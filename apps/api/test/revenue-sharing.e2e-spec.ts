import { CreditClass } from '@palcert/contracts';
import { API, type AuthClient } from './support/auth-client';
import { createTenant, createUser, signInPlatformAdmin } from './support/organization-client';
import {
  publishCheckableStandard,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx } from './support/fixtures';
import {
  ensureCheckPrice,
  grantCredit,
  quoteForCheck,
  chargesForPurchase,
} from './support/paid-check-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';
import { BalanceService } from '../src/modules/finance/services/balance.service';
import { ServicePurchaseService } from '../src/modules/finance/services/service-purchase.service';
import { TenantPrismaService } from '../src/infrastructure/tenant/tenant-prisma.service';
import { WithdrawalFundsService } from '../src/modules/withdrawals/services/withdrawal-funds.service';
import { reauthenticate, userIdOf } from './support/withdrawal-client';

describe('Institution service revenue (e2e)', () => {
  let context: TestContext;
  let admin: AuthClient;
  let student: Awaited<ReturnType<typeof createUser>>;
  let institution: Awaited<ReturnType<typeof createTenant>>;
  let standard: PublishedStandard;
  beforeAll(async () => {
    context = await createTestContext();
  });
  afterAll(async () => {
    await destroyTestContext(context);
  });
  beforeEach(async () => {
    await resetState(context);
    admin = await signInPlatformAdmin(context, 'revenue-admin@example.test');
    student = await createUser(context, 'ahmad@example.test');
    institution = await createTenant(context, 'Islamic University', 'registrar@example.test');
    standard = await publishCheckableStandard(
      context,
      institution.owner.client,
      institution.organizationId,
    );
  });
  const path = () => `${API}/admin/organizations/${institution.organizationId}/revenue-shares`;
  async function setRate(percent: string, service = 'DOCUMENT_CHECK') {
    await reauthenticate(context, await userIdOf(context, 'revenue-admin@example.test'));
    const response = await admin.put(`${path()}/${service}`, {
      institutionPercent: percent,
      reason: 'Institution agreement',
    });
    expect(response.status).toBe(200);
    return response;
  }
  async function check(promo = 0n, amount = 1000n) {
    const doc = await createDocument(student.client, 'Thesis');
    const { versionId } = await uploadAndProcess(student.client, doc.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
    await ensureCheckPrice(context, amount);
    await grantCredit(context, student.userId, amount);
    if (promo > 0n) await grantCredit(context, student.userId, promo, CreditClass.PROMOTIONAL);
    const quote = await quoteForCheck(context, student.userId);
    const started = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quote.id,
    });
    expect(started.status).toBe(202);
    expect((await waitForCheck(context, started.body.id)).status).toBe('COMPLETED');
    return String(started.body.billing.purchaseId);
  }
  it('splits $10 into $5/$5, snapshots the rate, captures once and reverses both shares on refund', async () => {
    await setRate('50');
    const purchaseId = await check();
    const entry = await context.adminDb.serviceRevenueEntry.findFirstOrThrow({
      where: { purchaseId },
    });
    expect(entry).toMatchObject({
      organizationId: institution.organizationId,
      grossMinor: 1000n,
      institutionMinor: 500n,
      platformMinor: 500n,
    });
    const range = 'from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z&locale=en&timeZone=UTC';
    const orgReportPath = `${API}/organizations/${institution.organizationId}/reports`;
    const organizationReport = await institution.owner.client.get(
      `${orgReportPath}?kind=financial&${range}`,
    );
    expect(organizationReport.status).toBe(200);
    expect(organizationReport.body.summaries[0].rows).toContainEqual([
      'USD',
      'CASH',
      '0.00',
      '5.00',
      '0.00',
      '5.00',
    ]);
    const platformReport = await admin.get(`${API}/admin/reports?kind=financial&${range}`);
    expect(platformReport.status).toBe(200);
    expect(platformReport.body.summaries[0].rows).toContainEqual([
      'USD',
      'CASH',
      '0.00',
      '5.00',
      '0.00',
      '5.00',
    ]);
    const activity = await institution.owner.client.get(
      `${orgReportPath}/print?kind=services&${range}&service=DOCUMENT_CHECK`,
    );
    expect(activity.status).toBe(200);
    expect(activity.body.total).toBe(1);
    expect(activity.body.detail.rows[0]).toContain(purchaseId);
    expect(JSON.stringify(activity.body)).not.toContain(student.email);
    // A member's private tables remain owner-scoped even though the safe projection is shared.
    expect(
      await context.app
        .get(TenantPrismaService)
        .withTenant(
          { userId: institution.owner.userId, organizationId: institution.organizationId },
          (tx) => tx.servicePurchase.findUnique({ where: { id: purchaseId } }),
        ),
    ).toBeNull();
    await setRate('75');
    const snapshot = await context.adminDb.serviceRevenueSnapshot.findUniqueOrThrow({
      where: { purchaseId },
    });
    expect(snapshot.institutionBps).toBe(5000);
    await context.app
      .get(TenantPrismaService)
      .withUser(student.userId, (tx) =>
        context.app.get(ServicePurchaseService).captureOnDelivery(tx, purchaseId),
      );
    expect(await context.adminDb.serviceRevenueEntry.count({ where: { purchaseId } })).toBe(1);
    const funds = await context.app
      .get(TenantPrismaService)
      .withPlatformAdmin({ actorUserId: student.userId, reason: 'test revenue' }, (tx) =>
        context.app.get(WithdrawalFundsService).platform(tx),
      );
    expect(funds.find((row) => row.currency === 'USD')?.cashServiceRevenueMinor).toBe(500n);
    const [charge] = await chargesForPurchase(context, purchaseId);
    const refunds = context.app.get(BalanceService);
    await refunds.refundServiceCharge({ ownerUserId: student.userId, ledgerEntryId: charge!.id });
    await refunds.refundServiceCharge({ ownerUserId: student.userId, ledgerEntryId: charge!.id });
    const rows = await context.adminDb.serviceRevenueEntry.findMany({ where: { purchaseId } });
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.institutionMinor, 0n)).toBe(0n);
    expect(rows.reduce((sum, row) => sum + row.platformMinor, 0n)).toBe(0n);
    const refunded = await institution.owner.client.get(`${orgReportPath}?kind=financial&${range}`);
    expect(refunded.body.summaries[0].rows).toContainEqual([
      'USD',
      'CASH',
      '0.00',
      '5.00',
      '5.00',
      '0.00',
    ]);
    const platformRefunded = await admin.get(`${API}/admin/reports?kind=financial&${range}`);
    expect(platformRefunded.body.summaries[0].rows).toContainEqual([
      'USD',
      'CASH',
      '0.00',
      '5.00',
      '5.00',
      '0.00',
    ]);
  });
  it('excludes promotional funds and assigns indivisible minor-unit remainder consistently', async () => {
    await setRate('50');
    const purchaseId = await check(200n, 1001n);
    expect(
      await context.adminDb.serviceRevenueEntry.findFirstOrThrow({ where: { purchaseId } }),
    ).toMatchObject({ grossMinor: 801n, institutionMinor: 401n, platformMinor: 400n });
  });
  it('keeps service rates independent and maps attestation institution share to its existing settlement policy', async () => {
    await setRate('50');
    await setRate('30', 'SMARTFIX');
    const response = await setRate('60', 'ATTESTATION');
    expect(response.body.rates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceCode: 'DOCUMENT_CHECK',
          institutionPercent: '50.00',
          platformPercent: '50.00',
        }),
        expect.objectContaining({
          serviceCode: 'SMARTFIX',
          institutionPercent: '30.00',
          platformPercent: '70.00',
        }),
        expect.objectContaining({
          serviceCode: 'ATTESTATION',
          institutionPercent: '60.00',
          platformPercent: '40.00',
        }),
      ]),
    );
    expect(
      (await context.adminDb.organizationAttestationCommission.findFirstOrThrow()).commissionBps,
    ).toBe(4000);
  });
  it('rejects non-admin writes, invalid percentages and cross-institution financial reads', async () => {
    expect(
      (
        await student.client.put(`${path()}/DOCUMENT_CHECK`, {
          institutionPercent: '50.00',
          reason: 'not permitted',
        })
      ).status,
    ).toBe(403);
    await reauthenticate(context, await userIdOf(context, 'revenue-admin@example.test'));
    for (const institutionPercent of ['-1', '100.01', '1.234', 'NaN']) {
      const response = await admin.put(`${path()}/DOCUMENT_CHECK`, {
        institutionPercent,
        reason: 'invalid',
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    await setRate('50');
    const purchaseId = await check();
    const other = await createTenant(context, 'Other University', 'other@example.test');
    const tenant = context.app.get(TenantPrismaService);
    const rows = await tenant.withTenant(
      { organizationId: other.organizationId, userId: other.owner.userId },
      (tx) => tx.serviceRevenueEntry.findMany({ where: { purchaseId } }),
    );
    expect(rows).toEqual([]);
    const otherReport = await other.owner.client.get(
      `${API}/organizations/${other.organizationId}/reports/print?kind=services&from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z&locale=en`,
    );
    expect(otherReport.status).toBe(200);
    expect(otherReport.body.total).toBe(0);

    await expect(
      tenant.withUser(student.userId, (tx) =>
        tx.serviceRevenueSnapshot.update({
          where: { purchaseId },
          data: { institutionBps: 10000 },
        }),
      ),
    ).rejects.toThrow();
  });
});
