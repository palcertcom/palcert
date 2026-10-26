import { API, type AuthClient } from './support/auth-client';
import {
  exhaustCheckAttempts,
  publishCheckableStandard,
  startCheck,
  waitForRunFailureRecorded,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx } from './support/fixtures';
import { createTenant, createUser } from './support/organization-client';
import {
  chargesForPurchase,
  purchaseOf,
  reserveForSyntheticCheck,
} from './support/paid-check-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Integrity and failure handling (§36–§40, §59–§64, §108).
 *
 * A compliance result is only worth anything if PalCert can prove what it
 * read. These suites break each promise in turn — a tampered artifact, a
 * snapshot whose hash no longer matches, an engine that will not answer — and
 * assert that the check fails closed rather than producing a confident answer
 * about evidence it never had.
 */
describe('Document checks - integrity (e2e)', () => {
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

  async function analyzedVersion(): Promise<string> {
    // Run one check to force the analysis, so the next check starts from a
    // document that already has an artifact to tamper with.
    const document = await createDocument(student.client, 'Thesis');
    const { versionId } = await uploadAndProcess(student.client, document.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
    const warmUp = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, warmUp.body.id);
    return versionId;
  }

  it('fails closed when the stored analysis artifact does not match its digest', async () => {
    const versionId = await analyzedVersion();
    const analysis = await context.adminDb.documentAnalysis.findFirstOrThrow({
      where: { documentVersionId: versionId },
    });

    // The bytes that come back are no longer the bytes that were recorded.
    // The worker must notice before it evaluates anything (§36).
    context.storage.corrupting.add(analysis.artifactObjectKey!);

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    const settled = await waitForCheck(context, created.body.id);
    expect(settled.status).toBe('FAILED');
    expect(settled.failureCode).toBe('ANALYSIS_ARTIFACT_INTEGRITY_FAILED');

    // And nothing was written that would look like a result.
    expect(await context.adminDb.checkReport.count({ where: { checkId: created.body.id } })).toBe(
      0,
    );
    expect(
      await context.adminDb.checkRuleResult.count({
        where: { run: { checkId: created.body.id } },
      }),
    ).toBe(0);
  });

  it('refuses to change the identities a check captured', async () => {
    // The other half of the snapshot guarantee: nothing can move the check
    // onto different bytes or different rules after the fact (§5, §102).
    const versionId = await analyzedVersion();
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);

    for (const data of [
      { standardContentHash: `sha256:${'0'.repeat(64)}` },
      { documentSha256: '0'.repeat(64) },
    ]) {
      await expect(
        context.adminDb.documentCheck.update({ where: { id: created.body.id }, data }),
      ).rejects.toThrow(/immutable/);
    }
  });

  it('fails closed when the published snapshot no longer matches the captured hash', async () => {
    const versionId = await analyzedVersion();

    // A check bound to a hash the published snapshot does not carry.
    // Evaluating it anyway would mean judging the document against rules it
    // was never promised (§20, §37). Built directly because the API cannot
    // produce one — capture and verification read the same snapshot.
    const genuine = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, genuine.body.id);
    const template = await context.adminDb.documentCheck.findUniqueOrThrow({
      where: { id: genuine.body.id },
    });

    const { randomUUID } = await import('node:crypto');
    const checkId = randomUUID();
    // Since Phase 11 a check cannot exist without a purchase that names it, so
    // a hand-built one needs a real reservation of its own.
    const servicePurchaseId = await reserveForSyntheticCheck(context, student.userId, checkId);
    await context.adminDb.documentCheck.create({
      data: {
        ...template,
        id: checkId,
        servicePurchaseId,
        idempotencyKey: null,
        currentRunId: null,
        status: 'EVALUATING',
        completedAt: null,
        standardContentHash: `sha256:${'0'.repeat(64)}`,
      },
    });
    const run = await context.adminDb.checkRun.create({
      data: {
        ownerUserId: student.userId,
        checkId,
        attemptNumber: 1,
        documentAnalysisId: template.documentAnalysisId,
        orchestratorVersion: '1',
      },
    });
    const job = await context.adminDb.processingJob.create({
      data: {
        jobType: 'CHECK_EVALUATION',
        resourceType: 'CHECK_RUN',
        resourceId: run.id,
        ownerUserId: student.userId,
        idempotencyKey: `CHECK_EVALUATION:${run.id}`,
        status: 'PENDING',
        maxAttempts: 3,
        availableAt: context.clock.now(),
      },
    });
    await context.worker.processJobId(job.id);

    const settled = await context.adminDb.documentCheck.findUniqueOrThrow({
      where: { id: checkId },
    });
    expect(settled.status).toBe('FAILED');
    expect(settled.failureCode).toBe('STANDARD_SNAPSHOT_INTEGRITY_FAILED');
    expect(await context.adminDb.checkReport.count({ where: { checkId } })).toBe(0);
  }, 90_000);

  it('records an engine outage as infrastructure, never as a compliance verdict', async () => {
    const versionId = await analyzedVersion();
    context.documentEngine.evaluationMode = 'unavailable';

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForRunFailureRecorded(context, created.body.id);
    const settled = await exhaustCheckAttempts(context, created.body.id);

    expect(settled.status).toBe('FAILED');
    expect(settled.failureCode).toBe('RULE_ENGINE_FAILED');

    // A failed check has no determination at all. An outage must never read
    // as "your document does not comply" (§108).
    const run = await context.adminDb.checkRun.findFirstOrThrow({
      where: { checkId: created.body.id },
      orderBy: { attemptNumber: 'desc' },
    });
    expect(run.determination).toBeNull();
    expect(run.scoreValue).toBeNull();

    const view = await student.client.get(`${API}/checks/${created.body.id}`);
    expect(view.body.determination).toBeNull();
    expect(view.body.score).toBeNull();
    expect(view.body.retryable).toBe(true);
  }, 90_000);

  it('refuses to store engine output that does not satisfy the shared contract', async () => {
    const versionId = await analyzedVersion();
    context.documentEngine.evaluationMode = 'malformed';

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForRunFailureRecorded(context, created.body.id);
    const settled = await exhaustCheckAttempts(context, created.body.id);

    // Malformed output from PalCert's own service is still malformed (§35).
    expect(settled.status).toBe('FAILED');
    expect(await context.adminDb.checkReport.count({ where: { checkId: created.body.id } })).toBe(
      0,
    );
  }, 90_000);

  it('refuses to retry a paid check, and runs a new one instead', async () => {
    // Phase 11 §47, §48. The failed check's reservation was released, so
    // restarting it would either do the work for nothing or re-take money
    // against a balance the customer may since have spent. Running it again
    // is a new purchase, which leaves the failed attempt's billing history
    // exactly as it happened.
    const versionId = await analyzedVersion();
    context.documentEngine.evaluationMode = 'unavailable';

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForRunFailureRecorded(context, created.body.id);
    await exhaustCheckAttempts(context, created.body.id);

    const failedRuns = await context.adminDb.checkRun.findMany({
      where: { checkId: created.body.id },
      orderBy: { attemptNumber: 'asc' },
    });
    // The failed run keeps its own record of what went wrong (§63).
    expect(failedRuns[0]!.status).toBe('FAILED');
    expect(failedRuns[0]!.failureCode).toBe('RULE_ENGINE_FAILED');

    const refused = await student.client.post(`${API}/checks/${created.body.id}/retry`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CHECK_RETRY_REQUIRES_NEW_PURCHASE');

    // And no charge was made for the attempt that failed.
    const released = await purchaseOf(context, created.body.id);
    expect(released!.status).toBe('RELEASED');
    expect(await chargesForPurchase(context, released!.id)).toHaveLength(0);

    context.documentEngine.evaluationMode = 'normal';
    const again = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    expect(again.status).toBe(202);
    expect(again.body.id).not.toBe(created.body.id);

    const settled = await waitForCheck(context, again.body.id, 40_000);
    expect(settled.status).toBe('COMPLETED');
    // The second check was delivered, so it — and only it — was charged.
    const delivered = await purchaseOf(context, again.body.id);
    expect(delivered!.status).toBe('DELIVERED');
    expect(await chargesForPurchase(context, delivered!.id)).toHaveLength(1);
    expect(await chargesForPurchase(context, released!.id)).toHaveLength(0);
  }, 90_000);

  it('does not rewrite results when a completed run is delivered again', async () => {
    const versionId = await analyzedVersion();
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);

    const before = await context.adminDb.checkReport.findFirstOrThrow({
      where: { checkId: created.body.id },
    });
    const run = await context.adminDb.checkRun.findFirstOrThrow({
      where: { checkId: created.body.id },
    });

    // At-least-once delivery is a fact of the queue, so the second delivery of
    // a finished run has to be a no-op rather than a second report (§59).
    const job = await context.jobs.findByResource('CHECK_EVALUATION', run.id);
    expect(job).not.toBeNull();
    await context.worker.processJobId(job!.id);

    const reports = await context.adminDb.checkReport.findMany({
      where: { checkId: created.body.id },
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.reportHash).toBe(before.reportHash);
    expect(reports[0]!.createdAt).toEqual(before.createdAt);
  });

  it('refuses to change a stored rule result after the fact', async () => {
    const versionId = await analyzedVersion();
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);

    const result = await context.adminDb.checkRuleResult.findFirstOrThrow({
      where: { run: { checkId: created.body.id } },
    });

    // Historical evidence is append-only. A rule outcome that could be edited
    // later is not evidence of anything (§40).
    await expect(
      context.adminDb.checkRuleResult.update({
        where: { id: result.id },
        data: { outcome: 'FAIL' },
      }),
    ).rejects.toThrow();
  });

  it('keeps the analysis artifact a report cites, even after the document is deleted', async () => {
    const versionId = await analyzedVersion();
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);

    const version = await context.adminDb.documentVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    await student.client.delete(`${API}/documents/${version.documentId}`);

    // The purge runs, finds the retention locks a completed check holds, and
    // leaves both the source and the derived artifact alone (§70, §71).
    await new Promise((resolve) => setTimeout(resolve, 500));
    const analysis = await context.adminDb.documentAnalysis.findFirstOrThrow({
      where: { documentVersionId: versionId },
    });
    expect(analysis.artifactPurgedAt).toBeNull();

    const artifact = await context.storage.getObjectBytes({
      zone: 'derived',
      key: analysis.artifactObjectKey!,
      versionId: analysis.artifactObjectVersionId,
    });
    expect(artifact.byteLength).toBeGreaterThan(0);

    // And the report still reads, because viewing one never re-runs anything.
    const report = await student.client.get(`${API}/checks/${created.body.id}/report/artifact`);
    expect(report.status).toBe(200);
  });

  it('does not re-run the engine when a historical report is read', async () => {
    const versionId = await analyzedVersion();
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);

    const before = context.documentEngine.evaluationCalls.length;
    await student.client.get(`${API}/checks/${created.body.id}/report`);
    await student.client.get(`${API}/checks/${created.body.id}/report/artifact`);
    await student.client.get(`${API}/checks/${created.body.id}/results`);

    // Reading a report is reading a stored artifact, not recomputing one
    // against whatever the standard says today (§74).
    expect(context.documentEngine.evaluationCalls.length).toBe(before);
  });
});
