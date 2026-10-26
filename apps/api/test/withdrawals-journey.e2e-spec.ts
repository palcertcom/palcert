import { CreditClass, CreditHoldPurpose } from '@palcert/contracts';
import { CreditHoldService } from '../src/modules/finance/services/credit-hold.service';
import { TenantPrismaService } from '../src/infrastructure/tenant/tenant-prisma.service';
import { signIn, type AuthClient } from './support/auth-client';
import { expectStatus } from './support/checks-client';
import { fundBalance } from './support/finance-client';
import { drainNotifications, enabledMethod } from './support/manual-topup-client';
import {
  PASSWORD,
  createUser,
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
  IBAN_A,
  IBAN_B,
  OWN,
  OWN_DESTINATIONS,
  SETTINGS,
  approve,
  createDestination,
  detail,
  manualTopUp,
  markPaid,
  reauthenticate,
  setClearing,
  startExecution,
  submit,
  userIdOf,
  withdrawable,
} from './support/withdrawal-client';

/**
 * A person's withdrawal, end to end (ADR-0150): only verified manual top-ups
 * past their clearing period can leave; submission reserves at once; finance
 * approves, then records the external transfer; the ledger moves exactly once.
 */
describe('Withdrawals — user journey (e2e)', () => {
  let context: TestContext;
  let admin: AuthClient;
  let financeA: AuthClient;
  let financeB: AuthClient;

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
    await setClearing(admin, 0, 0);
  });

  async function serviceHold(userId: string, amountMinor: bigint): Promise<string> {
    const tenant = context.app.get(TenantPrismaService);
    const holds = context.app.get(CreditHoldService);
    const hold = await tenant.withUser(userId, (tx) =>
      holds.create(tx, {
        ownerUserId: userId,
        currency: 'USD',
        creditClass: CreditClass.CASH,
        amountMinor,
        purpose: CreditHoldPurpose.SERVICE,
      }),
    );
    return hold.id;
  }

  it('withdraws at most the eligible amount, reserves at once, and settles exactly once (§44)', async () => {
    const person = await createUser(context, 'person@example.test');
    await manualTopUp(admin, financeA, person.client, '10000');
    await serviceHold(person.userId, 2000n);

    // 100.00 verified, 20.00 held by a service: 80.00 withdrawable.
    expect(await withdrawable(person.client)).toBe(8000n);

    const destination = await createDestination(person.client);
    const first = await submit(person.client, destination.id, '5000');
    expectStatus(first, 201, 'First withdrawal');
    expect(first.body).toMatchObject({
      status: 'PENDING_REVIEW',
      scope: 'USER',
      amount: { currency: 'USD', minorUnits: '5000' },
      destination: { ibanMasked: '•••• 5432', bankName: 'Bank of Palestine' },
      cancellable: true,
    });
    expect(JSON.stringify(first.body)).not.toContain(IBAN_A);
    // Reserved immediately: 30.00 left.
    expect(await withdrawable(person.client)).toBe(3000n);

    // Rejection releases it.
    const current = await detail(financeA, first.body.id as string);
    const rejected = await financeA.post(`${ADMIN}/${first.body.id}/reject`, {
      expectedVersion: current.body.version,
      reason: 'VERIFICATION_REQUIRED',
    });
    expectStatus(rejected, 200, 'Reject');
    expect(rejected.body.status).toBe('REJECTED');
    expect(await withdrawable(person.client)).toBe(8000n);

    // Again, approved by one finance user, paid out by another.
    const second = await submit(person.client, destination.id, '5000');
    expectStatus(second, 201, 'Second withdrawal');
    const id = second.body.id as string;
    expectStatus(await approve(financeA, id, '5000'), 200, 'Approve');
    // Approval moves no money and keeps the reservation.
    expect(await withdrawable(person.client)).toBe(3000n);
    expect(
      await context.adminDb.creditLedgerEntry.count({ where: { entryType: 'WITHDRAWAL_DEBIT' } }),
    ).toBe(0);

    expectStatus(await startExecution(financeB, id), 200, 'Start execution');
    const paid = await markPaid(financeB, id, '5000', 'BOP-778812');
    expectStatus(paid, 200, 'Mark paid');
    expect(paid.body).toMatchObject({
      status: 'PAID',
      externalTransferReference: 'BOP-778812',
      reservationActive: false,
    });

    // A double click, then a retry from the other finance user: one settlement.
    expectStatus(await markPaid(financeB, id, '5000', 'BOP-778812'), 200, 'Repeat');
    const conflicting = await markPaid(financeB, id, '5000', 'DIFFERENT');
    expectStatus(conflicting, 409, 'Different reference');
    expect(await context.adminDb.withdrawalSettlement.count()).toBe(1);
    const debits = await context.adminDb.creditLedgerEntry.findMany({
      where: { entryType: 'WITHDRAWAL_DEBIT' },
    });
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({
      amountMinorSigned: -5000n,
      creditClass: 'CASH',
      reasonCode: 'WITHDRAWAL_PAID',
    });
    const settlement = await context.adminDb.withdrawalSettlement.findFirstOrThrow();
    expect(settlement.idempotencyKey).toBe(`withdrawal:${id}:settle`);
    expect(settlement.ledgerEntryId).toBe(debits[0]!.id);

    // Eligible reduced exactly once: 100 − 50 paid − 20 held = 30.
    expect(await withdrawable(person.client)).toBe(3000n);

    // The requester sees the timeline, never finance's identities.
    const own = await person.client.get(`${OWN}/${id}`);
    expectStatus(own, 200, 'Own detail');
    expect(own.body.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'CREATED',
      'SUBMITTED',
      'RESERVED',
      'APPROVED',
      'EXECUTION_STARTED',
      'PAID',
    ]);
    for (const event of own.body.events as Array<{
      actorSide: string;
      actorDisplayName: unknown;
    }>) {
      if (event.actorSide === 'FINANCE') expect(event.actorDisplayName).toBeNull();
    }

    const reconciled = await financeA.post(`${SETTINGS}/reconciliation`);
    expectStatus(reconciled, 200, 'Reconcile');
    expect(reconciled.body).toMatchObject({ consistent: true, findings: [] });
  });

  it('never pays out card top-ups, admin credits or promotional credit (D1, D2)', async () => {
    const person = await createUser(context, 'person@example.test');
    await fundBalance(context, person.client, '20000');
    // An admin credit to CASH and a promotional credit: neither is real money in.
    for (const [creditClass, key] of [
      ['CASH', 'goodwill-cash'],
      ['PROMOTIONAL', 'promo-credit'],
    ] as const) {
      const adjusted = await financeA.post('/api/v1/admin/finance/adjustments', {
        ownerUserId: person.userId,
        currency: 'USD',
        creditClass,
        amountMinorUnits: '5000',
        reasonCode: creditClass === 'CASH' ? 'GOODWILL' : 'PROMOTION',
        idempotencyKey: key,
      });
      expectStatus(adjusted, 201, `${creditClass} adjustment`);
    }
    expect(await withdrawable(person.client)).toBe(0n);
    const view = await person.client.get(`/api/v1/balance/withdrawable?currency=USD`);
    expect(view.body.cashBalance.minorUnits).not.toBe('0');
    expect(view.body.notWithdrawable.minorUnits).toBe(view.body.cashBalance.minorUnits);

    const destination = await createDestination(person.client);
    const refused = await submit(person.client, destination.id, '100');
    expectStatus(refused, 409, 'Card money withdrawal');
    expect(refused.body.error.code).toBe('WITHDRAWAL_EXCEEDS_AVAILABLE');
    expect(await context.adminDb.creditHold.count({ where: { purpose: 'WITHDRAWAL' } })).toBe(0);
  });

  it('keeps a manual top-up out of reach until its clearing period ends (D3)', async () => {
    await setClearing(admin, 14, 30);
    const person = await createUser(context, 'person@example.test');
    await manualTopUp(admin, financeA, person.client, '10000');

    const before = await person.client.get(`/api/v1/balance/withdrawable?currency=USD`);
    expectStatus(before, 200, 'Breakdown');
    expect(before.body).toMatchObject({
      withdrawable: { minorUnits: '0' },
      clearing: { minorUnits: '10000' },
      clearingDays: 14,
    });

    context.clock.set(new Date(context.clock.now().getTime() + 15 * 86_400_000));
    // Fifteen days later the old session has expired; sign in again.
    const again = await signIn(context, 'person@example.test', PASSWORD);
    expect(await withdrawable(again)).toBe(10000n);
  });

  it('lets exactly one of two racing requests reserve the same money (§42)', async () => {
    const person = await createUser(context, 'person@example.test');
    await manualTopUp(admin, financeA, person.client, '10000');
    const destination = await createDestination(person.client);

    const results = await Promise.all([
      submit(person.client, destination.id, '8000'),
      submit(person.client, destination.id, '8000'),
    ]);
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([201, 409]);
    const loser = results.find((result) => result.status === 409)!;
    expect(loser.body.error.code).toBe('WITHDRAWAL_EXCEEDS_AVAILABLE');

    const holds = await context.adminDb.creditHold.findMany({
      where: { purpose: 'WITHDRAWAL', status: 'ACTIVE' },
    });
    expect(holds.reduce((total, hold) => total + hold.amountMinor, 0n)).toBe(8000n);
    expect(await withdrawable(person.client)).toBe(2000n);
  });

  it('returns the same request for a retried submission with one idempotency key', async () => {
    const person = await createUser(context, 'person@example.test');
    await manualTopUp(admin, financeA, person.client, '10000');
    const destination = await createDestination(person.client);
    const body = { currency: 'USD', amountMinorUnits: '3000', destinationId: destination.id };
    const first = await person.client.post(OWN, body, {
      headers: { 'Idempotency-Key': 'withdraw-once' },
    });
    const second = await person.client.post(OWN, body, {
      headers: { 'Idempotency-Key': 'withdraw-once' },
    });
    expectStatus(first, 201, 'First');
    expectStatus(second, 201, 'Replay');
    expect(second.body.id).toBe(first.body.id);
    expect(await withdrawable(person.client)).toBe(7000n);
  });

  it('refuses forged amounts, stale versions and anyone else’s request or proof (§43)', async () => {
    const person = await createUser(context, 'person@example.test');
    await manualTopUp(admin, financeA, person.client, '10000');
    const destination = await createDestination(person.client);
    const submitted = await submit(person.client, destination.id, '3000');
    expectStatus(submitted, 201, 'Submit');
    const id = submitted.body.id as string;

    // The approver restates the exact amount and currency; anything else is refused.
    const forged = await approve(financeA, id, '30000');
    expectStatus(forged, 422, 'Forged amount');
    expect(forged.body.error.code).toBe('WITHDRAWAL_CONFIRMATION_REQUIRED');
    expectStatus(await approve(financeA, id, '3000', 'EUR'), 422, 'Forged currency');

    // A decision made on a stale screen is refused, and changes nothing.
    const current = await detail(financeA, id);
    const stale = await financeA.post(`${ADMIN}/${id}/approve`, {
      expectedVersion: (current.body.version as number) - 1,
      confirmAmountMinorUnits: '3000',
      confirmCurrency: 'USD',
    });
    expectStatus(stale, 412, 'Stale version');
    expect(stale.body.error.code).toBe('WITHDRAWAL_CONFLICT');
    expect((await detail(financeA, id)).body.status).toBe('PENDING_REVIEW');

    // Another person reaches nothing of this one's, and cannot spend their destination.
    const stranger = await createUser(context, 'stranger@example.test');
    expectStatus(await stranger.client.get(`${OWN}/${id}`), 404, 'Foreign detail');
    expectStatus(await stranger.client.get(`${OWN}/${id}/proof`), 404, 'Foreign proof');
    expectStatus(
      await stranger.client.post(`${OWN}/${id}/cancel`, { expectedVersion: current.body.version }),
      404,
      'Foreign cancel',
    );
    expectStatus(await submit(stranger.client, destination.id, '1000'), 404, 'Foreign destination');
    const list = await stranger.client.get(OWN);
    expectStatus(list, 200, 'Own list');
    expect(list.body.items).toEqual([]);

    // Finance surfaces are finance's alone.
    expectStatus(await person.client.get(ADMIN), 403, 'Queue');
    expectStatus(await person.client.get(`${ADMIN}/${id}/destination`), 403, 'Reveal');
    expectStatus(await person.client.get(`${ADMIN}/${id}/proof`), 403, 'Admin proof');

    // Paid without a proof: the owner is told there is none, not handed a URL.
    expectStatus(await approve(financeA, id, '3000'), 200, 'Approve');
    expectStatus(await startExecution(financeB, id), 200, 'Start');
    expectStatus(await markPaid(financeB, id, '3000'), 200, 'Paid');
    const noProof = await person.client.get(`${OWN}/${id}/proof`);
    expectStatus(noProof, 404, 'No proof yet');
    expect(noProof.body.error.code).toBe('WITHDRAWAL_PROOF_NOT_FOUND');
  });

  it('freezes the destination at submission; later edits never change it (§14)', async () => {
    const person = await createUser(context, 'person@example.test');
    await manualTopUp(admin, financeA, person.client, '10000');
    const destination = await createDestination(person.client);
    const submitted = await submit(person.client, destination.id, '1000');
    expectStatus(submitted, 201, 'Submit');

    const edited = await person.client.patch(`${OWN_DESTINATIONS}/${destination.id}`, {
      type: 'BANK_ACCOUNT',
      label: 'My bank',
      beneficiaryName: 'Lina Haddad',
      currency: 'USD',
      bankName: 'Another Bank',
      iban: IBAN_B,
      expectedVersion: destination.version,
    });
    expectStatus(edited, 200, 'Edit destination');
    expect(edited.body.ibanMasked).toBe('•••• 3000');

    const reveal = await financeA.get(`${ADMIN}/${submitted.body.id}/destination`);
    expectStatus(reveal, 200, 'Reveal');
    expect(reveal.body).toMatchObject({ iban: IBAN_A, bankName: 'Bank of Palestine' });
    expect(
      await context.adminDb.auditEvent.count({
        where: { action: 'WITHDRAWAL_DESTINATION_REVEALED' },
      }),
    ).toBe(1);

    // The stored rows never carry the IBAN in the clear.
    const raw = await context.adminDb.$queryRawUnsafe<Array<{ row: string }>>(
      `SELECT row_to_json(d)::text AS "row" FROM "payout_destinations" d
       UNION ALL SELECT row_to_json(r)::text FROM "withdrawal_requests" r`,
    );
    for (const row of raw) {
      expect(row.row).not.toContain(IBAN_A);
      expect(row.row).not.toContain(IBAN_B);
    }
  });

  it('keeps a failed payout reserved until finance retries or releases it (D9)', async () => {
    const person = await createUser(context, 'person@example.test');
    await manualTopUp(admin, financeA, person.client, '10000');
    const destination = await createDestination(person.client);
    const submitted = await submit(person.client, destination.id, '4000');
    const id = submitted.body.id as string;
    expectStatus(await approve(financeA, id, '4000'), 200, 'Approve');
    expectStatus(await startExecution(financeB, id), 200, 'Start');

    let current = await detail(financeB, id);
    const failed = await financeB.post(`${ADMIN}/${id}/mark-failed`, {
      expectedVersion: current.body.version,
      note: 'Bank returned the transfer: account closed.',
    });
    expectStatus(failed, 200, 'Mark failed');
    expect(failed.body).toMatchObject({ status: 'FAILED', reservationActive: true });
    expect(await withdrawable(person.client)).toBe(6000n);

    // The requester cannot cancel once a transfer has been attempted.
    const cancel = await person.client.post(`${OWN}/${id}/cancel`, {});
    expectStatus(cancel, 409, 'Cancel after failure');

    // Retry: a second, append-only attempt.
    expectStatus(await startExecution(financeB, id), 200, 'Retry');
    current = await detail(financeB, id);
    expect(
      current.body.attempts.map((a: { attemptNumber: number; outcome: string }) => [
        a.attemptNumber,
        a.outcome,
      ]),
    ).toEqual([
      [1, 'FAILED'],
      [2, 'IN_PROGRESS'],
    ]);
    expectStatus(
      await financeB.post(`${ADMIN}/${id}/mark-failed`, {
        expectedVersion: current.body.version,
        note: 'Returned again.',
      }),
      200,
      'Fail again',
    );

    // Release needs a reason, then gives the money back.
    current = await detail(financeA, id);
    const noReason = await financeA.post(`${ADMIN}/${id}/release`, {
      expectedVersion: current.body.version,
      note: '   ',
    });
    expectStatus(noReason, 400, 'Release without reason');
    const released = await financeA.post(`${ADMIN}/${id}/release`, {
      expectedVersion: current.body.version,
      note: 'Customer to provide a new account.',
    });
    expectStatus(released, 200, 'Release');
    expect(released.body).toMatchObject({ status: 'CANCELLED', reservationActive: false });
    expect(await withdrawable(person.client)).toBe(10000n);
    expect(
      await context.adminDb.creditLedgerEntry.count({ where: { entryType: 'WITHDRAWAL_DEBIT' } }),
    ).toBe(0);
  });

  it('enforces separation of duties for every scope (D8)', async () => {
    // A finance user withdrawing their own money cannot approve it.
    const financeAId = await userIdOf(context, 'finance.a@palcert.test');
    await manualTopUp(admin, financeB, financeA, '10000');
    const destination = await createDestination(financeA);
    const own = await submit(financeA, destination.id, '1000');
    expectStatus(own, 201, 'Finance user’s own withdrawal');
    const self = await approve(financeA, own.body.id as string, '1000');
    expectStatus(self, 403, 'Self approval');
    expect(self.body.error.code).toBe('WITHDRAWAL_SEPARATION_OF_DUTIES');
    expect((await detail(financeA, own.body.id as string)).body.allowedActions).toEqual([]);

    // A PalCert administrator holds no approval permission.
    const byAdmin = await admin.post(`${ADMIN}/${own.body.id}/approve`, {
      expectedVersion: 2,
      confirmAmountMinorUnits: '1000',
      confirmCurrency: 'USD',
    });
    expectStatus(byAdmin, 403, 'Admin approval');

    // One finance user approving and executing a user payout needs a fresh
    // re-authentication after the approval.
    const person = await createUser(context, 'person@example.test');
    await manualTopUp(
      admin,
      financeA,
      person.client,
      '10000',
      (await context.adminDb.manualPaymentMethod.findFirstOrThrow()).id,
    );
    const personDestination = await createDestination(person.client);
    const submitted = await submit(person.client, personDestination.id, '2000');
    const id = submitted.body.id as string;
    expectStatus(await approve(financeB, id, '2000'), 200, 'Approve');
    const tooSoon = await startExecution(financeB, id);
    expectStatus(tooSoon, 401, 'Execution without re-authentication');
    expect(tooSoon.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    await reauthenticate(context, await userIdOf(context, 'finance.b@palcert.test'));
    expectStatus(await startExecution(financeB, id), 200, 'Execution after re-authentication');
    void financeAId;
  });

  it('alerts finance and the requester, with no account details in any email (§20, §34)', async () => {
    const person = await createUser(context, 'person@example.test');
    await manualTopUp(admin, financeA, person.client, '10000');
    await drainNotifications(context);
    context.emailProvider.reset();

    const destination = await createDestination(person.client);
    const submitted = await submit(person.client, destination.id, '5000');
    const id = submitted.body.id as string;
    await drainNotifications(context);

    const alert = context.emailProvider.lastTo('finance.a@palcert.test');
    expect(alert?.subject).toBe('Withdrawal request: 50.00 USD');
    expect(alert?.text).toContain('Beneficiary: Lina Haddad');
    expect(alert?.text).toContain('Requester:');
    expect(alert?.text).toContain(`/en/admin/withdrawals/${id}`);
    const receipt = context.emailProvider.lastTo('person@example.test');
    expect(receipt?.subject).toBe('Your withdrawal request was submitted: 50.00 USD');
    expect(receipt?.text).toContain(`/en/balance/withdrawals/${id}`);
    for (const message of context.emailProvider.all()) {
      const text = `${message.subject} ${message.text} ${message.html}`;
      expect(text).not.toContain(IBAN_A);
      expect(text).not.toContain('5432');
      expect(message).not.toHaveProperty('attachments');
    }

    const report = await financeA.get(`${ADMIN}/${id}/notifications`);
    expectStatus(report, 200, 'Notification report');
    expect(report.body.routing).toBe('GLOBAL_NOT_CONFIGURED');
    const types = (report.body.recipients as Array<{ notificationType: string }>).map(
      (r) => r.notificationType,
    );
    expect(types).toEqual(
      expect.arrayContaining(['WITHDRAWAL_PENDING_REVIEW', 'WITHDRAWAL_SUBMITTED']),
    );

    // Paid is announced to the requester too.
    expectStatus(await approve(financeA, id, '5000'), 200, 'Approve');
    expectStatus(await startExecution(financeB, id), 200, 'Start');
    expectStatus(await markPaid(financeB, id, '5000'), 200, 'Paid');
    await drainNotifications(context);
    expect(context.emailProvider.lastTo('person@example.test')?.subject).toBe(
      'Your withdrawal was paid: 50.00 USD',
    );
  });

  it('routes alerts to assigned reviewers and falls back when none qualifies (§19)', async () => {
    const financeBId = await userIdOf(context, 'finance.b@palcert.test');
    const assigned = await admin.put(`${SETTINGS}/reviewers`, { userIds: [financeBId] });
    expectStatus(assigned, 200, 'Assign reviewer');
    const person = await createUser(context, 'person@example.test');
    await manualTopUp(admin, financeA, person.client, '10000');
    await drainNotifications(context);
    context.emailProvider.reset();

    const destination = await createDestination(person.client);
    const submitted = await submit(person.client, destination.id, '1000');
    await drainNotifications(context);
    expect(context.emailProvider.lastTo('finance.b@palcert.test')).toBeDefined();
    expect(context.emailProvider.lastTo('finance.a@palcert.test')).toBeUndefined();
    const report = await financeA.get(`${ADMIN}/${submitted.body.id}/notifications`);
    expect(report.body.routing).toBe('ASSIGNED_REVIEWERS');

    // Somebody who is not a finance reviewer cannot be assigned.
    const refused = await admin.put(`${SETTINGS}/reviewers`, { userIds: [person.userId] });
    expectStatus(refused, 400, 'Ineligible reviewer');
    void enabledMethod;
  });
});
