import { type AuthClient } from './support/auth-client';
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

/** Wait for the live worker to finish issuing, or report why it did not. */
async function waitForCertificate(
  context: TestContext,
  revisionId: string,
  timeoutMs = 30_000,
): Promise<{ issuanceStatus: string; failureCode: string | null; id: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = 'none';
  while (Date.now() < deadline) {
    const row = await context.adminDb.complianceCertificate.findFirst({
      where: { submissionRevisionId: revisionId },
    });
    if (row !== null) {
      last = row.issuanceStatus;
      if (row.issuanceStatus !== 'PENDING') {
        return { issuanceStatus: row.issuanceStatus, failureCode: row.failureCode, id: row.id };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`certificate for ${revisionId} did not settle in ${timeoutMs} ms (${last})`);
}

describe('Certificates — issuance (e2e)', () => {
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

  it('issues a certificate when PalCert says compliant and the institution approves', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    // Nothing exists before the decision: eligibility is the approval, and a
    // compliant submission on its own certifies nothing.
    expect(await context.adminDb.complianceCertificate.count()).toBe(0);

    const approved = await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    expect(approved.status).toBe(200);

    const settled = await waitForCertificate(context, revisionId);
    expect([settled.issuanceStatus, settled.failureCode]).toEqual(['ISSUED', null]);

    const certificate = await context.adminDb.complianceCertificate.findUniqueOrThrow({
      where: { id: settled.id },
    });

    // The readable number is not a column — it lives in the claim artifact,
    // which is what the holder's view reads. What the row keeps is the
    // one-way digest, and nothing openable.
    expect(certificate.verificationCodeHash).toHaveLength(64);
    expect(certificate.verificationCodeCiphertext).toBeNull();
    expect(certificate.claimHash).toHaveLength(64);
    expect(certificate.certificateObjectSha256).toHaveLength(64);
    expect(certificate.claimObjectKey).toContain(
      `organizations/${university.organizationId}/certificates/`,
    );
    expect(certificate.issuedAt).not.toBeNull();
    // §28: no automatic expiry in Phase 15.
    expect(certificate.validUntil).toBeNull();

    // §61: PalCert issued it, so the event has no actor.
    const events = await context.adminDb.certificateEvent.findMany({
      where: { certificateId: settled.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('ISSUED');
    expect(events[0]?.eventSource).toBe('SYSTEM');
    expect(events[0]?.actorUserId).toBeNull();
  });

  it('issues nothing when the institution approves a non-compliant submission', async () => {
    // §139: Phase 14 explicitly allows this, and it is the case the whole
    // eligibility rule exists to get right.
    const { failResultFor } = await import('./support/fake-document-engine');
    context.documentEngine.evaluationResults = [failResultFor('MARGIN.TOP.MIN')];

    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    const approved = await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    expect(approved.status).toBe(200);

    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    expect(revision.determination).toBe('NON_COMPLIANT');
    expect(revision.institutionDecisionStatus).toBe('APPROVED');
    expect(await context.adminDb.complianceCertificate.count()).toBe(0);
  });

  it('issues nothing when a compliant submission is rejected', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    const rejected = await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'REJECTED',
      comment: 'The submission deadline had passed.',
    });
    expect(rejected.status).toBe(200);
    expect(await context.adminDb.complianceCertificate.count()).toBe(0);
  });
});
