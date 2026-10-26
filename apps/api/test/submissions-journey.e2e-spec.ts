import { type AuthClient } from './support/auth-client';
import { failResultFor } from './support/fake-document-engine';
import { type PublishedStandard } from './support/checks-client';
import { createTenant, createUser, type TenantFixture } from './support/organization-client';
import {
  addComment,
  completedCheck,
  decide,
  disclosureFor,
  listSubmissions,
  organizationDocument,
  organizationReport,
  publishStandardFor,
  readSubmission,
  reviewQueue,
  reviewSubmission,
  submitAndPrepare,
  submitCheck,
  submitterComments,
  submitterHistory,
  waitForRevision,
} from './support/submissions-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * A private check becoming an official submission, end to end.
 *
 * The journey the phase exists for: a person checks their own document
 * privately, reads exactly what submitting would share, decides to share it,
 * and a university reviews the copy they were handed — reaching nothing else
 * of theirs in the process.
 */
describe('Official submissions — journey (e2e)', () => {
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

  it('tells the author what would be shared, and what would not', async () => {
    const check = await completedCheck(context, author, standard);

    const response = await disclosureFor(author.client, check.checkId);
    expect(response.status).toBe(200);

    expect(response.body.organizationId).toBe(university.organizationId);
    expect(response.body.submitter.email).toBe(author.email);
    expect(response.body.standard.standardId).toBe(standard.standardId);
    expect(response.body.technical.determination).toBeDefined();

    // §21, §86: the promise is generated from the same read the submission
    // itself performs, so it cannot describe a different handoff.
    expect(response.body.shared).toContain('SUBMITTED_DOCUMENT_VERSION');
    expect(response.body.shared).toContain('TECHNICAL_REPORT');
    expect(response.body.notShared).toContain('AI_REVIEW');
    expect(response.body.notShared).toContain('SMARTFIX_PLAN_AND_MANIFEST');
    expect(response.body.notShared).toContain('BALANCE_AND_PAYMENTS');
    expect(response.body.notShared).toContain('OTHER_DOCUMENT_VERSIONS');
  });

  it('never submits anything on its own', async () => {
    // §20: a completed check, a settled payment and a finished report leave
    // the submission exactly where it was. Nothing but a person's own action
    // creates one.
    await completedCheck(context, author, standard);

    expect((await listSubmissions(author.client)).body).toEqual([]);
    expect(await context.adminDb.officialSubmission.count()).toBe(0);
    expect(await context.adminDb.submissionRevision.count()).toBe(0);
  });

  it('accepts a submission, prepares it, and only then shows the organization', async () => {
    const check = await completedCheck(context, author, standard);

    const accepted = await submitCheck(author.client, check.checkId);
    expect(accepted.status).toBe(202);
    expect(accepted.body.processingStatus).toBe('PREPARING');
    // §33: nothing has been handed over yet, so there is no institution
    // status to report.
    expect(accepted.body.institutionDecisionStatus).toBeNull();

    const revisionId = accepted.body.id as string;
    const ready = await waitForRevision(context, revisionId);
    expect(ready.processingStatus).toBe('READY');
    expect(ready.institutionDecisionStatus).toBe('SUBMITTED');

    const queue = await reviewQueue(university.owner.client, university.organizationId);
    expect(queue.status).toBe(200);
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0].revisionId).toBe(revisionId);
    expect(queue.body[0].institutionDecisionStatus).toBe('SUBMITTED');
    expect(queue.body[0].submitter.email).toBe(author.email);

    // §84: the queue row carries no route into anything private — no document
    // version, no check, no report, no analysis, no storage key.
    const entry = JSON.stringify(queue.body[0]);
    expect(entry).not.toContain(check.checkId);
    expect(entry).not.toContain(check.versionId);
    expect(entry).not.toContain(check.documentId);
  });

  it('copies the exact bytes and the exact report, and says so', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    const version = await context.adminDb.documentVersion.findUniqueOrThrow({
      where: { id: check.versionId },
    });
    const report = await context.adminDb.checkReport.findFirstOrThrow({
      where: { checkId: check.checkId },
    });

    // §29, §30: a copy, so the digest is the source's digest. Not a rebuild,
    // not a re-render, not a regeneration from current tables.
    expect(revision.documentSnapshotSha256).toBe(version.sha256);
    expect(revision.sourceDocumentSha256).toBe(version.sha256);
    expect(revision.sourceReportHash).toBe(report.reportHash);
    expect(revision.evidenceHash).not.toBeNull();
    expect(revision.documentSnapshotKey).toContain(
      `organizations/${university.organizationId}/submissions/`,
    );
    // §78: no name, no email, no title in the key an institution's storage
    // sees.
    expect(revision.documentSnapshotKey).not.toContain(author.email);
  });

  it('carries one case through review, revision and approval', async () => {
    const check = await completedCheck(context, author, standard);
    const first = await submitAndPrepare(context, author.client, check.checkId);

    const started = await decide(
      university.owner.client,
      university.organizationId,
      first.revisionId,
      { toStatus: 'UNDER_REVIEW' },
    );
    expect(started.status).toBe(200);
    expect(started.body.fromStatus).toBe('SUBMITTED');
    expect(started.body.eventSource).toBe('ORGANIZATION');
    expect(started.body.actorUserId).toBe(university.owner.userId);

    // §69: a revision request the author has to act on must say why.
    const bare = await decide(
      university.owner.client,
      university.organizationId,
      first.revisionId,
      { toStatus: 'REVISION_REQUESTED' },
    );
    expect(bare.status).toBe(422);
    expect(bare.body.error.code).toBe('SUBMISSION_COMMENT_REQUIRED');

    const requested = await decide(
      university.owner.client,
      university.organizationId,
      first.revisionId,
      {
        toStatus: 'REVISION_REQUESTED',
        reasonCode: 'TECHNICAL_CORRECTIONS_REQUIRED',
        comment: 'Please correct the margins on the front matter.',
      },
    );
    expect(requested.status).toBe(200);

    // The author reads the decision and the comment, and nothing else changed
    // hands to make that possible.
    const comments = await submitterComments(author.client, first.revisionId);
    expect(comments.status).toBe(200);
    expect(comments.body).toHaveLength(1);
    expect(comments.body[0].body).toContain('margins');
    expect(comments.body[0].authorSide).toBe('ORGANIZATION');

    // §9, §49: a revision is a new check of the same document, and it joins
    // the same case rather than starting a second one.
    const recheck = await completedCheck(context, author, standard, {
      documentId: check.documentId,
    });
    const second = await submitAndPrepare(context, author.client, recheck.checkId);
    expect(second.submissionId).toBe(first.submissionId);

    const secondRow = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: second.revisionId },
    });
    expect(secondRow.revisionNumber).toBe(2);

    const approved = await decide(
      university.owner.client,
      university.organizationId,
      second.revisionId,
      { toStatus: 'APPROVED' },
    );
    expect(approved.status).toBe(200);

    // §47: both are terminal, and the first one keeps what it was told.
    const again = await decide(
      university.owner.client,
      university.organizationId,
      second.revisionId,
      { toStatus: 'REJECTED', comment: 'Changed my mind.' },
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SUBMISSION_ALREADY_DECIDED');

    const history = await submitterHistory(author.client, second.revisionId);
    expect(history.body.map((event: { toStatus: string }) => event.toStatus)).toEqual([
      'SUBMITTED',
      'APPROVED',
    ]);
    expect(history.body[0].eventSource).toBe('SYSTEM');
    expect(history.body[0].actorUserId).toBeNull();

    const view = await readSubmission(author.client, first.submissionId);
    expect(view.body.displayStatus).toBe('APPROVED');
    expect(view.body.revisionCount).toBe(2);
  });

  it('lets an institution approve a submission PalCert found non-compliant', async () => {
    // §2, §3: technical compliance is not the institution's decision, and the
    // two disagreeing is a legitimate outcome rather than an error state.
    context.documentEngine.evaluationResults = [failResultFor('MARGIN.TOP.MIN')];
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    expect(
      (await context.adminDb.submissionRevision.findUniqueOrThrow({ where: { id: revisionId } }))
        .determination,
    ).toBe('NON_COMPLIANT');

    const approved = await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    expect(approved.status).toBe(200);

    const row = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    expect(row.determination).toBe('NON_COMPLIANT');
    expect(row.institutionDecisionStatus).toBe('APPROVED');
  });

  it('gives both parties the snapshot, and neither the original', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    const document = await organizationDocument(
      university.owner.client,
      university.organizationId,
      revisionId,
    );
    expect(document.status).toBe(200);
    expect(document.body.method).toBe('GET');
    expect(document.body.url).toContain('submissions');
    expect(new Date(document.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // §78: the filename an institution receives names the submission, not the
    // author's own file.
    expect(document.body.filename).not.toContain('thesis');

    const report = await organizationReport(
      university.owner.client,
      university.organizationId,
      revisionId,
    );
    expect(report.status).toBe(200);

    const own = await author.client.post(
      `/api/v1/submissions/revisions/${revisionId}/document`,
      {},
    );
    expect(own.status).toBe(200);
  });

  it('treats the same idempotency key as the same submission', async () => {
    const check = await completedCheck(context, author, standard);
    const headers = { 'idempotency-key': 'submit-once' };

    const first = await submitCheck(author.client, check.checkId, headers);
    expect(first.status).toBe(202);
    await waitForRevision(context, first.body.id as string);

    const second = await submitCheck(author.client, check.checkId, headers);
    expect(second.status).toBe(202);
    expect(second.body.id).toBe(first.body.id);
    expect(await context.adminDb.submissionRevision.count()).toBe(1);
  });

  it('refuses to submit the same check twice', async () => {
    // §95: one check is one revision's evidence. Submitting it again would put
    // the same bytes in the queue twice under different revision numbers.
    const check = await completedCheck(context, author, standard);
    await submitAndPrepare(context, author.client, check.checkId);

    const again = await submitCheck(author.client, check.checkId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SUBMISSION_CHECK_ALREADY_SUBMITTED');
  });

  it('refuses a second revision while the first is still with the reviewer', async () => {
    // §49: a case whose current revision is SUBMITTED or UNDER_REVIEW is being
    // read. Sending another one would make "the current official revision"
    // mean nothing.
    const check = await completedCheck(context, author, standard);
    const first = await submitAndPrepare(context, author.client, check.checkId);
    expect(first.revisionId).toBeDefined();

    const recheck = await completedCheck(context, author, standard, {
      documentId: check.documentId,
    });
    const again = await submitCheck(author.client, recheck.checkId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SUBMISSION_RESUBMISSION_NOT_ALLOWED');
  });

  it('records a comment without moving anything', async () => {
    // §65, §70: comments are communication. Writing one changes no status, and
    // the author's view of where they stand is what it was.
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    const written = await addComment(
      university.owner.client,
      university.organizationId,
      revisionId,
      'Could you confirm the submission date?',
    );
    expect(written.status).toBe(201);

    const row = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    expect(row.institutionDecisionStatus).toBe('SUBMITTED');
    expect(
      await context.adminDb.submissionDecisionEvent.count({
        where: { submissionRevisionId: revisionId },
      }),
    ).toBe(1);
  });

  it('shows the organization its case with every revision it received', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId, submissionId } = await submitAndPrepare(
      context,
      author.client,
      check.checkId,
    );

    const view = await reviewSubmission(
      university.owner.client,
      university.organizationId,
      submissionId,
    );
    expect(view.status).toBe(200);
    expect(view.body.currentRevisionId).toBe(revisionId);
    expect(view.body.revisions).toHaveLength(1);
    expect(view.body.revisions[0].isCurrent).toBe(true);
    expect(view.body.revisions[0].evidenceHash).toHaveLength(64);
    expect(view.body.submitter.email).toBe(author.email);
  });
});
