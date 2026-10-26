import { API, type AuthClient } from './support/auth-client';
import {
  extractionPath,
  grantOrganizationAIConsent,
  guidelineText,
  runExtraction,
  uploadSource,
  extractionBody,
} from './support/extraction-client';
import { minimalPdf } from './support/fixtures';
import { createTenant, createUser, grantOrganizationRoleTo } from './support/organization-client';
import { createDocumentType, createStandard, createVersion } from './support/standards-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Cross-tenant isolation for Phase 9 (§11, §12, §115, §116, §144).
 *
 * An institution's unpublished guidelines are confidential. A university that
 * could read another's draft standard, its sources, or the proposals extracted
 * from them would be a critical failure, and the phase's own wording says so.
 *
 * Every identifier used below is **real**: a genuine source, run and proposal
 * belonging to Organization B, requested by Organization A. A test using a
 * random UUID would prove only that PalCert can fail to find something that
 * does not exist.
 */
describe('Rule extraction isolation (e2e)', () => {
  let context: TestContext;
  let alpha: Tenant;
  let beta: Tenant;
  let betaFixture: Awaited<ReturnType<typeof createTenant>>;

  interface Tenant {
    organizationId: string;
    owner: AuthClient;
    versionId: string;
    standardId: string;
  }

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    alpha = await tenantWithDraft('Islamic University of Gaza', 'alpha@example.com');
    beta = await tenantWithDraft('Birzeit University', 'beta@example.com');
  });

  async function tenantWithDraft(name: string, email: string): Promise<Tenant> {
    const created = await createTenant(context, name, email);
    if (email.startsWith('beta')) betaFixture = created;
    const documentType = await createDocumentType(created.owner.client, created.organizationId);
    const standard = await createStandard(
      created.owner.client,
      created.organizationId,
      documentType.id,
    );
    const version = await createVersion(created.owner.client, created.organizationId, standard.id);
    return {
      organizationId: created.organizationId,
      owner: created.owner.client,
      versionId: version.id,
      standardId: standard.id,
    };
  }

  /** A complete extraction belonging to Beta, with real ids to attack with. */
  async function betaExtraction(): Promise<{
    sourceId: string;
    runId: string;
    proposalId: string;
  }> {
    await grantOrganizationAIConsent(beta.owner, beta.organizationId);
    const source = await uploadSource(context, beta.owner, beta.organizationId, beta.versionId, {
      sourceKind: 'GUIDELINE_PDF',
      filename: 'birzeit-guidelines.pdf',
      bytes: minimalPdf(guidelineText('The left margin must be 30 mm.')),
    });
    const { runId, status } = await runExtraction(
      context,
      beta.owner,
      beta.organizationId,
      beta.versionId,
    );
    expect(status).toBe('COMPLETED');
    const proposal = await context.adminDb.ruleProposal.findFirstOrThrow({
      where: { extractionRunId: runId },
    });
    return { sourceId: source.id, runId, proposalId: proposal.id };
  }

  describe('one organization cannot reach another’s sources', () => {
    it('does not list them', async () => {
      const { sourceId } = await betaExtraction();

      // Alpha asks for Beta's version under Alpha's own organization: the
      // version is invisible, so the answer is 404, not an empty list that
      // might later become a leak.
      const listed = await alpha.owner.get(
        `${API}/organizations/${alpha.organizationId}/standard-versions/${beta.versionId}/sources`,
      );
      expect(listed.status).toBe(404);
      expect(JSON.stringify(listed.body)).not.toContain(sourceId);
    });

    it('does not read one by its real id', async () => {
      const { sourceId } = await betaExtraction();

      const read = await alpha.owner.get(
        `${API}/organizations/${alpha.organizationId}/standard-versions/${alpha.versionId}/sources/${sourceId}`,
      );
      // 404, never 403: the difference would confirm the id exists.
      expect(read.status).toBe(404);
      expect(read.body.error.code).toBe('STANDARD_SOURCE_NOT_FOUND');
    });

    it('does not download one', async () => {
      const { sourceId } = await betaExtraction();

      const authorized = await alpha.owner.post(
        `${API}/organizations/${alpha.organizationId}/standard-versions/${alpha.versionId}/sources/${sourceId}/download-authorization`,
        {},
      );
      expect(authorized.status).toBe(404);
      expect(JSON.stringify(authorized.body)).not.toMatch(/https?:\/\//);
    });

    it('does not delete one', async () => {
      const { sourceId } = await betaExtraction();

      const deleted = await alpha.owner.delete(
        `${API}/organizations/${alpha.organizationId}/standard-versions/${alpha.versionId}/sources/${sourceId}`,
      );
      expect(deleted.status).toBe(404);
      // And it is still there.
      await context.adminDb.standardSourceAsset.findUniqueOrThrow({ where: { id: sourceId } });
    });

    it('cannot smuggle another organization’s version into its own path', async () => {
      // The composite foreign keys make this impossible at the database level
      // even if every check above were wrong (§116).
      const created = await alpha.owner.post(
        `${API}/organizations/${alpha.organizationId}/standard-versions/${beta.versionId}/sources`,
        { sourceKind: 'GUIDELINE_PDF', originalFilename: 'x.pdf', sizeBytes: 100 },
      );
      expect(created.status).toBe(404);
      // Nothing was written anywhere: not against Beta's version, and not
      // against Alpha's own either.
      expect(await context.adminDb.standardSourceAsset.count()).toBe(0);
    });
  });

  describe('one organization cannot reach another’s extraction', () => {
    it('does not list or read a run', async () => {
      const { runId } = await betaExtraction();

      const listed = await alpha.owner.get(
        `${API}/organizations/${alpha.organizationId}/standard-versions/${alpha.versionId}/extractions`,
      );
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([]);

      const read = await alpha.owner.get(
        extractionPath(alpha.organizationId, alpha.versionId, runId),
      );
      expect(read.status).toBe(404);
      expect(read.body.error.code).toBe('EXTRACTION_RUN_NOT_FOUND');
    });

    it('does not read its evidence or its proposals', async () => {
      const { runId, proposalId } = await betaExtraction();

      const proposals = await alpha.owner.get(
        `${extractionPath(alpha.organizationId, alpha.versionId, runId)}/proposals`,
      );
      expect(proposals.status).toBe(404);

      const proposal = await alpha.owner.get(
        `${extractionPath(alpha.organizationId, alpha.versionId, runId)}/proposals/${proposalId}`,
      );
      expect(proposal.status).toBe(404);
      // Nothing of the guideline's text escapes in the error body either.
      expect(JSON.stringify(proposal.body)).not.toMatch(/margin|Birzeit/i);
    });

    it('cannot accept another organization’s proposal', async () => {
      // The attack §115 names, with a real proposal id.
      const { runId, proposalId } = await betaExtraction();
      const version = await context.adminDb.standardVersion.findUniqueOrThrow({
        where: { id: alpha.versionId },
      });

      const accepted = await alpha.owner.post(
        `${extractionPath(alpha.organizationId, alpha.versionId, runId)}/proposals/${proposalId}/accept`,
        {},
        { headers: { 'If-Match': `"${version.revision}"` } },
      );
      expect(accepted.status).toBe(404);

      // No rule anywhere, and Beta's proposal is still waiting for Beta.
      expect(
        await context.adminDb.standardRule.count({
          where: { organizationId: alpha.organizationId },
        }),
      ).toBe(0);
      const untouched = await context.adminDb.ruleProposal.findUniqueOrThrow({
        where: { id: proposalId },
      });
      expect(untouched.status).toBe('PENDING_REVIEW');
      expect(await context.adminDb.ruleProposalDecision.count()).toBe(0);
    });

    it('cannot reject another organization’s proposal', async () => {
      const { runId, proposalId } = await betaExtraction();

      const rejected = await alpha.owner.post(
        `${extractionPath(alpha.organizationId, alpha.versionId, runId)}/proposals/${proposalId}/reject`,
        { reason: 'NOT_A_REQUIREMENT' },
      );
      expect(rejected.status).toBe(404);
      expect(await context.adminDb.ruleProposalDecision.count()).toBe(0);
    });

    it('cannot run an extraction against another organization’s draft', async () => {
      await grantOrganizationAIConsent(alpha.owner, alpha.organizationId);

      const started = await alpha.owner.post(
        `${API}/organizations/${alpha.organizationId}/standard-versions/${beta.versionId}/extractions`,
        await extractionBody(context, alpha.owner),
      );
      expect(started.status).toBe(404);
      expect(context.aiProvider.discoveryCalls).toHaveLength(0);
    });

    it('keeps one organization’s consent out of another’s reach', async () => {
      await grantOrganizationAIConsent(beta.owner, beta.organizationId);

      const alphaView = await alpha.owner.get(
        `${API}/organizations/${alpha.organizationId}/ai-consent`,
      );
      expect(alphaView.status).toBe(200);
      // Beta agreeing says nothing about Alpha (§15).
      expect(alphaView.body.granted).toBe(false);

      const refused = await alpha.owner.get(
        `${API}/organizations/${beta.organizationId}/ai-consent`,
      );
      expect([403, 404]).toContain(refused.status);
    });
  });

  describe('permissions inside one organization', () => {
    it('lets a reviewer read proposals but never decide on one', async () => {
      const { runId, proposalId } = await betaExtraction();
      const reviewer = await createUser(context, 'reviewer@example.com');
      await grantOrganizationRoleTo(context, betaFixture, reviewer, 'ORGANIZATION_REVIEWER');

      const read = await reviewer.client.get(
        `${extractionPath(beta.organizationId, beta.versionId, runId)}/proposals`,
      );
      expect(read.status).toBe(200);
      expect(read.body).toHaveLength(1);

      const version = await context.adminDb.standardVersion.findUniqueOrThrow({
        where: { id: beta.versionId },
      });
      const refused = await reviewer.client.post(
        `${extractionPath(beta.organizationId, beta.versionId, runId)}/proposals/${proposalId}/accept`,
        {},
        { headers: { 'If-Match': `"${version.revision}"` } },
      );
      expect(refused.status).toBe(403);
      expect(await context.adminDb.ruleProposalDecision.count()).toBe(0);
    });

    it('lets a template manager run extraction but not accept AI terms for the institution', async () => {
      // §16: a template manager doing their job must not be able to commit the
      // organization to external data processing.
      const manager = await createUser(context, 'manager@example.com');
      await grantOrganizationRoleTo(context, betaFixture, manager, 'TEMPLATE_MANAGER');

      const refused = await manager.client.post(
        `${API}/organizations/${beta.organizationId}/ai-consent`,
        {},
      );
      expect(refused.status).toBe(403);
      expect(await context.adminDb.organizationAIConsent.count()).toBe(0);

      // But once the owner agrees, the manager may run the extraction.
      await grantOrganizationAIConsent(beta.owner, beta.organizationId);
      await uploadSource(context, manager.client, beta.organizationId, beta.versionId, {
        sourceKind: 'GUIDELINE_PDF',
        filename: 'guidelines.pdf',
        bytes: minimalPdf(guidelineText('The left margin must be 30 mm.')),
      });
      const started = await manager.client.post(
        `${API}/organizations/${beta.organizationId}/standard-versions/${beta.versionId}/extractions`,
        await extractionBody(context, manager.client),
      );
      expect(started.status).toBe(202);
    });
  });
});
