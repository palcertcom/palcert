import {
  approve as approveAttestation,
  createInstitution,
  readyDraft,
  setCommission,
  startReview,
  submit as submitAttestation,
  waitForPayment,
  type Institution,
} from './support/attestation-client';
import type { AuthClient } from './support/auth-client';
import { expectStatus } from './support/checks-client';
import { fundBalance } from './support/finance-client';
import { drainNotifications } from './support/manual-topup-client';
import {
  createUser,
  grantOrganizationRoleTo,
  signInGlobalRole,
  signInPlatformAdmin,
} from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';
import {
  ADMIN,
  PLATFORM,
  SETTINGS,
  approve,
  bankDestination,
  createDestination,
  markPaid,
  orgPayouts,
  setClearing,
  startExecution,
  submit,
} from './support/withdrawal-client';

/**
 * Organization and PalCert payouts (ADR-0150): an institution withdraws only
 * its settled net share, PalCert only its realized commission and service
 * revenue, each per currency, each reserved at once and settled exactly once.
 */
describe('Withdrawals — organizations and PalCert (e2e)', () => {
  let context: TestContext;
  let admin: AuthClient;
  let financeA: AuthClient;
  let financeB: AuthClient;
  let financeC: AuthClient;

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
    financeA = await signInGlobalRole(context, 'finance.a@palcert.test', 'PALCERT_FINANCE');
    financeB = await signInGlobalRole(context, 'finance.b@palcert.test', 'PALCERT_FINANCE');
    financeC = await signInGlobalRole(context, 'finance.c@palcert.test', 'PALCERT_FINANCE');
    await setClearing(admin, 0, 0);
  });

  /** One attestation of a $1,000 fee, settled: net share and commission by the rate. */
  async function settledAttestation(percent: string): Promise<Institution> {
    const university = await createInstitution(context, 'University A', 'owner@university.test', {
      feeMinorUnits: '100000',
    });
    expectStatus(await setCommission(admin, university.organizationId, percent), 200, 'Commission');
    const applicant = await createUser(context, 'applicant@example.test');
    await fundBalance(context, applicant.client, '100000');
    const requestId = await readyDraft(applicant.client, university.typeId);
    expectStatus(await submitAttestation(applicant.client, requestId), 200, 'Submit');
    expectStatus(
      await startReview(university.owner.client, university.organizationId, requestId),
      200,
      'Start',
    );
    expectStatus(
      await approveAttestation(university.owner.client, university.organizationId, requestId),
      200,
      'Approve',
    );
    await waitForPayment(context, requestId, 'SETTLED');
    return university;
  }

  async function available(client: AuthClient, organizationId: string): Promise<bigint> {
    const earnings = await client.get(`${orgPayouts(organizationId)}/earnings`);
    expectStatus(earnings, 200, 'Earnings');
    const usd = (
      earnings.body.rows as Array<{ currency: string; available: { minorUnits: string } }>
    ).find((row) => row.currency === 'USD');
    return BigInt(usd?.available.minorUnits ?? '0');
  }

  it('pays an institution only its settled net share, reserved then consumed (§45)', async () => {
    const university = await settledAttestation('10');
    const owner = university.owner.client;
    const base = orgPayouts(university.organizationId);

    const earnings = await owner.get(`${base}/earnings`);
    expectStatus(earnings, 200, 'Earnings');
    // $1,000 gross, 10% commission: the institution's net share is $900.
    expect(earnings.body.rows).toEqual([
      expect.objectContaining({
        currency: 'USD',
        realized: { currency: 'USD', minorUnits: '90000' },
        available: { currency: 'USD', minorUnits: '90000' },
        paidOut: { currency: 'USD', minorUnits: '0' },
      }),
    ]);

    const destination = await createDestination(
      owner,
      `${base}/destinations`,
      bankDestination({
        label: 'University account',
        beneficiaryName: 'University A',
      }),
    );

    // Paid 300, reserved 200: 400 available.
    const paidOne = await submit(owner, destination.id, '30000', base);
    expectStatus(paidOne, 201, 'First payout');
    expectStatus(await approve(financeA, paidOne.body.id as string, '30000'), 200, 'Approve');
    expectStatus(await startExecution(financeB, paidOne.body.id as string), 200, 'Start');
    expectStatus(await markPaid(financeB, paidOne.body.id as string, '30000'), 200, 'Paid');
    expectStatus(await submit(owner, destination.id, '20000', base), 201, 'Reserved payout');
    expect(await available(owner, university.organizationId)).toBe(40000n);

    const tooMuch = await submit(owner, destination.id, '50000', base);
    expectStatus(tooMuch, 409, 'Above available');
    expect(tooMuch.body.error.code).toBe('WITHDRAWAL_EXCEEDS_AVAILABLE');

    const fits = await submit(owner, destination.id, '30000', base);
    expectStatus(fits, 201, 'Within available');
    expect(await available(owner, university.organizationId)).toBe(10000n);
    expectStatus(await approve(financeA, fits.body.id as string, '30000'), 200, 'Approve');
    expectStatus(await startExecution(financeB, fits.body.id as string), 200, 'Start');
    expectStatus(await markPaid(financeB, fits.body.id as string, '30000', 'BOP-2'), 200, 'Paid');
    expect(await available(owner, university.organizationId)).toBe(10000n);

    // Consumed reservations, one settlement each, no ledger entry for an organization.
    const settlements = await context.adminDb.withdrawalSettlement.findMany({
      where: { scope: 'ORGANIZATION' },
    });
    expect(settlements).toHaveLength(2);
    expect(
      settlements.every((row) => row.ledgerEntryId === null && row.reservationId !== null),
    ).toBe(true);
    expect(
      await context.adminDb.creditLedgerEntry.count({ where: { entryType: 'WITHDRAWAL_DEBIT' } }),
    ).toBe(0);

    const reconciled = await financeA.post(`${SETTINGS}/reconciliation`);
    expect(reconciled.body).toMatchObject({ consistent: true });

    // The requester is told on submission, from the organization's own page.
    await drainNotifications(context);
    const mail = context.emailProvider.lastTo('owner@university.test');
    expect(mail?.text).toContain(`/organizations/${university.organizationId}/payouts/`);
  });

  it('lets only the payout permission request, and keeps organizations apart (D6, §43)', async () => {
    const university = await settledAttestation('10');
    const base = orgPayouts(university.organizationId);
    const destination = await createDestination(university.owner.client, `${base}/destinations`);

    // An organization administrator can see earnings but cannot request a payout.
    const member = await createUser(context, 'admin@university.test');
    await grantOrganizationRoleTo(context, university, member, 'ORGANIZATION_ADMIN');
    expectStatus(await member.client.get(`${base}/earnings`), 200, 'Admin reads earnings');
    expectStatus(await submit(member.client, destination.id, '1000', base), 403, 'Admin requests');
    expectStatus(
      await member.client.post(`${base}/destinations`, bankDestination()),
      403,
      'Admin manages destinations',
    );

    // Another organization reaches nothing of this one's.
    const submitted = await submit(university.owner.client, destination.id, '1000', base);
    expectStatus(submitted, 201, 'Owner requests');
    const other = await createInstitution(context, 'University B', 'owner@other.test');
    expectStatus(await other.owner.client.get(`${base}/${submitted.body.id}`), 404, 'Foreign path');
    expectStatus(
      await other.owner.client.get(`${orgPayouts(other.organizationId)}/${submitted.body.id}`),
      404,
      'Foreign request in own path',
    );
    // A plain user cannot submit against an organization destination.
    const stranger = await createUser(context, 'stranger@example.test');
    const forged = await submit(stranger.client, destination.id, '1000');
    expectStatus(forged, 404, 'Forged destination');
  });

  it('pays PalCert only its realized revenue, with three different people (D5, D8)', async () => {
    await settledAttestation('10');
    const funds = await financeA.get(PLATFORM);
    expectStatus(funds, 200, 'Platform funds');
    expect(funds.body.rows).toEqual([
      expect.objectContaining({
        currency: 'USD',
        attestationCommission: { currency: 'USD', minorUnits: '10000' },
        realized: { currency: 'USD', minorUnits: '10000' },
        available: { currency: 'USD', minorUnits: '10000' },
      }),
    ]);

    // An administrator without the platform payout permission cannot ask.
    const treasury = await createDestination(
      financeA,
      `${PLATFORM}/destinations`,
      bankDestination({
        label: 'PalCert treasury',
        beneficiaryName: 'PalCert Ltd',
      }),
    );
    expectStatus(
      await submit(admin, treasury.id, '1000', `${PLATFORM}/withdrawals`),
      403,
      'Admin platform request',
    );

    const tooMuch = await submit(financeA, treasury.id, '10001', `${PLATFORM}/withdrawals`);
    expectStatus(tooMuch, 409, 'Above realized revenue');
    const requested = await submit(financeA, treasury.id, '6000', `${PLATFORM}/withdrawals`);
    expectStatus(requested, 201, 'Platform request');
    const id = requested.body.id as string;

    expectStatus(await approve(financeA, id, '6000'), 403, 'Requester approves');
    expectStatus(await approve(financeB, id, '6000'), 200, 'Second person approves');
    const byApprover = await startExecution(financeB, id);
    expectStatus(byApprover, 403, 'Approver executes');
    expect(byApprover.body.error.code).toBe('WITHDRAWAL_SEPARATION_OF_DUTIES');
    expectStatus(await startExecution(financeA, id), 403, 'Requester executes');
    expectStatus(await startExecution(financeC, id), 200, 'Third person starts');
    expectStatus(await markPaid(financeC, id, '6000', 'TREASURY-1'), 200, 'Third person pays');

    const after = await financeA.get(PLATFORM);
    expect(after.body.rows[0]).toMatchObject({
      paidOut: { currency: 'USD', minorUnits: '6000' },
      available: { currency: 'USD', minorUnits: '4000' },
    });
    const row = await context.adminDb.withdrawalRequest.findUniqueOrThrow({ where: { id } });
    expect(new Set([row.requesterUserId, row.approvedByUserId, row.executedByUserId]).size).toBe(3);

    const queue = await financeA.get(`${ADMIN}?status=PAID&scope=PLATFORM`);
    expectStatus(queue, 200, 'Queue');
    expect(queue.body.items).toHaveLength(1);
  });
});
