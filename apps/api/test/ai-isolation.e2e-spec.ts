import { reviewBody } from './support/ai-billing-client';
import { API, type AuthClient } from './support/auth-client';
import {
  aiAssistedRule,
  publishCheckableStandard,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx } from './support/fixtures';
import { createTenant, createUser } from './support/organization-client';
import { grantOrganizationRole, ORG_ROLE, validRule } from './support/standards-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Isolation around AI output (§61, §62, §63, §101, §102).
 *
 * An AI review is derived from a private document, so it inherits that
 * document's privacy exactly. Two properties, and the second is the one an
 * institution would most like to be untrue:
 *
 * **A review is private to its owner.** Another student cannot read it, start
 * one, or learn it exists.
 *
 * **Publishing a standard buys an organization nothing.** Not the assessments,
 * not the recommendations, not the evidence, not even the provider metadata or
 * the fact that an AI review happened.
 */
describe('AI review - isolation (e2e)', () => {
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
    standard = await publishCheckableStandard(context, tenant.owner.client, tenant.organizationId, {
      rules: [validRule(), aiAssistedRule()],
    });
  });

  async function completedReview(): Promise<{ checkId: string; reviewId: string }> {
    const document = await createDocument(student.client, 'Thesis');
    const { versionId } = await uploadAndProcess(student.client, document.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
    const check = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, check.body.id);

    await student.client.post(`${API}/ai/consent`);
    const review = await student.client.post(
      `${API}/checks/${check.body.id}/ai-reviews`,
      await reviewBody(context, student.userId),
    );
    expect(review.status).toBe(202);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const row = await context.adminDb.aIReview.findUniqueOrThrow({
        where: { id: review.body.id },
      });
      if (row.status === 'COMPLETED') break;
      if (row.status === 'FAILED') throw new Error(`review failed: ${row.failureKind}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { checkId: check.body.id, reviewId: review.body.id };
  }

  function aiPaths(checkId: string, reviewId: string): string[] {
    return [
      `/checks/${checkId}/ai-reviews`,
      `/checks/${checkId}/ai-reviews/${reviewId}`,
      `/checks/${checkId}/ai-reviews/${reviewId}/assessments`,
      `/checks/${checkId}/ai-reviews/${reviewId}/supplement`,
    ];
  }

  describe('a review is private to its owner', () => {
    it('hides another user’s review behind a 404, never a 403', async () => {
      const { checkId, reviewId } = await completedReview();

      for (const path of aiPaths(checkId, reviewId)) {
        const response = await stranger.client.get(`${API}${path}`);
        // The difference would confirm the id exists, which is itself a leak.
        expect([response.status, path]).toEqual([404, path]);
      }
    });

    it('refuses to start a review on another user’s check', async () => {
      const { checkId } = await completedReview();
      await stranger.client.post(`${API}/ai/consent`);

      const response = await stranger.client.post(
        `${API}/checks/${checkId}/ai-reviews`,
        await reviewBody(context, stranger.userId),
      );
      expect(response.status).toBe(404);
    });

    it('refuses to cancel another user’s review', async () => {
      const { checkId, reviewId } = await completedReview();
      const response = await stranger.client.post(
        `${API}/checks/${checkId}/ai-reviews/${reviewId}/cancel`,
      );
      expect(response.status).toBe(404);
    });

    it('keeps one user’s consent from serving another', async () => {
      // Consent is user-scoped. One person agreeing does not enrol anyone else
      // in external processing (§63).
      await student.client.post(`${API}/ai/consent`);

      const strangerConsent = await stranger.client.get(`${API}/ai/consent`);
      expect(strangerConsent.body.granted).toBe(false);
    });

    it('scopes every stored AI row to its owner', async () => {
      const { reviewId } = await completedReview();

      const review = await context.adminDb.aIReview.findUniqueOrThrow({ where: { id: reviewId } });
      const assessments = await context.adminDb.aIRuleAssessment.findMany({
        where: { aiReviewId: reviewId },
      });
      const invocations = await context.adminDb.aIInvocation.findMany({
        where: { aiReviewId: reviewId },
      });
      const supplement = await context.adminDb.aIReportSupplement.findUniqueOrThrow({
        where: { aiReviewId: reviewId },
      });

      expect(review.ownerUserId).toBe(student.userId);
      expect(supplement.ownerUserId).toBe(student.userId);
      for (const row of [...assessments, ...invocations]) {
        expect(row.ownerUserId).toBe(student.userId);
      }
    });
  });

  describe('the publishing organization sees nothing', () => {
    it('gives the standard’s owner no route to the AI review', async () => {
      const { checkId, reviewId } = await completedReview();

      for (const path of aiPaths(checkId, reviewId)) {
        const response = await tenant.owner.client.get(`${API}${path}`);
        expect([response.status, path]).toEqual([404, path]);
      }
    });

    it.each([ORG_ROLE.ADMIN, ORG_ROLE.REVIEWER])(
      'gives an organization %s no route either',
      async (roleCode) => {
        const { checkId, reviewId } = await completedReview();

        const member = await createUser(context, `member-${roleCode}@example.com`);
        const membership = await context.adminDb.organizationMembership.create({
          data: {
            organizationId: tenant.organizationId,
            userId: member.userId,
            status: 'ACTIVE',
          },
        });
        await grantOrganizationRole(
          tenant.owner.client,
          tenant.organizationId,
          membership.id,
          roleCode,
        );

        for (const path of aiPaths(checkId, reviewId)) {
          const response = await member.client.get(`${API}${path}`);
          expect([response.status, path]).toEqual([404, path]);
        }
      },
      60_000,
    );

    it('does not tell the organization that an AI review happened', async () => {
      await completedReview();

      // No counter, no flag, no timestamp: nothing in the organization's view
      // of its own standard changes because someone ran an AI review (§62).
      const view = await tenant.owner.client.get(
        `${API}/organizations/${tenant.organizationId}/standards/${standard.standardId}`,
      );
      expect(view.status).toBe(200);
      // Named fields, not a loose word match: "checkAvailability" legitimately
      // contains "ai", and a regex that broad would pass by accident.
      const body = view.body as Record<string, unknown>;
      for (const key of Object.keys(body)) {
        expect(key).not.toMatch(/^ai|aiReview|assessment|provider|reviewCount|lastReviewed/i);
      }
      expect(JSON.stringify(body)).not.toMatch(/aiReview|assessmentCount|providerReturnedModel/);
    });

    it('gives no access to the provider metadata or token usage', async () => {
      const { checkId, reviewId } = await completedReview();

      const response = await tenant.owner.client.get(
        `${API}/checks/${checkId}/ai-reviews/${reviewId}`,
      );
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toMatch(/fake-model|inputTokens|promptHash/);
    });
  });

  describe('the API never exposes provider internals', () => {
    it('returns no prompt, no raw response and no credential', async () => {
      const { checkId, reviewId } = await completedReview();

      const review = await student.client.get(`${API}/checks/${checkId}/ai-reviews/${reviewId}`);
      const assessments = await student.client.get(
        `${API}/checks/${checkId}/ai-reviews/${reviewId}/assessments`,
      );
      const supplement = await student.client.get(
        `${API}/checks/${checkId}/ai-reviews/${reviewId}/supplement`,
      );

      const serialized = JSON.stringify([review.body, assessments.body, supplement.body]);
      expect(serialized).not.toMatch(/sk-ant|apiKey|api_key/i);
      expect(serialized).not.toMatch(/systemPrompt|userPrompt|rawResponse/);
      expect(serialized).not.toMatch(/<task_instructions>|<document_evidence>/);

      // What it does return: identity and integrity, so a review stays
      // explicable without exposing how it was produced (§11, §109).
      expect(review.body.provider).toBe('fake');
      expect(review.body.aiReviewHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
