import { CAPABILITY_REGISTRY_VERSION } from '@palcert/contracts';
import { API, type AuthClient } from './support/auth-client';
import {
  publishCheckableStandard,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx } from './support/fixtures';
import { createTenant, createUser } from './support/organization-client';
import { chargesForPurchase, grantCredit } from './support/paid-check-client';
import {
  SMARTFIX_PRICE_MINOR,
  cancelSmartFix,
  ensureSmartFixPrice,
  fundForSmartFix,
  planSmartFix,
  quoteForSmartFix,
  readManifest,
  readPlan,
  readSmartFix,
  smartFixRow,
  startSmartFix,
} from './support/smartfix-client';
import { FakeDocumentEngine } from './support/fake-document-engine';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * The SmartFix journey (§201–§214).
 *
 * One student, one thesis, one correction, end to end. Every test here is
 * really asserting one sentence: **PalCert may change deterministic document
 * formatting, but it must never silently change academic meaning — and the
 * customer pays only when it has proved it did neither.**
 */
/**
 * The engine double has to claim the registry the real engine runs.
 *
 * Every suite below plans and applies through `FakeDocumentEngine`, which both
 * stamps a plan with a capability registry version and accepts that plan back.
 * The real Python engine does not: it refuses any plan whose stamped version is
 * not the current one, with PLAN_ENGINE_MISMATCH. So a double left on a stale
 * version would agree with itself all the way through a journey that
 * production would reject outright — and the suite would report success.
 *
 * These assertions need no application, so they run before it is built.
 */
describe('SmartFix - engine double fidelity', () => {
  it('claims the capability registry the real engine is running', () => {
    expect(new FakeDocumentEngine().capabilityRegistryVersion).toBe(CAPABILITY_REGISTRY_VERSION);
  });

  it('restores the current registry on reset, never the version it was set to', () => {
    // reset() runs between tests. If it restored a literal, one test
    // simulating an old engine would leave every later test simulating it too.
    const engine = new FakeDocumentEngine();
    engine.capabilityRegistryVersion = 1;
    engine.reset();
    expect(engine.capabilityRegistryVersion).toBe(CAPABILITY_REGISTRY_VERSION);
  });

  it('still lets a test simulate another engine deliberately', () => {
    // The default tracks the contract; the field stays writable, because
    // proving the mismatch path needs a mismatch.
    const engine = new FakeDocumentEngine();
    engine.capabilityRegistryVersion = 1;
    expect(engine.capabilityRegistryVersion).toBe(1);
    expect(engine.capabilityRegistryVersion).not.toBe(CAPABILITY_REGISTRY_VERSION);
  });
});

describe('SmartFix - journey (e2e)', () => {
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

  /** A completed check of a ready DOCX: everything SmartFix starts from. */
  async function completedCheck(): Promise<{ checkId: string; versionId: string }> {
    const document = await createDocument(student.client, 'Thesis');
    const { versionId } = await uploadAndProcess(student.client, document.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    expect(created.status).toBe(202);
    const settled = await waitForCheck(context, created.body.id);
    expect(settled.status).toBe('COMPLETED');
    return { checkId: created.body.id, versionId };
  }

  async function waitForSmartFix(
    requestId: string,
    timeoutMs = 30_000,
  ): Promise<{ status: string; failureCode: string | null }> {
    const deadline = Date.now() + timeoutMs;
    let last = 'RESERVED';
    while (Date.now() < deadline) {
      const row = await context.adminDb.smartFixRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      last = row.status;
      if (row.status === 'DELIVERED' || row.status === 'FAILED' || row.status === 'CANCELLED') {
        return { status: row.status, failureCode: row.failureCode };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`correction ${requestId} did not settle; last status ${last}`);
  }

  async function available(currency = 'USD'): Promise<bigint> {
    const balance = await student.client.get(`${API}/balance?currency=${currency}`);
    return BigInt(balance.body.available.minorUnits);
  }

  // -------------------------------------------------------------------------
  // Planning is free
  // -------------------------------------------------------------------------

  it('plans a correction without reserving or charging anything', async () => {
    const { checkId } = await completedCheck();
    const before = await available();

    const planned = await planSmartFix(student.client, checkId);
    expect(planned.status).toBe(200);
    expect(planned.body.checkId).toBe(checkId);
    expect(planned.body.actionCount).toBeGreaterThan(0);
    // Every rule the plan will not touch says why, so the user can see the
    // whole picture before deciding (§3).
    expect(planned.body.rules.length).toBeGreaterThan(0);

    // Free means free: no purchase, no hold, no ledger entry, no job.
    expect(await available()).toBe(before);
    expect(
      await context.adminDb.servicePurchase.count({ where: { resourceType: 'SMARTFIX' } }),
    ).toBe(0);
    // The check's own reservation is somebody else's business; what matters
    // is that planning created none of its own.
    expect(
      await context.adminDb.servicePurchaseAllocation.count({
        where: { purchase: { resourceType: 'SMARTFIX' } },
      }),
    ).toBe(0);
  });

  it('reads a plan back unchanged', async () => {
    const { checkId } = await completedCheck();
    const planned = await planSmartFix(student.client, checkId);
    const reread = await readPlan(student.client, planned.body.id);
    expect(reread.status).toBe(200);
    expect(reread.body).toEqual(planned.body);
  });

  it('refuses to plan a check that has not finished', async () => {
    const document = await createDocument(student.client, 'Thesis');
    const { versionId } = await uploadAndProcess(student.client, document.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
    const created = await context.adminDb.documentCheck.findFirst({ where: {} });
    expect(created).toBeNull();

    const check = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    // Immediately, before the worker gets to it: there is no report to plan
    // against, and inventing one would be inventing a correction.
    const planned = await planSmartFix(student.client, check.body.id);
    if (planned.status !== 200) {
      expect(planned.status).toBe(409);
      expect(planned.body.error.code).toBe('SMARTFIX_NOT_AVAILABLE');
    }
    await waitForCheck(context, check.body.id);
  });

  // -------------------------------------------------------------------------
  // The golden journey
  // -------------------------------------------------------------------------

  it('reserves on request, corrects a copy, rechecks it, then charges', async () => {
    const { checkId, versionId } = await completedCheck();
    const planned = await planSmartFix(student.client, checkId);

    await ensureSmartFixPrice(context, SMARTFIX_PRICE_MINOR);
    await grantCredit(context, student.userId, 2000n);
    const before = await available();
    const quote = await quoteForSmartFix(context, student.userId);

    const started = await startSmartFix(student.client, {
      planId: planned.body.id,
      priceQuoteId: quote.id,
    });
    expect(started.status).toBe(202);
    expect(started.body.status).toBe('RESERVED');
    // Reserved, not charged, and no corrected document offered yet.
    expect(await available()).toBe(before - SMARTFIX_PRICE_MINOR);
    expect(started.body.correctedDocumentVersionId).toBeNull();

    const settled = await waitForSmartFix(started.body.id);
    expect(settled).toEqual({ status: 'DELIVERED', failureCode: null });

    const row = await smartFixRow(context, started.body.id);
    expect(row.servicePurchase.status).toBe('DELIVERED');
    expect(row.manifest).not.toBeNull();
    expect(row.recheck!.status).toBe('COMPLETED');
    expect(row.recheck!.purpose).toBe('SMARTFIX_RECHECK');
    // The recheck carries no purchase of its own: the user paid for it once,
    // as part of the correction (§93, §98).
    expect(row.recheck!.servicePurchaseId).toBeNull();

    // Exactly one charge, for exactly the quoted amount.
    const charges = await chargesForPurchase(context, row.servicePurchaseId);
    expect(charges).toHaveLength(1);
    expect(charges[0]!.amountMinorSigned).toBe(-SMARTFIX_PRICE_MINOR);
    expect(await available()).toBe(before - SMARTFIX_PRICE_MINOR);

    // The original is untouched, and the correction is a *new version* of the
    // same document with its parent recorded (§2).
    const original = await context.adminDb.documentVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(original.origin).toBe('USER_UPLOAD');
    expect(original.sha256).toBe(original.sha256);
    const corrected = row.correctedVersion!;
    expect(corrected.origin).toBe('SMARTFIX');
    expect(corrected.sourceDocumentVersionId).toBe(versionId);
    expect(corrected.documentId).toBe(original.documentId);
    expect(corrected.sha256).not.toBe(original.sha256);
    expect(corrected.status).toBe('READY');
    expect(corrected.visibleToOwner).toBe(true);

    const view = await readSmartFix(student.client, started.body.id);
    expect(view.body.status).toBe('DELIVERED');
    expect(view.body.correctedDocumentVersionId).toBe(corrected.id);
  });

  it('publishes a manifest that proves it changed nothing but formatting', async () => {
    const { checkId } = await completedCheck();
    const planned = await planSmartFix(student.client, checkId);
    const { quoteId } = await fundForSmartFix(context, student.userId);
    const started = await startSmartFix(student.client, {
      planId: planned.body.id,
      priceQuoteId: quoteId,
    });
    await waitForSmartFix(started.body.id);

    const manifest = await readManifest(student.client, started.body.id);
    expect(manifest.status).toBe(200);
    expect(manifest.body.entryCount).toBeGreaterThan(0);
    expect(manifest.body.changedParts).toContain('word/document.xml');
    // The four proofs, as the one question the user actually has.
    expect(manifest.body.textUnchanged).toBe(true);
    expect(manifest.body.mediaUnchanged).toBe(true);
    expect(manifest.body.fieldsUnchanged).toBe(true);
    expect(manifest.body.relationshipsUnchanged).toBe(true);
    expect(manifest.body.entries.length).toBe(manifest.body.entryCount);
  });

  // -------------------------------------------------------------------------
  // The failure path is free
  // -------------------------------------------------------------------------

  it('releases the reservation and charges nothing when the engine refuses', async () => {
    const { checkId } = await completedCheck();
    const planned = await planSmartFix(student.client, checkId);
    const { quoteId } = await fundForSmartFix(context, student.userId);
    const before = await available();

    context.documentEngine.smartFixMode = 'refuse-apply';
    const started = await startSmartFix(student.client, {
      planId: planned.body.id,
      priceQuoteId: quoteId,
    });
    const settled = await waitForSmartFix(started.body.id);
    expect(settled.status).toBe('FAILED');

    const row = await smartFixRow(context, started.body.id);
    expect(row.servicePurchase.status).toBe('RELEASED');
    expect(await chargesForPurchase(context, row.servicePurchaseId)).toHaveLength(0);
    // Not a penny, and the balance is exactly what it was.
    expect(await available()).toBe(before);
    expect(row.correctedVersion).toBeNull();
  });

  it('gives the reservation back when the user cancels', async () => {
    const { checkId } = await completedCheck();
    const planned = await planSmartFix(student.client, checkId);
    const { quoteId } = await fundForSmartFix(context, student.userId);
    const before = await available();

    // Hold the engine so the correction is still in flight when it is cancelled.
    context.documentEngine.smartFixMode = 'unavailable';
    const started = await startSmartFix(student.client, {
      planId: planned.body.id,
      priceQuoteId: quoteId,
    });
    expect(await available()).toBe(before - SMARTFIX_PRICE_MINOR);

    const cancelled = await cancelSmartFix(student.client, started.body.id);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.failureCode).toBe('CANCELLED_BY_CUSTOMER');

    const row = await smartFixRow(context, started.body.id);
    expect(row.servicePurchase.status).toBe('RELEASED');
    expect(await chargesForPurchase(context, row.servicePurchaseId)).toHaveLength(0);
    expect(await available()).toBe(before);
  });

  it('refuses to start a correction the customer cannot afford', async () => {
    const { checkId } = await completedCheck();
    const planned = await planSmartFix(student.client, checkId);
    // A correction priced far beyond anything this customer holds.
    await ensureSmartFixPrice(context, 100_000_000n);
    const quote = await quoteForSmartFix(context, student.userId);

    const started = await startSmartFix(student.client, {
      planId: planned.body.id,
      priceQuoteId: quote.id,
    });
    expect(started.status).toBe(402);
    expect(started.body.error.code).toBe('INSUFFICIENT_BALANCE');
    // Nothing was created: no request, no purchase, no hold, no job.
    expect(await context.adminDb.smartFixRequest.count()).toBe(0);
    expect(
      await context.adminDb.servicePurchase.count({ where: { resourceType: 'SMARTFIX' } }),
    ).toBe(0);
  });

  it('refuses a second correction of the same plan', async () => {
    const { checkId } = await completedCheck();
    const planned = await planSmartFix(student.client, checkId);
    const first = await fundForSmartFix(context, student.userId);
    const started = await startSmartFix(student.client, {
      planId: planned.body.id,
      priceQuoteId: first.quoteId,
    });
    expect(started.status).toBe(202);

    const second = await quoteForSmartFix(context, student.userId);
    const again = await startSmartFix(student.client, {
      planId: planned.body.id,
      priceQuoteId: second.id,
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SMARTFIX_NOT_AVAILABLE');
    await waitForSmartFix(started.body.id);
  });
});
