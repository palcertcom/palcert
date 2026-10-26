import {
  DOCX_ANALYZER_VERSION,
  PDF_ANALYZER_VERSION,
  DocumentAnalysisService,
} from '../src/modules/analysis/services/document-analysis.service';
import { ProcessingJobType } from '@palcert/contracts';
import type { AuthClient } from './support/auth-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx, minimalPdf } from './support/fixtures';
import { createUser } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Analysis orchestration end to end (§125).
 *
 * The analyzer itself is proved by the Python golden corpus; these suites
 * prove everything around it — that analysis reads the exact promoted object,
 * that asking twice costs once, that a duplicate delivery is a no-op, and
 * that a failure lands in the right place.
 */
describe('Document analysis - lifecycle (e2e)', () => {
  let context: TestContext;
  let user: { email: string; userId: string; client: AuthClient };

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    user = await createUser(context, 'analysis-owner@example.com');
  });

  const analyses = (): DocumentAnalysisService => context.app.get(DocumentAnalysisService);

  async function readyDocx(): Promise<{ documentId: string; versionId: string }> {
    const document = await createDocument(user.client, 'Thesis');
    const bytes = minimalDocx();
    const { versionId } = await uploadAndProcess(user.client, document.id, {
      name: 'thesis.docx',
      bytes,
    });
    return { documentId: document.id, versionId };
  }

  /**
   * Wait for the live worker to settle an analysis.
   *
   * The test context runs a real worker on the real queue, exactly as
   * deployed, so analyses are driven by the same path production uses rather
   * than by calling the handler directly.
   *
   * Thirty seconds, matching every other waiter in the e2e suite. The outage
   * test sweeps the dispatcher and then waits for a retried job to travel the
   * whole real path, and the twenty seconds this used to allow was the only
   * budget in the suite tight enough to expire on a loaded machine while the
   * job was still RUNNING. Nothing about what is asserted changes: the
   * analysis must still reach SUCCEEDED with no failure code.
   */
  async function waitForAnalysis(
    analysisId: string,
    timeoutMs = 30_000,
  ): Promise<{ status: string; failureCode: string | null }> {
    const deadline = Date.now() + timeoutMs;
    let last = 'PENDING';
    while (Date.now() < deadline) {
      const row = await context.adminDb.documentAnalysis.findUniqueOrThrow({
        where: { id: analysisId },
      });
      last = row.status;
      if (row.status === 'SUCCEEDED' || row.status === 'FAILED') {
        return { status: row.status, failureCode: row.failureCode };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`analysis ${analysisId} did not settle in ${timeoutMs} ms (last ${last})`);
  }

  /**
   * The job ledger row for a resource, once the worker has finished with it.
   *
   * The handler writes the analysis outcome and *then* the worker marks the
   * job, so an analysis that has reached FAILED or SUCCEEDED says nothing yet
   * about the ledger row — reading it straight away races the worker and sees
   * RUNNING. Converge on the ledger instead of inferring it from the analysis.
   * Still an assertion: a job that never settles fails here on the deadline.
   */
  async function settledJob(resourceId: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let job = await context.adminDb.processingJob.findFirstOrThrow({ where: { resourceId } });
    while (!['SUCCEEDED', 'DEAD'].includes(job.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = await context.adminDb.processingJob.findFirstOrThrow({ where: { resourceId } });
    }
    return job;
  }

  /** Wait until a transient attempt has been recorded against the analysis. */
  async function waitForFailureRecorded(analysisId: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await context.adminDb.documentAnalysis.findUniqueOrThrow({
        where: { id: analysisId },
      });
      if (row.failureCode !== null || row.status === 'FAILED') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`analysis ${analysisId} recorded no attempt in ${timeoutMs} ms`);
  }

  /** Deliver a job by hand, for the duplicate-delivery cases. */
  async function deliverAgain(analysisId: string): Promise<void> {
    const job = await context.jobs.findByResource(ProcessingJobType.DOCX_ANALYSIS, analysisId);
    expect(job).not.toBeNull();
    await context.worker.processJobId(job!.id);
  }

  it('analyzes a READY DOCX and stores an immutable artifact', async () => {
    const { versionId } = await readyDocx();

    const ensured = await analyses().ensureDocumentAnalysis(user.userId, versionId);
    expect(ensured.created).toBe(true);
    expect(ensured.analysis.status).toBe('PENDING');

    await waitForAnalysis(ensured.analysis.id);

    const stored = await context.adminDb.documentAnalysis.findUniqueOrThrow({
      where: { id: ensured.analysis.id },
    });
    expect(stored.status).toBe('SUCCEEDED');
    expect(stored.artifactObjectKey).not.toBeNull();
    expect(stored.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.factCount).toBeGreaterThan(0);
    expect(stored.completedAt).not.toBeNull();

    // The artifact is really there, and it really is those bytes (§87).
    const artifact = await context.storage.getObjectBytes({
      zone: 'derived',
      key: stored.artifactObjectKey!,
      versionId: stored.artifactObjectVersionId,
    });
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(artifact).digest('hex')).toBe(stored.artifactSha256);
    expect(artifact.byteLength).toBe(stored.artifactSizeBytes);
  });

  it('reads the exact clean object version the upload recorded (§4)', async () => {
    const { versionId } = await readyDocx();
    const version = await context.adminDb.documentVersion.findUniqueOrThrow({
      where: { id: versionId },
    });

    const ensured = await analyses().ensureDocumentAnalysis(user.userId, versionId);
    await waitForAnalysis(ensured.analysis.id);

    // The analyzer was handed the document digest the version recorded, not
    // whatever happens to be at the key now.
    expect(context.documentEngine.calls).toHaveLength(1);
    expect(context.documentEngine.calls[0]!.expectedSha256).toBe(version.sha256);
  });

  it('reuses a compatible analysis instead of creating a second one (§8)', async () => {
    const { versionId } = await readyDocx();

    const first = await analyses().ensureDocumentAnalysis(user.userId, versionId);
    await waitForAnalysis(first.analysis.id);

    const second = await analyses().ensureDocumentAnalysis(user.userId, versionId);
    expect(second.created).toBe(false);
    expect(second.analysis.id).toBe(first.analysis.id);

    const all = await context.adminDb.documentAnalysis.findMany({
      where: { documentVersionId: versionId },
    });
    expect(all).toHaveLength(1);
    expect(context.documentEngine.calls).toHaveLength(1);
  });

  it('creates a separate analysis for a new analyzer version (§7)', async () => {
    const { versionId } = await readyDocx();

    // An analysis produced by an earlier analyzer, exactly as it would be
    // found in a database that has been running across a release.
    const older = await context.adminDb.documentAnalysis.create({
      data: {
        documentVersionId: versionId,
        ownerUserId: user.userId,
        analyzerName: 'palcert-docx',
        analyzerVersion: '0',
        factSchemaVersion: 2,
        analysisSchemaVersion: 1,
        status: 'SUCCEEDED',
        sourceSha256: 'a'.repeat(64),
        artifactObjectKey: `users/${user.userId}/legacy/artifact.json`,
        artifactSha256: 'b'.repeat(64),
        artifactSizeBytes: 10,
        factCount: 1,
        completedAt: new Date(),
      },
    });

    // The old analysis is not compatible with this release, so a new one is
    // created rather than the old one being reused or rewritten.
    const current = await analyses().ensureDocumentAnalysis(user.userId, versionId);
    expect(current.created).toBe(true);
    expect(current.analysis.id).not.toBe(older.id);
    // The release's version, imported rather than written out: this asserts
    // that the new analysis is for the analyzer this release ships, which is
    // still true after a bump.
    expect(current.analysis.analyzerVersion).toBe(DOCX_ANALYZER_VERSION);

    await waitForAnalysis(current.analysis.id);

    const untouched = await context.adminDb.documentAnalysis.findUniqueOrThrow({
      where: { id: older.id },
    });
    expect(untouched.status).toBe('SUCCEEDED');
    expect(untouched.analyzerVersion).toBe('0');
    expect(untouched.artifactSha256).toBe('b'.repeat(64));
  });

  it.each(['2', '3'])(
    'never reuses a DOCX analysis from analyzer version %s',
    async (staleVersion) => {
      // Phase 18 moved the DOCX analyzer three times: 2 gained citation
      // evidence, 3 projected four properties of it into facts, 4 added the
      // coverage entry declaring that DOCX cannot answer
      // citationTargetResolved. The last one is the reason this matters most:
      // a version 3 analysis carries no entry for the new property, so a rule
      // about it would be read under this format's COMPLETE citation coverage
      // rather than being refused — wrong, not merely incomplete.
      const { versionId } = await readyDocx();

      const stale = await context.adminDb.documentAnalysis.create({
        data: {
          documentVersionId: versionId,
          ownerUserId: user.userId,
          analyzerName: 'palcert-docx',
          analyzerVersion: staleVersion,
          factSchemaVersion: 2,
          analysisSchemaVersion: 2,
          status: 'SUCCEEDED',
          sourceSha256: 'e'.repeat(64),
          artifactObjectKey: `users/${user.userId}/legacy/docx-artifact-${staleVersion}.json`,
          artifactSha256: 'f'.repeat(64),
          artifactSizeBytes: 10,
          factCount: 1,
          completedAt: new Date(),
        },
      });

      const current = await analyses().ensureDocumentAnalysis(user.userId, versionId);
      expect(current.created).toBe(true);
      expect(current.analysis.id).not.toBe(stale.id);
      expect(current.analysis.analyzerVersion).toBe(DOCX_ANALYZER_VERSION);
    },
  );

  it('refuses to rewrite a successful analysis (§7)', async () => {
    const { versionId } = await readyDocx();
    const ensured = await analyses().ensureDocumentAnalysis(user.userId, versionId);
    await waitForAnalysis(ensured.analysis.id);

    // The database, not the service, is what makes immutability true: even the
    // schema owner cannot rewrite an analysis's identity or its artifact.
    await expect(
      context.adminDb.$executeRawUnsafe(
        `UPDATE document_analyses SET analyzer_version = '9' WHERE id = '${ensured.analysis.id}'`,
      ),
    ).rejects.toThrow(/identity is immutable/);

    await expect(
      context.adminDb.$executeRawUnsafe(
        `UPDATE document_analyses SET artifact_sha256 = '${'c'.repeat(64)}' WHERE id = '${ensured.analysis.id}'`,
      ),
    ).rejects.toThrow(/write-once/);

    await expect(
      context.adminDb.$executeRawUnsafe(
        `UPDATE document_analyses SET status = 'FAILED', failure_code = 'ENGINE_ERROR', failed_at = now() WHERE id = '${ensured.analysis.id}'`,
      ),
    ).rejects.toThrow(/has succeeded and cannot change/);
  });

  it('is a no-op on a duplicate delivery of the same job (§90)', async () => {
    const { versionId } = await readyDocx();
    const ensured = await analyses().ensureDocumentAnalysis(user.userId, versionId);

    await waitForAnalysis(ensured.analysis.id);
    // The queue may deliver the same job again; it must change nothing.
    await deliverAgain(ensured.analysis.id);
    await deliverAgain(ensured.analysis.id);

    expect(context.documentEngine.calls).toHaveLength(1);
    const rows = await context.adminDb.documentAnalysis.findMany({
      where: { documentVersionId: versionId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('SUCCEEDED');
  });

  it('refuses a version that is not READY', async () => {
    const document = await createDocument(user.client, 'Draft');
    const created = await user.client.post(`/api/v1/documents/${document.id}/versions`, {
      originalFilename: 'thesis.docx',
      sizeBytes: minimalDocx().length,
    });
    expect(created.status).toBe(201);

    await expect(
      analyses().ensureDocumentAnalysis(user.userId, created.body.version.id),
    ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_READY' });
  });

  it.each([
    '1.0.0',
    '2.0.0',
    '3.0.0',
    '4.0.0',
    '5.0.0',
    '6.0.0',
    '7.0.0',
    '8.0.0',
    '9.0.0',
    '10.0.0',
  ])('never reuses a PDF analysis from analyzer version %s', async (staleVersion) => {
    // Phase 18 moved the PDF analyzer ten times: 2.0.0 gained citation
    // evidence, 3.0.0 internal-destination links, 4.0.0 the projected
    // reference-region fact, 5.0.0 the per-citation citationTargetResolved
    // value, 6.0.0 numeric heuristic discovery for untagged PDFs, 7.0.0 the
    // author-year heuristic family, 8.0.0 structured bibliographic parsing,
    // 9.0.0 citation-side identifiers and DOI_IDENTITY linking, 10.0.0
    // multiple reference regions plus raised and parenthesised numeric
    // citation forms, 11.0.0 advisory heuristic projection. An analysis
    // from any earlier version is a perfectly valid artifact, so nothing
    // about *reading* one says it is stale — only the analyzer version
    // does, and this enforces it.
    const document = await createDocument(user.client, 'Older paper');
    const { versionId } = await uploadAndProcess(user.client, document.id, {
      name: 'older.pdf',
      bytes: minimalPdf(),
    });

    const stale = await context.adminDb.documentAnalysis.create({
      data: {
        documentVersionId: versionId,
        ownerUserId: user.userId,
        analyzerName: 'palcert-pdf',
        analyzerVersion: staleVersion,
        factSchemaVersion: 2,
        analysisSchemaVersion: staleVersion === '1.0.0' ? 1 : 2,
        status: 'SUCCEEDED',
        sourceSha256: 'c'.repeat(64),
        artifactObjectKey: `users/${user.userId}/legacy/pdf-artifact.json`,
        artifactSha256: 'd'.repeat(64),
        artifactSizeBytes: 10,
        factCount: 1,
        completedAt: new Date(),
      },
    });

    const current = await analyses().ensureDocumentAnalysis(user.userId, versionId);
    expect(current.created).toBe(true);
    expect(current.analysis.id).not.toBe(stale.id);
    expect(current.analysis.analyzerVersion).toBe(PDF_ANALYZER_VERSION);
    expect(current.analysis.analysisSchemaVersion).toBe(2);
  });

  it('routes a PDF to the PDF analyzer, not the DOCX one (Phase 13 §10)', async () => {
    // Phase 6 refused a PDF here. Phase 13 analyzes it — with its own
    // analyzer, its own job type and its own analysis row, so a DOCX analysis
    // can never stand in for a PDF one or vice versa.
    const document = await createDocument(user.client, 'Paper');
    const { versionId } = await uploadAndProcess(user.client, document.id, {
      name: 'paper.pdf',
      bytes: minimalPdf(),
    });

    const ensured = await analyses().ensureDocumentAnalysis(user.userId, versionId);
    expect(ensured.analysis.analyzerName).toBe('palcert-pdf');
    await waitForAnalysis(ensured.analysis.id);

    expect(context.documentEngine.calls).toHaveLength(1);
    expect(context.documentEngine.calls[0]!.format).toBe('PDF');

    const job = await context.adminDb.processingJob.findFirstOrThrow({
      where: { resourceId: ensured.analysis.id },
    });
    expect(job.jobType).toBe('PDF_ANALYSIS');
  });

  it('refuses to analyze bytes that do not match the recorded digest (§5)', async () => {
    const { versionId } = await readyDocx();

    // An analysis pinned to a digest the stored object does not have. The
    // source digest is immutable once written, so this is created that way —
    // which is exactly the state a swapped or truncated object would leave.
    const mismatched = await context.adminDb.documentAnalysis.create({
      data: {
        documentVersionId: versionId,
        ownerUserId: user.userId,
        analyzerName: 'palcert-docx',
        analyzerVersion: '1',
        factSchemaVersion: 2,
        analysisSchemaVersion: 1,
        status: 'PENDING',
        sourceSha256: 'b'.repeat(64),
      },
    });

    const job = await context.jobs.enqueueInTransaction(context.prisma, {
      type: ProcessingJobType.DOCX_ANALYSIS,
      resourceType: 'DOCUMENT_ANALYSIS',
      resourceId: mismatched.id,
      ownerUserId: user.userId,
    });
    await context.worker.processJobId(job.id);

    const stored = await context.adminDb.documentAnalysis.findUniqueOrThrow({
      where: { id: mismatched.id },
    });
    expect(stored.status).toBe('FAILED');
    expect(stored.failureCode).toBe('DOCUMENT_SOURCE_INTEGRITY_FAILED');
    expect(stored.artifactObjectKey).toBeNull();
    // Nothing was handed to the analyzer: the check happens first.
    expect(context.documentEngine.calls).toHaveLength(0);
  });

  it('records a malformed document as a permanent failure and does not retry it (§91)', async () => {
    const { versionId } = await readyDocx();
    context.documentEngine.mode = 'invalid-document';
    const ensured = await analyses().ensureDocumentAnalysis(user.userId, versionId);

    await waitForAnalysis(ensured.analysis.id);

    const stored = await context.adminDb.documentAnalysis.findUniqueOrThrow({
      where: { id: ensured.analysis.id },
    });
    expect(stored.status).toBe('FAILED');
    expect(stored.failureCode).toBe('DOCUMENT_INVALID');

    const job = await settledJob(ensured.analysis.id);
    // The job succeeded: deciding "this cannot be analyzed" *is* its work.
    expect(job.status).toBe('SUCCEEDED');
    expect(job.attemptCount).toBeLessThanOrEqual(1);
  });

  it('retries an engine outage and recovers (§91)', async () => {
    const { versionId } = await readyDocx();
    context.documentEngine.mode = 'unavailable';
    const ensured = await analyses().ensureDocumentAnalysis(user.userId, versionId);

    // The attempt fails, the analysis stays RUNNING and remembers why.
    await waitForFailureRecorded(ensured.analysis.id);
    let stored = await context.adminDb.documentAnalysis.findUniqueOrThrow({
      where: { id: ensured.analysis.id },
    });
    expect(stored.status).toBe('RUNNING');
    expect(stored.failureCode).toBe('ENGINE_UNAVAILABLE');

    // The engine comes back; the ledger's own retry runs the same job again.
    context.documentEngine.mode = 'normal';
    context.clock.advanceMinutes(2);
    await context.dispatcher.sweep();

    await waitForAnalysis(ensured.analysis.id);
    stored = await context.adminDb.documentAnalysis.findUniqueOrThrow({
      where: { id: ensured.analysis.id },
    });
    expect(stored.status).toBe('SUCCEEDED');
    expect(stored.failureCode).toBeNull();
  });

  it('never marks an analysis succeeded when storage refuses the artifact', async () => {
    const { versionId } = await readyDocx();
    context.storage.failing.add('put');
    const ensured = await analyses().ensureDocumentAnalysis(user.userId, versionId);

    await waitForFailureRecorded(ensured.analysis.id);

    const stored = await context.adminDb.documentAnalysis.findUniqueOrThrow({
      where: { id: ensured.analysis.id },
    });
    expect(stored.status).not.toBe('SUCCEEDED');
    expect(stored.artifactObjectKey).toBeNull();
  });

  it('rejects an analyzer whose identity does not match the record', async () => {
    const { versionId } = await readyDocx();
    // The deployed analyzer is a different version from the one recorded.
    context.documentEngine.analyzerVersion = '99';
    const ensured = await analyses().ensureDocumentAnalysis(user.userId, versionId);

    await waitForFailureRecorded(ensured.analysis.id);

    const stored = await context.adminDb.documentAnalysis.findUniqueOrThrow({
      where: { id: ensured.analysis.id },
    });
    expect(stored.status).not.toBe('SUCCEEDED');
    expect(stored.artifactObjectKey).toBeNull();
  });
});
