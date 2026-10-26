import { ruleStructuringBatchCount } from '@palcert/contracts';
import { API, type AuthClient } from './support/auth-client';
import {
  draftRevision,
  extractionPath,
  grantOrganizationAIConsent,
  guidelineText,
  runExtraction,
  uploadSource,
  waitForExtraction,
  extractionBody,
} from './support/extraction-client';
import { minimalDocx, minimalPdf } from './support/fixtures';
import { createTenant, createUser, grantOrganizationRoleTo } from './support/organization-client';
import { createStandard, createVersion, createDocumentType } from './support/standards-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * The review console's server side: a progress read cheap enough to poll, and
 * bulk decisions that behave exactly like the individual ones they replace.
 *
 * Nothing here changes how an extraction runs or what a proposal is. What is
 * pinned is that the progress a reviewer sees is read back from what the
 * worker stored (so a reload shows the same thing), and that "reject 111" or
 * "accept all valid" is one request that decides nothing twice, accepts
 * nothing that lacks a valid rule, and leaves the same audit trail as 111
 * clicks would.
 */
describe('Extraction review console (e2e)', () => {
  let context: TestContext;
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let owner: AuthClient;
  let organizationId: string;
  let versionId: string;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    tenant = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
    owner = tenant.owner.client;
    organizationId = tenant.organizationId;
    const documentType = await createDocumentType(owner, organizationId);
    const standard = await createStandard(owner, organizationId, documentType.id);
    versionId = (await createVersion(owner, organizationId, standard.id)).id;
    await grantOrganizationAIConsent(owner, organizationId);
  });

  const base = (runId: string) => extractionPath(organizationId, versionId, runId);

  /** A run whose proposals include rules and findings that carry no rule. */
  async function mixedRun() {
    context.aiProvider.proposalKinds = [
      'EXPLICIT_REQUIREMENT',
      'AMBIGUOUS_REQUIREMENT',
      'UNREPRESENTABLE_REQUIREMENT',
      'EXPLICIT_REQUIREMENT',
    ];
    await uploadSource(context, owner, organizationId, versionId, {
      sourceKind: 'GUIDELINE_PDF',
      filename: 'thesis-guidelines-2026.pdf',
      bytes: minimalPdf(guidelineText('The left margin must be 30 mm.')),
    });
    const { runId, status } = await runExtraction(context, owner, organizationId, versionId);
    expect(status).toBe('COMPLETED');
    const proposals = await context.adminDb.ruleProposal.findMany({
      where: { extractionRunId: runId },
      orderBy: { displayOrder: 'asc' },
    });
    expect(proposals).toHaveLength(4);
    return { runId, proposals };
  }

  // -------------------------------------------------------------------------
  // Progress
  // -------------------------------------------------------------------------

  describe('progress', () => {
    it('advances with the stored invocations, and reads the same after a reload', async () => {
      // Several guidelines and a template: enough items for more than one
      // proposal-generation call at the test batch size.
      context.documentEngine.extraFacts = Array.from({ length: 7 }, (_, i) => ({
        provenance: { sourceKind: 'OOXML' },
        scope: { kind: 'DOCUMENT', property: `templateMetric${i}` },
        unit: 'COUNT',
        value: { number: String(i + 1), type: 'NUMBER' },
      }));
      await uploadSource(context, owner, organizationId, versionId, {
        sourceKind: 'TEMPLATE_DOCX',
        filename: 'PhD_Template_00.docx',
        bytes: minimalDocx(),
      });
      const requirements = ['The left margin must be 30 mm.', 'Body text must be 12 pt.'];
      for (const [index, requirement] of requirements.entries()) {
        await uploadSource(context, owner, organizationId, versionId, {
          sourceKind: 'GUIDELINE_PDF',
          filename: `guidelines-${index + 1}.pdf`,
          bytes: minimalPdf(guidelineText(requirement)),
        });
      }
      context.aiProvider.citedTextsByDocument = requirements;

      // Hold the second proposal-generation call until the test has looked.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const real = context.aiProvider.extractRuleProposals.bind(context.aiProvider);
      let calls = 0;
      context.aiProvider.extractRuleProposals = async (request) => {
        calls += 1;
        if (calls === 2) await held;
        return real(request);
      };

      try {
        const started = await owner.post(
          `${API}/organizations/${organizationId}/standard-versions/${versionId}/extractions`,
          await extractionBody(context, owner),
        );
        expect(started.status).toBe(202);
        const runId = started.body.id as string;

        // Wait until the first call has settled and the second is in flight.
        const deadline = Date.now() + 30_000;
        let progress = (await owner.get(`${base(runId)}/progress`)).body;
        while (progress.completedBatches < 1 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          progress = (await owner.get(`${base(runId)}/progress`)).body;
        }
        context.clock.advanceMinutes(1.5);
        const mid = await owner.get(`${base(runId)}/progress`);
        expect(mid.status).toBe(200);

        const evidence = await context.adminDb.sourceEvidence.count({
          where: { extractionRunId: runId },
        });
        const observations = await context.adminDb.templateObservation.count({
          where: { extractionRunId: runId },
        });
        const planned = ruleStructuringBatchCount({
          items: evidence + observations,
          maxRulesPerRequest: 5,
        });
        expect(planned).toBeGreaterThan(1);
        expect(mid.body).toMatchObject({
          runId,
          status: 'GENERATING_PROPOSALS',
          stage: 'GENERATING_PROPOSALS',
          completedBatches: 1,
          successfulBatches: 1,
          failedBatches: 0,
          totalBatches: planned,
          evidenceCount: evidence,
          observationCount: observations,
          // Not saved yet, so not known: never a guess.
          proposalCount: null,
          cancellable: false,
          finishedAt: null,
        });
        expect(mid.body.elapsedSeconds).toBeGreaterThanOrEqual(90);

        // A reload asks again and gets the same answer: nothing is held in
        // the page or estimated from time.
        const reloaded = await owner.get(`${base(runId)}/progress`);
        expect(reloaded.body).toEqual(mid.body);

        release();
        const settled = await waitForExtraction(context, runId);
        expect(settled.status).toBe('COMPLETED');

        const done = await owner.get(`${base(runId)}/progress`);
        const invocations = await context.adminDb.extractionInvocation.count({
          where: { extractionRunId: runId, purpose: 'GUIDELINE_RULE_STRUCTURING' },
        });
        const proposals = await context.adminDb.ruleProposal.count({
          where: { extractionRunId: runId },
        });
        expect(done.body).toMatchObject({
          status: 'COMPLETED',
          stage: 'COMPLETED',
          completedBatches: invocations,
          totalBatches: invocations,
          proposalCount: proposals,
          cancellable: false,
        });
        expect(done.body.finishedAt).not.toBeNull();
        // Finished: the clock moving on does not move the elapsed time.
        context.clock.advanceMinutes(10);
        expect((await owner.get(`${base(runId)}/progress`)).body.elapsedSeconds).toBe(
          done.body.elapsedSeconds,
        );
      } finally {
        release();
        context.aiProvider.extractRuleProposals = real;
      }
    });

    it('reports a failed run as failed, with its kind', async () => {
      context.aiProvider.mode = 'refusal';
      await uploadSource(context, owner, organizationId, versionId, {
        sourceKind: 'GUIDELINE_PDF',
        filename: 'guidelines.pdf',
        bytes: minimalPdf(guidelineText('The left margin must be 30 mm.')),
      });
      const { runId, status } = await runExtraction(context, owner, organizationId, versionId);
      expect(status).toBe('FAILED');

      const progress = await owner.get(`${base(runId)}/progress`);
      expect(progress.body).toMatchObject({
        status: 'FAILED',
        stage: 'FAILED',
        failureKind: 'PROVIDER_REFUSAL',
        proposalCount: null,
        cancellable: false,
      });
    });

    it('is not readable from another organization', async () => {
      const { runId } = await mixedRun();
      const other = await createTenant(context, 'Another University', 'other@example.com');
      const refused = await other.owner.client.get(`${base(runId)}/progress`);
      expect([403, 404]).toContain(refused.status);
    });
  });

  // -------------------------------------------------------------------------
  // The list, as the table reads it
  // -------------------------------------------------------------------------

  it('lists each proposal with its sources, without a request per row', async () => {
    const { runId } = await mixedRun();
    const listed = await owner.get(`${base(runId)}/proposals`);
    expect(listed.status).toBe(200);
    for (const proposal of listed.body) {
      expect(proposal.summary.sources).toEqual([
        expect.objectContaining({
          sourceFilename: 'thesis-guidelines-2026.pdf',
          sourceKind: 'GUIDELINE_PDF',
        }),
      ]);
      expect(proposal.summary.evidenceCount).toBe(proposal.evidenceIds.length);
      expect(proposal.summary.observation).toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // Bulk rejection
  // -------------------------------------------------------------------------

  describe('reject selected', () => {
    it('rejects every pending one in one request, audited one by one, and a retry changes nothing', async () => {
      const { runId, proposals } = await mixedRun();
      const ids = proposals.map((proposal) => proposal.id);

      const first = await owner.post(`${base(runId)}/proposals/reject-selected`, {
        proposalIds: ids,
        reason: 'NOT_A_REQUIREMENT',
      });
      expect(first.status).toBe(200);
      expect([...first.body.rejected].sort()).toEqual([...ids].sort());
      expect(first.body.skipped).toEqual([]);

      const decisions = await context.adminDb.ruleProposalDecision.findMany({
        where: { proposalId: { in: ids } },
      });
      expect(decisions).toHaveLength(ids.length);
      expect(decisions.every((row) => row.decision === 'REJECTED')).toBe(true);
      expect(decisions.every((row) => row.rejectionReason === 'NOT_A_REQUIREMENT')).toBe(true);
      expect(decisions.every((row) => row.reviewedByUserId === tenant.owner.userId)).toBe(true);

      // The same audit action an individual rejection records, per proposal.
      const audits = await context.adminDb.auditEvent.findMany({
        where: { action: 'RULE_PROPOSAL_REJECTED' },
      });
      expect(audits.map((row) => row.targetId).sort()).toEqual([...ids].sort());
      expect(audits.every((row) => row.actorUserId === tenant.owner.userId)).toBe(true);

      // A retried request: already decided, so skipped, never decided twice.
      const retried = await owner.post(`${base(runId)}/proposals/reject-selected`, {
        proposalIds: ids,
        reason: 'NOT_A_REQUIREMENT',
      });
      expect(retried.status).toBe(200);
      expect(retried.body.rejected).toEqual([]);
      expect(retried.body.skipped.map((entry: { reason: string }) => entry.reason)).toEqual(
        ids.map(() => 'RULE_PROPOSAL_ALREADY_DECIDED'),
      );
      expect(await context.adminDb.ruleProposalDecision.count()).toBe(ids.length);
      expect(
        await context.adminDb.auditEvent.count({ where: { action: 'RULE_PROPOSAL_REJECTED' } }),
      ).toBe(ids.length);
      // Rejection creates no rule.
      expect(
        await context.adminDb.standardRule.count({ where: { standardVersionId: versionId } }),
      ).toBe(0);
    });

    it('skips what someone already accepted, without touching it', async () => {
      const { runId, proposals } = await mixedRun();
      const explicit = proposals.find((proposal) => proposal.kind === 'EXPLICIT_REQUIREMENT')!;
      const accepted = await owner.post(
        `${base(runId)}/proposals/${explicit.id}/accept`,
        {},
        { headers: { 'If-Match': `"${await draftRevision(context, versionId)}"` } },
      );
      expect(accepted.status).toBe(200);

      const rejected = await owner.post(`${base(runId)}/proposals/reject-selected`, {
        proposalIds: proposals.map((proposal) => proposal.id),
      });
      expect(rejected.status).toBe(200);
      expect(rejected.body.rejected).toHaveLength(3);
      expect(rejected.body.skipped).toEqual([
        { id: explicit.id, reason: 'RULE_PROPOSAL_ALREADY_DECIDED' },
      ]);
      const stored = await context.adminDb.ruleProposal.findUniqueOrThrow({
        where: { id: explicit.id },
      });
      expect(stored.status).toBe('ACCEPTED');
    });

    it('refuses a reviewer who may read proposals but not decide', async () => {
      const { runId, proposals } = await mixedRun();
      const reviewer = await createUser(context, 'reviewer@example.com');
      await grantOrganizationRoleTo(context, tenant, reviewer, 'ORGANIZATION_REVIEWER');

      const read = await reviewer.client.get(`${base(runId)}/progress`);
      expect(read.status).toBe(200);

      const ids = proposals.map((proposal) => proposal.id);
      const rejected = await reviewer.client.post(`${base(runId)}/proposals/reject-selected`, {
        proposalIds: ids,
      });
      expect(rejected.status).toBe(403);
      const accepted = await reviewer.client.post(
        `${base(runId)}/proposals/accept-selected`,
        { proposalIds: ids },
        { headers: { 'If-Match': `"${await draftRevision(context, versionId)}"` } },
      );
      expect(accepted.status).toBe(403);
      expect(await context.adminDb.ruleProposalDecision.count()).toBe(0);
    });

    it('cannot reach another organization’s proposals by any path', async () => {
      const { runId, proposals } = await mixedRun();
      const ids = proposals.map((proposal) => proposal.id);

      const other = await createTenant(context, 'Another University', 'other@example.com');
      // Straight at the victim's path: not a member.
      const direct = await other.owner.client.post(`${base(runId)}/proposals/reject-selected`, {
        proposalIds: ids,
      });
      expect([403, 404]).toContain(direct.status);

      // Through the attacker's own organization, naming the victim's ids.
      await grantOrganizationAIConsent(other.owner.client, other.organizationId);
      const documentType = await createDocumentType(other.owner.client, other.organizationId);
      const standard = await createStandard(
        other.owner.client,
        other.organizationId,
        documentType.id,
      );
      const otherVersion = (
        await createVersion(other.owner.client, other.organizationId, standard.id)
      ).id;
      await uploadSource(context, other.owner.client, other.organizationId, otherVersion, {
        sourceKind: 'GUIDELINE_PDF',
        filename: 'other.pdf',
        bytes: minimalPdf(guidelineText('The left margin must be 30 mm.')),
      });
      const otherRun = await runExtraction(
        context,
        other.owner.client,
        other.organizationId,
        otherVersion,
      );
      const smuggled = await other.owner.client.post(
        `${extractionPath(other.organizationId, otherVersion, otherRun.runId)}/proposals/reject-selected`,
        { proposalIds: ids },
      );
      expect(smuggled.status).toBe(200);
      expect(smuggled.body.rejected).toEqual([]);
      expect(smuggled.body.skipped.map((entry: { reason: string }) => entry.reason)).toEqual(
        ids.map(() => 'RULE_PROPOSAL_NOT_FOUND'),
      );

      const victim = await context.adminDb.ruleProposal.findMany({
        where: { id: { in: ids } },
      });
      expect(victim.every((proposal) => proposal.status === 'PENDING_REVIEW')).toBe(true);
      expect(
        await context.adminDb.ruleProposalDecision.count({ where: { proposalId: { in: ids } } }),
      ).toBe(0);
    });

    it('refuses more than one request may name', async () => {
      const { runId } = await mixedRun();
      const tooMany = Array.from(
        { length: 201 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
      const refused = await owner.post(`${base(runId)}/proposals/reject-selected`, {
        proposalIds: tooMany,
      });
      expect(refused.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Accept all valid
  // -------------------------------------------------------------------------

  describe('accept all valid', () => {
    it('never accepts a proposal without a valid rule, even when named', async () => {
      const { runId, proposals } = await mixedRun();
      const noRule = proposals.filter((proposal) => proposal.suggestedRule === null);
      expect(noRule.map((proposal) => proposal.kind).sort()).toEqual([
        'AMBIGUOUS_REQUIREMENT',
        'UNREPRESENTABLE_REQUIREMENT',
      ]);

      // A client that sends every id, as if it had forgotten to filter.
      const revision = await draftRevision(context, versionId);
      const result = await owner.post(
        `${base(runId)}/proposals/accept-selected`,
        { proposalIds: proposals.map((proposal) => proposal.id) },
        { headers: { 'If-Match': `"${revision}"` } },
      );
      expect(result.status).toBe(200);
      for (const proposal of noRule) {
        expect(result.body.accepted).not.toContain(proposal.id);
        expect(result.body.skipped).toContainEqual({
          id: proposal.id,
          reason: 'RULE_PROPOSAL_NOT_ACCEPTABLE',
        });
      }
      expect(result.body.accepted.length).toBeGreaterThan(0);

      const rules = await context.adminDb.standardRule.count({
        where: { standardVersionId: versionId },
      });
      expect(rules).toBe(result.body.accepted.length);
      const audits = await context.adminDb.auditEvent.findMany({
        where: { action: 'RULE_PROPOSAL_ACCEPTED' },
      });
      expect(audits.map((row) => row.targetId).sort()).toEqual([...result.body.accepted].sort());

      // A retry against the current revision decides nothing twice and adds
      // no rule.
      const retried = await owner.post(
        `${base(runId)}/proposals/accept-selected`,
        { proposalIds: result.body.accepted },
        { headers: { 'If-Match': `"${await draftRevision(context, versionId)}"` } },
      );
      expect(retried.status).toBe(200);
      expect(retried.body.accepted).toEqual([]);
      expect(
        await context.adminDb.standardRule.count({ where: { standardVersionId: versionId } }),
      ).toBe(rules);
      expect(
        await context.adminDb.ruleProposalDecision.count({
          where: { decision: { in: ['ACCEPTED', 'MODIFIED_AND_ACCEPTED'] } },
        }),
      ).toBe(rules);
    });
  });
});
