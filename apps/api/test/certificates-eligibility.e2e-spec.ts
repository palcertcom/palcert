import { type AuthClient } from './support/auth-client';
import {
  certificateForRevision,
  settleWithoutCertificate,
  waitForCertificate,
} from './support/certificates-client';
import {
  aiAssistedRule,
  publishCheckableStandard,
  type PublishedStandard,
} from './support/checks-client';
import { failResultFor } from './support/fake-document-engine';
import { createTenant, createUser, type TenantFixture } from './support/organization-client';
import { validRule } from './support/standards-client';
import {
  completedCheck,
  decide,
  publishStandardFor,
  submitAndPrepare,
} from './support/submissions-client';
import { CertificateIssueJobHandler } from '../src/worker/certificate-issue-job.handler';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * The eligibility rule, stated once and tested exhaustively (§4, §136–§143).
 *
 *     PalCert technical determination = COMPLIANT
 *     AND institution decision        = APPROVED
 *
 * Nothing else issues a certificate. The two interesting cases are the ones a
 * reader might expect to be "close enough": a university that approves a
 * document PalCert found non-compliant, and a university that rejects one
 * PalCert found compliant. Both are ordinary, legitimate Phase 14 outcomes,
 * and neither certifies anything — because a PalCert certificate says both
 * authorities said yes, and there is no partial credit.
 */
describe('Certificates — eligibility (e2e)', () => {
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

  /** A handed-over revision whose technical determination is what was asked. */
  async function handedOver(): Promise<{
    revisionId: string;
    submissionId: string;
    documentId: string;
  }> {
    const check = await completedCheck(context, author, standard);
    const handed = await submitAndPrepare(context, author.client, check.checkId);
    return { ...handed, documentId: check.documentId };
  }

  /** A standard PalCert cannot fully decide, for the two non-verdict cases. */
  async function undecidableStandard(): Promise<PublishedStandard> {
    return publishCheckableStandard(context, university.owner.client, university.organizationId, {
      standardCode: 'IUG.THESIS.ETHICS',
      documentTypeName: 'Ethics thesis',
      // A standard of only unmeasurable rules is refused at check time
      // (ADR-0100), so one measurable rule sits alongside the judged one.
      rules: [validRule(), aiAssistedRule({ blocking: true })],
    });
  }

  // -------------------------------------------------------------------------
  // The only combination that certifies (§4)
  // -------------------------------------------------------------------------

  it('certifies COMPLIANT + APPROVED, and records why', async () => {
    const { revisionId } = await handedOver();
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });

    const settled = await waitForCertificate(context, revisionId);
    expect([settled.issuanceStatus, settled.failureCode]).toEqual(['ISSUED', null]);

    const status = await certificateForRevision(author.client, revisionId);
    expect(status.status).toBe(200);
    expect(status.body.eligible).toBe(true);
    expect(status.body.reason).toBeNull();
    expect(status.body.certificate.technicalResult).toBe('COMPLIANT');
    expect(status.body.certificate.institutionDecision).toBe('APPROVED');
  });

  // -------------------------------------------------------------------------
  // Approved, but PalCert did not say compliant (§139–§141)
  // -------------------------------------------------------------------------

  it('issues nothing for NON_COMPLIANT + APPROVED, and says which half is missing', async () => {
    context.documentEngine.evaluationResults = [failResultFor('MARGIN.TOP.MIN')];
    const { revisionId } = await handedOver();

    const approved = await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    expect(approved.status).toBe(200);

    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    expect([revision.determination, revision.institutionDecisionStatus]).toEqual([
      'NON_COMPLIANT',
      'APPROVED',
    ]);
    await settleWithoutCertificate(context, revisionId);

    // §117: the reason names PalCert's finding, not the institution's
    // decision — the university did approve, and saying otherwise would be a
    // lie about them.
    const status = await certificateForRevision(author.client, revisionId);
    expect([status.body.eligible, status.body.reason]).toEqual([false, 'NOT_COMPLIANT']);
  });

  it.each([['REVIEW_REQUIRED or INDETERMINATE', 'judged']] as const)(
    'issues nothing for %s + APPROVED',
    async () => {
      // §140, §141: a determination that is not a verdict is not a verdict of
      // COMPLIANT either. The engine could not decide; PalCert will not.
      const judged = await undecidableStandard();
      const check = await completedCheck(context, author, judged);
      const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

      const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
        where: { id: revisionId },
      });
      expect(['REVIEW_REQUIRED', 'INDETERMINATE']).toContain(revision.determination);

      await decide(university.owner.client, university.organizationId, revisionId, {
        toStatus: 'APPROVED',
      });
      await settleWithoutCertificate(context, revisionId);

      const status = await certificateForRevision(author.client, revisionId);
      expect([status.body.eligible, status.body.reason]).toEqual([false, 'NOT_COMPLIANT']);
    },
  );

  // -------------------------------------------------------------------------
  // Compliant, but the institution has not approved (§142, §143)
  // -------------------------------------------------------------------------

  it('issues nothing for COMPLIANT + REJECTED, and does not blame the document', async () => {
    const { revisionId } = await handedOver();
    const rejected = await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'REJECTED',
      comment: 'The submission deadline had passed.',
    });
    expect(rejected.status).toBe(200);
    await settleWithoutCertificate(context, revisionId);

    const status = await certificateForRevision(author.client, revisionId);
    expect([status.body.eligible, status.body.reason]).toEqual([false, 'NOT_APPROVED']);
  });

  it('issues nothing while a compliant submission is still SUBMITTED', async () => {
    const { revisionId } = await handedOver();
    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    expect(revision.institutionDecisionStatus).toBe('SUBMITTED');
    await settleWithoutCertificate(context, revisionId);

    const status = await certificateForRevision(author.client, revisionId);
    expect([status.body.eligible, status.body.reason]).toEqual([
      false,
      'AWAITING_INSTITUTION_DECISION',
    ]);
  });

  it.each(['UNDER_REVIEW', 'REVISION_REQUESTED'] as const)(
    'issues nothing for COMPLIANT + %s',
    async (toStatus) => {
      const { revisionId } = await handedOver();
      const moved = await decide(university.owner.client, university.organizationId, revisionId, {
        toStatus,
        ...(toStatus === 'REVISION_REQUESTED'
          ? { comment: 'Please widen the top margin before resubmitting.' }
          : {}),
      });
      expect(moved.status).toBe(200);
      await settleWithoutCertificate(context, revisionId);

      const status = await certificateForRevision(author.client, revisionId);
      expect([status.body.eligible, status.body.reason]).toEqual([
        false,
        'AWAITING_INSTITUTION_DECISION',
      ]);
    },
  );

  // -------------------------------------------------------------------------
  // The current revision only (§5, §6)
  // -------------------------------------------------------------------------

  it('certifies the revision that was approved, and never a superseded one', async () => {
    // A revision that was approved and then superseded keeps its certificate:
    // the claim is about that immutable revision, and a later attempt does not
    // unsay what the institution decided about the earlier one. What must not
    // happen is a *new* certificate for the superseded revision.
    const { revisionId, submissionId, documentId } = await handedOver();
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'REVISION_REQUESTED',
      comment: 'Please widen the top margin before resubmitting.',
    });

    // The same document, so this is a second revision of the same case rather
    // than a second case.
    const second = await completedCheck(context, author, standard, { documentId });
    const resubmitted = await submitAndPrepare(context, author.client, second.checkId);
    expect(resubmitted.submissionId).toBe(submissionId);

    await decide(university.owner.client, university.organizationId, resubmitted.revisionId, {
      toStatus: 'APPROVED',
    });
    const settled = await waitForCertificate(context, resubmitted.revisionId);
    expect(settled.issuanceStatus).toBe('ISSUED');

    // The superseded revision has none, and is told why in its own terms.
    expect(
      await context.adminDb.complianceCertificate.count({
        where: { submissionRevisionId: revisionId },
      }),
    ).toBe(0);
    const status = await certificateForRevision(author.client, revisionId);
    expect([status.body.eligible, status.body.reason]).toEqual([false, 'SUPERSEDED_REVISION']);
  });

  // -------------------------------------------------------------------------
  // One certificate per revision (§25, §147)
  // -------------------------------------------------------------------------

  it('never issues a second certificate for the same revision', async () => {
    const { revisionId } = await handedOver();
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    const first = await waitForCertificate(context, revisionId);

    // Run the handler again against the same job, which is what a duplicate
    // queue delivery that beat the ledger claim would do. It must neither
    // issue a second certificate nor throw — a handler that crashed would be
    // retried, and the retry would crash too.
    const job = await context.adminDb.processingJob.findFirstOrThrow({
      where: { jobType: 'CERTIFICATE_ISSUE', resourceId: first.id },
    });
    await expect(
      context.workerApp.get(CertificateIssueJobHandler).handle({ ...job, status: 'RUNNING' }),
    ).resolves.toBeUndefined();

    expect(
      await context.adminDb.complianceCertificate.count({
        where: { submissionRevisionId: revisionId },
      }),
    ).toBe(1);
    const after = await context.adminDb.complianceCertificate.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(after.issuanceStatus).toBe('ISSUED');
    // §60: one issuance event, not two.
    expect(
      await context.adminDb.certificateEvent.count({
        where: { certificateId: first.id, eventType: 'ISSUED' },
      }),
    ).toBe(1);
  });
});
