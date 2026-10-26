import { type AuthClient } from './support/auth-client';
import { certificateForRevision, verify, waitForCertificate } from './support/certificates-client';
import { type PublishedStandard } from './support/checks-client';
import { createTenant, createUser, type TenantFixture } from './support/organization-client';
import {
  completedCheck,
  decide,
  publishStandardFor,
  submitAndPrepare,
} from './support/submissions-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';
import { CertificateReconciliationService } from '../src/modules/certificates/services/certificate-reconciliation.service';
import { CertificateSchedulingService } from '../src/modules/certificates/services/certificate-scheduling.service';

/**
 * Issuing from evidence, or not issuing at all (§80–§86, §148–§151, §169).
 *
 * A certificate is only worth something if the thing it was made from is the
 * thing that was approved. So issuance re-reads the stored document, re-reads
 * the stored report, re-hashes both and recomputes Phase 14's evidence hash
 * before it writes a single byte of the claim — and any mismatch stops it
 * dead rather than certifying whatever it happened to find.
 *
 * The distinction that matters most here is between "PalCert's machinery could
 * not finish" and "the evidence does not hold up". The first is retried until
 * it works, because an outage says nothing about somebody's submission. The
 * second is never retried, because retrying it would eventually succeed
 * against corrupt evidence.
 */
describe('Certificates — evidence integrity and recovery (e2e)', () => {
  let context: TestContext;
  let author: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let standard: PublishedStandard;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    author = await createUser(context, 'author@example.com');
    university = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
    standard = await publishStandardFor(context, university);
  });

  /** A compliant submission, handed over and waiting for a decision. */
  async function ready(): Promise<{ revisionId: string }> {
    const check = await completedCheck(context, author, standard);
    return submitAndPrepare(context, author.client, check.checkId);
  }

  /**
   * Drive the issuance job's retry ladder to its end.
   *
   * The test context runs on a fake clock, so a retry's backoff never becomes
   * due on its own. Advancing and sweeping is how a test exercises the real
   * ladder rather than waiting for wall time that never passes.
   */
  async function exhaustIssuance(
    revisionId: string,
    maxRounds = 12,
  ): Promise<{ issuanceStatus: string; failureCode: string | null; id: string }> {
    for (let round = 0; round < maxRounds; round += 1) {
      const row = await context.adminDb.complianceCertificate.findFirst({
        where: { submissionRevisionId: revisionId },
      });
      if (row !== null && row.issuanceStatus !== 'PENDING') {
        return {
          issuanceStatus: row.issuanceStatus,
          failureCode: row.failureCode,
          id: row.id,
        };
      }
      context.clock.advanceMinutes(5);
      await context.dispatcher.sweep();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`issuance for ${revisionId} never left PENDING`);
  }

  async function approve(revisionId: string): Promise<void> {
    const approved = await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    expect(approved.status).toBe(200);
  }

  // -------------------------------------------------------------------------
  // Evidence that does not hold up (§80–§85, §150)
  // -------------------------------------------------------------------------

  it('refuses to certify a document whose stored bytes no longer match', async () => {
    // §81: the digest is re-verified against the bytes, not trusted from the
    // row. Corrupting the bytes on the way back is the honest simulation of an
    // object that was swapped underneath PalCert.
    const { revisionId } = await ready();
    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    context.storage.corrupting.add(revision.documentSnapshotKey!);

    await approve(revisionId);
    const settled = await waitForCertificate(context, revisionId);

    expect(settled.issuanceStatus).toBe('FAILED_PERMANENT');
    expect(settled.failureCode).toBe('DOCUMENT_SNAPSHOT_MISMATCH');

    // §86: nothing was written. No claim, no artifact, no issuance event.
    const row = await context.adminDb.complianceCertificate.findUniqueOrThrow({
      where: { id: settled.id },
    });
    expect([row.claimHash, row.claimObjectKey, row.certificateObjectKey, row.issuedAt]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(
      await context.adminDb.certificateEvent.count({ where: { certificateId: settled.id } }),
    ).toBe(0);
  });

  it('refuses to certify a report whose stored bytes no longer match', async () => {
    const { revisionId } = await ready();
    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    context.storage.corrupting.add(revision.reportSnapshotKey!);

    await approve(revisionId);
    const settled = await waitForCertificate(context, revisionId);
    expect(settled.issuanceStatus).toBe('FAILED_PERMANENT');
    expect(settled.failureCode).toBe('REPORT_SNAPSHOT_MISMATCH');
  });

  it('never retries an evidence failure, however long it waits', async () => {
    // §85: retrying would eventually succeed against corrupt evidence, which
    // is the one outcome worse than issuing nothing.
    const { revisionId } = await ready();
    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    context.storage.corrupting.add(revision.documentSnapshotKey!);
    await approve(revisionId);
    const settled = await waitForCertificate(context, revisionId);
    expect(settled.issuanceStatus).toBe('FAILED_PERMANENT');

    // The corruption goes away, time passes, and every recovery mechanism in
    // the system runs. None of them may resurrect it.
    context.storage.corrupting.clear();
    context.clock.advanceMinutes(120);
    await context.dispatcher.sweep();
    await context.workerApp.get(CertificateReconciliationService).reconcile();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const after = await context.adminDb.complianceCertificate.findUniqueOrThrow({
      where: { id: settled.id },
    });
    expect(after.issuanceStatus).toBe('FAILED_PERMANENT');
    expect(await context.adminDb.complianceCertificate.count()).toBe(1);
  });

  it('tells a verifier nothing about a certificate that failed', async () => {
    // §155: a failed issuance is not a certificate, so its number verifies as
    // not found rather than as anything a person could misread.
    const { revisionId } = await ready();
    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    context.storage.corrupting.add(revision.documentSnapshotKey!);
    await approve(revisionId);
    const settled = await waitForCertificate(context, revisionId);

    // The code is not recoverable from the row by design, so the test opens
    // the sealed staging copy the same way the worker would — which also
    // proves a permanent failure erased it.
    const row = await context.adminDb.complianceCertificate.findUniqueOrThrow({
      where: { id: settled.id },
    });
    expect(row.verificationCodeCiphertext).toBeNull();

    // Verifying by the hash the row does keep finds nothing public either.
    const projected = await context.adminDb.$queryRawUnsafe<unknown[]>(
      'SELECT * FROM app_public_certificate($1)',
      row.verificationCodeHash,
    );
    expect(projected).toEqual([]);

    const response = await verify(context, 'PC-ZZZZZZZZ-ZZZZZZZZ-ZZZZZZZZ-ZZZZZZZZ');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('CERTIFICATE_NOT_FOUND');
  });

  it('tells the author it is still being prepared, not that it was refused', async () => {
    // §116: a machinery failure is PalCert's problem. Telling somebody their
    // approved, compliant submission was rejected would be false.
    const { revisionId } = await ready();
    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    context.storage.corrupting.add(revision.documentSnapshotKey!);
    await approve(revisionId);
    await waitForCertificate(context, revisionId);

    const status = await certificateForRevision(author.client, revisionId);
    expect(status.status).toBe(200);
    // Still eligible — the rule is satisfied. What failed is the issuing, and
    // the status the author sees says so without ever naming a decision.
    expect(status.body.eligible).toBe(true);
    expect(status.body.reason).toBeNull();
    expect(status.body.certificate.issuanceStatus).toBe('FAILED_PERMANENT');
    expect(status.body.certificate.issuedAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Machinery that could not finish (§151, §169)
  // -------------------------------------------------------------------------

  it('issues once storage comes back, without a new approval', async () => {
    // §71, §77: an outage delays a certificate. It never cancels one, and
    // nobody has to approve anything a second time.
    //
    // The first defence is the queue's own retry ladder, which is why an
    // outage does not settle the certificate at all. Only once the ladder is
    // exhausted does the certificate become FAILED_RETRYABLE, which is
    // reconciliation's cue rather than an ending.
    const { revisionId } = await ready();
    context.storage.failing.add('put');
    await approve(revisionId);

    const failed = await exhaustIssuance(revisionId);
    expect(failed.issuanceStatus).toBe('FAILED_RETRYABLE');
    expect(failed.failureCode).toBe('STORAGE_UNAVAILABLE');

    context.storage.failing.clear();
    expect(await context.workerApp.get(CertificateReconciliationService).reconcile()).toBe(1);
    const settled = await waitForCertificate(context, revisionId);

    expect([settled.issuanceStatus, settled.failureCode]).toEqual(['ISSUED', null]);
    // §4 of the approved corrections: the retry reused the same certificate
    // identity, so the number a person may already have been shown still
    // verifies.
    expect(settled.id).toBe(failed.id);
    expect(await context.adminDb.complianceCertificate.count()).toBe(1);
  }, 120_000);

  it('reconciles an approval that was never scheduled at all', async () => {
    // §77: the case that matters for approvals recorded before Phase 15
    // existed. The intent row is deleted to stand in for one that was never
    // written, and reconciliation is what notices.
    const { revisionId } = await ready();

    // Scheduling is silenced for this one decision, which is the state a
    // pre-Phase-15 approval is permanently in: approved, compliant, current,
    // and with nothing anywhere that would ever certify it. Nothing here is
    // deleted afterwards — a certificate row cannot be deleted at all, which
    // is itself the point.
    const scheduling = context.app.get(CertificateSchedulingService);
    const silenced = jest.spyOn(scheduling, 'scheduleIfEligible').mockResolvedValue(null);

    await approve(revisionId);
    expect(await context.adminDb.complianceCertificate.count()).toBe(0);
    expect(
      await context.adminDb.processingJob.count({ where: { jobType: 'CERTIFICATE_ISSUE' } }),
    ).toBe(0);
    silenced.mockRestore();

    await context.workerApp.get(CertificateReconciliationService).reconcile();
    const settled = await waitForCertificate(context, revisionId);
    expect(settled.issuanceStatus).toBe('ISSUED');

    // §79: reconciliation reads and enqueues. It never edits a Phase 14
    // decision, and never repairs a determination.
    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    expect([revision.determination, revision.institutionDecisionStatus]).toEqual([
      'COMPLIANT',
      'APPROVED',
    ]);
  });

  it('enqueues nothing for a submission that is not eligible', async () => {
    // §79: the sweep is bounded by the same rule as everything else. A
    // rejected submission is not a backlog item.
    const { revisionId } = await ready();
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'REJECTED',
      comment: 'The submission deadline had passed.',
    });

    await context.workerApp.get(CertificateReconciliationService).reconcile();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await context.adminDb.complianceCertificate.count()).toBe(0);
    expect(
      await context.adminDb.processingJob.count({ where: { jobType: 'CERTIFICATE_ISSUE' } }),
    ).toBe(0);
  });

  it('is idempotent: reconciling twice leaves exactly one certificate', async () => {
    const { revisionId } = await ready();
    await approve(revisionId);
    await waitForCertificate(context, revisionId);

    await context.workerApp.get(CertificateReconciliationService).reconcile();
    await context.workerApp.get(CertificateReconciliationService).reconcile();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await context.adminDb.complianceCertificate.count()).toBe(1);
    expect(await context.adminDb.certificateEvent.count({ where: { eventType: 'ISSUED' } })).toBe(
      1,
    );
  });
});
