import { CreditClass, CreditHoldPurpose } from '@palcert/contracts';
import { ApiConfigService } from '../src/config/api-config.service';
import { TenantPrismaService } from '../src/infrastructure/tenant/tenant-prisma.service';
import { CreditHoldService } from '../src/modules/finance/services/credit-hold.service';
import { ServicePurchaseService } from '../src/modules/finance/services/service-purchase.service';
import { ensureAIPrice, quoteForAI } from './support/ai-billing-client';
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
import { signIn, type AuthClient } from './support/auth-client';
import { expectStatus } from './support/checks-client';
import {
  deliverWebhook,
  disputeOpened,
  drainPaymentJobs,
  fundBalance,
} from './support/finance-client';
import { drainNotifications } from './support/manual-topup-client';
import { grantCredit } from './support/paid-check-client';
import {
  PASSWORD,
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
  IBAN_A,
  OWN,
  OWN_DESTINATIONS,
  PLATFORM,
  SETTINGS,
  approve,
  bankDestination,
  createDestination,
  detail,
  manualTopUp,
  markPaid,
  reauthenticate,
  userIdOf,
  orgPayouts,
  setClearing,
  startExecution,
  submit,
  withdrawable,
} from './support/withdrawal-client';

/**
 * The withdrawal guarantees, each proven on its own (ADR-0150): who is told
 * and where they land, what is withdrawable at each scope, who may act, that
 * money settles exactly once, that a failed transfer stays reserved, that
 * account details never leak, and that racing requests cannot overspend.
 */
describe('Withdrawals — guarantees (e2e)', () => {
  let context: TestContext;
  let admin: AuthClient;
  let financeA: AuthClient;
  let financeB: AuthClient;
  let financeC: AuthClient;
  let financeD: AuthClient;

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
    financeD = await signInGlobalRole(context, 'finance.d@palcert.test', 'PALCERT_FINANCE');
    await setClearing(admin, 0, 0);
  });

  // --- shared fixtures ------------------------------------------------------

  /** One attestation of `fee`, settled: the institution's net share and PalCert's commission. */
  async function settledAttestation(
    percent: string,
    fee = '100000',
    name = 'University A',
    owner = 'owner@university.test',
    applicantEmail = 'applicant@example.test',
  ): Promise<Institution & { applicantUserId: string; paymentId: string }> {
    const university = await createInstitution(context, name, owner, { feeMinorUnits: fee });
    expectStatus(await setCommission(admin, university.organizationId, percent), 200, 'Commission');
    const applicant = await createUser(context, applicantEmail);
    const { paymentId } = await fundBalance(context, applicant.client, fee);
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
    return { ...university, applicantUserId: applicant.userId, paymentId };
  }

  async function orgRow(client: AuthClient, organizationId: string) {
    const earnings = await client.get(`${orgPayouts(organizationId)}/earnings`);
    expectStatus(earnings, 200, 'Earnings');
    return (earnings.body.rows as Array<Record<string, { minorUnits: string }>>).find(
      (row) => (row.currency as unknown as string) === 'USD',
    )!;
  }

  async function platformRow(client: AuthClient) {
    const funds = await client.get(PLATFORM);
    expectStatus(funds, 200, 'Platform funds');
    return (funds.body.rows as Array<Record<string, { minorUnits: string }>>).find(
      (row) => (row.currency as unknown as string) === 'USD',
    );
  }

  const minor = (view: { minorUnits: string } | undefined) => BigInt(view?.minorUnits ?? '0');

  async function holdFor(userId: string, amountMinor: bigint, purpose = CreditHoldPurpose.SERVICE) {
    const tenant = context.app.get(TenantPrismaService);
    const holds = context.app.get(CreditHoldService);
    return tenant.withUser(userId, (tx) =>
      holds.create(tx, {
        ownerUserId: userId,
        currency: 'USD',
        creditClass: CreditClass.CASH,
        amountMinor,
        purpose,
      }),
    );
  }

  async function releaseHold(userId: string, holdId: string) {
    const tenant = context.app.get(TenantPrismaService);
    const holds = context.app.get(CreditHoldService);
    await tenant.withUser(userId, (tx) => holds.release(tx, holdId));
  }

  /** A delivered service purchase, funded the way the purchase domain funds it. */
  async function deliveredPurchase(userId: string, price: bigint): Promise<void> {
    await ensureAIPrice(context, 'AI_REVIEW', price);
    const quote = await quoteForAI(context, userId, 'AI_REVIEW');
    const row = await context.adminDb.priceQuote.findUniqueOrThrow({ where: { id: quote.id } });
    const tenant = context.app.get(TenantPrismaService);
    const purchases = context.app.get(ServicePurchaseService);
    await tenant.withUser(userId, async (tx) => {
      const purchase = await purchases.reserve(tx, {
        ownerUserId: userId,
        purchaseId: crypto.randomUUID(),
        productCode: 'AI_REVIEW',
        resourceType: 'AI_REVIEW',
        resourceId: crypto.randomUUID(),
        quote: {
          id: row.id,
          priceVersionId: row.priceVersionId,
          currency: row.currency,
          amountMinor: row.amountMinor,
        },
      });
      await purchases.markProcessing(tx, purchase.id);
      await purchases.captureOnDelivery(tx, purchase.id);
    });
  }

  async function staleSession(email: string): Promise<void> {
    const window = context.app.get(ApiConfigService).sessionPolicy.reauthWindowMinutes;
    const user = await context.adminDb.user.findFirstOrThrow({ where: { email } });
    const old = new Date(context.clock.now().getTime() - (window + 5) * 60_000);
    await context.adminDb.$executeRawUnsafe('SET row_security = off');
    await context.adminDb.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { mfaCompletedAt: old },
    });
  }

  async function notificationsFor(requestId: string) {
    await drainNotifications(context);
    const rows = await context.adminDb.userNotification.findMany({
      where: { deepLink: { endsWith: requestId } },
      include: { recipient: { select: { email: true } } },
    });
    return rows.map((row) => ({
      type: row.notificationType as string,
      email: row.recipient.email,
      link: row.deepLink,
    }));
  }

  // --- 1. Notification deep links ------------------------------------------

  describe('notification deep links by audience', () => {
    it('sends a person to their balance and finance to the queue (USER)', async () => {
      const person = await createUser(context, 'person@example.test');
      await manualTopUp(admin, financeA, person.client, '10000');
      const destination = await createDestination(person.client);
      const id = (await submit(person.client, destination.id, '1000')).body.id as string;

      const rows = await notificationsFor(id);
      const requester = rows.filter((row) => row.email === 'person@example.test');
      expect(requester.map((row) => row.type)).toEqual(['WITHDRAWAL_SUBMITTED']);
      expect(requester[0]!.link).toBe(`/en/balance/withdrawals/${id}`);
      const reviewers = rows.filter((row) => row.type === 'WITHDRAWAL_PENDING_REVIEW');
      expect(reviewers.length).toBeGreaterThanOrEqual(4);
      for (const row of reviewers) expect(row.link).toBe(`/en/admin/withdrawals/${id}`);
      expect(
        rows.some((row) => row.email === 'person@example.test' && row.link.includes('/admin/')),
      ).toBe(false);
    });

    it('sends an organization requester to the organization payout page (ORGANIZATION)', async () => {
      const university = await settledAttestation('10');
      const base = orgPayouts(university.organizationId);
      const destination = await createDestination(university.owner.client, `${base}/destinations`);
      const id = (await submit(university.owner.client, destination.id, '1000', base)).body
        .id as string;
      expectStatus(await approve(financeA, id, '1000'), 200, 'Approve');

      const rows = await notificationsFor(id);
      const owner = rows.filter((row) => row.email === 'owner@university.test');
      expect(owner.map((row) => row.type).sort()).toEqual([
        'WITHDRAWAL_APPROVED',
        'WITHDRAWAL_SUBMITTED',
      ]);
      for (const row of owner) {
        expect(row.link).toBe(`/en/organizations/${university.organizationId}/payouts/${id}`);
      }
      for (const row of rows.filter((r) => r.type === 'WITHDRAWAL_PENDING_REVIEW')) {
        expect(row.link).toBe(`/en/admin/withdrawals/${id}`);
      }
    });

    it('never alerts a requester to review their own request (PLATFORM)', async () => {
      await settledAttestation('10');
      const treasury = await createDestination(financeA, `${PLATFORM}/destinations`);
      const id = (await submit(financeA, treasury.id, '1000', `${PLATFORM}/withdrawals`)).body
        .id as string;

      const rows = await notificationsFor(id);
      // The requester (a finance user) gets the receipt only, on the PalCert payout page.
      expect(rows.filter((row) => row.email === 'finance.a@palcert.test')).toEqual([
        {
          type: 'WITHDRAWAL_SUBMITTED',
          email: 'finance.a@palcert.test',
          link: `/en/admin/withdrawals/${id}`,
        },
      ]);
      const reviewers = rows
        .filter((row) => row.type === 'WITHDRAWAL_PENDING_REVIEW')
        .map((row) => row.email);
      expect(reviewers.sort()).toEqual([
        'finance.b@palcert.test',
        'finance.c@palcert.test',
        'finance.d@palcert.test',
      ]);
    });
  });

  // --- 3. USER withdrawability ------------------------------------------------

  it('counts only cleared manual top-ups, net of holds and reservations (USER, D1–D3)', async () => {
    await setClearing(admin, 14, 0);
    const person = await createUser(context, 'person@example.test');
    await manualTopUp(admin, financeA, person.client, '10000');
    const view = async () =>
      (await person.client.get(`/api/v1/balance/withdrawable?currency=USD`)).body;

    // Inside the clearing period: nothing yet.
    expect(await view()).toMatchObject({
      withdrawable: { minorUnits: '0' },
      clearing: { minorUnits: '10000' },
    });
    context.clock.set(new Date(context.clock.now().getTime() + 15 * 86_400_000));
    const client = await signIn(context, 'person@example.test', PASSWORD);
    // Fifteen days on, staff sessions have expired too: a fresh finance user.
    const finance = await signInGlobalRole(context, 'finance.e@palcert.test', 'PALCERT_FINANCE');
    const read = async () => (await client.get(`/api/v1/balance/withdrawable?currency=USD`)).body;
    expect(await withdrawable(client)).toBe(10000n);

    // An active service hold reduces it…
    const hold = await holdFor(person.userId, 3000n);
    expect(await withdrawable(client)).toBe(7000n);
    // …and so does an active withdrawal reservation.
    const destination = await createDestination(client);
    expectStatus(await submit(client, destination.id, '2000'), 201, 'Reserve');
    expect(await withdrawable(client)).toBe(5000n);
    await releaseHold(person.userId, hold.id);
    expect(await withdrawable(client)).toBe(8000n);

    // PROMOTIONAL, ADMIN_CREDIT and a card TOP_UP_CREDIT add spendable money, never withdrawable money.
    const adjust = (creditClass: 'CASH' | 'PROMOTIONAL', key: string) =>
      finance.post('/api/v1/admin/finance/adjustments', {
        ownerUserId: person.userId,
        currency: 'USD',
        creditClass,
        amountMinorUnits: '5000',
        reasonCode: creditClass === 'CASH' ? 'GOODWILL' : 'PROMOTION',
        idempotencyKey: key,
      });
    expectStatus(await adjust('PROMOTIONAL', 'promo'), 201, 'Promotional credit');
    expect(await withdrawable(client)).toBe(8000n);
    expectStatus(await adjust('CASH', 'goodwill'), 201, 'Admin credit');
    expect(await withdrawable(client)).toBe(8000n);
    const card = await fundBalance(context, client, '20000');
    expect(await withdrawable(client)).toBe(8000n);
    const after = await read();
    expect(after.promotionalBalance.minorUnits).toBe('5000');
    expect(BigInt(after.cashBalance.minorUnits)).toBe(35000n);
    expect(
      await context.adminDb.creditLedgerEntry.count({
        where: { ownerUserId: person.userId, entryType: 'TOP_UP_CREDIT' },
      }),
    ).toBe(1);

    // Card money leaves by the refund path, back to the card — never as a payout.
    const tooMuch = await submit(client, destination.id, '8001');
    expectStatus(tooMuch, 409, 'Card money as payout');
    const refund = await finance.post('/api/v1/admin/finance/refunds', {
      topUpId: card.topUpId,
      amountMinorUnits: '20000',
      reason: 'REQUESTED_BY_CUSTOMER',
    });
    expectStatus(refund, 201, 'Card refund');
    expect(refund.body.status).toBe('SUCCEEDED');
    expect(context.paymentProvider.refunds).toHaveLength(1);
    // Conservative by design: every CASH outflow, the card refund included, is
    // assumed to have spent eligible money first (ADR-0150 §4, D1).
    expect(await withdrawable(client)).toBe(0n);
  });

  // --- 4. ORGANIZATION payout -------------------------------------------------

  it('pays an organization only its settled net share, after clearing, to its owner (D4, D6)', async () => {
    await setClearing(admin, 0, 30);
    const university = await settledAttestation('15');
    // $1,000 fee, 15% commission: $850 institution share, $150 PalCert commission.
    const revenue = await context.adminDb.attestationRevenueEntry.findMany({
      where: { organizationId: university.organizationId },
    });
    expect(Object.fromEntries(revenue.map((e) => [e.account, e.amountMinor]))).toEqual({
      INSTITUTION: 85000n,
      PLATFORM_COMMISSION: 15000n,
    });

    let row = await orgRow(university.owner.client, university.organizationId);
    expect([minor(row.realized), minor(row.clearing), minor(row.available)]).toEqual([
      85000n,
      85000n,
      0n,
    ]);
    const base = orgPayouts(university.organizationId);
    const destination = await createDestination(university.owner.client, `${base}/destinations`);
    expectStatus(
      await submit(university.owner.client, destination.id, '100', base),
      409,
      'Inside clearing',
    );

    context.clock.set(new Date(context.clock.now().getTime() + 31 * 86_400_000));
    const owner = await signIn(context, 'owner@university.test', PASSWORD);
    row = await orgRow(owner, university.organizationId);
    // Never the gross fee and never PalCert's commission.
    expect([minor(row.clearing), minor(row.available)]).toEqual([0n, 85000n]);
    expectStatus(await submit(owner, destination.id, '85001', base), 409, 'Above net share');
    expectStatus(await submit(owner, destination.id, '85000', base), 201, 'Whole net share');

    // Only ORGANIZATION_OWNER holds the request permission by default.
    const holders = await context.adminDb.rolePermission.findMany({
      where: { permission: { code: 'organization:withdrawal:request' } },
      include: { role: { select: { code: true } } },
    });
    expect(holders.map((h) => h.role.code)).toEqual(['ORGANIZATION_OWNER']);
    const member = await createUser(context, 'admin@university.test');
    await grantOrganizationRoleTo(
      context,
      { ...university, owner: { ...university.owner, client: owner } },
      member,
      'ORGANIZATION_ADMIN',
    );
    expectStatus(
      await submit(member.client, destination.id, '100', base),
      403,
      'Org admin requests',
    );

    // Organization B reaches none of A's payout data.
    const other = await createInstitution(context, 'University B', 'owner@other.test');
    for (const path of [`${base}/earnings`, `${base}`, `${base}/destinations`]) {
      expect([403, 404]).toContain((await other.owner.client.get(path)).status);
    }
    const listed = await other.owner.client.get(orgPayouts(other.organizationId));
    expectStatus(listed, 200, 'Own list');
    expect(listed.body.items).toEqual([]);
  });

  // --- 5. PLATFORM payout -----------------------------------------------------

  it('counts only CASH-funded captures and settled commission, less chargeback losses (D5)', async () => {
    const spender = await createUser(context, 'spender@example.test');
    // A promotional-funded capture: PalCert received nothing, so it is not revenue.
    await grantCredit(context, spender.userId, 5000n, CreditClass.PROMOTIONAL);
    await deliveredPurchase(spender.userId, 3000n);
    expect(minor((await platformRow(financeA))?.cashServiceRevenue)).toBe(0n);
    // A CASH-funded capture of the same service is.
    await grantCredit(context, spender.userId, 5000n, CreditClass.CASH);
    await deliveredPurchase(spender.userId, 4000n); // 2000 promotional left, then 2000 cash
    let row = await platformRow(financeA);
    expect(minor(row?.cashServiceRevenue)).toBe(2000n);

    // Settled attestation commission counts; the institution's share does not.
    const university = await settledAttestation('10');
    row = await platformRow(financeA);
    expect([
      minor(row?.attestationCommission),
      minor(row?.realized),
      minor(row?.available),
    ]).toEqual([10000n, 12000n, 12000n]);

    // The applicant's card payment is charged back after the money was spent:
    // an unrecovered loss that PalCert absorbs, so it cannot be paid out.
    await deliverWebhook(
      context,
      disputeOpened({
        eventId: 'evt_dispute_1',
        disputeId: 'dp_1',
        paymentId: university.paymentId,
        amountMinorUnits: '100000',
      }),
    );
    await drainPaymentJobs(context);
    row = await platformRow(financeA);
    expect(minor(row?.unrecoveredChargebackLoss)).toBe(100000n);
    expect([minor(row?.realized), minor(row?.available)]).toEqual([0n, 0n]);
    const treasury = await createDestination(financeA, `${PLATFORM}/destinations`);
    expectStatus(
      await submit(financeA, treasury.id, '1', `${PLATFORM}/withdrawals`),
      409,
      'Nothing realized',
    );
  });

  it('needs three different people with the right permissions and a fresh sign-in (PLATFORM, D8)', async () => {
    await settledAttestation('10');
    const auditor = await signInGlobalRole(context, 'auditor@palcert.test', 'PALCERT_AUDITOR');
    const treasury = await createDestination(financeA, `${PLATFORM}/destinations`);
    expectStatus(
      await submit(auditor, treasury.id, '1000', `${PLATFORM}/withdrawals`),
      403,
      'Auditor requests',
    );
    const id = (await submit(financeA, treasury.id, '1000', `${PLATFORM}/withdrawals`)).body
      .id as string;

    // Permission: an auditor can read the queue but not act.
    expectStatus(await auditor.get(`${ADMIN}/${id}`), 200, 'Auditor reads');
    expectStatus(await approve(auditor, id, '1000'), 403, 'Auditor approves');
    // Recent authentication: a stale session is asked to sign in again.
    await staleSession('finance.b@palcert.test');
    const stale = await approve(financeB, id, '1000');
    expectStatus(stale, 401, 'Stale approver');
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expectStatus(await approve(financeA, id, '1000'), 403, 'Requester approves');
    expectStatus(await approve(financeC, id, '1000'), 200, 'Second person approves');

    expectStatus(await startExecution(auditor, id), 403, 'Auditor executes');
    expectStatus(await startExecution(financeA, id), 403, 'Requester executes');
    expectStatus(await startExecution(financeC, id), 403, 'Approver executes');
    await staleSession('finance.d@palcert.test');
    expectStatus(await startExecution(financeD, id), 401, 'Stale executor');
    const financeDId = await userIdOf(context, 'finance.d@palcert.test');
    await reauthenticate(context, financeDId);
    expectStatus(await startExecution(financeD, id), 200, 'Third person starts');
    await staleSession('finance.d@palcert.test');
    expectStatus(await markPaid(financeD, id, '1000'), 401, 'Stale mark-paid');
    await reauthenticate(context, financeDId);
    expectStatus(await markPaid(financeD, id, '1000'), 200, 'Third person pays');
    const paid = await context.adminDb.withdrawalRequest.findUniqueOrThrow({ where: { id } });
    expect(new Set([paid.requesterUserId, paid.approvedByUserId, paid.executedByUserId]).size).toBe(
      3,
    );
  });

  // --- 6. Exactly-once settlement --------------------------------------------

  describe('exactly-once settlement', () => {
    async function race(id: string, amount: string) {
      // Two approvals of the same version at once: one decision.
      const current = await detail(financeA, id);
      const approvals = await Promise.all(
        [financeA, financeA].map((client) =>
          client.post(`${ADMIN}/${id}/approve`, {
            expectedVersion: current.body.version,
            confirmAmountMinorUnits: amount,
            confirmCurrency: 'USD',
          }),
        ),
      );
      // The same approver's duplicate is a replay of the one decision (200, no new event);
      // anyone else deciding again is refused.
      expect(approvals.map((r) => r.status)).toEqual([200, 200]);
      expect(approvals[0]!.body.version).toBe(approvals[1]!.body.version);
      expectStatus(await approve(financeA, id, amount), 200, 'Approve again (replay)');
      expectStatus(await approve(financeB, id, amount), 409, 'Someone else approves again');

      // Two executors start at once: one attempt.
      const approved = await detail(financeB, id);
      const starts = await Promise.all(
        [financeB, financeD].map((client) =>
          client.post(`${ADMIN}/${id}/start-execution`, { expectedVersion: approved.body.version }),
        ),
      );
      // One executor opens the attempt; the other is told it is taken.
      expect(starts.map((r) => r.status).sort()).toEqual([200, 409]);

      // Two executors record the payout at once, then again: one settlement.
      const processing = await detail(financeB, id);
      const body = {
        expectedVersion: processing.body.version,
        externalTransferReference: 'BANK-ONCE-1',
        confirmAmountMinorUnits: amount,
        confirmCurrency: 'USD',
      };
      const paid = await Promise.all(
        [financeB, financeD].map((client) => client.post(`${ADMIN}/${id}/mark-paid`, body)),
      );
      expect(paid.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
      for (const r of paid) expect([200, 409, 412]).toContain(r.status);
      expectStatus(await markPaid(financeB, id, amount, 'BANK-ONCE-1'), 200, 'Replay');

      const settlements = await context.adminDb.withdrawalSettlement.findMany({
        where: { requestId: id },
      });
      expect(settlements).toHaveLength(1);
      expect(settlements[0]!.idempotencyKey).toBe(`withdrawal:${id}:settle`);
      const events = await context.adminDb.withdrawalRequestEvent.groupBy({
        by: ['eventType'],
        where: { requestId: id },
        _count: true,
      });
      const count = Object.fromEntries(events.map((e) => [e.eventType, e._count]));
      expect([count.APPROVED, count.EXECUTION_STARTED, count.PAID]).toEqual([1, 1, 1]);
      return settlements[0]!;
    }

    it('settles a USER payout once, with one ledger debit', async () => {
      const person = await createUser(context, 'person@example.test');
      await manualTopUp(admin, financeA, person.client, '10000');
      const destination = await createDestination(person.client);
      const id = (await submit(person.client, destination.id, '3000')).body.id as string;
      const settlement = await race(id, '3000');
      const debits = await context.adminDb.creditLedgerEntry.findMany({
        where: { entryType: 'WITHDRAWAL_DEBIT' },
      });
      expect(debits).toHaveLength(1);
      expect(settlement.ledgerEntryId).toBe(debits[0]!.id);
      expect(await withdrawable(person.client)).toBe(7000n);
    });

    it('settles an ORGANIZATION payout once, consuming one reservation', async () => {
      const university = await settledAttestation('10');
      const base = orgPayouts(university.organizationId);
      const destination = await createDestination(university.owner.client, `${base}/destinations`);
      const id = (await submit(university.owner.client, destination.id, '30000', base)).body
        .id as string;
      const settlement = await race(id, '30000');
      const reservations = await context.adminDb.withdrawalReservation.findMany({
        where: { requestId: id },
      });
      expect(reservations.map((r) => r.status)).toEqual(['CONSUMED']);
      expect(settlement.reservationId).toBe(reservations[0]!.id);
      expect(
        minor((await orgRow(university.owner.client, university.organizationId)).available),
      ).toBe(60000n);
    });

    it('settles a PLATFORM payout once', async () => {
      await settledAttestation('10');
      const treasury = await createDestination(financeC, `${PLATFORM}/destinations`);
      const id = (await submit(financeC, treasury.id, '4000', `${PLATFORM}/withdrawals`)).body
        .id as string;
      await race(id, '4000');
      expect(minor((await platformRow(financeA))?.available)).toBe(6000n);
    });

    it('keeps the settlement key unique in the database', async () => {
      const indexes = await context.adminDb.$queryRawUnsafe<Array<{ indexdef: string }>>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'withdrawal_settlements' AND indexdef LIKE 'CREATE UNIQUE%'`,
      );
      const defs = indexes.map((i) => i.indexdef).join('\n');
      expect(defs).toMatch(/\(idempotency_key\)|\("idempotency_key"\)/);
      expect(defs).toMatch(/\(request_id\)|\("request_id"\)/);
    });
  });

  // --- 7. FAILED keeps the reservation ---------------------------------------

  it('never releases a FAILED payout by itself, however long it waits (D9)', async () => {
    const person = await createUser(context, 'person@example.test');
    await manualTopUp(admin, financeA, person.client, '10000');
    const destination = await createDestination(person.client);
    const id = (await submit(person.client, destination.id, '4000')).body.id as string;
    expectStatus(await approve(financeA, id, '4000'), 200, 'Approve');
    expectStatus(await startExecution(financeB, id), 200, 'Start');
    const current = await detail(financeB, id);
    expectStatus(
      await financeB.post(`${ADMIN}/${id}/mark-failed`, {
        expectedVersion: current.body.version,
        note: 'Returned by the bank.',
      }),
      200,
      'Failed',
    );

    // Ninety days and a hold sweep later, the money is still reserved.
    context.clock.set(new Date(context.clock.now().getTime() + 90 * 86_400_000));
    const tenant = context.app.get(TenantPrismaService);
    const holds = context.app.get(CreditHoldService);
    await tenant.withPlatformAdmin(
      { actorUserId: null as unknown as string, reason: 'test sweep' },
      (tx) => holds.expireDue(tx),
    );
    const hold = await context.adminDb.creditHold.findFirstOrThrow({
      where: { purpose: 'WITHDRAWAL', referenceId: id },
    });
    expect([hold.status, hold.expiresAt]).toEqual(['ACTIVE', null]);
    expect(
      (await context.adminDb.withdrawalRequest.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('FAILED');

    // Only finance, explicitly: release needs a reason (retry is proven in the journey suite).
    const finance = await signInGlobalRole(context, 'finance.e@palcert.test', 'PALCERT_FINANCE');
    const failed = await detail(finance, id);
    expectStatus(
      await finance.post(`${ADMIN}/${id}/release`, {
        expectedVersion: failed.body.version,
        note: '',
      }),
      400,
      'No reason',
    );
    const released = await finance.post(`${ADMIN}/${id}/release`, {
      expectedVersion: failed.body.version,
      note: 'New account needed.',
    });
    expectStatus(released, 200, 'Release');
    expect(released.body.status).toBe('CANCELLED');
    expect(
      (await context.adminDb.creditHold.findFirstOrThrow({ where: { id: hold.id } })).status,
    ).toBe('RELEASED');
  });

  // --- 8. No account details anywhere but the sealed rows --------------------

  it('keeps full account details out of rows, audit, notifications, emails and lists', async () => {
    const MOBILE = '+970599123456';
    const ACCOUNT = '00123456789012';
    const person = await createUser(context, 'person@example.test');
    await manualTopUp(admin, financeA, person.client, '10000');
    const bank = await createDestination(person.client);
    const wallet = await person.client.post(OWN_DESTINATIONS, {
      type: 'MOBILE_WALLET',
      label: 'Wallet',
      beneficiaryName: 'Lina Haddad',
      mobileNumber: MOBILE,
    });
    expectStatus(wallet, 201, 'Wallet');
    const account = await person.client.post(OWN_DESTINATIONS, {
      type: 'BANK_ACCOUNT',
      label: 'Account',
      beneficiaryName: 'Lina Haddad',
      bankName: 'Bank of Palestine',
      accountNumber: ACCOUNT,
    });
    expectStatus(account, 201, 'Account number');
    for (const destinationId of [bank.id, wallet.body.id, account.body.id]) {
      const id = (await submit(person.client, destinationId as string, '1000')).body.id as string;
      expectStatus(await approve(financeA, id, '1000'), 200, 'Approve');
      expectStatus(await startExecution(financeB, id), 200, 'Start');
      expectStatus(await markPaid(financeB, id, '1000'), 200, 'Paid');
    }
    // Finance looked at one full snapshot: audited, but the audit row holds no details.
    const anyRequest = await context.adminDb.withdrawalRequest.findFirstOrThrow();
    expectStatus(await financeA.get(`${ADMIN}/${anyRequest.id}/destination`), 200, 'Reveal');
    await drainNotifications(context);

    const secrets = [IBAN_A, MOBILE, ACCOUNT];
    const leaks = (text: string) =>
      secrets.filter((secret) => text.includes(secret) || text.includes(secret.replace('+', '')));

    const raw = await context.adminDb.$queryRawUnsafe<Array<{ row: string }>>(
      `SELECT row_to_json(t)::text AS "row" FROM "payout_destinations" t
       UNION ALL SELECT row_to_json(t)::text FROM "withdrawal_requests" t
       UNION ALL SELECT row_to_json(t)::text FROM "withdrawal_request_events" t
       UNION ALL SELECT row_to_json(t)::text FROM "withdrawal_settlements" t
       UNION ALL SELECT row_to_json(t)::text FROM "withdrawal_execution_attempts" t
       UNION ALL SELECT row_to_json(t)::text FROM "audit_events" t
       UNION ALL SELECT row_to_json(t)::text FROM "domain_events" t
       UNION ALL SELECT row_to_json(t)::text FROM "user_notifications" t
       UNION ALL SELECT row_to_json(t)::text FROM "notification_deliveries" t`,
    );
    expect(raw.flatMap((r) => leaks(r.row))).toEqual([]);
    const sealed = await context.adminDb.payoutDestination.findMany();
    expect(sealed.every((d) => d.detailsCiphertext.length > 0)).toBe(true);

    const mails = context.emailProvider.all();
    expect(mails.length).toBeGreaterThan(0);
    expect(mails.flatMap((m) => leaks(JSON.stringify(m)))).toEqual([]);
    expect(
      mails.every(
        (m) =>
          !('attachments' in m) || (m as { attachments?: unknown[] }).attachments?.length === 0,
      ),
    ).toBe(true);

    for (const [client, path] of [
      [person.client, OWN],
      [person.client, OWN_DESTINATIONS],
      [financeA, ADMIN],
      [financeA, `${ADMIN}/${anyRequest.id}`],
      [financeA, `${ADMIN}/${anyRequest.id}/notifications`],
    ] as const) {
      const response = await client.get(path);
      expectStatus(response, 200, path);
      expect(leaks(JSON.stringify(response.body))).toEqual([]);
    }
  });

  // --- 9. Racing requests ----------------------------------------------------

  it('lets one of two racing 80s reserve against 100 (USER and ORGANIZATION, §42)', async () => {
    const person = await createUser(context, 'person@example.test');
    await manualTopUp(admin, financeA, person.client, '10000');
    const destination = await createDestination(person.client);
    const users = await Promise.all([
      submit(person.client, destination.id, '8000'),
      submit(person.client, destination.id, '8000'),
    ]);
    expect(users.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await withdrawable(person.client)).toBe(2000n);

    const university = await settledAttestation('0', '10000');
    const base = orgPayouts(university.organizationId);
    const orgDestination = await createDestination(
      university.owner.client,
      `${base}/destinations`,
      bankDestination(),
    );
    const orgs = await Promise.all([
      submit(university.owner.client, orgDestination.id, '8000', base),
      submit(university.owner.client, orgDestination.id, '8000', base),
    ]);
    expect(orgs.map((r) => r.status).sort()).toEqual([201, 409]);
    const reserved = await context.adminDb.withdrawalReservation.findMany({
      where: { scope: 'ORGANIZATION', status: 'ACTIVE' },
    });
    expect(reserved.reduce((total, r) => total + r.amountMinor, 0n)).toBe(8000n);

    const reconciled = await financeA.post(`${SETTINGS}/reconciliation`);
    expect(reconciled.body).toMatchObject({ consistent: true, findings: [] });
  });
});
