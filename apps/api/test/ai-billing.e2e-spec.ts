import { AIProviderPort } from '@palcert/contracts';
import { FakeAIProvider } from '../src/infrastructure/ai/fake-ai-provider';
import { OutboxDispatcher } from '../src/infrastructure/queue/outbox-dispatcher';
import {
  aiPurchase,
  availableCash,
  ensureAIPrice,
  fundForAI,
  quoteForAI,
  retireAIPrice,
  reviewBody,
} from './support/ai-billing-client';
import { API, type AuthClient } from './support/auth-client';
import {
  aiAssistedRule,
  manualRule,
  publishCheckableStandard,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import {
  grantOrganizationAIConsent,
  guidelineText,
  uploadSource,
  waitForExtraction,
} from './support/extraction-client';
import { minimalDocx, minimalPdf } from './support/fixtures';
import {
  createTenant,
  createUser,
  grantOrganizationRoleTo,
  signInPlatformAdmin,
} from './support/organization-client';
import {
  createDocumentType,
  createStandard,
  createVersion,
  validRule,
} from './support/standards-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Centralized billing for customer-initiated AI services (ADR-0149).
 *
 * Every AI service is paid for by the user who starts it — also inside an
 * organization, also when that user is an administrator. The fee is reserved
 * before any AI work is queued, captured exactly once when the service
 * COMPLETES and released when it FAILS or is cancelled. The fake provider
 * stands in for Anthropic throughout; nothing leaves the machine.
 */
describe('AI service billing (e2e)', () => {
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
    context.aiProvider.reset();
    student = await createUser(context, 'student@example.com');
    tenant = await createTenant(context, 'University A', 'registrar@example.com');
    standard = await publishCheckableStandard(context, tenant.owner.client, tenant.organizationId, {
      rules: [validRule(), aiAssistedRule(), manualRule()],
    });
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function completedCheckFor(owner: { userId: string; client: AuthClient }) {
    const document = await createDocument(owner.client, 'Thesis');
    const { versionId } = await uploadAndProcess(owner.client, document.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
    const created = await startCheck(context, owner, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    const settled = await waitForCheck(context, created.body.id);
    expect(settled.status).toBe('COMPLETED');
    await owner.client.post(`${API}/ai/consent`);
    return created.body.id as string;
  }

  async function waitForReview(reviewId: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await context.adminDb.aIReview.findUniqueOrThrow({ where: { id: reviewId } });
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(row.status)) return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`review ${reviewId} did not settle`);
  }

  /**
   * Settle a review whose retries back off on the (frozen) test clock: move the
   * clock past each backoff and run the outbox sweep instead of waiting on its
   * production timer.
   */
  async function settleWithRetries(reviewId: string, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await context.adminDb.aIReview.findUniqueOrThrow({ where: { id: reviewId } });
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(row.status)) return row;
      context.clock.advanceMinutes(2 / 60);
      await context.dispatcher.sweep();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`review ${reviewId} did not settle`);
  }

  /** Hold queued work in the outbox, so a run can be inspected or cancelled before it starts. */
  function holdTheQueue(): () => void {
    const dispatchers = [
      context.app.get(OutboxDispatcher),
      context.workerApp.get(OutboxDispatcher),
    ];
    const spies = dispatchers.flatMap((dispatcher) => [
      jest.spyOn(dispatcher, 'dispatchNow').mockResolvedValue(undefined as never),
      jest.spyOn(dispatcher, 'sweep').mockResolvedValue({ published: 0, requeued: 0, dead: 0 }),
    ]);
    return () => spies.forEach((spy) => spy.mockRestore());
  }

  async function invocationCount(): Promise<number> {
    return context.adminDb.aIInvocation.count();
  }

  /** Ledger entries a purchase's holds produced — the only way money moves (ADR-0069). */
  async function chargesFor(purchaseId: string) {
    const purchase = await aiPurchase(context, purchaseId);
    return context.adminDb.creditLedgerEntry.findMany({
      where: {
        referenceType: 'CREDIT_HOLD',
        referenceId: { in: purchase.allocations.map((a) => a.holdId) },
      },
    });
  }

  const review = (checkId: string) => `${API}/checks/${checkId}/ai-reviews`;

  // ---------------------------------------------------------------------------
  // AI Review
  // ---------------------------------------------------------------------------

  describe('AI Review', () => {
    it('reserves $0.50, then captures exactly $0.50 when the review completes', async () => {
      const checkId = await completedCheckFor(student);
      const { quoteId } = await fundForAI(context, student.userId, 'AI_REVIEW', {
        price: 50n,
        grant: 1000n,
      });
      const before = await availableCash(context, student.userId);

      const release = holdTheQueue();
      const started = await student.client.post(review(checkId), { priceQuoteId: quoteId });
      expect(started.status).toBe(202);
      const row = await context.adminDb.aIReview.findUniqueOrThrow({
        where: { id: started.body.id },
      });
      expect(row.servicePurchaseId).not.toBeNull();
      const reserved = await aiPurchase(context, row.servicePurchaseId!);
      expect(reserved).toMatchObject({
        ownerUserId: student.userId,
        productCode: 'AI_REVIEW',
        resourceType: 'AI_REVIEW',
        resourceId: row.id,
        amountMinor: 50n,
        status: 'RESERVED',
        idempotencyKey: `ai-review:${row.id}`,
      });
      expect(await availableCash(context, student.userId)).toBe(before - 50n);
      release();

      await context.dispatcher.dispatchNow(
        (await context.jobs.findByResource('AI_REVIEW' as never, row.id))!.id,
      );
      const settled = await waitForReview(row.id);
      expect(settled.status).toBe('COMPLETED');

      const delivered = await aiPurchase(context, row.servicePurchaseId!);
      expect(delivered.status).toBe('DELIVERED');
      expect(delivered.allocations.every((a) => a.hold.status === 'CAPTURED')).toBe(true);
      const charges = await context.adminDb.creditLedgerEntry.aggregate({
        where: {
          ownerUserId: student.userId,
          reasonCode: 'SERVICE_CAPTURED',
          amountMinorSigned: { lt: 0 },
        },
        _sum: { amountMinorSigned: true },
      });
      // The check itself was also captured; isolate this review's charge.
      const holdIds = delivered.allocations.map((a) => a.holdId);
      const reviewCharges = await context.adminDb.creditLedgerEntry.findMany({
        where: { referenceType: 'CREDIT_HOLD', referenceId: { in: holdIds } },
      });
      expect(reviewCharges.reduce((sum, e) => sum + e.amountMinorSigned, 0n)).toBe(-50n);
      // Charged exactly once: one SERVICE_CHARGE per captured hold, nothing else.
      expect(reviewCharges).toHaveLength(holdIds.length);
      expect(reviewCharges.every((e) => e.entryType === 'SERVICE_CHARGE')).toBe(true);
      expect(await context.adminDb.aIReview.count({ where: { checkId } })).toBe(1);
      expect(charges._sum.amountMinorSigned).not.toBeNull();
      expect(await availableCash(context, student.userId)).toBe(before - 50n);
    });

    it('charges a COMPLETED review even when every assessment is "insufficient evidence"', async () => {
      const checkId = await completedCheckFor(student);
      context.aiProvider.assessment = 'INSUFFICIENT_EVIDENCE';
      const started = await student.client.post(
        review(checkId),
        await reviewBody(context, student.userId),
      );
      const settled = await waitForReview(started.body.id);
      expect(settled.status).toBe('COMPLETED');
      expect((await aiPurchase(context, settled.servicePurchaseId!)).status).toBe('DELIVERED');
    });

    it('releases the reservation when the provider fails, and the balance is whole again', async () => {
      const checkId = await completedCheckFor(student);
      const body = await reviewBody(context, student.userId);
      const before = await availableCash(context, student.userId);
      context.aiProvider.mode = 'refusal';
      const started = await student.client.post(review(checkId), body);
      const settled = await waitForReview(started.body.id);
      expect(settled.status).toBe('FAILED');
      const purchase = await aiPurchase(context, settled.servicePurchaseId!);
      expect(purchase).toMatchObject({ status: 'RELEASED', failureCode: 'SERVICE_FAILED' });
      expect(purchase.allocations.every((a) => a.hold.status === 'RELEASED')).toBe(true);
      expect(await availableCash(context, student.userId)).toBe(before);
      expect(await chargesFor(purchase.id)).toHaveLength(0);
    });

    it('releases after retries are exhausted on a transient provider failure — no charge remains', async () => {
      const checkId = await completedCheckFor(student);
      const body = await reviewBody(context, student.userId);
      const before = await availableCash(context, student.userId);
      context.aiProvider.mode = 'overloaded';
      const started = await student.client.post(review(checkId), body);
      const settled = await settleWithRetries(started.body.id);
      expect(settled).toMatchObject({ status: 'FAILED', failureKind: 'OVERLOADED' });
      // It was retried, and every attempt failed.
      expect(context.aiProvider.assessmentCalls.length).toBeGreaterThan(1);
      const purchase = await aiPurchase(context, settled.servicePurchaseId!);
      expect(purchase).toMatchObject({ status: 'RELEASED', failureCode: 'SERVICE_FAILED' });
      expect(purchase.allocations.every((a) => a.hold.status === 'RELEASED')).toBe(true);
      expect(await chargesFor(purchase.id)).toHaveLength(0);
      expect(await availableCash(context, student.userId)).toBe(before);
      // Released exactly once, across every retry: one purchase, one release audit.
      expect(
        await context.adminDb.servicePurchase.count({ where: { resourceId: settled.id } }),
      ).toBe(1);
      expect(
        await context.adminDb.auditEvent.count({
          where: { targetId: purchase.id, action: 'AI_SERVICE_RELEASED' },
        }),
      ).toBe(1);
      expect(
        await context.adminDb.auditEvent.count({
          where: { targetId: purchase.id, action: 'AI_SERVICE_CAPTURED' },
        }),
      ).toBe(0);
      // Each retry recorded its own attempt number.
      const attempts = (
        await context.adminDb.aIInvocation.findMany({
          where: { aiReviewId: settled.id },
          orderBy: { attempt: 'asc' },
        })
      ).map((i) => i.attempt);
      expect(attempts.length).toBe(context.aiProvider.assessmentCalls.length);
      expect(new Set(attempts).size).toBe(attempts.length);
    }, 120_000);

    it('a transient failure that recovers on retry completes and is charged once', async () => {
      const checkId = await completedCheckFor(student);
      context.aiProvider.failuresBeforeSuccess = 1;
      const started = await student.client.post(
        review(checkId),
        await reviewBody(context, student.userId),
      );
      const settled = await settleWithRetries(started.body.id);
      expect(settled.status).toBe('COMPLETED');
      const purchase = await aiPurchase(context, settled.servicePurchaseId!);
      expect(purchase.status).toBe('DELIVERED');
      const charges = await chargesFor(purchase.id);
      expect(charges.reduce((sum, e) => sum + e.amountMinorSigned, 0n)).toBe(-50n);
      // One capture: one SERVICE_CHARGE per hold, one capture audit, one purchase.
      expect(charges).toHaveLength(purchase.allocations.length);
      expect(charges.every((e) => e.entryType === 'SERVICE_CHARGE')).toBe(true);
      expect(
        await context.adminDb.servicePurchase.count({ where: { resourceId: settled.id } }),
      ).toBe(1);
      expect(
        await context.adminDb.servicePurchase.count({ where: { productCode: 'AI_REVIEW' } }),
      ).toBe(1);
      expect(
        await context.adminDb.auditEvent.count({
          where: { targetId: purchase.id, action: 'AI_SERVICE_CAPTURED' },
        }),
      ).toBe(1);
      expect(
        await context.adminDb.auditEvent.count({
          where: { targetId: purchase.id, action: 'AI_SERVICE_RELEASED' },
        }),
      ).toBe(0);
      // The failed first attempt and the successful retry each kept their own number.
      const invocations = await context.adminDb.aIInvocation.findMany({
        where: { aiReviewId: settled.id },
        orderBy: { attempt: 'asc' },
      });
      const keys = invocations.map((i) => `${i.purpose}:${i.attempt}`);
      expect(new Set(keys).size).toBe(keys.length);
      const assessment = invocations.filter((i) => i.purpose === 'RULE_ASSESSMENT');
      expect(assessment.map((i) => i.attempt)).toEqual([1, 2]);
      expect(assessment.map((i) => i.status)).toEqual(['FAILED', 'SUCCEEDED']);
      // Every call went to the fake provider.
      expect(context.aiProvider.assessmentCalls).toHaveLength(2);
    }, 120_000);

    it('releases on malformed provider output that leaves the review FAILED', async () => {
      const checkId = await completedCheckFor(student);
      const body = await reviewBody(context, student.userId);
      const before = await availableCash(context, student.userId);
      context.aiProvider.mode = 'malformed';
      const started = await student.client.post(review(checkId), body);
      const settled = await waitForReview(started.body.id);
      expect(settled).toMatchObject({ status: 'FAILED', failureKind: 'OUTPUT_INVALID' });
      expect((await aiPurchase(context, settled.servicePurchaseId!)).status).toBe('RELEASED');
      expect(await chargesFor(settled.servicePurchaseId!)).toHaveLength(0);
      expect(await availableCash(context, student.userId)).toBe(before);
    });

    it('refuses with insufficient balance: no review, no job, no provider call', async () => {
      const checkId = await completedCheckFor(student);
      const { quoteId } = await fundForAI(context, student.userId, 'AI_REVIEW', {
        price: 1_000_000n,
        grant: 0n,
      });
      const calls = await invocationCount();
      const reviewsBefore = await context.adminDb.aIReview.count();
      const refused = await student.client.post(review(checkId), { priceQuoteId: quoteId });
      expect(refused.status).toBe(402);
      expect(refused.body.error.code).toBe('INSUFFICIENT_BALANCE');
      expect(await context.adminDb.aIReview.count()).toBe(reviewsBefore);
      expect(await context.adminDb.processingJob.count({ where: { jobType: 'AI_REVIEW' } })).toBe(
        0,
      );
      expect(
        await context.adminDb.servicePurchase.count({ where: { productCode: 'AI_REVIEW' } }),
      ).toBe(0);
      expect(await invocationCount()).toBe(calls);
    });

    it('cannot start without an active price, and says so', async () => {
      await completedCheckFor(student);
      await retireAIPrice(context, 'AI_REVIEW');
      const quote = await student.client.get(`${API}/pricing/quote?product=AI_REVIEW&currency=USD`);
      expect(quote.status).toBe(409);
      expect(quote.body.error.code).toBe('PRICE_NOT_AVAILABLE');
      expect(quote.body.error.message).toBe(
        'This AI service is not currently available in your balance currency.',
      );
      // Without a quote there is nothing to start with.
      const calls = await invocationCount();
      const checkId = (
        await context.adminDb.documentCheck.findFirstOrThrow({
          where: { ownerUserId: student.userId },
        })
      ).id;
      const refused = await student.client.post(review(checkId), {});
      expect(refused.status).toBe(400);
      expect(await context.adminDb.aIReview.count()).toBe(0);
      expect(await context.adminDb.processingJob.count({ where: { jobType: 'AI_REVIEW' } })).toBe(
        0,
      );
      expect(
        await context.adminDb.servicePurchase.count({ where: { productCode: 'AI_REVIEW' } }),
      ).toBe(0);
      expect(await invocationCount()).toBe(calls);
    });

    it('refuses forged, foreign, expired and mismatched quotes, and a client-stated price', async () => {
      const checkId = await completedCheckFor(student);
      await ensureAIPrice(context, 'AI_REVIEW');
      const stranger = await createUser(context, 'stranger@example.com');
      const foreign = await quoteForAI(context, stranger.userId, 'AI_REVIEW');

      const forged = await student.client.post(review(checkId), {
        priceQuoteId: '00000000-0000-4000-8000-000000000000',
      });
      expect([forged.status, forged.body.error.code]).toEqual([404, 'QUOTE_NOT_FOUND']);

      const theirs = await student.client.post(review(checkId), { priceQuoteId: foreign.id });
      expect([theirs.status, theirs.body.error.code]).toEqual([404, 'QUOTE_NOT_FOUND']);

      const check = await student.client.get(
        `${API}/pricing/quote?product=DOCUMENT_CHECK&currency=USD`,
      );
      const mismatched = await student.client.post(review(checkId), {
        priceQuoteId: check.body.id,
      });
      expect(mismatched.body.error.code).toBe('QUOTE_PRODUCT_MISMATCH');

      const stale = await quoteForAI(context, student.userId, 'AI_REVIEW');
      // Quotes are immutable; time moves instead (the test context owns the clock).
      const now = context.clock.now();
      context.clock.advanceMinutes(31);
      const expired = await student.client.post(review(checkId), { priceQuoteId: stale.id });
      context.clock.set(now);
      expect(expired.body.error.code).toBe('QUOTE_EXPIRED');

      const fresh = await quoteForAI(context, student.userId, 'AI_REVIEW');
      const priced = await student.client.post(review(checkId), {
        priceQuoteId: fresh.id,
        amountMinor: '1',
      });
      expect(priced.status).toBe(400);
      expect(
        await context.adminDb.servicePurchase.count({ where: { productCode: 'AI_REVIEW' } }),
      ).toBe(0);
    });

    it('honours the quoted amount after the price changes', async () => {
      const checkId = await completedCheckFor(student);
      const { quoteId } = await fundForAI(context, student.userId, 'AI_REVIEW', { price: 50n });
      await ensureAIPrice(context, 'AI_REVIEW', 90n);
      const started = await student.client.post(review(checkId), { priceQuoteId: quoteId });
      const settled = await waitForReview(started.body.id);
      expect((await aiPurchase(context, settled.servicePurchaseId!)).amountMinor).toBe(50n);
    });

    it('treats an HTTP retry of the same confirmation as the same review — one purchase', async () => {
      const checkId = await completedCheckFor(student);
      const body = await reviewBody(context, student.userId);
      const first = await student.client.post(review(checkId), body);
      const second = await student.client.post(review(checkId), body);
      expect(second.status).toBe(202);
      expect(second.body.id).toBe(first.body.id);
      await waitForReview(first.body.id);
      expect(
        await context.adminDb.servicePurchase.count({ where: { productCode: 'AI_REVIEW' } }),
      ).toBe(1);
      expect(await context.adminDb.aIReview.count({ where: { checkId } })).toBe(1);
    });

    it('lets only one of two simultaneous requests through when the balance covers one', async () => {
      const checkId = await completedCheckFor(student);
      // Spend the check-funding surplus first so exactly one review fits.
      const spare = await availableCash(context, student.userId);
      const price = spare > 0n ? spare : 50n;
      await ensureAIPrice(context, 'AI_REVIEW', price);
      if (spare <= 0n)
        await fundForAI(context, student.userId, 'AI_REVIEW', { price, grant: price });
      const a = await quoteForAI(context, student.userId, 'AI_REVIEW');
      const b = await quoteForAI(context, student.userId, 'AI_REVIEW');
      const [one, two] = await Promise.all([
        student.client.post(review(checkId), { priceQuoteId: a.id }),
        student.client.post(review(checkId), { priceQuoteId: b.id }),
      ]);
      expect([one.status, two.status].sort()).toEqual([202, 402]);
      expect(
        await context.adminDb.servicePurchase.count({ where: { productCode: 'AI_REVIEW' } }),
      ).toBe(1);
    });

    it('a queue redelivery of a completed review never charges twice', async () => {
      const checkId = await completedCheckFor(student);
      const started = await student.client.post(
        review(checkId),
        await reviewBody(context, student.userId),
      );
      const settled = await waitForReview(started.body.id);
      const job = await context.jobs.findByResource('AI_REVIEW' as never, settled.id);
      const entriesBefore = await context.adminDb.creditLedgerEntry.count();
      await context.worker.processJobId(job!.id).catch(() => undefined);
      expect(await context.adminDb.creditLedgerEntry.count()).toBe(entriesBefore);
      expect((await aiPurchase(context, settled.servicePurchaseId!)).status).toBe('DELIVERED');
    });

    it('releases on cancellation before the provider is called', async () => {
      const checkId = await completedCheckFor(student);
      const release = holdTheQueue();
      try {
        const started = await student.client.post(
          review(checkId),
          await reviewBody(context, student.userId),
        );
        const cancelled = await student.client.post(
          `${review(checkId)}/${started.body.id}/cancel`,
          {},
        );
        expect(cancelled.status).toBe(200);
        const row = await context.adminDb.aIReview.findUniqueOrThrow({
          where: { id: started.body.id },
        });
        expect(row.status).toBe('CANCELLED');
        expect(await aiPurchase(context, row.servicePurchaseId!)).toMatchObject({
          status: 'RELEASED',
          failureCode: 'CANCELLED_BY_CUSTOMER',
        });
      } finally {
        release();
      }
    });

    it('never calls the provider on a lapsed reservation, and releases it', async () => {
      const checkId = await completedCheckFor(student);
      const release = holdTheQueue();
      const started = await student.client.post(
        review(checkId),
        await reviewBody(context, student.userId),
      );
      const row = await context.adminDb.aIReview.findUniqueOrThrow({
        where: { id: started.body.id },
      });
      await context.adminDb.$executeRawUnsafe(
        // Relative to PalCert's clock, which the test context controls.
        `UPDATE credit_holds SET expires_at = '${new Date(context.clock.now().getTime() - 60_000).toISOString()}' WHERE reference_id = '${row.servicePurchaseId}'`,
      );
      const calls = await invocationCount();
      release();
      const job = await context.jobs.findByResource('AI_REVIEW' as never, row.id);
      await context.dispatcher.dispatchNow(job!.id);
      const settled = await waitForReview(row.id);
      expect(settled).toMatchObject({ status: 'FAILED', failureKind: 'RESERVATION_EXPIRED' });
      expect(await invocationCount()).toBe(calls);
      expect((await aiPurchase(context, row.servicePurchaseId!)).status).toBe('RELEASED');
    });

    it('charges a PALCERT_ADMIN who starts a review — no role is free', async () => {
      const adminClient = await signInPlatformAdmin(context, 'admin@palcert.test');
      const me = await adminClient.get(`${API}/users/me`);
      const admin = { userId: me.body.id as string, client: adminClient };
      const checkId = await completedCheckFor(admin);
      const started = await adminClient.post(
        review(checkId),
        await reviewBody(context, admin.userId),
      );
      expect(started.status).toBe(202);
      const settled = await waitForReview(started.body.id);
      const purchase = await aiPurchase(context, settled.servicePurchaseId!);
      expect(purchase).toMatchObject({ ownerUserId: admin.userId, status: 'DELIVERED' });

      // And without a quote there is no way in.
      const free = await adminClient.post(review(checkId), {});
      expect(free.status).toBe(400);
    });

    it('refuses a free AI review row at the database, from any role', async () => {
      const checkId = await completedCheckFor(student);
      const template = await context.adminDb.aIReview.findFirst();
      expect(template).toBeNull();
      await expect(
        context.adminDb.$executeRawUnsafe(
          `INSERT INTO ai_reviews (id, owner_user_id, check_id, check_run_id, report_id, report_hash, evaluation_hash,
             document_version_id, document_sha256, analysis_id, analysis_artifact_sha256, standard_version_id,
             standard_content_hash, provider, configured_model, prompt_version, prompt_hash, context_builder_version,
             context_schema_version, ai_review_schema_version, ai_review_canonicalization_version, status, updated_at)
           SELECT gen_random_uuid(), owner_user_id, id, gen_random_uuid(), gen_random_uuid(), 'x', 'x', gen_random_uuid(),
             'x', gen_random_uuid(), 'x', gen_random_uuid(), 'x', 'fake', 'fake', '1', 'x', '1', 1, 1, 1, 'QUEUED', now()
           FROM document_checks WHERE id = '${checkId}'`,
        ),
      ).rejects.toThrow(/must be bound to a service purchase/);
    });
  });

  // ---------------------------------------------------------------------------
  // AI Rule Extraction — organization-scoped, paid by the initiating member
  // ---------------------------------------------------------------------------

  describe('AI Rule Extraction', () => {
    let versionId: string;

    beforeEach(async () => {
      const owner = tenant.owner.client;
      const documentType = await createDocumentType(owner, tenant.organizationId, {
        name: 'Extraction guidelines',
      });
      const created = await createStandard(owner, tenant.organizationId, documentType.id, {
        code: 'UA.EXTRACTION.DRAFT',
      });
      const version = await createVersion(owner, tenant.organizationId, created.id);
      versionId = version.id;
      await grantOrganizationAIConsent(owner, tenant.organizationId);
      await uploadSource(context, owner, tenant.organizationId, versionId, {
        sourceKind: 'GUIDELINE_PDF',
        filename: 'guidelines.pdf',
        bytes: minimalPdf(guidelineText('The left margin must be 30 mm.')),
      });
    });

    const extractions = () =>
      `${API}/organizations/${tenant.organizationId}/standard-versions/${versionId}/extractions`;

    async function member(roleCode: string, email: string) {
      const user = await createUser(context, email);
      await grantOrganizationRoleTo(context, tenant, user, roleCode);
      return user;
    }

    it('charges the template manager who starts it — $2 from their own balance, captured on completion', async () => {
      const manager = await member('TEMPLATE_MANAGER', 'manager@example.com');
      const { quoteId } = await fundForAI(context, manager.userId, 'AI_RULE_EXTRACTION', {
        price: 200n,
        grant: 2000n,
      });
      const ownerBefore = await availableCash(context, tenant.owner.userId);

      const started = await manager.client.post(extractions(), { priceQuoteId: quoteId });
      expect(started.status).toBe(202);
      const run = await context.adminDb.ruleExtractionRun.findUniqueOrThrow({
        where: { id: started.body.id },
      });
      // Still the organization's run…
      expect(run.organizationId).toBe(tenant.organizationId);
      // …but the member's purchase.
      const purchase = await aiPurchase(context, run.servicePurchaseId!);
      expect(purchase).toMatchObject({
        ownerUserId: manager.userId,
        productCode: 'AI_RULE_EXTRACTION',
        resourceId: run.id,
        amountMinor: 200n,
        idempotencyKey: `ai-rule-extraction:${run.id}`,
      });

      const settled = await waitForExtraction(context, run.id);
      expect(settled.status).toBe('COMPLETED');
      expect((await aiPurchase(context, run.servicePurchaseId!)).status).toBe('DELIVERED');
      expect(await availableCash(context, manager.userId)).toBe(1800n);
      // Nobody else paid: not the owner, not "the organization".
      expect(await availableCash(context, tenant.owner.userId)).toBe(ownerBefore);
      // Captured exactly once, from the manager's personal balance.
      const charges = await chargesFor(run.servicePurchaseId!);
      expect(charges.every((e) => e.ownerUserId === manager.userId)).toBe(true);
      expect(charges.reduce((sum, e) => sum + e.amountMinorSigned, 0n)).toBe(-200n);
      expect(charges).toHaveLength(purchase.allocations.length);
      // A queue redelivery charges nothing more.
      const job = await context.jobs.findByResource('RULE_EXTRACTION' as never, run.id);
      const entries = await context.adminDb.creditLedgerEntry.count();
      await context.worker.processJobId(job!.id).catch(() => undefined);
      expect(await context.adminDb.creditLedgerEntry.count()).toBe(entries);
      expect((await aiPurchase(context, run.servicePurchaseId!)).status).toBe('DELIVERED');
    });

    it.each([
      ['the organization owner', 'OWNER'],
      ['an organization admin', 'ORGANIZATION_ADMIN'],
    ])('charges %s exactly like anyone else', async (_label, role) => {
      const payer =
        role === 'OWNER' ? tenant.owner : await member(role, `${role.toLowerCase()}@example.com`);
      const started = await payer.client.post(extractions(), {
        priceQuoteId: (await fundForAI(context, payer.userId, 'AI_RULE_EXTRACTION')).quoteId,
      });
      expect(started.status).toBe(202);
      const settled = await waitForExtraction(context, started.body.id);
      const run = await context.adminDb.ruleExtractionRun.findUniqueOrThrow({
        where: { id: started.body.id },
      });
      expect(settled.status).toBe('COMPLETED');
      expect(await aiPurchase(context, run.servicePurchaseId!)).toMatchObject({
        ownerUserId: payer.userId,
        status: 'DELIVERED',
      });
      const charges = await chargesFor(run.servicePurchaseId!);
      expect(charges.reduce((sum, e) => sum + e.amountMinorSigned, 0n)).toBe(-200n);
      expect(charges.every((e) => e.ownerUserId === payer.userId)).toBe(true);
    });

    it('cannot start without an active price: no run, no job, no provider call', async () => {
      await retireAIPrice(context, 'AI_RULE_EXTRACTION');
      const quote = await tenant.owner.client.get(
        `${API}/pricing/quote?product=AI_RULE_EXTRACTION&currency=USD`,
      );
      expect([quote.status, quote.body.error.code]).toEqual([409, 'PRICE_NOT_AVAILABLE']);
      const calls = await context.adminDb.extractionInvocation.count();
      const refused = await tenant.owner.client.post(extractions(), {});
      expect(refused.status).toBe(400);
      expect(
        await context.adminDb.ruleExtractionRun.count({ where: { standardVersionId: versionId } }),
      ).toBe(0);
      expect(
        await context.adminDb.processingJob.count({ where: { jobType: 'RULE_EXTRACTION' } }),
      ).toBe(0);
      expect(await context.adminDb.extractionInvocation.count()).toBe(calls);
    });

    it('never calls the provider on a lapsed reservation, and releases it', async () => {
      const manager = await member('TEMPLATE_MANAGER', 'lapsed@example.com');
      const release = holdTheQueue();
      const started = await manager.client.post(extractions(), {
        priceQuoteId: (await fundForAI(context, manager.userId, 'AI_RULE_EXTRACTION')).quoteId,
      });
      expect(started.status).toBe(202);
      const run = await context.adminDb.ruleExtractionRun.findUniqueOrThrow({
        where: { id: started.body.id },
      });
      await context.adminDb.$executeRawUnsafe(
        `UPDATE credit_holds SET expires_at = '${new Date(context.clock.now().getTime() - 60_000).toISOString()}' WHERE reference_id = '${run.servicePurchaseId}'`,
      );
      const calls = await context.adminDb.extractionInvocation.count();
      const before = await availableCash(context, manager.userId);
      release();
      const job = await context.jobs.findByResource('RULE_EXTRACTION' as never, run.id);
      await context.dispatcher.dispatchNow(job!.id);
      const settled = await waitForExtraction(context, run.id);
      expect(settled.status).toBe('FAILED');
      const failed = await context.adminDb.ruleExtractionRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(failed.failureKind).toBe('RESERVATION_EXPIRED');
      expect(await context.adminDb.extractionInvocation.count()).toBe(calls);
      expect((await aiPurchase(context, run.servicePurchaseId!)).status).toBe('RELEASED');
      expect(await chargesFor(run.servicePurchaseId!)).toHaveLength(0);
      expect(await availableCash(context, manager.userId)).toBeGreaterThanOrEqual(before);
    });

    it('refuses with insufficient personal balance: no run, no job, no provider call', async () => {
      const manager = await member('TEMPLATE_MANAGER', 'poor@example.com');
      const { quoteId } = await fundForAI(context, manager.userId, 'AI_RULE_EXTRACTION', {
        grant: 0n,
      });
      const calls = await context.adminDb.extractionInvocation.count();
      const refused = await manager.client.post(extractions(), { priceQuoteId: quoteId });
      expect([refused.status, refused.body.error.code]).toEqual([402, 'INSUFFICIENT_BALANCE']);
      expect(
        await context.adminDb.ruleExtractionRun.count({ where: { standardVersionId: versionId } }),
      ).toBe(0);
      expect(
        await context.adminDb.processingJob.count({ where: { jobType: 'RULE_EXTRACTION' } }),
      ).toBe(0);
      expect(await context.adminDb.extractionInvocation.count()).toBe(calls);
    });

    it('cannot charge another member: the quote must be the caller’s own', async () => {
      const manager = await member('TEMPLATE_MANAGER', 'manager2@example.com');
      const ownersQuote = await fundForAI(context, tenant.owner.userId, 'AI_RULE_EXTRACTION');
      const refused = await manager.client.post(extractions(), {
        priceQuoteId: ownersQuote.quoteId,
      });
      expect([refused.status, refused.body.error.code]).toEqual([404, 'QUOTE_NOT_FOUND']);
      expect(
        await context.adminDb.ruleExtractionRun.count({ where: { standardVersionId: versionId } }),
      ).toBe(0);
    });

    it('checks consent before reserving anything', async () => {
      await tenant.owner.client.delete(`${API}/organizations/${tenant.organizationId}/ai-consent`);
      const { quoteId } = await fundForAI(context, tenant.owner.userId, 'AI_RULE_EXTRACTION');
      const refused = await tenant.owner.client.post(extractions(), { priceQuoteId: quoteId });
      expect(refused.status).toBe(403);
      expect(
        await context.adminDb.servicePurchase.count({
          where: { productCode: 'AI_RULE_EXTRACTION' },
        }),
      ).toBe(0);
    });

    it('releases the payer’s reservation when another member cancels before work starts', async () => {
      const manager = await member('TEMPLATE_MANAGER', 'canceller-target@example.com');
      const release = holdTheQueue();
      try {
        const started = await manager.client.post(extractions(), {
          priceQuoteId: (await fundForAI(context, manager.userId, 'AI_RULE_EXTRACTION')).quoteId,
        });
        const cancelled = await tenant.owner.client.post(
          `${extractions()}/${started.body.id}/cancel`,
          {},
        );
        expect(cancelled.status).toBe(200);
        const run = await context.adminDb.ruleExtractionRun.findUniqueOrThrow({
          where: { id: started.body.id },
        });
        expect(await aiPurchase(context, run.servicePurchaseId!)).toMatchObject({
          ownerUserId: manager.userId,
          status: 'RELEASED',
          failureCode: 'CANCELLED_BY_CUSTOMER',
        });
      } finally {
        release();
      }
    });

    it('releases when the run FAILS (nothing citable found)', async () => {
      context.aiProvider.mode = 'no-citations';
      const body = {
        priceQuoteId: (await fundForAI(context, tenant.owner.userId, 'AI_RULE_EXTRACTION')).quoteId,
      };
      const before = await availableCash(context, tenant.owner.userId);
      const started = await tenant.owner.client.post(extractions(), body);
      const settled = await waitForExtraction(context, started.body.id);
      expect(settled.status).toBe('FAILED');
      const run = await context.adminDb.ruleExtractionRun.findUniqueOrThrow({
        where: { id: started.body.id },
      });
      expect((await aiPurchase(context, run.servicePurchaseId!)).status).toBe('RELEASED');
      expect(await chargesFor(run.servicePurchaseId!)).toHaveLength(0);
      expect(await availableCash(context, tenant.owner.userId)).toBe(before);
    });

    it('a retried confirmation returns the same run — one purchase', async () => {
      const body = {
        priceQuoteId: (await fundForAI(context, tenant.owner.userId, 'AI_RULE_EXTRACTION')).quoteId,
      };
      const first = await tenant.owner.client.post(extractions(), body);
      const second = await tenant.owner.client.post(extractions(), body);
      expect(second.body.id).toBe(first.body.id);
      await waitForExtraction(context, first.body.id);
      expect(
        await context.adminDb.servicePurchase.count({
          where: { productCode: 'AI_RULE_EXTRACTION' },
        }),
      ).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // History, finance and legacy rows
  // ---------------------------------------------------------------------------

  describe('history and finance', () => {
    it('names the service on the customer’s history and in the admin summary, per currency', async () => {
      const checkId = await completedCheckFor(student);
      const started = await student.client.post(
        review(checkId),
        await reviewBody(context, student.userId),
      );
      await waitForReview(started.body.id);

      const history = await student.client.get(`${API}/balance/transactions?currency=USD`);
      const products = (history.body.items as { serviceProductCode: string | null }[]).map(
        (entry) => entry.serviceProductCode,
      );
      expect(products).toContain('AI_REVIEW');

      const finance = await signInPlatformAdmin(context, 'finance-admin@palcert.test');
      const summary = await finance.get(`${API}/admin/finance/purchases/summary`);
      expect(summary.status).toBe(200);
      const ai = (
        summary.body.rows as {
          productCode: string;
          currency: string;
          capturedCount: number;
          capturedAmount: { minorUnits: string };
        }[]
      ).find((row) => row.productCode === 'AI_REVIEW' && row.currency === 'USD');
      expect(ai).toMatchObject({ capturedCount: 1, capturedAmount: { minorUnits: '50' } });

      const filtered = await finance.get(`${API}/admin/finance/purchases?productCode=AI_REVIEW`);
      expect(filtered.body).toHaveLength(1);
      expect(filtered.body[0]).toMatchObject({
        productCode: 'AI_REVIEW',
        payer: { userId: student.userId },
      });

      expect((await student.client.get(`${API}/admin/finance/purchases/summary`)).status).toBe(403);
    });

    it('reports AI_REVIEW and AI_RULE_EXTRACTION separately, one row per currency, never summed', async () => {
      // A USD review, a EUR review, and a USD extraction.
      const usdCheck = await completedCheckFor(student);
      const usd = await student.client.post(
        review(usdCheck),
        await reviewBody(context, student.userId),
      );
      await waitForReview(usd.body.id);
      const euro = await createUser(context, 'euro@example.com');
      const eurCheck = await completedCheckFor(euro);
      const { quoteId } = await fundForAI(context, euro.userId, 'AI_REVIEW', {
        price: 45n,
        grant: 1000n,
        currency: 'EUR',
      });
      const eur = await euro.client.post(review(eurCheck), { priceQuoteId: quoteId });
      expect(eur.status).toBe(202);
      await waitForReview(eur.body.id);

      const finance = await signInPlatformAdmin(context, 'finance-admin@palcert.test');
      const summary = await finance.get(`${API}/admin/finance/purchases/summary`);
      type Row = {
        productCode: string;
        currency: string;
        capturedCount: number;
        capturedAmount: { currency: string; minorUnits: string };
        reservedAmount: { currency: string };
        refundedAmount: { currency: string };
      };
      const rows = summary.body.rows as Row[];
      const keys = rows.map((row) => `${row.productCode}|${row.currency}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(rows.find((r) => r.productCode === 'AI_REVIEW' && r.currency === 'USD')).toMatchObject(
        { capturedCount: 1, capturedAmount: { currency: 'USD', minorUnits: '50' } },
      );
      expect(rows.find((r) => r.productCode === 'AI_REVIEW' && r.currency === 'EUR')).toMatchObject(
        { capturedCount: 1, capturedAmount: { currency: 'EUR', minorUnits: '45' } },
      );
      // Every amount is in its own row's currency; no row adds currencies up.
      for (const row of rows) {
        expect([
          row.capturedAmount.currency,
          row.reservedAmount.currency,
          row.refundedAmount.currency,
        ]).toEqual([row.currency, row.currency, row.currency]);
      }
      expect(Object.keys(summary.body).sort()).toEqual(['from', 'rows', 'to']);
      const eurOnly = await finance.get(`${API}/admin/finance/purchases/summary?currency=EUR`);
      expect((eurOnly.body.rows as Row[]).every((r) => r.currency === 'EUR')).toBe(true);
    });

    it('runs only against the fake AI provider — no real provider is reachable from tests', async () => {
      expect(context.app.get(AIProviderPort, { strict: false })).toBeInstanceOf(FakeAIProvider);
      expect(context.workerApp.get(AIProviderPort, { strict: false })).toBeInstanceOf(
        FakeAIProvider,
      );
    });

    it('runs a review created before AI billing to completion without charging anyone', async () => {
      const checkId = await completedCheckFor(student);
      const release = holdTheQueue();
      const started = await student.client.post(
        review(checkId),
        await reviewBody(context, student.userId),
      );
      const row = await context.adminDb.aIReview.findUniqueOrThrow({
        where: { id: started.body.id },
      });
      // Make it look exactly like a pre-billing row: no purchase. Only possible
      // with the guard triggers disabled for this one statement.
      await context.adminDb.$transaction([
        context.adminDb.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        context.adminDb.$executeRawUnsafe(
          `UPDATE ai_reviews SET service_purchase_id = NULL WHERE id = '${row.id}'`,
        ),
      ]);
      release();
      const job = await context.jobs.findByResource('AI_REVIEW' as never, row.id);
      await context.dispatcher.dispatchNow(job!.id);
      const settled = await waitForReview(row.id);
      expect(settled.status).toBe('COMPLETED');
      // Its orphaned reservation was never captured, and nothing was charged.
      expect((await aiPurchase(context, row.servicePurchaseId!)).status).not.toBe('DELIVERED');
      expect(await chargesFor(row.servicePurchaseId!)).toHaveLength(0);
      expect(
        (await context.adminDb.aIReview.findUniqueOrThrow({ where: { id: row.id } }))
          .servicePurchaseId,
      ).toBeNull();
    });

    it('runs an extraction created before AI billing to completion without charging anyone', async () => {
      const owner = tenant.owner.client;
      const documentType = await createDocumentType(owner, tenant.organizationId, {
        name: 'Legacy guidelines',
      });
      const created = await createStandard(owner, tenant.organizationId, documentType.id, {
        code: 'UA.LEGACY.DRAFT',
      });
      const version = await createVersion(owner, tenant.organizationId, created.id);
      await grantOrganizationAIConsent(owner, tenant.organizationId);
      await uploadSource(context, owner, tenant.organizationId, version.id, {
        sourceKind: 'GUIDELINE_PDF',
        filename: 'guidelines.pdf',
        bytes: minimalPdf(guidelineText('The left margin must be 30 mm.')),
      });
      const release = holdTheQueue();
      const started = await owner.post(
        `${API}/organizations/${tenant.organizationId}/standard-versions/${version.id}/extractions`,
        {
          priceQuoteId: (await fundForAI(context, tenant.owner.userId, 'AI_RULE_EXTRACTION'))
            .quoteId,
        },
      );
      const run = await context.adminDb.ruleExtractionRun.findUniqueOrThrow({
        where: { id: started.body.id },
      });
      await context.adminDb.$transaction([
        context.adminDb.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        context.adminDb.$executeRawUnsafe(
          `UPDATE rule_extraction_runs SET service_purchase_id = NULL WHERE id = '${run.id}'`,
        ),
      ]);
      const chargesBefore = await context.adminDb.creditLedgerEntry.count({
        where: { entryType: 'SERVICE_CHARGE' },
      });
      release();
      const job = await context.jobs.findByResource('RULE_EXTRACTION' as never, run.id);
      await context.dispatcher.dispatchNow(job!.id);
      const settled = await waitForExtraction(context, run.id);
      expect(settled.status).toBe('COMPLETED');
      expect(
        (await context.adminDb.ruleExtractionRun.findUniqueOrThrow({ where: { id: run.id } }))
          .servicePurchaseId,
      ).toBeNull();
      expect(
        await context.adminDb.creditLedgerEntry.count({ where: { entryType: 'SERVICE_CHARGE' } }),
      ).toBe(chargesBefore);
      expect((await aiPurchase(context, run.servicePurchaseId!)).status).not.toBe('DELIVERED');
    });
  });
});
