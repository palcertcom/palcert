import { type AuthClient } from './support/auth-client';
import { type PublishedStandard } from './support/checks-client';
import {
  createTenant,
  createUser,
  grantOrganizationRoleTo,
  type TenantFixture,
} from './support/organization-client';
import {
  completedCheck,
  decide,
  publishStandardFor,
  submitAndPrepare,
  submitCheck,
  waitForRevision,
} from './support/submissions-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Two people pressing the button at the same moment (§71, §72, §73, §128).
 *
 * The failure these guard against is not an exception: it is two reviewers
 * both being told their decision was recorded, and the author later reading a
 * history in which the university both approved and rejected the same thesis.
 * The lock is what makes one of them wait and the other lose.
 */
describe('Official submissions — concurrency (e2e)', () => {
  let context: TestContext;
  let author: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let standard: PublishedStandard;
  let secondReviewer: { email: string; userId: string; client: AuthClient };

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
    secondReviewer = await createUser(context, 'second@example.com');
    await grantOrganizationRoleTo(context, university, secondReviewer, 'ORGANIZATION_REVIEWER');
  });

  it('records one decision when two reviewers decide at once', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    const [approve, reject] = await Promise.all([
      decide(university.owner.client, university.organizationId, revisionId, {
        toStatus: 'APPROVED',
      }),
      decide(secondReviewer.client, university.organizationId, revisionId, {
        toStatus: 'REJECTED',
        comment: 'The methodology chapter is missing.',
      }),
    ]);

    const statuses = [approve.status, reject.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = approve.status === 200 ? 'APPROVED' : 'REJECTED';
    const row = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    expect(row.institutionDecisionStatus).toBe(winner);

    // §42: the history says one thing, and it is the thing that happened.
    const events = await context.adminDb.submissionDecisionEvent.findMany({
      where: { submissionRevisionId: revisionId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => event.toStatus)).toEqual(['SUBMITTED', winner]);

    // §69: the losing reviewer's comment is not written either. A rejection
    // that did not happen must not leave a rejection's reasoning behind.
    const comments = await context.adminDb.submissionComment.findMany({
      where: { submissionRevisionId: revisionId },
    });
    expect(comments.length).toBe(winner === 'REJECTED' ? 1 : 0);
  });

  it('refuses a decision made against a stale view', async () => {
    // §72: If-Match, in effect. The reviewer pressed Approve on a screen that
    // said SUBMITTED; by the time it arrived somebody else had moved it.
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    const started = await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'UNDER_REVIEW',
    });
    expect(started.status).toBe(200);

    const stale = await decide(secondReviewer.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
      expectedStatus: 'SUBMITTED',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('SUBMISSION_REVISION_CONFLICT');

    const fresh = await decide(secondReviewer.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
      expectedStatus: 'UNDER_REVIEW',
    });
    expect(fresh.status).toBe(200);
  });

  it('creates one revision when the same submission is sent twice at once', async () => {
    // §96, §128: the same idempotency key arriving twice concurrently is one
    // submission, one revision and one preparation job — not two handoffs of
    // the same bytes.
    const check = await completedCheck(context, author, standard);
    const headers = { 'idempotency-key': 'pressed-twice' };

    const [first, second] = await Promise.all([
      submitCheck(author.client, check.checkId, headers),
      submitCheck(author.client, check.checkId, headers),
    ]);

    const accepted = [first, second].filter((response) => response.status === 202);
    expect(accepted.length).toBeGreaterThan(0);

    for (const response of accepted) {
      await waitForRevision(context, response.body.id as string);
    }

    expect(await context.adminDb.submissionRevision.count()).toBe(1);
    expect(await context.adminDb.officialSubmission.count()).toBe(1);
    expect(
      await context.adminDb.processingJob.count({ where: { jobType: 'SUBMISSION_PREPARE' } }),
    ).toBe(1);
  });

  it('numbers revisions monotonically when two are sent at once', async () => {
    // §126, §128: the case row is locked before the highest revision number is
    // read, so two requests cannot both see the same maximum. Whatever else
    // happens, the numbers do not collide.
    const check = await completedCheck(context, author, standard);
    const first = await submitAndPrepare(context, author.client, check.checkId);

    await decide(university.owner.client, university.organizationId, first.revisionId, {
      toStatus: 'REVISION_REQUESTED',
      comment: 'Please add the ethics declaration.',
    });

    // Sequentially: buying two checks at once is not what this test is about,
    // and doing so deadlocks against the worker on the finance tables — the
    // lock order Phase 11 documents is per-request, not per-test. The race
    // under test is the pair of submissions below.
    const a = await completedCheck(context, author, standard, { documentId: check.documentId });
    const b = await completedCheck(context, author, standard, { documentId: check.documentId });

    const responses = await Promise.all([
      submitCheck(author.client, a.checkId),
      submitCheck(author.client, b.checkId),
    ]);

    // Exactly one second revision: the other is refused, because the case is
    // no longer asking for one once the first arrives.
    const accepted = responses.filter((response) => response.status === 202);
    expect(accepted).toHaveLength(1);

    const revisions = await context.adminDb.submissionRevision.findMany({
      where: { submissionId: first.submissionId },
      orderBy: { revisionNumber: 'asc' },
    });
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([1, 2]);
  });

  it('runs the preparation once however many times the job is delivered', async () => {
    // §34, §97: an at-least-once queue means the handler must be idempotent.
    // A second delivery finds the revision already READY and changes nothing —
    // no second copy, no second SUBMITTED event.
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    const job = await context.adminDb.processingJob.findFirstOrThrow({
      where: { jobType: 'SUBMISSION_PREPARE', resourceId: revisionId },
    });
    await context.jobs.releaseToPending(job.id);
    await context.dispatcher.dispatchNow(job.id);
    await waitForRevision(context, revisionId);

    const events = await context.adminDb.submissionDecisionEvent.findMany({
      where: { submissionRevisionId: revisionId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventSource).toBe('SYSTEM');
  });
});
