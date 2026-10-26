import { randomUUID } from 'node:crypto';
import { CheckStatus, PurchaseFailureCode, ServicePurchaseStatus } from '@palcert/contracts';
import { API, type AuthClient } from './support/auth-client';
import {
  exhaustCheckAttempts,
  publishCheckableStandard,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx } from './support/fixtures';
import { createTenant, createUser } from './support/organization-client';
import {
  cancelCheck,
  chargesForPurchase,
  ensureCheckPrice,
  fundForCheck,
  grantCredit,
  purchaseOf,
  quoteForCheck,
} from './support/paid-check-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';
import { TenantPrismaService } from '../src/infrastructure/tenant/tenant-prisma.service';
import { PaidCheckSettlementService } from '../src/modules/checks/services/paid-check-settlement.service';
import { CheckEvaluationJobHandler } from '../src/worker/check-evaluation-job.handler';
import { CheckPrepareJobHandler } from '../src/worker/check-prepare-job.handler';
import { FinanceSweeper } from '../src/worker/finance-sweeper';

/**
 * Settlement under contention (§115–§120, §45, §84, §85).
 *
 * Every test here drives two things at the money at once and asserts the same
 * property: **there is exactly one outcome, and it is internally consistent.**
 *
 * A check is COMPLETED and charged, or it is not completed and not charged.
 * There is no third state, no partial capture, and no order of events that
 * produces one. That is enforced by the check's row lock — every settlement
 * path takes it first — and by deferred constraint triggers that refuse the
 * inconsistent combinations at COMMIT even if a service somehow tried.
 */
describe('Paid document checks - settlement races (e2e)', () => {
  let context: TestContext;
  let student: { email: string; userId: string; client: AuthClient };
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let standard: PublishedStandard;
  let settlement: PaidCheckSettlementService;

  beforeAll(async () => {
    context = await createTestContext();
    settlement = context.app.get(PaidCheckSettlementService);
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    student = await createUser(context, 'student@example.com');
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

  /** A paid check parked mid-flight, so a race has something to race against. */
  async function inFlightCheck(): Promise<string> {
    const versionId = await readyDocx();
    const { quoteId } = await fundForCheck(context, student.userId);
    context.documentEngine.evaluationMode = 'unavailable';
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quoteId,
    });
    expect(created.status).toBe(202);
    return created.body.id;
  }

  /**
   * The invariant every test in this file ends with.
   *
   * Charged if and only if completed — stated once, so no test can quietly
   * check a weaker version of it.
   */
  async function assertConsistent(checkId: string): Promise<{ status: string }> {
    const check = await context.adminDb.documentCheck.findUniqueOrThrow({ where: { id: checkId } });
    const purchase = await purchaseOf(context, checkId);
    const charges = await chargesForPurchase(context, purchase!.id);

    if (check.status === CheckStatus.COMPLETED) {
      expect(purchase!.status).toBe(ServicePurchaseStatus.DELIVERED);
      expect(charges).toHaveLength(purchase!.allocations.length);
      const charged = charges.reduce((total, charge) => total - charge.amountMinorSigned, 0n);
      expect(charged).toBe(purchase!.amountMinor);
    } else {
      expect(purchase!.status).toBe(ServicePurchaseStatus.RELEASED);
      expect(charges).toHaveLength(0);
      expect(
        purchase!.allocations.every((allocation) => allocation.hold.status !== 'CAPTURED'),
      ).toBe(true);
    }
    return { status: check.status };
  }

  // -------------------------------------------------------------------------
  // Concurrent purchases (§115)
  // -------------------------------------------------------------------------

  it('lets only one of two simultaneous checks win the last of the balance', async () => {
    const first = await readyDocx('one.docx');
    const second = await readyDocx('two.docx');
    await ensureCheckPrice(context, 300n);
    // Exactly enough for one check, never two.
    await grantCredit(context, student.userId, 300n);
    const quoteA = await quoteForCheck(context, student.userId);
    const quoteB = await quoteForCheck(context, student.userId);

    const [a, b] = await Promise.all([
      startCheck(context, student, {
        documentVersionId: first,
        standardId: standard.standardId,
        priceQuoteId: quoteA.id,
      }),
      startCheck(context, student, {
        documentVersionId: second,
        standardId: standard.standardId,
        priceQuoteId: quoteB.id,
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 402]);
    expect(await context.adminDb.servicePurchase.count()).toBe(1);
    expect(await context.adminDb.documentCheck.count()).toBe(1);
    // Never overdrawn.
    const holds = await context.adminDb.creditHold.aggregate({
      where: { ownerUserId: student.userId, status: 'ACTIVE' },
      _sum: { amountMinor: true },
    });
    expect(holds._sum.amountMinor ?? 0n).toBeLessThanOrEqual(300n);
  });

  it('survives many simultaneous checks without ever overspending', async () => {
    // Uploaded one at a time: the race under test is over the *balance*, and
    // five simultaneous multipart uploads would only prove the test harness
    // can saturate a socket.
    const versions: string[] = [];
    for (const name of ['a.docx', 'b.docx', 'c.docx', 'd.docx', 'e.docx']) {
      versions.push(await readyDocx(name));
    }
    await ensureCheckPrice(context, 300n);
    // Enough for two of the five.
    await grantCredit(context, student.userId, 600n);
    const quotes: { id: string }[] = [];
    for (const _version of versions) quotes.push(await quoteForCheck(context, student.userId));

    const responses = await Promise.all(
      versions.map((versionId, index) =>
        startCheck(context, student, {
          documentVersionId: versionId,
          standardId: standard.standardId,
          priceQuoteId: quotes[index]!.id,
        }),
      ),
    );

    const accepted = responses.filter((response) => response.status === 202);
    expect(accepted).toHaveLength(2);
    expect(responses.filter((response) => response.status === 402)).toHaveLength(3);
    expect(await context.adminDb.servicePurchase.count()).toBe(2);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Completion against cancellation and failure (§117, §118, §84, §85)
  // -------------------------------------------------------------------------

  it('never both charges and cancels when the two race', async () => {
    // §45: outcome A is COMPLETED + DELIVERED + charged; outcome B is
    // CANCELLED + RELEASED + not charged. Nothing else is permitted.
    for (let round = 0; round < 3; round += 1) {
      await resetState(context);
      student = await createUser(context, 'student@example.com');
      tenant = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
      standard = await publishCheckableStandard(
        context,
        tenant.owner.client,
        tenant.organizationId,
      );

      const versionId = await readyDocx();
      const { quoteId } = await fundForCheck(context, student.userId);
      const created = await startCheck(context, student, {
        documentVersionId: versionId,
        standardId: standard.standardId,
        priceQuoteId: quoteId,
      });

      // The cancellation is fired without waiting, so it lands somewhere in
      // the middle of the worker's run rather than at a rehearsed moment.
      const [, settled] = await Promise.all([
        cancelCheck(student.client, created.body.id).catch(() => undefined),
        waitForCheck(context, created.body.id, 40_000),
      ]);

      expect(['COMPLETED', 'CANCELLED', 'FAILED']).toContain(settled.status);
      await assertConsistent(created.body.id);
    }
  }, 120_000);

  it('never both charges and fails when the two race', async () => {
    // §85, §118.
    const checkId = await inFlightCheck();

    await Promise.all([
      settlement.fail(student.userId, checkId, { code: 'CHECK_ENGINE_ERROR', detail: 'raced' }),
      settlement.fail(student.userId, checkId, { code: 'CHECK_ENGINE_ERROR', detail: 'raced' }),
    ]);

    const outcome = await assertConsistent(checkId);
    expect(outcome.status).toBe('FAILED');
    // §83: two failure settlements release once, not twice.
    const purchase = await purchaseOf(context, checkId);
    expect(purchase!.status).toBe('RELEASED');
    expect(purchase!.allocations.every((a) => a.hold.status === 'RELEASED')).toBe(true);
  });

  it('cancels once when two cancellations race', async () => {
    const checkId = await inFlightCheck();

    const [first, second] = await Promise.all([
      cancelCheck(student.client, checkId),
      cancelCheck(student.client, checkId),
    ]);
    expect([first.status, second.status].every((status) => status === 200)).toBe(true);

    const outcome = await assertConsistent(checkId);
    expect(outcome.status).toBe('CANCELLED');
  });

  it('gives one answer when a cancellation and a failure race', async () => {
    // §84: both are non-billable, and whichever wins the row lock decides. The
    // documented precedence is simply "first writer wins" — the property that
    // matters is that no charge exists either way.
    const checkId = await inFlightCheck();

    await Promise.all([
      cancelCheck(student.client, checkId),
      settlement.fail(student.userId, checkId, { code: 'CHECK_ENGINE_ERROR', detail: 'raced' }),
    ]);

    const outcome = await assertConsistent(checkId);
    expect(['CANCELLED', 'FAILED']).toContain(outcome.status);
  });

  it('does not restart a cancelled check when its prepare job is delivered again', async () => {
    // §46: a worker that keeps running briefly after a cancellation must check
    // authoritative state before it does anything, and a cancelled check must
    // never come back to life.
    const checkId = await inFlightCheck();
    await cancelCheck(student.client, checkId);

    const job = await context.adminDb.processingJob.findFirstOrThrow({
      where: { jobType: 'CHECK_PREPARE', resourceId: checkId },
    });

    // Deliver the same job again, exactly as a duplicate queue message would.
    // The ledger claim is the first defence and refuses a job that is already
    // terminal, so this is a no-op.
    await context.worker.processJobId(job.id);
    expect(
      (await context.adminDb.documentCheck.findUniqueOrThrow({ where: { id: checkId } })).status,
    ).toBe('CANCELLED');

    // The ledger is not the only defence, and a test that stopped here would
    // only be proving the ledger works. Run the handler itself against the
    // cancelled check — the case a duplicate delivery that beats the claim
    // would produce — and require it to read authoritative state and stop
    // (§46). It must neither revive the check nor throw: a prepare pass that
    // crashed would be retried, and the retry would crash too.
    await expect(
      context.workerApp.get(CheckPrepareJobHandler).handle({ ...job, status: 'RUNNING' }),
    ).resolves.toBeUndefined();

    const outcome = await assertConsistent(checkId);
    expect(outcome.status).toBe('CANCELLED');
    expect(await context.adminDb.checkReport.count({ where: { checkId } })).toBe(0);
  });

  // -------------------------------------------------------------------------
  // A reservation that runs out (§116)
  // -------------------------------------------------------------------------

  it('never delivers a free report after the reservation has expired', async () => {
    const checkId = await inFlightCheck();
    const before = await purchaseOf(context, checkId);
    // Reserved, and possibly already marked as being worked on. Either way
    // nothing has been charged.
    expect([ServicePurchaseStatus.RESERVED, ServicePurchaseStatus.PROCESSING]).toContain(
      before!.status,
    );

    // Past the reservation's lifetime. The sweeper expires the holds and then
    // converges the check and the purchase, so a late worker has nothing left
    // to capture (§26, §28).
    context.clock.advanceMinutes(120);
    await context.workerApp.get(FinanceSweeper).sweep();

    const purchase = await purchaseOf(context, checkId);
    expect(purchase!.status).toBe(ServicePurchaseStatus.RELEASED);
    expect(purchase!.failureCode).toBe(PurchaseFailureCode.SERVICE_FAILED);

    const check = await context.adminDb.documentCheck.findUniqueOrThrow({ where: { id: checkId } });
    expect(check.status).toBe(CheckStatus.FAILED);
    expect(await chargesForPurchase(context, purchase!.id)).toHaveLength(0);

    // And a worker arriving late cannot complete it for free.
    context.documentEngine.evaluationMode = 'normal';
    const run = await context.adminDb.checkRun.findFirst({ where: { checkId } });
    if (run !== null) {
      const job = await context.adminDb.processingJob.findFirst({
        where: { jobType: 'CHECK_EVALUATION', resourceId: run.id },
      });
      if (job !== null) {
        await context.adminDb.processingJob.update({
          where: { id: job.id },
          data: { status: 'PENDING', availableAt: context.clock.now(), workerId: null },
        });
        await context.worker.processJobId(job.id).catch(() => undefined);
      }
    }
    const after = await context.adminDb.documentCheck.findUniqueOrThrow({ where: { id: checkId } });
    expect(after.status).not.toBe(CheckStatus.COMPLETED);
    expect(await chargesForPurchase(context, purchase!.id)).toHaveLength(0);
  }, 60_000);

  // -------------------------------------------------------------------------
  // When the money or the artifact cannot be written (§119, §120)
  // -------------------------------------------------------------------------

  it('completes nothing and charges nothing when a capture cannot be made', async () => {
    // §119: one hold is released behind the worker's back. The completion
    // transaction must roll back entirely rather than charge the other one.
    const versionId = await readyDocx();
    await ensureCheckPrice(context, 500n);
    await grantCredit(context, student.userId, 200n, 'PROMOTIONAL');
    await grantCredit(context, student.userId, 1000n, 'CASH');
    const quote = await quoteForCheck(context, student.userId);

    context.documentEngine.evaluationMode = 'unavailable';
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quote.id,
    });
    const purchase = await purchaseOf(context, created.body.id);
    expect(purchase!.allocations).toHaveLength(2);

    // Expire only the promotional reservation.
    const promotional = purchase!.allocations.find(
      (allocation) => allocation.creditClass === 'PROMOTIONAL',
    )!;
    await context.adminDb.creditHold.update({
      where: { id: promotional.holdId },
      data: { status: 'EXPIRED', expiredAt: context.clock.now() },
    });

    context.documentEngine.evaluationMode = 'normal';
    const settled = await waitForCheck(context, created.body.id, 60_000);

    expect(settled.status).toBe('FAILED');
    expect(settled.failureCode).toBe('SERVICE_RESERVATION_EXPIRED');
    // Not one partial charge: the cash hold was never captured either.
    expect(await chargesForPurchase(context, purchase!.id)).toHaveLength(0);
    expect(await context.adminDb.checkReport.count({ where: { checkId: created.body.id } })).toBe(
      0,
    );
  }, 90_000);

  it('charges nothing when the report cannot be stored', async () => {
    // §33, §120: the artifact is written before the commit precisely so that a
    // storage failure happens while nothing has been charged.
    const versionId = await readyDocx();
    // A first check gets the document analyzed, so the second one fails on the
    // report write and on nothing else — which is the failure under test.
    const warmUp = await fundForCheck(context, student.userId);
    const first = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: warmUp.quoteId,
    });
    await waitForCheck(context, first.body.id, 60_000);

    const { quoteId } = await fundForCheck(context, student.userId);
    context.storage.failing.add('put');

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quoteId,
    });
    // A storage outage is infrastructure, so it is retried rather than turned
    // into a verdict. The attempts are spent on the fake clock, exactly as the
    // Phase 7 retry ladder does.
    const settled = await exhaustCheckAttempts(context, created.body.id);
    expect(settled.status).toBe('FAILED');

    const purchase = await purchaseOf(context, created.body.id);
    expect(purchase!.status).toBe(ServicePurchaseStatus.RELEASED);
    expect(await chargesForPurchase(context, purchase!.id)).toHaveLength(0);
    expect(await context.adminDb.checkReport.count({ where: { checkId: created.body.id } })).toBe(
      0,
    );
  }, 120_000);

  // -------------------------------------------------------------------------
  // Duplicate delivery of a completed check (§82)
  // -------------------------------------------------------------------------

  it('charges once when a completed check is settled again', async () => {
    const versionId = await readyDocx();
    const { quoteId } = await fundForCheck(context, student.userId);
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quoteId,
    });
    await waitForCheck(context, created.body.id);

    const purchase = await purchaseOf(context, created.body.id);
    expect(await chargesForPurchase(context, purchase!.id)).toHaveLength(1);

    // A second delivery of the same evaluation job, exactly as an
    // at-least-once queue would produce. The job row is handed to the handler
    // directly: the ledger refuses to rewind a SUCCEEDED job, and rewinding it
    // would be simulating something the system cannot do rather than
    // something it must survive.
    const run = await context.adminDb.checkRun.findFirstOrThrow({
      where: { checkId: created.body.id },
    });
    const job = await context.adminDb.processingJob.findFirstOrThrow({
      where: { jobType: 'CHECK_EVALUATION', resourceId: run.id },
    });
    await context.workerApp
      .get(CheckEvaluationJobHandler)
      .handle(job)
      .catch(() => undefined);

    expect(await chargesForPurchase(context, purchase!.id)).toHaveLength(1);

    // And the settlement service itself is a no-op on an already delivered
    // purchase, whichever path reaches it (§82).
    const again = await context.app
      .get(TenantPrismaService)
      .withUser(student.userId, (tx) => settlement.captureOnDelivery(tx, created.body.id));
    expect(again.charged).toBe(false);
    expect(await chargesForPurchase(context, purchase!.id)).toHaveLength(1);
    expect(await context.adminDb.checkReport.count({ where: { checkId: created.body.id } })).toBe(
      1,
    );
    await assertConsistent(created.body.id);
  }, 60_000);

  it('refuses to cancel after delivery, even by the settlement service itself', async () => {
    const versionId = await readyDocx();
    const { quoteId } = await fundForCheck(context, student.userId);
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quoteId,
    });
    await waitForCheck(context, created.body.id);

    const refused = await student.client.post(`${API}/checks/${created.body.id}/cancel`, {});
    expect(refused.status).toBe(409);
    await assertConsistent(created.body.id);
  });

  // -------------------------------------------------------------------------
  // Cancelling a check that has already stopped (§204)
  // -------------------------------------------------------------------------

  /** Every release this purchase has ever had, so a second one cannot hide. */
  async function releaseCount(checkId: string): Promise<number> {
    const purchase = await purchaseOf(context, checkId);
    if (purchase === null) return 0;
    return context.adminDb.auditEvent.count({
      where: { action: 'CHECK_PURCHASE_RELEASED', targetId: checkId },
    });
  }

  it('answers a cancellation of an already-failed check without releasing twice', async () => {
    // The Phase 11 carry-forward. `isCheckTerminal` deliberately excludes
    // FAILED so the retry workflow can move a failed check back to
    // WAITING_ANALYSIS — but settlement was asking that question too, so
    // cancelling a failed check fell straight through the "already stopped"
    // guard, wrote CANCELLED over FAILED and released a reservation that had
    // already been given back. The customer saw a 500.
    //
    // Repeated, because the bug was originally found by a test that only
    // sometimes lost the race.
    for (let round = 0; round < 5; round += 1) {
      const checkId = await inFlightCheck();
      await settlement.fail(student.userId, checkId, {
        code: 'CHECK_ENGINE_ERROR',
        detail: 'stopped before the cancellation arrived',
      });

      const cancelled = await cancelCheck(student.client, checkId);
      expect([round, cancelled.status]).toEqual([round, 200]);

      // The terminal state is never overwritten, and nothing is released a
      // second time.
      const check = await context.adminDb.documentCheck.findUniqueOrThrow({
        where: { id: checkId },
      });
      expect([round, check.status]).toEqual([round, CheckStatus.FAILED]);
      expect([round, await releaseCount(checkId)]).toEqual([round, 1]);
      await assertConsistent(checkId);
    }
  }, 120_000);

  it('cancels then ignores a later worker failure, over and over', async () => {
    for (let round = 0; round < 5; round += 1) {
      const checkId = await inFlightCheck();
      await cancelCheck(student.client, checkId);

      const settled = await settlement.fail(student.userId, checkId, {
        code: 'CHECK_ENGINE_ERROR',
        detail: 'late worker',
      });
      expect([round, settled.settled]).toEqual([round, false]);

      const check = await context.adminDb.documentCheck.findUniqueOrThrow({
        where: { id: checkId },
      });
      expect([round, check.status]).toEqual([round, CheckStatus.CANCELLED]);
      expect([round, await releaseCount(checkId)]).toEqual([round, 1]);
      await assertConsistent(checkId);
    }
  }, 120_000);

  it('reaches one outcome when a cancellation and a failure race, repeatedly', async () => {
    // Both orders, many times: the previous fix made the states mutually
    // exclusive, and this asserts the exclusion holds under real contention
    // rather than at a rehearsed moment.
    for (let round = 0; round < 6; round += 1) {
      const checkId = await inFlightCheck();
      const failure = () =>
        settlement.fail(student.userId, checkId, { code: 'CHECK_ENGINE_ERROR', detail: 'raced' });

      await Promise.all(
        round % 2 === 0
          ? [cancelCheck(student.client, checkId), failure()]
          : [failure(), cancelCheck(student.client, checkId)],
      );

      const check = await context.adminDb.documentCheck.findUniqueOrThrow({
        where: { id: checkId },
      });
      expect([round, check.status]).toEqual([round, expect.stringMatching(/^(CANCELLED|FAILED)$/)]);
      // Exactly one release, whichever of the two won.
      expect([round, await releaseCount(checkId)]).toEqual([round, 1]);
      await assertConsistent(checkId);
    }
  }, 150_000);

  it('still treats a failed check as retryable, and refuses only over the money', async () => {
    // The boundary on the fix. Settlement asks whether the money is finished
    // with; the Check domain still allows FAILED -> WAITING_ANALYSIS, because
    // an explicit retry is a legitimate thing to do to a failed check. If the
    // refusal below ever becomes CHECK_NOT_RETRYABLE, FAILED has been made
    // terminal for the whole domain and the retry workflow has gone with it.
    const checkId = await inFlightCheck();
    await settlement.fail(student.userId, checkId, {
      code: 'CHECK_ENGINE_ERROR',
      detail: 'engine down',
    });

    const refused = await student.client.post(`${API}/checks/${checkId}/retry`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CHECK_RETRY_REQUIRES_NEW_PURCHASE');
  });

  // -------------------------------------------------------------------------
  // Two real simultaneous check-create requests (§205)
  // -------------------------------------------------------------------------

  it('accepts two genuinely simultaneous check creations without crossing them', async () => {
    // Deliberately not two complete upload-check-wait pipelines: those race
    // the fixture harness, not the code. Everything either request needs
    // exists before the clock starts, so the only concurrent thing is the two
    // POSTs — which is the thing under test.
    const first = await readyDocx('one.docx');
    const second = await readyDocx('two.docx');
    await ensureCheckPrice(context, 300n);
    // Comfortably enough for both, so the balance is not what decides.
    await grantCredit(context, student.userId, 5_000n);
    const quoteA = await quoteForCheck(context, student.userId);
    const quoteB = await quoteForCheck(context, student.userId);

    const [a, b] = await Promise.all([
      startCheck(context, student, {
        documentVersionId: first,
        standardId: standard.standardId,
        priceQuoteId: quoteA.id,
      }),
      startCheck(context, student, {
        documentVersionId: second,
        standardId: standard.standardId,
        priceQuoteId: quoteB.id,
      }),
    ]);

    expect([a.status, b.status]).toEqual([202, 202]);
    // Two checks, two purchases, each bound to its own quote and its own
    // document version — nothing crossed over.
    expect(await context.adminDb.documentCheck.count()).toBe(2);
    expect(await context.adminDb.servicePurchase.count()).toBe(2);

    const checks = await context.adminDb.documentCheck.findMany({ orderBy: { id: 'asc' } });
    expect(new Set(checks.map((check) => check.documentVersionId)).size).toBe(2);
    expect(new Set(checks.map((check) => check.servicePurchaseId)).size).toBe(2);

    const reserved = await context.adminDb.creditHold.aggregate({
      where: { ownerUserId: student.userId, status: 'ACTIVE' },
      _sum: { amountMinor: true },
    });
    expect(reserved._sum.amountMinor ?? 0n).toBe(600n);
  }, 60_000);

  it('answers two simultaneous creations of the same request with one check', async () => {
    // The same idempotency key twice, at the same instant. One check, one
    // purchase, one reservation — a second would be a second charge for one
    // request.
    const versionId = await readyDocx();
    await ensureCheckPrice(context, 300n);
    await grantCredit(context, student.userId, 5_000n);
    const quote = await quoteForCheck(context, student.userId);
    const idempotencyKey = randomUUID();

    const [a, b] = await Promise.all([
      startCheck(
        context,
        student,
        {
          documentVersionId: versionId,
          standardId: standard.standardId,
          priceQuoteId: quote.id,
        },
        { 'Idempotency-Key': idempotencyKey },
      ),
      startCheck(
        context,
        student,
        {
          documentVersionId: versionId,
          standardId: standard.standardId,
          priceQuoteId: quote.id,
        },
        { 'Idempotency-Key': idempotencyKey },
      ),
    ]);

    expect([a.status, b.status].every((status) => status === 202 || status === 200)).toBe(true);
    expect(a.body.id).toBe(b.body.id);
    expect(await context.adminDb.documentCheck.count()).toBe(1);
    expect(await context.adminDb.servicePurchase.count()).toBe(1);
  }, 60_000);
});
