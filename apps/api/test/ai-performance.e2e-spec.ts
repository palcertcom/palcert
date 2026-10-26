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
import { validRule } from './support/standards-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * AI cost and context-size characteristics (§117).
 *
 * Every character PalCert sends to a provider is paid for twice — once in
 * money and once in the privacy of the person whose thesis it came from — so
 * the size of a request is a product property worth asserting, not an
 * implementation detail.
 *
 * These assertions are deliberately about *what PalCert sends and how often*,
 * never about how long a provider takes. Wall-clock latency against a network
 * service is not a property CI can measure honestly, and a test that tried
 * would fail for reasons that have nothing to do with the code under review.
 */
describe('AI review cost and context size (e2e)', () => {
  let context: TestContext;
  let student: { email: string; userId: string; client: AuthClient };
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let standard: PublishedStandard;

  /**
   * Ten AI-assisted requirements, which is a realistic institutional standard
   * and — at the test configuration's five rules per request — two provider
   * calls rather than one.
   */
  const AI_RULE_COUNT = 10;
  const RULES_PER_REQUEST = 5;

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

    const rules = [validRule()];
    for (let index = 0; index < AI_RULE_COUNT; index += 1) {
      rules.push(
        aiAssistedRule({
          ruleCode: `ETHICS.REQUIREMENT.${String(index + 1).padStart(2, '0')}`,
          titleEn: `Declaration ${index + 1} is present`,
          titleAr: `الإقرار ${index + 1} موجود`,
        }),
      );
    }

    standard = await publishCheckableStandard(context, tenant.owner.client, tenant.organizationId, {
      rules,
    });
  });

  async function completedReview(): Promise<{ reviewId: string; checkId: string }> {
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

    const consent = await student.client.post(`${API}/ai/consent`);
    expect(consent.status).toBe(201);

    const started = await student.client.post(
      `${API}/checks/${created.body.id}/ai-reviews`,
      await reviewBody(context, student.userId),
    );
    expect(started.status).toBe(202);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const row = await context.adminDb.aIReview.findUniqueOrThrow({
        where: { id: started.body.id },
      });
      if (row.status === 'COMPLETED') return { reviewId: row.id, checkId: created.body.id };
      if (row.status === 'FAILED') throw new Error(`review failed: ${row.failureKind}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('AI review did not settle');
  }

  it('splits ten requirements into bounded batches rather than one giant request', async () => {
    await completedReview();

    const calls = context.aiProvider.assessmentCalls;
    expect(calls).toHaveLength(Math.ceil(AI_RULE_COUNT / RULES_PER_REQUEST));

    // No batch exceeds the configured bound, and between them they cover every
    // requirement exactly once — an unbounded request is how a token budget is
    // blown, and a dropped rule is how a requirement silently goes unassessed.
    const requested: string[] = [];
    for (const call of calls) {
      expect(call.requestedRuleCodes.length).toBeLessThanOrEqual(RULES_PER_REQUEST);
      requested.push(...call.requestedRuleCodes);
    }
    expect(new Set(requested).size).toBe(AI_RULE_COUNT);
  });

  it('records one invocation per provider call, with the tokens each one cost', async () => {
    const { reviewId, checkId } = await completedReview();

    const invocations = await context.adminDb.aIInvocation.findMany({
      where: { aiReviewId: reviewId },
    });
    // Two rule-assessment calls plus the report supplement.
    expect(invocations.length).toBeGreaterThanOrEqual(
      Math.ceil(AI_RULE_COUNT / RULES_PER_REQUEST) + 1,
    );

    for (const invocation of invocations) {
      expect(invocation.provider).toBe('fake');
      expect(invocation.inputTokens ?? 0).toBeGreaterThan(0);
      expect(invocation.outputTokens ?? 0).toBeGreaterThan(0);
    }

    // The review's own counters are the sum of its invocations, so cost is
    // answerable per review without re-reading the ledger (§79).
    const review = await context.adminDb.aIReview.findUniqueOrThrow({ where: { id: reviewId } });
    const inputTotal = invocations.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
    expect(review.inputTokens).toBe(inputTotal);

    // Tokens, never a money amount: a price baked into a row now would be a
    // wrong price later (§102).
    const view = await student.client.get(`${API}/checks/${checkId}/ai-reviews/${reviewId}`);
    expect(view.status).toBe(200);
    expect(view.body.usage.invocationCount).toBe(invocations.length);
    expect(JSON.stringify(view.body)).not.toMatch(/costUsd|priceUsd|"cost"/i);
  });

  it('keeps each request far below the configured context budget', async () => {
    await completedReview();

    const budget = 60_000;
    for (const call of context.aiProvider.assessmentCalls) {
      const characters = call.systemPrompt.length + call.userPrompt.length;
      expect(characters).toBeLessThan(budget);
      // The bundle is what minimization is measured on: the prompt wrapper is
      // PalCert's own fixed text, the bundle is the document's share of it.
      expect(JSON.stringify(call.context).length).toBeLessThan(budget);
    }
  });

  it('sends the document once per batch, not once per rule', async () => {
    // A naive implementation calls the provider per rule and pays for the same
    // evidence ten times over. Batching is the difference (§49).
    await completedReview();

    const calls = context.aiProvider.assessmentCalls;
    expect(calls.length).toBeLessThan(AI_RULE_COUNT);

    const nodeCounts = calls.map((call) => call.context.nodes.length);
    for (const count of nodeCounts) {
      expect(count).toBeLessThanOrEqual(120);
    }
  });

  it('never re-sends the document to explain the report', async () => {
    // The supplement is built from results, not from the manuscript. Sending
    // the document again to write a summary would be minimization abandoned
    // for no benefit (§40).
    await completedReview();

    expect(context.aiProvider.supplementCalls.length).toBeGreaterThan(0);
    for (const call of context.aiProvider.supplementCalls) {
      expect(call.userPrompt).not.toContain('<document_evidence>');
      expect(call.userPrompt).not.toContain('<node ');
    }
  });
});
