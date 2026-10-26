import { CreditClass } from '@palcert/contracts';
import { API, type AuthClient } from './support/auth-client';
import {
  publishCheckableStandard,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { failResultFor } from './support/fake-document-engine';
import { minimalDocx } from './support/fixtures';
import { createTenant, createUser } from './support/organization-client';
import {
  CHECK_PRICE_MINOR,
  cancelCheck,
  chargesForPurchase,
  chargebackDebit,
  ensureCheckPrice,
  fundForCheck,
  grantCredit,
  purchaseOf,
  quoteForCheck,
  readCheck,
} from './support/paid-check-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * The paid check journey (§103–§110).
 *
 * One student, one thesis, one price, end to end. What each test here is
 * really asserting is a single sentence: **a check is charged for the
 * successful delivery of its report, and for nothing else.**
 *
 * Not for starting. Not for finishing badly. Not for a document that failed
 * its rules — that is a delivered service whose answer the customer did not
 * like, and refunding it would mean PalCert only charges for good news.
 */
describe('Paid document checks - journey (e2e)', () => {
  let context: TestContext;
  let student: { email: string; userId: string; client: AuthClient };
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

  /** Available balance, from the API the customer themselves would read. */
  async function available(currency = 'USD'): Promise<bigint> {
    const balance = await student.client.get(`${API}/balance?currency=${currency}`);
    return BigInt(balance.body.available.minorUnits);
  }

  // -------------------------------------------------------------------------
  // The golden journey (§103)
  // -------------------------------------------------------------------------

  it('reserves on creation, charges on delivery, and leaves the report untouched', async () => {
    const versionId = await readyDocx();
    await ensureCheckPrice(context, 300n);
    await grantCredit(context, student.userId, 1000n);
    expect(await available()).toBe(1000n);

    const quote = await quoteForCheck(context, student.userId);
    expect(quote.amountMinor).toBe(300n);

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quote.id,
    });
    expect(created.status).toBe(202);

    // Reserved, not charged. The customer can see both numbers and they mean
    // different things (§58).
    expect(created.body.billing).toMatchObject({
      status: expect.stringMatching(/RESERVED|PROCESSING/),
      amount: { currency: 'USD', minorUnits: '300' },
      reserved: { currency: 'USD', minorUnits: '300' },
      charged: { currency: 'USD', minorUnits: '0' },
    });
    expect(created.body.legacyFree).toBe(false);
    expect(await available()).toBe(700n);
    // Nothing has been spent: the reservation writes no ledger entry at all.
    expect(await chargesForPurchase(context, created.body.billing.purchaseId)).toHaveLength(0);

    const settled = await waitForCheck(context, created.body.id);
    expect(settled).toEqual({ status: 'COMPLETED', failureCode: null });

    const purchase = await purchaseOf(context, created.body.id);
    expect(purchase!.status).toBe('DELIVERED');
    expect(purchase!.amountMinor).toBe(300n);

    // One charge, for exactly the quoted amount, and the balance is now lower
    // by that and by nothing else.
    const charges = await chargesForPurchase(context, purchase!.id);
    expect(charges).toHaveLength(1);
    expect(charges[0]!.amountMinorSigned).toBe(-300n);
    expect(await available()).toBe(700n);

    const view = await readCheck(student.client, created.body.id);
    expect(view.body.billing).toMatchObject({
      status: 'DELIVERED',
      reserved: { minorUnits: '0' },
      charged: { minorUnits: '300' },
    });

    // And the report is exactly the report Phase 7 would have produced (§51).
    const report = await context.adminDb.checkReport.findFirstOrThrow({
      where: { checkId: created.body.id },
    });
    const artifact = await context.storage.getObjectBytes({
      zone: 'derived',
      key: report.artifactObjectKey,
      versionId: report.artifactObjectVersionId,
    });
    const canonical = artifact.toString('utf8');
    expect(canonical).not.toMatch(/price|purchase|hold|balance|charge|billing|amountMinor/i);
  });

  // -------------------------------------------------------------------------
  // A failing document is still a delivered service (§104)
  // -------------------------------------------------------------------------

  it('charges for a NON_COMPLIANT report exactly as for a compliant one', async () => {
    // §31, §96: the customer bought the analysis, not a passing result.
    const versionId = await readyDocx();
    context.documentEngine.evaluationResults = [failResultFor('MARGIN.TOP.MIN')];

    const { quoteId } = await fundForCheck(context, student.userId);
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quoteId,
    });
    const settled = await waitForCheck(context, created.body.id);
    expect(settled.status).toBe('COMPLETED');

    const run = await context.adminDb.checkRun.findFirstOrThrow({
      where: { checkId: created.body.id },
    });
    expect(run.determination).toBe('NON_COMPLIANT');

    const purchase = await purchaseOf(context, created.body.id);
    expect(purchase!.status).toBe('DELIVERED');
    expect(await chargesForPurchase(context, purchase!.id)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Failure and cancellation release (§105, §106)
  // -------------------------------------------------------------------------

  it('releases the reservation when the check fails, and charges nothing', async () => {
    const versionId = await readyDocx();
    await ensureCheckPrice(context, 300n);
    await grantCredit(context, student.userId, 1000n);
    const quote = await quoteForCheck(context, student.userId);

    // A permanent analyzer failure: PalCert's problem, not the customer's.
    context.documentEngine.mode = 'invalid-document';

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quote.id,
    });
    const settled = await waitForCheck(context, created.body.id, 40_000);
    expect(settled.status).toBe('FAILED');

    const purchase = await purchaseOf(context, created.body.id);
    expect(purchase!.status).toBe('RELEASED');
    expect(purchase!.failureCode).toBe('SERVICE_FAILED');
    expect(await chargesForPurchase(context, purchase!.id)).toHaveLength(0);
    // Every penny back, and it was never described as a refund (§60).
    expect(await available()).toBe(1000n);

    const view = await readCheck(student.client, created.body.id);
    expect(view.body.billing).toMatchObject({
      status: 'RELEASED',
      reserved: { minorUnits: '0' },
      charged: { minorUnits: '0' },
    });
  }, 60_000);

  it('releases the reservation when the customer cancels', async () => {
    const versionId = await readyDocx();
    await ensureCheckPrice(context, 300n);
    await grantCredit(context, student.userId, 1000n);
    const quote = await quoteForCheck(context, student.userId);

    // Hold the engine so the check is genuinely still in flight when the
    // customer changes their mind.
    context.documentEngine.evaluationMode = 'unavailable';
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quote.id,
    });
    expect(await available()).toBe(700n);

    const cancelled = await cancelCheck(student.client, created.body.id);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');

    const purchase = await purchaseOf(context, created.body.id);
    expect(purchase!.status).toBe('RELEASED');
    expect(purchase!.failureCode).toBe('CANCELLED_BY_CUSTOMER');
    expect(await chargesForPurchase(context, purchase!.id)).toHaveLength(0);
    expect(await available()).toBe(1000n);
  });

  it('refuses to cancel a check that has already produced a report', async () => {
    const versionId = await readyDocx();
    const { quoteId } = await fundForCheck(context, student.userId);
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quoteId,
    });
    await waitForCheck(context, created.body.id);

    const refused = await cancelCheck(student.client, created.body.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SERVICE_ALREADY_DELIVERED');

    const purchase = await purchaseOf(context, created.body.id);
    expect(purchase!.status).toBe('DELIVERED');
  });

  // -------------------------------------------------------------------------
  // Mixed credit (§107)
  // -------------------------------------------------------------------------

  it('spends promotional credit first, then cash, and captures each in its own class', async () => {
    const versionId = await readyDocx();
    await ensureCheckPrice(context, 500n);
    await grantCredit(context, student.userId, 200n, CreditClass.PROMOTIONAL);
    await grantCredit(context, student.userId, 1000n, CreditClass.CASH);

    const quote = await quoteForCheck(context, student.userId);
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quote.id,
    });

    const reserved = await purchaseOf(context, created.body.id);
    const byClass = Object.fromEntries(
      reserved!.allocations.map((allocation) => [allocation.creditClass, allocation.amountMinor]),
    );
    // §10: the promotional $2 goes first, and cash covers only the remainder.
    expect(byClass).toEqual({ PROMOTIONAL: 200n, CASH: 300n });

    await waitForCheck(context, created.body.id);

    const charges = await chargesForPurchase(context, reserved!.id);
    expect(charges).toHaveLength(2);
    const chargedByClass = Object.fromEntries(
      charges.map((charge) => [charge.creditClass, charge.amountMinorSigned]),
    );
    // Two ledger entries, one per class — the ledger stays the authority even
    // though the customer sees one $5 purchase (§65).
    expect(chargedByClass).toEqual({ PROMOTIONAL: -200n, CASH: -300n });

    const view = await readCheck(student.client, created.body.id);
    expect(view.body.billing.charged).toEqual({ currency: 'USD', minorUnits: '500' });
  });

  // -------------------------------------------------------------------------
  // Insufficient balance (§108)
  // -------------------------------------------------------------------------

  it('creates absolutely nothing when the balance is short', async () => {
    const versionId = await readyDocx();
    await ensureCheckPrice(context, 500n);
    await grantCredit(context, student.userId, 400n);
    const quote = await quoteForCheck(context, student.userId);

    const refused = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quote.id,
    });
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('INSUFFICIENT_BALANCE');

    // The whole transaction rolled back: no check, no purchase, no hold, no
    // job, and the quote is still spendable (§11, §108).
    expect(await context.adminDb.documentCheck.count()).toBe(0);
    expect(await context.adminDb.servicePurchase.count()).toBe(0);
    expect(await context.adminDb.creditHold.count()).toBe(0);
    expect(await context.adminDb.processingJob.count({ where: { jobType: 'CHECK_PREPARE' } })).toBe(
      0,
    );
    expect(await available()).toBe(400n);
  });

  it('refuses to buy a check on credit after a chargeback took the balance negative', async () => {
    // §91: a negative balance is not a borrowing facility.
    const versionId = await readyDocx();
    await ensureCheckPrice(context, 300n);
    await grantCredit(context, student.userId, 100n);
    await chargebackDebit(context, student.userId, 500n);
    const quote = await quoteForCheck(context, student.userId);

    const refused = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quote.id,
    });
    expect(refused.status).toBe(402);
    expect(await context.adminDb.servicePurchase.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Quotes (§109, §110)
  // -------------------------------------------------------------------------

  it('honours the quoted price after PalCert changes the price', async () => {
    // §15: the customer was shown $3 and is charged $3, even though every new
    // quote from now on says $4.
    const versionId = await readyDocx();
    await ensureCheckPrice(context, 300n);
    await grantCredit(context, student.userId, 1000n);
    const quote = await quoteForCheck(context, student.userId);
    expect(quote.amountMinor).toBe(300n);

    await ensureCheckPrice(context, 400n);
    const laterQuote = await quoteForCheck(context, student.userId);
    expect(laterQuote.amountMinor).toBe(400n);

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quote.id,
    });
    expect(created.body.billing.amount).toEqual({ currency: 'USD', minorUnits: '300' });

    await waitForCheck(context, created.body.id);
    const purchase = await purchaseOf(context, created.body.id);
    expect(purchase!.amountMinor).toBe(300n);
    expect((await chargesForPurchase(context, purchase!.id))[0]!.amountMinorSigned).toBe(-300n);
  });

  it('creates nothing from an expired quote', async () => {
    const versionId = await readyDocx();
    await ensureCheckPrice(context, 300n);
    await grantCredit(context, student.userId, 1000n);
    const quote = await quoteForCheck(context, student.userId);

    // Past the quote's thirty-minute deadline and comfortably inside the
    // session's hour, so what expires is the price and nothing else. The row
    // itself cannot be edited — a quote is immutable once issued (Phase 10
    // §32) — so the clock is the only honest way to get there.
    context.clock.advanceMinutes(45);

    const refused = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quote.id,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('QUOTE_EXPIRED');
    expect(await context.adminDb.documentCheck.count()).toBe(0);
    expect(await context.adminDb.servicePurchase.count()).toBe(0);
    expect(await context.adminDb.creditHold.count()).toBe(0);
  });

  it('spends a quote exactly once', async () => {
    // §16: a second intentional check needs a second quote.
    const versionId = await readyDocx();
    const { quoteId } = await fundForCheck(context, student.userId);

    const first = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quoteId,
    });
    expect(first.status).toBe(202);

    const second = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quoteId,
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('QUOTE_ALREADY_USED');
  });

  it('refuses a quote that belongs to somebody else', async () => {
    const stranger = await createUser(context, 'stranger@example.com');
    const versionId = await readyDocx();
    await ensureCheckPrice(context, 300n);
    await grantCredit(context, student.userId, 1000n);
    const theirQuote = await quoteForCheck(context, stranger.userId);

    const refused = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: theirQuote.id,
    });
    // The same answer a nonexistent quote gets: the difference would confirm
    // the id exists.
    expect(refused.status).toBe(404);
    expect(refused.body.error.code).toBe('QUOTE_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // Provider independence (§111)
  // -------------------------------------------------------------------------

  it('buys and completes a check while the payment provider is unavailable', async () => {
    // §1, §56: a customer with balance is not affected by a provider outage,
    // and nothing in the paid-check path may even ask the provider.
    const versionId = await readyDocx();
    const { quoteId } = await fundForCheck(context, student.userId);

    context.paymentProvider.mode = 'unavailable';
    context.paymentProvider.sessions.length = 0;

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quoteId,
    });
    expect(created.status).toBe(202);

    const settled = await waitForCheck(context, created.body.id);
    expect(settled.status).toBe('COMPLETED');

    const purchase = await purchaseOf(context, created.body.id);
    expect(purchase!.status).toBe('DELIVERED');
    // Not one provider call was made on the way.
    expect(context.paymentProvider.sessions).toHaveLength(0);
    expect(context.paymentProvider.refunds).toHaveLength(0);
  });

  it('says adding credit is unavailable without taking checks down with it', async () => {
    // §57: a provider outage stops top-ups and nothing else.
    const versionId = await readyDocx();
    const { quoteId } = await fundForCheck(context, student.userId);
    context.paymentProvider.mode = 'unavailable';

    const topUp = await student.client.post(`${API}/balance/top-ups`, {
      currency: 'USD',
      amountMinorUnits: '1000',
    });
    expect(topUp.status).toBe(503);

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quoteId,
    });
    expect(created.status).toBe(202);
    expect((await waitForCheck(context, created.body.id)).status).toBe('COMPLETED');
  });

  // -------------------------------------------------------------------------
  // Durability (§112, §113, §114)
  // -------------------------------------------------------------------------

  it('leaves a durable processing intent behind, committed with the purchase', async () => {
    // §22, §112: if the API process died one instruction after the commit, the
    // work would still start — because the intent is a row, not a promise.
    const versionId = await readyDocx();
    const { quoteId } = await fundForCheck(context, student.userId);

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quoteId,
    });

    const job = await context.adminDb.processingJob.findFirstOrThrow({
      where: { jobType: 'CHECK_PREPARE', resourceId: created.body.id },
    });
    expect(job.resourceType).toBe('DOCUMENT_CHECK');
    expect(job.ownerUserId).toBe(student.userId);
    await waitForCheck(context, created.body.id);
  });

  it('buys exactly one check however many times the request is retried', async () => {
    // §114.
    const versionId = await readyDocx();
    const { quoteId } = await fundForCheck(context, student.userId);
    const body = {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quoteId,
    };
    const headers = { 'Idempotency-Key': 'paid-retry-1' };

    const responses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      responses.push(await startCheck(context, student, body, headers));
    }
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);

    expect(await context.adminDb.documentCheck.count()).toBe(1);
    expect(await context.adminDb.servicePurchase.count()).toBe(1);
    expect(await context.adminDb.creditHold.count()).toBe(1);
    expect(await context.adminDb.processingJob.count({ where: { jobType: 'CHECK_PREPARE' } })).toBe(
      1,
    );
  });

  it('refuses the same idempotency key for a different quote', async () => {
    // §18: the key covers the whole commercial request.
    const versionId = await readyDocx();
    await ensureCheckPrice(context, CHECK_PRICE_MINOR);
    await grantCredit(context, student.userId, 5_000n);
    const first = await quoteForCheck(context, student.userId);
    const second = await quoteForCheck(context, student.userId);
    const headers = { 'Idempotency-Key': 'paid-retry-2' };

    await startCheck(
      context,
      student,
      { documentVersionId: versionId, standardId: standard.standardId, priceQuoteId: first.id },
      headers,
    );
    const conflicting = await startCheck(
      context,
      student,
      { documentVersionId: versionId, standardId: standard.standardId, priceQuoteId: second.id },
      headers,
    );
    expect(conflicting.status).toBe(422);
    expect(conflicting.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
