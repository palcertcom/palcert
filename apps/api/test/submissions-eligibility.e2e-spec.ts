import { type AuthClient } from './support/auth-client';
import {
  aiAssistedRule,
  publishCheckableStandard,
  setCheckAvailability,
  type PublishedStandard,
} from './support/checks-client';
import { failResultFor } from './support/fake-document-engine';
import { validRule } from './support/standards-client';
import { createTenant, createUser, type TenantFixture } from './support/organization-client';
import {
  completedCheck,
  disclosureFor,
  publishStandardFor,
  reviewQueue,
  submitAndPrepare,
  submitCheck,
} from './support/submissions-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * What may be submitted, and what may not (§13–§19).
 *
 * The rules here are deliberately strict about identity and deliberately
 * silent about quality. A NON_COMPLIANT thesis may be submitted, and so may an
 * INDETERMINATE one: the institution decides what to do with it, which is the
 * whole point of keeping the two authorities apart. What must hold is that the
 * bytes, the rules and the report really are the ones the check measured, and
 * that the recipient is still an organization able to receive anything.
 */
describe('Official submissions — eligibility (e2e)', () => {
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

  it.each([
    ['a passing check', undefined, 'COMPLIANT'],
    ['a failing check', 'fail', 'NON_COMPLIANT'],
  ] as const)(
    'submits %s, because the institution decides what to do with it',
    async (_label, mode, expected) => {
      // §14: a determination is never a reason to refuse a submission.
      // Refusing to let somebody submit a document PalCert found wanting would
      // be PalCert deciding their application for them.
      if (mode === 'fail') {
        context.documentEngine.evaluationResults = [failResultFor('MARGIN.TOP.MIN')];
      }
      const check = await completedCheck(context, author, standard);
      const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

      const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
        where: { id: revisionId },
      });
      expect(revision.determination).toBe(expected);
      expect(revision.institutionDecisionStatus).toBe('SUBMITTED');
      expect((await reviewQueue(university.owner.client, university.organizationId)).body).toEqual([
        expect.objectContaining({ revisionId }),
      ]);
    },
  );

  it('submits a check PalCert could not fully decide', async () => {
    // §14 again, for the two determinations that are not verdicts at all. A
    // rule that needs a human to read it leaves the deterministic engine
    // unable to say yes or no — and that is precisely the document somebody
    // most needs an institution to look at.
    const judged = await publishCheckableStandard(
      context,
      university.owner.client,
      university.organizationId,
      {
        standardCode: 'IUG.THESIS.ETHICS',
        documentTypeName: 'Ethics thesis',
        // One rule the engine can measure and one it cannot: a standard of
        // only unmeasurable rules is refused at check time (ADR-0100), so the
        // mixed case is the one that produces this determination.
        rules: [validRule(), aiAssistedRule({ blocking: true })],
      },
    );

    const check = await completedCheck(context, author, judged);
    const run = await context.adminDb.checkRun.findFirstOrThrow({
      where: { checkId: check.checkId },
    });
    expect(['REVIEW_REQUIRED', 'INDETERMINATE']).toContain(run.determination);

    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    expect(revision.determination).toBe(run.determination);
    expect(revision.institutionDecisionStatus).toBe('SUBMITTED');
  });

  it('still accepts a submission after the standard leaves the catalogue', async () => {
    // §19: `PUBLIC_CHECKABLE` governs who may *start* a check. A person who
    // already paid for one, and holds its report, is not stopped from
    // submitting it because the institution has since stopped advertising the
    // standard — the evidence they hold is unaffected.
    const check = await completedCheck(context, author, standard);

    const withdrawn = await setCheckAvailability(
      university.owner.client,
      university.organizationId,
      standard.standardId,
      'PRIVATE',
    );
    expect(withdrawn.status).toBe(200);

    expect((await disclosureFor(author.client, check.checkId)).status).toBe(200);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    expect(revisionId).toBeDefined();
  });

  it('refuses a new submission to an organization that is not verified', async () => {
    // §18: fail closed for a *new* decision. An organization whose
    // verification was withdrawn is not somewhere PalCert should be sending
    // people's theses.
    const check = await completedCheck(context, author, standard);

    await context.adminDb.organization.update({
      where: { id: university.organizationId },
      data: { verificationStatus: 'UNVERIFIED' },
    });

    const attempt = await submitCheck(author.client, check.checkId);
    expect(attempt.status).toBe(409);
    expect(attempt.body.error.code).toBe('SUBMISSION_ORGANIZATION_NOT_ELIGIBLE');
    expect(await context.adminDb.submissionRevision.count()).toBe(0);
  });

  it('refuses a new submission to an organization that is not active', async () => {
    const check = await completedCheck(context, author, standard);

    await context.adminDb.organization.update({
      where: { id: university.organizationId },
      // The status and its timestamp move together; the schema refuses one
      // without the other.
      data: { status: 'SUSPENDED', suspendedAt: new Date() },
    });

    const attempt = await submitCheck(author.client, check.checkId);
    expect(attempt.status).toBe(409);
    expect(attempt.body.error.code).toBe('SUBMISSION_ORGANIZATION_NOT_ELIGIBLE');
  });

  it('leaves an existing submission alone when the organization is suspended', async () => {
    // §18 fails closed for *new* submissions only. A handoff that already
    // happened is a record, and a record does not disappear because the
    // recipient's status changed afterwards.
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    await context.adminDb.organization.update({
      where: { id: university.organizationId },
      data: { status: 'SUSPENDED', suspendedAt: new Date() },
    });

    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    expect(revision.processingStatus).toBe('READY');
    expect(revision.institutionDecisionStatus).toBe('SUBMITTED');
    expect(revision.evidenceHash).toHaveLength(64);
  });

  it('never resolves the recipient from anything the request said', async () => {
    // §15: the recipient is whoever owns the standard the check was measured
    // against. There is no organization id anywhere in the submitter's API, so
    // a document checked against one university's rules cannot be sent to
    // another as if it had been measured against theirs.
    const other = await createTenant(context, 'Birzeit University', 'other@example.com');
    const check = await completedCheck(context, author, standard);

    const { submissionId } = await submitAndPrepare(context, author.client, check.checkId);

    const submission = await context.adminDb.officialSubmission.findUniqueOrThrow({
      where: { id: submissionId },
    });
    expect(submission.organizationId).toBe(university.organizationId);
    expect(submission.organizationId).not.toBe(other.organizationId);

    expect((await reviewQueue(other.owner.client, other.organizationId)).body).toEqual([]);
  });
});
