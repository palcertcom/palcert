import {
  ATTESTATIONS,
  approve,
  availableCash,
  createInstitution,
  orgAttestations,
  readyDraft,
  setCommission,
  startReview,
  submit,
  waitForPayment,
  type Institution,
} from './support/attestation-client';
import { AttestationHousekeepingService } from '../src/modules/attestations/services/attestation-housekeeping.service';
import { AttestationPaymentService } from '../src/modules/attestations/services/attestation-payment.service';
import { API, type AuthClient } from './support/auth-client';
import { expectStatus } from './support/checks-client';
import { fundBalance, ledgerOf } from './support/finance-client';
import { createUser, signInGlobalRole, signInPlatformAdmin } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Attestation money: per-institution commission, frozen price snapshots,
 * concurrency and retries.
 */
describe('Certificate attestation — finance (e2e)', () => {
  let context: TestContext;
  let admin: AuthClient;

  beforeAll(async () => {
    context = await createTestContext();
    await new Promise<void>((resolve) => {
      context.app.getHttpServer().listen(0, '127.0.0.1', () => resolve());
    });
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    admin = await signInPlatformAdmin(context, 'admin@palcert.test');
  });

  async function approveThrough(institution: Institution, owner: AuthClient): Promise<string> {
    const requestId = await readyDraft(owner, institution.typeId);
    expectStatus(await submit(owner, requestId), 200, 'Submit');
    expectStatus(
      await startReview(institution.owner.client, institution.organizationId, requestId),
      200,
      'Start',
    );
    expectStatus(
      await approve(institution.owner.client, institution.organizationId, requestId),
      200,
      'Approve',
    );
    await waitForPayment(context, requestId, 'SETTLED');
    return requestId;
  }

  it('splits a $10 fee by each institution’s own commission: 10%, 20% and 0%', async () => {
    const a = await createInstitution(context, 'University A', 'a@university.test');
    const b = await createInstitution(context, 'University B', 'b@university.test');
    const c = await createInstitution(context, 'University C', 'c@university.test');
    expectStatus(await setCommission(admin, a.organizationId, '10'), 200, 'A rate');
    expectStatus(await setCommission(admin, b.organizationId, '20'), 200, 'B rate');
    expectStatus(await setCommission(admin, c.organizationId, '0'), 200, 'C rate');

    const user = await createUser(context, 'holder@example.test');
    await fundBalance(context, user.client, '5000');

    const expected: Array<[Institution, bigint, bigint, number]> = [
      [a, 900n, 100n, 1000],
      [b, 800n, 200n, 2000],
      [c, 1000n, 0n, 0],
    ];
    for (const [institution, net, platform, bps] of expected) {
      const requestId = await approveThrough(institution, user.client);
      const request = await context.adminDb.attestationRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      expect(request.platformCommissionBps).toBe(bps);
      const settlement = await context.adminDb.attestationSettlement.findUniqueOrThrow({
        where: { requestId },
      });
      expect([
        institution.organizationId,
        settlement.institutionNetMinor,
        settlement.platformFeeMinor,
      ]).toEqual([institution.organizationId, net, platform]);
    }
    // The user paid $30 in total.
    expect(await availableCash(user.client)).toBe(2000n);

    // PalCert's report shows each institution with its own rate.
    const overview = await admin.get(`${API}/admin/attestations/finance`);
    expectStatus(overview, 200, 'Overview');
    expect(overview.body.approvals).toBe(3);
    expect(overview.body.byCurrency).toEqual([
      {
        currency: 'USD',
        gross: { currency: 'USD', minorUnits: '3000' },
        platformCommission: { currency: 'USD', minorUnits: '300' },
        organizationNet: { currency: 'USD', minorUnits: '2700' },
      },
    ]);
    const rows = Object.fromEntries(
      (overview.body.organizations as Array<Record<string, unknown>>).map((row) => [
        row['organizationName'],
        row,
      ]),
    );
    expect((rows['University B'] as Record<string, unknown>)['currentCommissionPercent']).toBe(
      '20.00',
    );
    expect(
      (rows['University C'] as Record<string, Record<string, string>>)['platformRevenue']![
        'minorUnits'
      ],
    ).toBe('0');
    // No certificate content in finance reports.
    expect(JSON.stringify(overview.body)).not.toContain('Bachelor');
  });

  it('keeps the submitted price when the fee and the commission change afterwards', async () => {
    const university = await createInstitution(context, 'University A', 'a@university.test');
    expectStatus(await setCommission(admin, university.organizationId, '10'), 200, 'Rate 10');
    const user = await createUser(context, 'holder@example.test');
    await fundBalance(context, user.client, '5000');

    const before = await readyDraft(user.client, university.typeId);
    expectStatus(await submit(user.client, before), 200, 'Submit');

    // $5 → $8 and 10% → 15% after submission.
    const fee = await university.owner.client.put(
      `${orgAttestations(university.organizationId)}/attestation-types/${university.typeId}/fee`,
      { currency: 'USD', feeMinorUnits: '800' },
    );
    expectStatus(fee, 200, 'Fee change');
    expectStatus(await setCommission(admin, university.organizationId, '15'), 200, 'Rate 15');

    expectStatus(
      await startReview(university.owner.client, university.organizationId, before),
      200,
      'Start',
    );
    expectStatus(
      await approve(university.owner.client, university.organizationId, before),
      200,
      'Approve',
    );
    await waitForPayment(context, before, 'SETTLED');
    const old = await context.adminDb.attestationSettlement.findUniqueOrThrow({
      where: { requestId: before },
    });
    expect([
      old.grossMinor,
      old.platformFeeMinor,
      old.institutionNetMinor,
      old.platformCommissionBps,
    ]).toEqual([1000n, 100n, 900n, 1000]);

    // A new request is priced at the new fee and the new rate.
    const after = await approveThrough(university, user.client);
    const renewed = await context.adminDb.attestationSettlement.findUniqueOrThrow({
      where: { requestId: after },
    });
    expect([
      renewed.grossMinor,
      renewed.platformFeeMinor,
      renewed.institutionNetMinor,
      renewed.platformCommissionBps,
    ]).toEqual([800n, 120n, 680n, 1500]);

    // The database itself refuses to rewrite a submitted price.
    await expect(
      context.adminDb.attestationRequest.update({
        where: { id: before },
        data: { grossFeeMinor: 1n },
      }),
    ).rejects.toThrow(/snapshot is immutable/);

    // The commission history is append-only and explains itself.
    const history = await admin.get(
      `${API}/admin/organizations/${university.organizationId}/attestation-commission`,
    );
    expectStatus(history, 200, 'History');
    expect(history.body.currentPercent).toBe('15.00');
    expect(history.body.history).toHaveLength(2);
    expect(history.body.history[0]).toMatchObject({
      percent: '15.00',
      changeReason: 'Agreed platform commission',
    });
    await expect(
      context.adminDb.organizationAttestationCommission.updateMany({ data: { commissionBps: 0 } }),
    ).rejects.toThrow(/append-only/);
  });

  it('never overspends: two submissions racing for one balance reserve exactly one fee', async () => {
    const university = await createInstitution(context, 'University A', 'a@university.test');
    const user = await createUser(context, 'holder@example.test');
    await fundBalance(context, user.client, '1500');
    const first = await readyDraft(user.client, university.typeId);
    const second = await readyDraft(user.client, university.typeId);

    const results = await Promise.all([submit(user.client, first), submit(user.client, second)]);
    const statuses = results.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 402]);
    expect(await availableCash(user.client)).toBe(500n);
    const holds = await context.adminDb.creditHold.findMany({
      where: { ownerUserId: user.userId, status: 'ACTIVE' },
    });
    expect(holds.map((hold) => hold.amountMinor)).toEqual([1000n]);
  });

  it('does not double-charge on retried submits, decisions or settlement jobs', async () => {
    const university = await createInstitution(context, 'University A', 'a@university.test');
    const user = await createUser(context, 'holder@example.test');
    await fundBalance(context, user.client, '3000');
    const requestId = await readyDraft(user.client, university.typeId);

    // Three submits: one reservation.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expectStatus(await submit(user.client, requestId), 200, `Submit ${attempt}`);
    }
    expect(await context.adminDb.creditHold.count({ where: { ownerUserId: user.userId } })).toBe(1);

    expectStatus(
      await startReview(university.owner.client, university.organizationId, requestId),
      200,
      'Start',
    );
    // Two approvals race: exactly one decision, one attestation.
    const [one, two] = await Promise.all([
      approve(university.owner.client, university.organizationId, requestId),
      approve(university.owner.client, university.organizationId, requestId),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect(await context.adminDb.attestation.count({ where: { requestId } })).toBe(1);

    await waitForPayment(context, requestId, 'SETTLED');
    // Replay the payment job as an at-least-once queue might.
    const job = await context.adminDb.processingJob.findFirstOrThrow({
      where: { jobType: 'ATTESTATION_PAYMENT', resourceId: requestId },
    });
    expect(job.status).toBe('SUCCEEDED');
    // The job's own record refuses to run again, so replay the settlement it
    // performs, twice, and let the reconciler try as well.
    const payments = context.workerApp.get(AttestationPaymentService);
    await payments.settle(requestId);
    await payments.settle(requestId);
    context.clock.advanceMinutes(10);
    await context.workerApp.get(AttestationHousekeepingService).reviveStrandedPayments();

    const charges = (await ledgerOf(context, user.userId)).filter(
      (entry) => entry.entryType === 'SERVICE_CHARGE',
    );
    expect(charges).toHaveLength(1);
    expect(await context.adminDb.attestationSettlement.count()).toBe(1);
    expect(await context.adminDb.attestationRevenueEntry.count()).toBe(2);
    expect(await availableCash(user.client)).toBe(2000n);
  });

  it('refuses a settlement that does not balance, at the database', async () => {
    const university = await createInstitution(context, 'University A', 'a@university.test');
    const user = await createUser(context, 'holder@example.test');
    await fundBalance(context, user.client, '3000');
    const requestId = await approveThrough(university, user.client);
    const settlement = await context.adminDb.attestationSettlement.findUniqueOrThrow({
      where: { requestId },
    });
    await expect(
      context.adminDb.attestationRevenueEntry.updateMany({
        where: { settlementId: settlement.id },
        data: { amountMinor: 0n },
      }),
    ).rejects.toThrow(/append-only/);
  });

  it('keeps finance permission-gated and per-organization', async () => {
    const a = await createInstitution(context, 'University A', 'a@university.test');
    const b = await createInstitution(context, 'University B', 'b@university.test');
    const user = await createUser(context, 'holder@example.test');
    await fundBalance(context, user.client, '3000');
    await approveThrough(a, user.client);

    // B sees none of A's revenue.
    const other = await b.owner.client.get(
      `${orgAttestations(b.organizationId)}/attestation-revenue`,
    );
    expectStatus(other, 200, 'B revenue');
    expect(other.body.totals).toEqual([]);
    expect(other.body.lines).toEqual([]);
    // And cannot ask for A's.
    expect(
      (await b.owner.client.get(`${orgAttestations(a.organizationId)}/attestation-revenue`)).status,
    ).toBe(404);

    // An institution cannot set PalCert's commission, nor can support staff.
    expect((await setCommission(a.owner.client, a.organizationId, '0')).status).toBe(403);
    const support = await signInGlobalRole(context, 'support@palcert.test', 'PALCERT_SUPPORT');
    expect((await setCommission(support, a.organizationId, '1')).status).toBe(403);
    expect((await support.get(`${API}/admin/attestations/finance`)).status).toBe(403);
    // Finance staff can.
    const finance = await signInGlobalRole(context, 'finance@palcert.test', 'PALCERT_FINANCE');
    expectStatus(await setCommission(finance, a.organizationId, '12.5'), 200, 'Finance sets rate');
    // Out-of-range rates are refused.
    expect((await setCommission(admin, a.organizationId, '100.01')).status).toBe(422);
    expect((await setCommission(admin, a.organizationId, '-5')).status).toBe(400);
    const invalid = await admin.put(
      `${API}/admin/organizations/${a.organizationId}/attestation-commission`,
      {
        percent: '101',
        reason: 'x',
      },
    );
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe('ATTESTATION_COMMISSION_INVALID');

    // The user's receipt carries no split.
    const requests = await user.client.get(ATTESTATIONS);
    const receipt = await user.client.get(`${ATTESTATIONS}/${requests.body[0].id}/receipt`);
    expect(JSON.stringify(receipt.body)).not.toMatch(/commission|institutionNet|platform/i);
  });
});
