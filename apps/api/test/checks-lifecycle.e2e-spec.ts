import { API, type AuthClient } from './support/auth-client';
import {
  publishCheckableStandard,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx, minimalPdf } from './support/fixtures';
import { createTenant, createUser } from './support/organization-client';
import { fundForCheck } from './support/paid-check-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * The golden check journey (§125).
 *
 * One student, one thesis, one university standard, end to end through the
 * real API, the real queue, the real worker and the real rule engine double.
 * What it proves is not that a margin rule evaluates correctly — the Python
 * corpus does that — but that the orchestration around it holds: the right
 * bytes, the right rules, one immutable report, and a result a person can
 * actually read.
 */
describe('Document checks - lifecycle (e2e)', () => {
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

  async function readyDocx(
    name = 'thesis.docx',
  ): Promise<{ documentId: string; versionId: string }> {
    const document = await createDocument(student.client, 'Thesis');
    const { versionId } = await uploadAndProcess(student.client, document.id, {
      name,
      bytes: minimalDocx(),
    });
    return { documentId: document.id, versionId };
  }

  it('runs a check from a document version to an immutable report', async () => {
    const { documentId, versionId } = await readyDocx();

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    expect(created.status).toBe(202);
    // Accepted, not answered: the verdict is not ready, and the response does
    // not pretend otherwise (§29).
    expect(created.body.determination).toBeNull();
    expect(created.body.documentId).toBe(documentId);

    const checkId: string = created.body.id;
    const settled = await waitForCheck(context, checkId);
    expect(settled).toEqual({ status: 'COMPLETED', failureCode: null });

    const check = await context.adminDb.documentCheck.findUniqueOrThrow({
      where: { id: checkId },
    });
    // Every identity captured at creation, and unchanged by the run.
    expect(check.standardVersionId).toBe(standard.standardVersionId);
    expect(check.documentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(check.standardContentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const run = await context.adminDb.checkRun.findFirstOrThrow({ where: { checkId } });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.attemptNumber).toBe(1);
    expect(run.determination).toBe('COMPLIANT');
    expect(run.evaluationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.orchestratorVersion).toBe('1');

    const report = await context.adminDb.checkReport.findFirstOrThrow({ where: { checkId } });
    expect(report.reportHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.reportSchemaVersion).toBe(1);

    // The stored artifact really is the bytes that were hashed (§43).
    const artifact = await context.storage.getObjectBytes({
      zone: 'derived',
      key: report.artifactObjectKey,
      versionId: report.artifactObjectVersionId,
    });
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(artifact).digest('hex')).toBe(report.reportHash);
  });

  it('serves the report through the API, reading back the same canonical bytes', async () => {
    const { versionId } = await readyDocx();
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    const checkId: string = created.body.id;
    await waitForCheck(context, checkId);

    const metadata = await student.client.get(`${API}/checks/${checkId}/report`);
    expect(metadata.status).toBe(200);
    expect(metadata.body.reportHash).toMatch(/^[0-9a-f]{64}$/);
    // No object key and no URL ever leaves the API (§53, §94).
    expect(JSON.stringify(metadata.body)).not.toMatch(/users\/|artifact_object_key|http/);

    const artifact = await student.client.get(`${API}/checks/${checkId}/report/artifact`);
    expect(artifact.status).toBe(200);
    const { createHash } = await import('node:crypto');
    const served = createHash('sha256').update(artifact.text).digest('hex');
    expect(served).toBe(metadata.body.reportHash);
  });

  it('returns rule results worst first, with the standard’s own titles', async () => {
    const { versionId } = await readyDocx();
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);

    const results = await student.client.get(`${API}/checks/${created.body.id}/results`);
    expect(results.status).toBe(200);
    expect(results.body.items.length).toBeGreaterThan(0);
    const first = results.body.items[0];
    expect(first.ruleCode).toBe('MARGIN.TOP.MIN');
    expect(first.titleEn).toBe('Top margin at least 25 mm');
    // Both languages travel with the result, so the report renders in Arabic
    // without another round trip to the organization's tables (§76).
    expect(first.titleAr).toBe('الهامش العلوي 25 مم على الأقل');
  });

  it('reuses one analysis across two checks of the same version', async () => {
    const { versionId } = await readyDocx();
    const second = await publishCheckableStandard(
      context,
      tenant.owner.client,
      tenant.organizationId,
      { standardCode: 'IUG.THESIS.STYLE', documentTypeName: 'Doctoral Thesis' },
    );

    const first = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, first.body.id);
    const other = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: second.standardId,
    });
    await waitForCheck(context, other.body.id);

    // Analysis is expensive and the document did not change (§27).
    const analyses = await context.adminDb.documentAnalysis.findMany({
      where: { documentVersionId: versionId },
    });
    expect(analyses).toHaveLength(1);

    const checks = await context.adminDb.documentCheck.findMany({
      where: { documentVersionId: versionId },
    });
    expect(checks.map((check) => check.documentAnalysisId)).toEqual([
      analyses[0]!.id,
      analyses[0]!.id,
    ]);
  });

  it('does not deduplicate two deliberate checks of the same document and standard', async () => {
    // Re-checking after a supervisor's feedback is a legitimate thing to do,
    // and the second check must be its own record (§61).
    const { versionId } = await readyDocx();
    const body = { documentVersionId: versionId, standardId: standard.standardId };

    const first = await startCheck(context, student, body);
    await waitForCheck(context, first.body.id);
    const second = await startCheck(context, student, body);
    await waitForCheck(context, second.body.id);

    expect(second.body.id).not.toBe(first.body.id);
    const reports = await context.adminDb.checkReport.count();
    expect(reports).toBe(2);
  });

  it('deduplicates a repeated request carrying the same idempotency key', async () => {
    const { versionId } = await readyDocx();
    // A real browser retry resends the same request, quote included: the whole
    // commercial request is what the key covers (Phase 11 §18).
    const { quoteId } = await fundForCheck(context, student.userId);
    const body = {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quoteId,
    };
    const headers = { 'Idempotency-Key': 'browser-retry-1' };

    const first = await startCheck(context, student, body, headers);
    const second = await startCheck(context, student, body, headers);
    expect(second.body.id).toBe(first.body.id);
    await waitForCheck(context, first.body.id);
    expect(await context.adminDb.documentCheck.count()).toBe(1);
  });

  it('refuses the same idempotency key for a different request', async () => {
    const { versionId } = await readyDocx();
    const other = await readyDocx('second.docx');
    const headers = { 'Idempotency-Key': 'browser-retry-2' };

    await startCheck(
      context,
      student,
      { documentVersionId: versionId, standardId: standard.standardId },
      headers,
    );
    const conflicting = await startCheck(
      context,
      student,
      { documentVersionId: other.versionId, standardId: standard.standardId },
      headers,
    );
    expect(conflicting.status).toBe(422);
    expect(conflicting.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses a margin standard against a PDF, on coverage rather than on format', async () => {
    // Phase 7 refused every PDF here. Phase 13 reads PDFs — and still refuses
    // this check, for the more precise reason: the standard's only rule is
    // about the authoring margin, which a PDF does not store. Answering it
    // from where ink happens to start would be a confident answer about
    // evidence PalCert never read (§25, Phase 13 §66).
    const document = await createDocument(student.client, 'Scanned thesis');
    const { versionId } = await uploadAndProcess(student.client, document.id, {
      name: 'thesis.pdf',
      bytes: minimalPdf(),
    });

    const response = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('CHECK_STANDARD_NOT_SUPPORTED_FOR_FORMAT');
  });

  it('keeps the captured standard version even after the standard is withdrawn', async () => {
    const { versionId } = await readyDocx();
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);

    await context.adminDb.standard.update({
      where: { id: standard.standardId },
      data: { checkAvailability: 'PRIVATE' },
    });

    // The report was written against a version; making the standard private
    // stops new checks, it does not erase existing ones (§24, §102).
    const report = await student.client.get(`${API}/checks/${created.body.id}/report`);
    expect(report.status).toBe(200);

    const blocked = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    expect(blocked.status).toBe(404);
    expect(blocked.body.error.code).toBe('CHECK_STANDARD_NOT_AVAILABLE');
  });

  it('refuses to retry a completed check', async () => {
    const { versionId } = await readyDocx();
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);

    const retried = await student.client.post(`${API}/checks/${created.body.id}/retry`);
    expect(retried.status).toBe(409);
    expect(retried.body.error.code).toBe('CHECK_ALREADY_COMPLETED');
  });

  it('separates processing status from compliance determination', async () => {
    const { versionId } = await readyDocx();
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    // Before the worker gets there the check has a status and no verdict —
    // never a FAIL standing in for "not finished" (§10).
    expect(created.body.status).toMatch(/CREATED|WAITING_ANALYSIS|EVALUATING/);
    expect(created.body.determination).toBeNull();
    expect(created.body.score).toBeNull();

    await waitForCheck(context, created.body.id);
    const done = await student.client.get(`${API}/checks/${created.body.id}`);
    expect(done.body.status).toBe('COMPLETED');
    expect(done.body.determination).toBe('COMPLIANT');
  });

  it('never claims a university approved anything', async () => {
    const { versionId } = await readyDocx();
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);

    const artifact = await student.client.get(`${API}/checks/${created.body.id}/report/artifact`);
    // PalCert checks formatting against a published standard. It does not
    // approve theses, accept papers, or certify anything (§56, §75).
    expect(artifact.text).not.toMatch(/approved|accepted|certified/i);
  });
});
