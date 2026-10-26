import { API, type AuthClient } from './support/auth-client';
import { type PublishedStandard } from './support/checks-client';
import {
  createTenant,
  createUser,
  grantOrganizationRoleTo,
  type TenantFixture,
} from './support/organization-client';
import {
  addComment,
  completedCheck,
  decide,
  disclosureFor,
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
} from './support/submissions-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Two isolations at once, which is what makes this phase different (§74).
 *
 * The ordinary one: one author's submission is invisible to another author,
 * and one organization's queue is invisible to another organization.
 *
 * The one this phase adds: the organization that received a submission gains
 * *nothing else*. Not the document, not the version, not the check, not the
 * report row, not the analysis, not the AI review, not the SmartFix plan, not
 * a balance. Owning the standard a document was measured against is not a
 * relationship with the person who was measured (§25, §77).
 */
describe('Official submissions — isolation (e2e)', () => {
  let context: TestContext;
  let author: { email: string; userId: string; client: AuthClient };
  let stranger: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let otherUniversity: TenantFixture;
  let standard: PublishedStandard;

  let submissionId: string;
  let revisionId: string;
  let checkId: string;
  let documentId: string;
  let versionId: string;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    author = await createUser(context, 'author@example.com');
    stranger = await createUser(context, 'stranger@example.com');
    university = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
    otherUniversity = await createTenant(context, 'Birzeit University', 'other@example.com');
    standard = await publishStandardFor(context, university);

    const check = await completedCheck(context, author, standard);
    checkId = check.checkId;
    documentId = check.documentId;
    versionId = check.versionId;

    const submitted = await submitAndPrepare(context, author.client, checkId);
    submissionId = submitted.submissionId;
    revisionId = submitted.revisionId;
  });

  describe('another person is not a party', () => {
    it('answers not found rather than forbidden, everywhere', async () => {
      // §90: forbidden would confirm the id exists, which is itself a
      // disclosure about somebody else's submission.
      expect((await readSubmission(stranger.client, submissionId)).status).toBe(404);
      expect((await submitterHistory(stranger.client, revisionId)).status).toBe(404);
      expect((await submitterComments(stranger.client, revisionId)).status).toBe(404);
      expect(
        (await stranger.client.post(`${API}/submissions/revisions/${revisionId}/document`, {}))
          .status,
      ).toBe(404);
      expect(
        (await stranger.client.post(`${API}/submissions/revisions/${revisionId}/report`, {}))
          .status,
      ).toBe(404);
    });

    it('cannot submit somebody else’s check', async () => {
      // §143: the binding is checked, not assumed. A check id is not a
      // capability.
      const attempt = await submitCheck(stranger.client, checkId);
      expect(attempt.status).toBe(404);
      expect((await disclosureFor(stranger.client, checkId)).status).toBe(404);
    });
  });

  describe('another organization is not a party', () => {
    it('shows an empty queue and refuses every submission route', async () => {
      const queue = await reviewQueue(otherUniversity.owner.client, otherUniversity.organizationId);
      expect(queue.status).toBe(200);
      expect(queue.body).toEqual([]);

      // Its own organization id with somebody else's submission id: the row is
      // simply not theirs.
      expect(
        (
          await reviewSubmission(
            otherUniversity.owner.client,
            otherUniversity.organizationId,
            submissionId,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await decide(otherUniversity.owner.client, otherUniversity.organizationId, revisionId, {
            toStatus: 'APPROVED',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await organizationDocument(
            otherUniversity.owner.client,
            otherUniversity.organizationId,
            revisionId,
          )
        ).status,
      ).toBe(404);
    });

    it('cannot borrow the receiving organization’s id', async () => {
      // §143: the organization id in the path is a selector, and becomes a
      // context only by passing the membership guard.
      const forged = await reviewQueue(otherUniversity.owner.client, university.organizationId);
      expect([403, 404]).toContain(forged.status);

      const decided = await decide(
        otherUniversity.owner.client,
        university.organizationId,
        revisionId,
        { toStatus: 'APPROVED' },
      );
      expect([403, 404]).toContain(decided.status);

      expect(
        (await context.adminDb.submissionRevision.findUniqueOrThrow({ where: { id: revisionId } }))
          .institutionDecisionStatus,
      ).toBe('SUBMITTED');
    });
  });

  describe('the receiving organization gains nothing else', () => {
    it('cannot reach the document, the version, the check or the report', async () => {
      // The ids are supplied here on purpose: this is the test for what
      // happens when an organization somehow learns one. §26 — the snapshot
      // architecture means knowing an id buys nothing.
      const reviewer = university.owner.client;

      expect((await reviewer.get(`${API}/documents/${documentId}`)).status).toBe(404);
      expect(
        (await reviewer.get(`${API}/documents/${documentId}/versions/${versionId}`)).status,
      ).toBe(404);
      expect((await reviewer.get(`${API}/checks/${checkId}`)).status).toBe(404);
      expect((await reviewer.get(`${API}/checks/${checkId}/report`)).status).toBe(404);
      expect(
        (await reviewer.post(`${API}/documents/${documentId}/versions/${versionId}/download`, {}))
          .status,
      ).toBe(404);
    });

    it('cannot reach AI review, SmartFix or anything financial', async () => {
      // §22, §23, §24. None of these is mentioned by any submission route, and
      // asking directly does not work either.
      const reviewer = university.owner.client;

      expect((await reviewer.get(`${API}/checks/${checkId}/ai-review`)).status).toBe(404);
      expect((await reviewer.post(`${API}/smartfix/checks/${checkId}/plan`, {})).status).toBe(404);

      const balance = await reviewer.get(`${API}/billing/balance`);
      // Their own balance, never the author's — the route is self-scoped and
      // has no parameter that could name somebody else.
      if (balance.status === 200) {
        expect(JSON.stringify(balance.body)).not.toContain(author.userId);
      }
    });

    it('never sees the author’s private identity beyond a name and an email', async () => {
      // §85, §87: an official submission shares a document, not an account.
      const view = await reviewSubmission(
        university.owner.client,
        university.organizationId,
        submissionId,
      );
      expect(view.status).toBe(200);
      expect(Object.keys(view.body.submitter).sort()).toEqual(['displayName', 'email', 'userId']);

      const serialized = JSON.stringify(view.body);
      expect(serialized).not.toContain(checkId);
      expect(serialized).not.toContain(versionId);
      expect(serialized).not.toContain(documentId);
      for (const forbidden of ['mfa', 'session', 'password', 'balance', 'ipAddress']) {
        expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    });
  });

  describe('authority inside the organization is a permission, never a role name', () => {
    it('lets a reviewer review', async () => {
      const coordinator = await createUser(context, 'coordinator@example.com');
      await grantOrganizationRoleTo(context, university, coordinator, 'ORGANIZATION_REVIEWER');

      const queue = await reviewQueue(coordinator.client, university.organizationId);
      expect(queue.status).toBe(200);
      expect(queue.body).toHaveLength(1);

      const decided = await decide(coordinator.client, university.organizationId, revisionId, {
        toStatus: 'UNDER_REVIEW',
      });
      expect(decided.status).toBe(200);
      expect(decided.body.actorUserId).toBe(coordinator.userId);
    });

    it('never lets a template manager decide a submission', async () => {
      // §55: writing the rules a document is measured against and deciding a
      // student's submission are different jobs. The bundle says so, so no
      // check in any controller has to.
      const templates = await createUser(context, 'templates@example.com');
      await grantOrganizationRoleTo(context, university, templates, 'TEMPLATE_MANAGER');

      expect((await reviewQueue(templates.client, university.organizationId)).status).toBe(403);
      expect(
        (
          await decide(templates.client, university.organizationId, revisionId, {
            toStatus: 'APPROVED',
          })
        ).status,
      ).toBe(403);
      expect(
        (await addComment(templates.client, university.organizationId, revisionId, 'Hello')).status,
      ).toBe(403);
      expect(
        (await organizationReport(templates.client, university.organizationId, revisionId)).status,
      ).toBe(403);
    });
  });

  describe('the author’s own reach stops at their own submission', () => {
    it('cannot use the organization’s routes for their own case', async () => {
      // The author is not a member of the university, and submitting did not
      // make them one (§17). A non-member is told the organization is not
      // found rather than forbidden, which is the same answer they would get
      // for a university that does not exist — as it should be.
      expect((await reviewQueue(author.client, university.organizationId)).status).toBe(404);
      expect(
        (
          await decide(author.client, university.organizationId, revisionId, {
            toStatus: 'APPROVED',
          })
        ).status,
      ).toBe(404);
      expect(
        (await addComment(author.client, university.organizationId, revisionId, 'Approve me'))
          .status,
      ).toBe(404);

      expect(
        (await context.adminDb.submissionRevision.findUniqueOrThrow({ where: { id: revisionId } }))
          .institutionDecisionStatus,
      ).toBe('SUBMITTED');
    });
  });
});
