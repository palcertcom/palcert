import {
  grantOrganizationAIConsent,
  guidelineText,
  runExtraction,
  uploadSource,
  extractionBody,
} from './support/extraction-client';
import { macroDocx, minimalPdf, zipBomb } from './support/fixtures';
import { createTenant } from './support/organization-client';
import { createDocumentType, createStandard, createVersion } from './support/standards-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * What must never escape (§144, §150).
 *
 * Guideline documents are confidential institutional material, and a provider
 * credential is a server secret. Neither may reach a log line, an audit row, a
 * queue payload or an API response — and "neither did in the case I happened to
 * test" is not the claim; these tests walk everything PalCert persisted after a
 * real extraction and assert the content is not in any of it.
 */
describe('Rule extraction security (e2e)', () => {
  let context: TestContext;
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let organizationId: string;
  let versionId: string;

  /** A distinctive phrase that could only have come from the guideline. */
  const SECRET_PHRASE = 'ZQXJ-CONFIDENTIAL-GUIDELINE-TEXT-ZQXJ';

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    tenant = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
    organizationId = tenant.organizationId;
    const documentType = await createDocumentType(tenant.owner.client, organizationId);
    const standard = await createStandard(tenant.owner.client, organizationId, documentType.id);
    const version = await createVersion(tenant.owner.client, organizationId, standard.id);
    versionId = version.id;
  });

  it('keeps guideline text out of every audit row a full extraction writes', async () => {
    await grantOrganizationAIConsent(tenant.owner.client, organizationId);
    context.aiProvider.citedText = SECRET_PHRASE;
    await uploadSource(context, tenant.owner.client, organizationId, versionId, {
      sourceKind: 'GUIDELINE_PDF',
      filename: 'confidential-guidelines.pdf',
      bytes: minimalPdf(guidelineText(SECRET_PHRASE)),
    });
    const { status } = await runExtraction(context, tenant.owner.client, organizationId, versionId);
    expect(status).toBe('COMPLETED');

    const events = await context.adminDb.auditEvent.findMany();
    expect(events.length).toBeGreaterThan(0);
    // Identifiers and counts, never content (§118).
    expect(JSON.stringify(events)).not.toContain(SECRET_PHRASE);
    expect(JSON.stringify(events)).not.toMatch(/confidential-guidelines\.pdf/);
  });

  it('keeps guideline text out of the job ledger and the invocation ledger', async () => {
    await grantOrganizationAIConsent(tenant.owner.client, organizationId);
    context.aiProvider.citedText = SECRET_PHRASE;
    await uploadSource(context, tenant.owner.client, organizationId, versionId, {
      sourceKind: 'GUIDELINE_PDF',
      filename: 'guidelines.pdf',
      bytes: minimalPdf(guidelineText(SECRET_PHRASE)),
    });
    await runExtraction(context, tenant.owner.client, organizationId, versionId);

    // The queue carries an id and nothing else (ADR-0036).
    const jobs = await context.adminDb.processingJob.findMany();
    expect(JSON.stringify(jobs)).not.toContain(SECRET_PHRASE);

    // The invocation ledger records which prompt and model ran, never what was
    // sent or what came back (§79, §150).
    const invocations = await context.adminDb.extractionInvocation.findMany();
    expect(invocations.length).toBeGreaterThan(0);
    expect(JSON.stringify(invocations)).not.toContain(SECRET_PHRASE);
    expect(JSON.stringify(invocations)).not.toMatch(/systemPrompt|userPrompt|rawResponse/i);
  });

  it('keeps the run’s own failure detail content-free', async () => {
    context.aiProvider.mode = 'refusal';
    await grantOrganizationAIConsent(tenant.owner.client, organizationId);
    await uploadSource(context, tenant.owner.client, organizationId, versionId, {
      sourceKind: 'GUIDELINE_PDF',
      filename: 'guidelines.pdf',
      bytes: minimalPdf(guidelineText(SECRET_PHRASE)),
    });
    const { status } = await runExtraction(context, tenant.owner.client, organizationId, versionId);
    expect(status).toBe('FAILED');

    const run = await context.adminDb.ruleExtractionRun.findFirstOrThrow({
      where: { standardVersionId: versionId },
    });
    // Shown to an institution, so it says what happened and nothing more.
    expect(run.failureKind).toBe('PROVIDER_REFUSAL');
    expect(run.failureDetail).not.toContain(SECRET_PHRASE);
    expect(run.failureDetail?.length ?? 0).toBeLessThan(320);
  });

  it('never puts a provider credential anywhere PalCert persists', async () => {
    await grantOrganizationAIConsent(tenant.owner.client, organizationId);
    await uploadSource(context, tenant.owner.client, organizationId, versionId, {
      sourceKind: 'GUIDELINE_PDF',
      filename: 'guidelines.pdf',
      bytes: minimalPdf(guidelineText('The left margin must be 30 mm.')),
    });
    await runExtraction(context, tenant.owner.client, organizationId, versionId);

    const everything = JSON.stringify([
      await context.adminDb.ruleExtractionRun.findMany(),
      await context.adminDb.extractionInvocation.findMany(),
      await context.adminDb.ruleProposal.findMany(),
      await context.adminDb.sourceEvidence.findMany(),
      await context.adminDb.auditEvent.findMany(),
      await context.adminDb.processingJob.findMany(),
    ]);
    expect(everything).not.toMatch(/apiKey|api_key|ANTHROPIC_API_KEY|sk-ant/i);
  });

  it('never returns a provider prompt or raw response over the API', async () => {
    await grantOrganizationAIConsent(tenant.owner.client, organizationId);
    await uploadSource(context, tenant.owner.client, organizationId, versionId, {
      sourceKind: 'GUIDELINE_PDF',
      filename: 'guidelines.pdf',
      bytes: minimalPdf(guidelineText('The left margin must be 30 mm.')),
    });
    const { runId } = await runExtraction(context, tenant.owner.client, organizationId, versionId);

    const base = `/api/v1/organizations/${organizationId}/standard-versions/${versionId}/extractions/${runId}`;
    const run = await tenant.owner.client.get(base);
    const proposals = await tenant.owner.client.get(`${base}/proposals`);
    const serialized = JSON.stringify([run.body, proposals.body]);

    // Provider and model *are* shown: an institution should know which model
    // read its guidelines. The conversation is not (§132).
    expect(run.body.provider).toBe('fake');
    expect(serialized).not.toMatch(/systemPrompt|userPrompt|rawResponse|providerRequest|file_id/i);
  });

  it('refuses a zip bomb dressed as a guideline', async () => {
    const source = await uploadSource(context, tenant.owner.client, organizationId, versionId, {
      sourceKind: 'GUIDELINE_DOCX',
      filename: 'guidelines.docx',
      bytes: zipBomb(),
    });
    const row = await context.adminDb.standardSourceAsset.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(row.status).toBe('REJECTED');
    expect(row.cleanObjectKey).toBeNull();
  });

  it('never lets a rejected source into an extraction', async () => {
    await grantOrganizationAIConsent(tenant.owner.client, organizationId);
    await uploadSource(context, tenant.owner.client, organizationId, versionId, {
      sourceKind: 'GUIDELINE_DOCX',
      filename: 'guidelines.docx',
      bytes: macroDocx(),
    });

    const started = await tenant.owner.client.post(
      `/api/v1/organizations/${organizationId}/standard-versions/${versionId}/extractions`,
      await extractionBody(context, tenant.owner.client),
    );
    // Nothing ready to read, so nothing is read — and nothing is sent.
    expect(started.status).toBe(409);
    expect(started.body.error.code).toBe('EXTRACTION_NO_USABLE_SOURCES');
    expect(context.aiProvider.discoveryCalls).toHaveLength(0);
  });
});
