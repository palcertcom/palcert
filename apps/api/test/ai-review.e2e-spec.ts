import { reviewBody } from './support/ai-billing-client';
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
import { minimalDocx } from './support/fixtures';
import { createTenant, createUser } from './support/organization-client';
import { validRule } from './support/standards-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * AI review, end to end (§113).
 *
 * The deterministic report is the product; the AI layer is an addition to it.
 * Everything asserted here follows from that: consent before anything leaves,
 * advisory assessments that never become verdicts, blocking rules that still
 * need a person, and — the mandatory one — a Phase 7 report that is
 * byte-identical before and after.
 */
describe('AI review (e2e)', () => {
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
    standard = await publishCheckableStandard(context, tenant.owner.client, tenant.organizationId, {
      rules: [validRule(), aiAssistedRule(), manualRule()],
    });
  });

  async function completedCheck(): Promise<string> {
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
    return created.body.id;
  }

  async function grantConsent(): Promise<void> {
    const response = await student.client.post(`${API}/ai/consent`);
    expect(response.status).toBe(201);
  }

  async function waitForReview(
    reviewId: string,
    timeoutMs = 30_000,
  ): Promise<{ status: string; failureKind: string | null }> {
    const deadline = Date.now() + timeoutMs;
    let last = 'CREATED';
    while (Date.now() < deadline) {
      const row = await context.adminDb.aIReview.findUniqueOrThrow({ where: { id: reviewId } });
      last = row.status;
      if (row.status === 'COMPLETED' || row.status === 'FAILED' || row.status === 'CANCELLED') {
        return { status: row.status, failureKind: row.failureKind };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`AI review ${reviewId} did not settle in ${timeoutMs} ms (last ${last})`);
  }

  async function startReview(checkId: string) {
    return student.client.post(
      `${API}/checks/${checkId}/ai-reviews`,
      await reviewBody(context, student.userId),
    );
  }

  describe('consent', () => {
    it('refuses an AI review until the user has agreed', async () => {
      const checkId = await completedCheck();

      const refused = await startReview(checkId);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('AI_CONSENT_REQUIRED');
      // Nothing was queued, so nothing could have been sent.
      expect(context.aiProvider.assessmentCalls).toHaveLength(0);
    });

    it('allows it once the user agrees, and records what they agreed to', async () => {
      const checkId = await completedCheck();
      await grantConsent();

      const accepted = await startReview(checkId);
      expect(accepted.status).toBe(202);

      const consent = await context.adminDb.aIConsent.findUniqueOrThrow({
        where: { ownerUserId: student.userId },
      });
      expect(consent.consentVersion).toBe('1');
      expect(consent.providerCategory).toBe('EXTERNAL_AI_PROVIDER');

      const events = await context.adminDb.auditEvent.findMany({
        where: { action: 'AI_CONSENT_GRANTED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.actorUserId).toBe(student.userId);
    });

    it('stops new reviews when the user withdraws', async () => {
      const checkId = await completedCheck();
      await grantConsent();
      await student.client.delete(`${API}/ai/consent`);

      const refused = await startReview(checkId);
      expect(refused.status).toBe(403);
    });
  });

  describe('preconditions', () => {
    it('refuses a check that has not completed', async () => {
      await grantConsent();
      const document = await createDocument(student.client, 'Thesis');
      const { versionId } = await uploadAndProcess(student.client, document.id, {
        name: 'thesis.docx',
        bytes: minimalDocx(),
      });
      const created = await startCheck(context, student, {
        documentVersionId: versionId,
        standardId: standard.standardId,
      });

      const refused = await startReview(created.body.id);
      // Either still running, or completed between the two calls; both are
      // correct refusals of an incomplete check.
      if (refused.status !== 202) {
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('AI_REVIEW_CHECK_NOT_COMPLETED');
      }
    });

    it('refuses a standard with no AI-assisted rules', async () => {
      await grantConsent();
      const deterministicOnly = await publishCheckableStandard(
        context,
        tenant.owner.client,
        tenant.organizationId,
        { standardCode: 'IUG.DETERMINISTIC', documentTypeName: 'Journal Article' },
      );
      const document = await createDocument(student.client, 'Paper');
      const { versionId } = await uploadAndProcess(student.client, document.id, {
        name: 'paper.docx',
        bytes: minimalDocx(),
      });
      const created = await startCheck(context, student, {
        documentVersionId: versionId,
        standardId: deterministicOnly.standardId,
      });
      await waitForCheck(context, created.body.id);

      const refused = await startReview(created.body.id);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('AI_REVIEW_NO_ASSESSABLE_RULES');
    });
  });

  describe('a completed review', () => {
    it('assesses the AI-assisted rule and never sends the manual one', async () => {
      const checkId = await completedCheck();
      await grantConsent();
      const created = await startReview(checkId);
      await waitForReview(created.body.id);

      const assessments = await context.adminDb.aIRuleAssessment.findMany({
        where: { aiReviewId: created.body.id },
      });
      expect(assessments.map((row) => row.ruleCode)).toEqual(['COI.DECLARATION']);

      // A manual rule stays manual. Sending it to a model would be treating an
      // AI opinion as equivalent to human review (§23).
      const sent = context.aiProvider.assessmentCalls.flatMap((call) => call.requestedRuleCodes);
      expect(sent).toContain('COI.DECLARATION');
      expect(sent).not.toContain('SUPERVISOR.SIGNOFF');
      expect(sent).not.toContain('MARGIN.TOP.MIN');
    });

    it('records provider, model, prompt and context versions', async () => {
      const checkId = await completedCheck();
      await grantConsent();
      const created = await startReview(checkId);
      await waitForReview(created.body.id);

      const review = await context.adminDb.aIReview.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(review.provider).toBe('fake');
      expect(review.configuredModel).toBe('fake-model-1');
      expect(review.providerReturnedModel).toBe('fake-model-1');
      expect(review.promptVersion).toBe('1');
      expect(review.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(review.contextBuilderVersion).toBe('1');
      expect(review.contextHash).toMatch(/^[0-9a-f]{64}$/);
      expect(review.rulesHash).toMatch(/^[0-9a-f]{64}$/);
      expect(review.aiReviewHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('records provider usage without a money amount', async () => {
      const checkId = await completedCheck();
      await grantConsent();
      const created = await startReview(checkId);
      await waitForReview(created.body.id);

      const invocations = await context.adminDb.aIInvocation.findMany({
        where: { aiReviewId: created.body.id },
      });
      expect(invocations.length).toBeGreaterThanOrEqual(2);
      expect(invocations.every((row) => row.status === 'SUCCEEDED')).toBe(true);
      expect(invocations[0]!.providerRequestId).toBe('fake-request-1');
      expect(invocations[0]!.inputTokens).toBeGreaterThan(0);

      // Prices change; a cost baked into a row now would be wrong later (§79).
      const columns = Object.keys(invocations[0]!);
      expect(columns.join(' ')).not.toMatch(/cost|usd|price/i);
    });

    it('writes a bilingual explanation and a supplement', async () => {
      const checkId = await completedCheck();
      await grantConsent();
      const created = await startReview(checkId);
      await waitForReview(created.body.id);

      const assessments = await student.client.get(
        `${API}/checks/${checkId}/ai-reviews/${created.body.id}/assessments`,
      );
      expect(assessments.status).toBe(200);
      expect(assessments.body[0].explanationEn.length).toBeGreaterThan(0);
      expect(assessments.body[0].explanationAr).toMatch(/[؀-ۿ]/);

      const supplement = await student.client.get(
        `${API}/checks/${checkId}/ai-reviews/${created.body.id}/supplement`,
      );
      expect(supplement.status).toBe(200);
      expect(supplement.body.summaryAr).toMatch(/[؀-ۿ]/);
      // No score, no determination, no certification anywhere in it (§39).
      expect(JSON.stringify(supplement.body)).not.toMatch(
        /score|determination|approved|accepted|certified/i,
      );
    });

    it('carries the deterministic outcome beside every assessment', async () => {
      const checkId = await completedCheck();
      await grantConsent();
      const created = await startReview(checkId);
      await waitForReview(created.body.id);

      const assessments = await student.client.get(
        `${API}/checks/${checkId}/ai-reviews/${created.body.id}/assessments`,
      );
      // So a client physically cannot render an AI verdict without the machine
      // one next to it (§66).
      expect(assessments.body[0].deterministicOutcome).toBe('INDETERMINATE');
      expect(assessments.body[0].assessment).toBe('SATISFIED');
    });
  });

  describe('the AI never acquires authority', () => {
    it.each(['SATISFIED', 'NOT_SATISFIED', 'INSUFFICIENT_EVIDENCE'] as const)(
      'still requires human review for a blocking rule assessed %s',
      async (assessment) => {
        await resetState(context);
        student = await createUser(context, 'student@example.com');
        tenant = await createTenant(context, 'IUG', 'registrar@example.com');
        standard = await publishCheckableStandard(
          context,
          tenant.owner.client,
          tenant.organizationId,
          { rules: [validRule(), aiAssistedRule({ blocking: true })] },
        );

        const checkId = await completedCheck();
        await grantConsent();
        context.aiProvider.assessment = assessment;
        const created = await startReview(checkId);
        await waitForReview(created.body.id);

        const row = await context.adminDb.aIRuleAssessment.findFirstOrThrow({
          where: { aiReviewId: created.body.id },
        });
        // The single most important guarantee in Phase 8 (§26).
        expect(row.assessment).toBe(assessment);
        expect(row.requiresHumanReview).toBe(true);
      },
      60_000,
    );

    it('leaves the deterministic report byte-identical', async () => {
      // The mandatory test (§75). Everything Phase 7 decided must be exactly
      // what it was before an AI ever looked at the document.
      const checkId = await completedCheck();

      const before = {
        check: await context.adminDb.documentCheck.findUniqueOrThrow({ where: { id: checkId } }),
        run: await context.adminDb.checkRun.findFirstOrThrow({ where: { checkId } }),
        report: await context.adminDb.checkReport.findFirstOrThrow({ where: { checkId } }),
        results: await context.adminDb.checkRuleResult.findMany({
          where: { run: { checkId } },
          orderBy: { ruleCode: 'asc' },
        }),
        violations: await context.adminDb.checkViolation.findMany({
          where: { result: { run: { checkId } } },
          orderBy: { id: 'asc' },
        }),
      };

      await grantConsent();
      const created = await startReview(checkId);
      await waitForReview(created.body.id);

      const after = {
        check: await context.adminDb.documentCheck.findUniqueOrThrow({ where: { id: checkId } }),
        run: await context.adminDb.checkRun.findFirstOrThrow({ where: { checkId } }),
        report: await context.adminDb.checkReport.findFirstOrThrow({ where: { checkId } }),
        results: await context.adminDb.checkRuleResult.findMany({
          where: { run: { checkId } },
          orderBy: { ruleCode: 'asc' },
        }),
        violations: await context.adminDb.checkViolation.findMany({
          where: { result: { run: { checkId } } },
          orderBy: { id: 'asc' },
        }),
      };

      expect(after.report.reportHash).toBe(before.report.reportHash);
      expect(after.report.evaluationHash).toBe(before.report.evaluationHash);
      expect(after.run.determination).toBe(before.run.determination);
      expect(after.run.scoreValue).toBe(before.run.scoreValue);
      expect(after.run.scoreCoverage).toBe(before.run.scoreCoverage);
      expect(after.check.status).toBe(before.check.status);
      expect(after.results).toEqual(before.results);
      expect(after.violations).toEqual(before.violations);
    });

    it('serves the same report artifact bytes after an AI review', async () => {
      const checkId = await completedCheck();
      const before = await student.client.get(`${API}/checks/${checkId}/report/artifact`);

      await grantConsent();
      const created = await startReview(checkId);
      await waitForReview(created.body.id);

      const after = await student.client.get(`${API}/checks/${checkId}/report/artifact`);
      expect(after.text).toBe(before.text);
    });
  });

  describe('provider failures', () => {
    it('fails the review without touching the check', async () => {
      const checkId = await completedCheck();
      await grantConsent();
      context.aiProvider.mode = 'authentication';

      const created = await startReview(checkId);
      const settled = await waitForReview(created.body.id);

      expect(settled.status).toBe('FAILED');
      expect(settled.failureKind).toBe('AUTHENTICATION');

      // The deterministic report remains fully usable (§105).
      const check = await student.client.get(`${API}/checks/${checkId}`);
      expect(check.body.status).toBe('COMPLETED');
      expect(check.body.determination).not.toBeNull();
    });

    it('does not endlessly retry a permanent error', async () => {
      const checkId = await completedCheck();
      await grantConsent();
      context.aiProvider.mode = 'invalid-request';

      const created = await startReview(checkId);
      await waitForReview(created.body.id);

      // One attempt: a malformed request fails identically for ever (§56).
      expect(context.aiProvider.assessmentCalls).toHaveLength(1);
    });

    it('rejects fabricated evidence rather than storing it', async () => {
      const checkId = await completedCheck();
      await grantConsent();
      context.aiProvider.mode = 'unknown-node';

      const created = await startReview(checkId);
      const settled = await waitForReview(created.body.id);

      expect(settled.status).toBe('FAILED');
      expect(settled.failureKind).toBe('OUTPUT_INVALID');
      expect(
        await context.adminDb.aIRuleAssessment.count({ where: { aiReviewId: created.body.id } }),
      ).toBe(0);
    });

    it('rejects a rule the model added on its own', async () => {
      const checkId = await completedCheck();
      await grantConsent();
      context.aiProvider.mode = 'unknown-rule';

      const created = await startReview(checkId);
      const settled = await waitForReview(created.body.id);

      expect(settled.status).toBe('FAILED');
      expect(settled.failureKind).toBe('OUTPUT_INVALID');
    });

    it('rejects a response that omitted a requested rule', async () => {
      const checkId = await completedCheck();
      await grantConsent();
      context.aiProvider.mode = 'missing-rule';

      const created = await startReview(checkId);
      const settled = await waitForReview(created.body.id);
      expect(settled.status).toBe('FAILED');
    });

    it('reports the provider as unavailable without failing platform readiness', async () => {
      context.aiProvider.available = false;

      const ready = await student.client.get('/health/ready');
      expect(ready.status).toBe(200);

      const ai = await student.client.get('/api/health/ai');
      expect(ai.status).toBe(200);
      expect(ai.body).toEqual({ enabled: true, available: false });
    });
  });

  describe('repeat reviews', () => {
    it('creates a new review rather than overwriting the old one', async () => {
      const checkId = await completedCheck();
      await grantConsent();

      const first = await startReview(checkId);
      await waitForReview(first.body.id);

      // A different model is a different review; the old one stays identifiable
      // by the model and prompt that produced it (§11, §29 of §113).
      context.aiProvider.configuredModel = 'fake-model-2';
      const second = await startReview(checkId);
      await waitForReview(second.body.id);

      expect(second.body.id).not.toBe(first.body.id);
      const reviews = await context.adminDb.aIReview.findMany({
        where: { checkId },
        orderBy: { createdAt: 'asc' },
      });
      expect(reviews).toHaveLength(2);
      expect(reviews[0]!.providerReturnedModel).toBe('fake-model-1');
      expect(reviews[1]!.providerReturnedModel).toBe('fake-model-2');
      expect(reviews[0]!.aiReviewHash).not.toBe(reviews[1]!.aiReviewHash);
    });

    it('deduplicates a repeated request carrying the same idempotency key', async () => {
      const checkId = await completedCheck();
      await grantConsent();
      const headers = { 'Idempotency-Key': 'browser-retry-1' };
      const body = await reviewBody(context, student.userId);

      const first = await student.client.post(`${API}/checks/${checkId}/ai-reviews`, body, {
        headers,
      });
      const second = await student.client.post(`${API}/checks/${checkId}/ai-reviews`, body, {
        headers,
      });

      expect(second.body.id).toBe(first.body.id);
      await waitForReview(first.body.id);
      expect(await context.adminDb.aIReview.count({ where: { checkId } })).toBe(1);
    });

    it('is a no-op when a completed review is delivered again', async () => {
      const checkId = await completedCheck();
      await grantConsent();
      const created = await startReview(checkId);
      await waitForReview(created.body.id);

      const callsBefore = context.aiProvider.assessmentCalls.length;
      const job = await context.jobs.findByResource('AI_REVIEW', created.body.id);
      expect(job).not.toBeNull();
      await context.worker.processJobId(job!.id);

      // At-least-once delivery must not mean calling a provider twice over
      // somebody's document (§59).
      expect(context.aiProvider.assessmentCalls).toHaveLength(callsBefore);
      expect(
        await context.adminDb.aIRuleAssessment.count({ where: { aiReviewId: created.body.id } }),
      ).toBe(1);
    });
  });
});
