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
import {
  cancelSmartFix,
  fundForSmartFix,
  planSmartFix,
  startSmartFix,
} from './support/smartfix-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Isolation around SmartFix (§128–§131).
 *
 * A correction is made of the most private things PalCert holds: the
 * document's own bytes, the list of what is wrong with it, and what the owner
 * paid to put it right. Everything in this phase is USER_SCOPED, and the two
 * properties below are what that has to mean in practice.
 *
 * **A correction is private to the person who bought it.** Another student
 * cannot read the plan, the request, the manifest, or the corrected document —
 * and cannot cancel, spend against, or even confirm the existence of any of
 * them.
 *
 * **Publishing a standard buys an institution nothing.** The university whose
 * standard the document was checked against gains no sight of the correction.
 * Phase 12 adds no organization route, no revenue share, and no visibility
 * (§221).
 */
describe('SmartFix - isolation (e2e)', () => {
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
    const settled = await waitForCheck(context, created.body.id);
    expect(settled.status).toBe('COMPLETED');
    return { checkId: created.body.id, versionId };
  }

  /** A planned, paid-for, in-flight correction belonging to `student`. */
  async function startedCorrection(): Promise<{
    checkId: string;
    versionId: string;
    planId: string;
    requestId: string;
  }> {
    const { checkId, versionId } = await completedCheck();
    const planned = await planSmartFix(student.client, checkId);
    expect(planned.status).toBe(200);
    const { quoteId } = await fundForSmartFix(context, student.userId);
    const started = await startSmartFix(student.client, {
      planId: planned.body.id,
      priceQuoteId: quoteId,
    });
    expect(started.status).toBe(202);
    return { checkId, versionId, planId: planned.body.id, requestId: started.body.id };
  }

  /** The same correction, waited out to whatever end it reaches. */
  async function settledCorrection(): Promise<Awaited<ReturnType<typeof startedCorrection>>> {
    const correction = await startedCorrection();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const row = await context.adminDb.smartFixRequest.findUniqueOrThrow({
        where: { id: correction.requestId },
      });
      if (row.status === 'DELIVERED' || row.status === 'FAILED' || row.status === 'CANCELLED') {
        expect(row.status).toBe('DELIVERED');
        return correction;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`correction ${correction.requestId} did not settle`);
  }

  // -------------------------------------------------------------------------
  // A correction is private to the person who bought it (§128, §129)
  // -------------------------------------------------------------------------

  describe('another user', () => {
    it('hides every SmartFix resource behind a 404, never a 403', async () => {
      // A 403 would confirm the id exists, which is itself the leak. Reading
      // and writing alike must be indistinguishable from "there is nothing
      // here" (§130).
      const { checkId, planId, requestId } = await settledCorrection();

      for (const path of [
        `/smartfix/plans/${planId}`,
        `/smartfix/requests/${requestId}`,
        `/smartfix/requests/${requestId}/manifest`,
      ]) {
        const response = await stranger.client.get(`${API}${path}`);
        expect([response.status, path]).toEqual([404, path]);
      }

      // The per-check listing is owner-scoped rather than 404, and that is
      // the same answer a caller gets for a check of their own with no
      // corrections — so it confirms nothing either.
      const listed = await stranger.client.get(`${API}/smartfix/checks/${checkId}/requests`);
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([]);

      for (const response of [
        await planSmartFix(stranger.client, checkId),
        await cancelSmartFix(stranger.client, requestId),
      ]) {
        expect(response.status).toBe(404);
      }
    });

    it('cannot spend another person’s plan, even with their money', async () => {
      // The stranger is solvent and holds a valid quote of their own. The only
      // thing they do not have is the plan — and that is enough (§73).
      const { planId } = await startedCorrection();
      const { quoteId } = await fundForSmartFix(context, stranger.userId);

      const attempt = await startSmartFix(stranger.client, { planId, priceQuoteId: quoteId });
      expect(attempt.status).toBe(404);

      // Nothing was reserved and nothing was charged for the attempt.
      const purchases = await context.adminDb.servicePurchase.findMany({
        where: { ownerUserId: stranger.userId },
      });
      expect(purchases).toEqual([]);
    });

    it('cannot pay for another person’s correction with their own quote', async () => {
      // The mirror image: the plan is the student's and so is the quote, but
      // the caller is neither. A purchase must belong to one person from end
      // to end.
      const { planId } = await startedCorrection();
      const { quoteId } = await fundForSmartFix(context, student.userId);

      const attempt = await startSmartFix(stranger.client, { planId, priceQuoteId: quoteId });
      expect(attempt.status).toBe(404);
    });

    it('never sees the corrected document among their own', async () => {
      const { requestId } = await settledCorrection();
      const row = await context.adminDb.smartFixRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      const correctedId = row.correctedDocumentVersionId!;

      const documents = await stranger.client.get(`${API}/documents`);
      expect(documents.body.items).toEqual([]);
      expect(JSON.stringify(documents.body)).not.toContain(correctedId);

      const version = await stranger.client.get(
        `${API}/documents/${row.documentId}/versions/${correctedId}`,
      );
      expect(version.status).toBe(404);
    });

    it('never sees the recheck it produced', async () => {
      const { requestId } = await settledCorrection();
      const row = await context.adminDb.smartFixRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      const recheckId = row.recheckCheckId!;

      const list = await stranger.client.get(`${API}/checks`);
      expect(list.body.items).toEqual([]);
      const direct = await stranger.client.get(`${API}/checks/${recheckId}`);
      expect(direct.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // The publishing organization sees nothing (§131, §221)
  // -------------------------------------------------------------------------

  describe('the standard’s owner', () => {
    it('gains no route to a correction made against its standard', async () => {
      const { checkId, planId, requestId } = await settledCorrection();

      // The registrar owns the standard the document was checked against, and
      // owns the organization. Neither grants a single byte of this (§221).
      for (const path of [
        `/smartfix/plans/${planId}`,
        `/smartfix/requests/${requestId}`,
        `/smartfix/requests/${requestId}/manifest`,
      ]) {
        const response = await tenant.owner.client.get(`${API}${path}`);
        expect([response.status, path]).toEqual([404, path]);
      }

      const listed = await tenant.owner.client.get(`${API}/smartfix/checks/${checkId}/requests`);
      expect(listed.body).toEqual([]);
    });

    it('is told nothing about corrections in its own view of the standard', async () => {
      await settledCorrection();

      // No counter, no timestamp, no revenue line: Phase 12 pays organizations
      // nothing and tells them nothing (§221).
      const view = await tenant.owner.client.get(
        `${API}/organizations/${tenant.organizationId}/standards/${standard.standardId}`,
      );
      expect(view.status).toBe(200);
      expect(JSON.stringify(view.body)).not.toMatch(/smartfix|correction|fixCount|revenue/i);
    });
  });

  // -------------------------------------------------------------------------
  // The rows themselves carry their owner (§128)
  // -------------------------------------------------------------------------

  it('scopes every stored SmartFix row to its owner', async () => {
    const { planId, requestId } = await settledCorrection();

    const plan = await context.adminDb.smartFixPlan.findUniqueOrThrow({ where: { id: planId } });
    const request = await context.adminDb.smartFixRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    const manifest = await context.adminDb.smartFixManifest.findFirstOrThrow({
      where: { requestId },
    });
    const corrected = await context.adminDb.documentVersion.findUniqueOrThrow({
      where: { id: request.correctedDocumentVersionId! },
    });
    const recheck = await context.adminDb.documentCheck.findUniqueOrThrow({
      where: { id: request.recheckCheckId! },
    });

    // The owner is on the row, not inferred from a join, because that is what
    // the row-level security policies are written against (ADR-0018).
    for (const row of [plan, request, manifest, corrected, recheck]) {
      expect(row.ownerUserId).toBe(student.userId);
    }
  });

  it('shows a caller only their own corrections for a check they own', async () => {
    // The check id is the only scoping key the route takes, so a missing owner
    // predicate would show up here: the stranger passing the student's own
    // check id would see the student's correction.
    const mine = await startedCorrection();
    const list = await student.client.get(`${API}/smartfix/checks/${mine.checkId}/requests`);
    expect(list.status).toBe(200);
    expect(list.body.map((item: { id: string }) => item.id)).toEqual([mine.requestId]);

    const theirs = await stranger.client.get(`${API}/smartfix/checks/${mine.checkId}/requests`);
    expect(theirs.status).toBe(200);
    expect(theirs.body).toEqual([]);
  });
});
