import { NOTIFICATION_TYPES, ProcessingJobType } from '@palcert/contracts';
import { type AuthClient } from './support/auth-client';
import { type PublishedStandard } from './support/checks-client';
import {
  createTenant,
  createUser,
  grantOrganizationRoleTo,
  type TenantFixture,
} from './support/organization-client';
import { revokeCertificate, waitForCertificate } from './support/certificates-client';
import {
  addComment,
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

const API = '/api/v1';

/**
 * Run every notification job the fixtures produced.
 *
 * Fan-out creates email jobs, so the loop repeats until nothing new appears —
 * one pass would leave the emails unsent and the assertions would be about
 * half a pipeline.
 */
async function drainNotifications(context: TestContext): Promise<void> {
  for (let pass = 0; pass < 5; pass += 1) {
    const jobs = await context.adminDb.processingJob.findMany({
      where: {
        jobType: {
          in: [ProcessingJobType.NOTIFICATION_FANOUT, ProcessingJobType.NOTIFICATION_EMAIL_SEND],
        },
        // DISPATCHED too: the live dispatcher may have claimed a job
        // already, and `start` accepts it in that state.
        status: { in: ['PENDING', 'DISPATCHED', 'RETRY_PENDING'] },
      },
    });
    if (jobs.length === 0) return;
    for (const job of jobs) {
      await context.worker.processJobId(job.id);
    }
  }
}

/**
 * The mail of one kind sent to one address.
 *
 * By subject rather than "the last one", because an approved compliant
 * submission legitimately produces two: the decision, and then the
 * certificate its approval caused.
 */
function mailAbout(
  context: TestContext,
  email: string,
  subject: string,
): { to: string; subject: string; text: string; html: string } | undefined {
  return context.emailProvider
    .all()
    .find((message) => message.to === email && message.subject === subject);
}

/** Wait for the live worker to finish issuing, or report why it did not. */
async function waitForIssuedCertificate(
  context: TestContext,
  revisionId: string,
  timeoutMs = 30_000,
): Promise<{ id: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = 'none';
  while (Date.now() < deadline) {
    const row = await context.adminDb.complianceCertificate.findFirst({
      where: { submissionRevisionId: revisionId },
    });
    if (row !== null) {
      last = row.issuanceStatus;
      if (row.issuanceStatus === 'ISSUED') return { id: row.id };
      if (row.issuanceStatus.startsWith('FAILED')) {
        throw new Error(`certificate for ${revisionId} failed: ${row.failureCode}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`certificate for ${revisionId} did not issue in ${timeoutMs} ms (${last})`);
}

describe('Notifications — reporting what already happened (e2e)', () => {
  let context: TestContext;
  let author: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let reviewer: { email: string; userId: string; client: AuthClient };
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
    reviewer = await createUser(context, 'reviewer@example.com');
    await grantOrganizationRoleTo(context, university, reviewer, 'ORGANIZATION_REVIEWER');
    standard = await publishStandardFor(context, university);
  });

  it('tells the institution a submission is ready, and the author what was decided', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId, submissionId } = await submitAndPrepare(
      context,
      author.client,
      check.checkId,
    );

    await drainNotifications(context);

    // The event is derived from the revision, and READY rather than
    // REVISION_READY because this is revision 1 — decided by the database from
    // authoritative state, not by the worker.
    const ready = await context.adminDb.domainEvent.findFirstOrThrow({
      where: { sourceType: 'SUBMISSION_REVISION', sourceId: revisionId },
    });
    expect(ready.eventType).toBe('SUBMISSION_READY');
    expect(ready.aggregateType).toBe('OFFICIAL_SUBMISSION');
    expect(ready.aggregateId).toBe(submissionId);
    expect(ready.ownerUserId).toBe(author.userId);
    expect(ready.organizationId).toBe(university.organizationId);

    // The reviewer audience: the owner and admin who can review, plus the
    // reviewer invited above. The author is not told their own submission
    // arrived — they sent it.
    const readyRecipients = await context.adminDb.userNotification.findMany({
      where: { sourceEventId: ready.id },
    });
    const told = readyRecipients.map((row) => row.recipientUserId).sort();
    expect(told).toContain(reviewer.userId);
    expect(told).toContain(university.owner.userId);
    expect(told).not.toContain(author.userId);

    // A reviewer's link points into the organization's own route, not at the
    // author's page, which the reviewer is not authorized for.
    const reviewerCopy = readyRecipients.find((row) => row.recipientUserId === reviewer.userId);
    expect(reviewerCopy?.deepLink).toBe(
      `/en/organizations/${university.organizationId}/submissions/${submissionId}`,
    );

    const approved = await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    expect(approved.status).toBe(200);
    await drainNotifications(context);

    const decision = await context.adminDb.domainEvent.findFirstOrThrow({
      where: { eventType: 'SUBMISSION_APPROVED' },
    });
    expect(decision.sourceType).toBe('SUBMISSION_DECISION_EVENT');

    const authorCopy = await context.adminDb.userNotification.findFirstOrThrow({
      where: { sourceEventId: decision.id },
    });
    expect(authorCopy.recipientUserId).toBe(author.userId);
    expect(authorCopy.deepLink).toBe(`/en/submissions/${submissionId}`);
  });

  it('carries identifiers and a decision status, and nothing a reader could be leaked', async () => {
    const check = await completedCheck(context, author, standard, {
      documentName: 'Confidential Thesis On Something Private',
    });
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'REVISION_REQUESTED',
      comment: 'The bibliography uses the wrong citation style throughout chapter four.',
    });
    await drainNotifications(context);

    for (const event of await context.adminDb.domainEvent.findMany()) {
      const payload = JSON.stringify(event.payload);
      expect(payload).not.toContain('Confidential');
      expect(payload).not.toContain('bibliography');
      expect(payload).not.toContain('@example.com');
      expect(payload).not.toContain('.docx');
      for (const key of Object.keys(event.payload as Record<string, unknown>)) {
        expect([
          'submissionId',
          'submissionRevisionId',
          'revisionNumber',
          'certificateId',
          'institutionDecisionStatus',
        ]).toContain(key);
      }
    }

    // And the rendered copy says that something happened, not what.
    for (const notification of await context.adminDb.userNotification.findMany()) {
      expect(notification.title).not.toContain('Confidential');
      expect(notification.body).not.toContain('bibliography');
      expect(notification.body).not.toContain('@example.com');
    }
  });

  it('notifies once however many times the job is delivered', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'UNDER_REVIEW',
    });
    await drainNotifications(context);

    const before = await context.adminDb.userNotification.count();
    const beforeEmails = context.emailProvider.all().length;
    expect(before).toBeGreaterThan(0);

    // At-least-once is what the queue promises. Re-running every fan-out is
    // exactly the duplicate delivery that must change nothing.
    const fanouts = await context.adminDb.processingJob.findMany({
      where: { jobType: ProcessingJobType.NOTIFICATION_FANOUT },
    });
    for (const job of fanouts) {
      await context.worker.processJobId(job.id);
      await context.worker.processJobId(job.id);
    }
    await drainNotifications(context);

    expect(await context.adminDb.userNotification.count()).toBe(before);
    expect(context.emailProvider.all().length).toBe(beforeEmails);
  });

  it('reports a standalone comment, and never twice for a decision that carried one', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    // A decision with an inline comment is one act, so it is one event.
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'REVISION_REQUESTED',
      comment: 'Please fix the margins.',
    });
    await drainNotifications(context);
    expect(
      await context.adminDb.domainEvent.count({ where: { eventType: 'SUBMISSION_COMMENT_ADDED' } }),
    ).toBe(0);

    // A comment written on its own is its own event.
    const commented = await addComment(
      university.owner.client,
      university.organizationId,
      revisionId,
      'One more thing about chapter two.',
    );
    expect(commented.status).toBe(201);
    await drainNotifications(context);

    const commentEvents = await context.adminDb.domainEvent.findMany({
      where: { eventType: 'SUBMISSION_COMMENT_ADDED' },
    });
    expect(commentEvents).toHaveLength(1);
    expect(commentEvents[0]?.sourceType).toBe('SUBMISSION_COMMENT');
  });

  it('shows a person their own inbox and nobody else’s', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    await drainNotifications(context);

    const authorInbox = await author.client.get(`${API}/notifications`);
    expect(authorInbox.status).toBe(200);
    const authorItems = authorInbox.body.items as Array<{ id: string; notificationType: string }>;
    expect(authorItems.map((item) => item.notificationType)).toContain('SUBMISSION_APPROVED');

    // The reviewer sees the arrival, never the author's decision copy.
    const reviewerInbox = await reviewer.client.get(`${API}/notifications`);
    const reviewerItems = reviewerInbox.body.items as Array<{ id: string }>;
    const authorIds = new Set(authorItems.map((item) => item.id));
    for (const item of reviewerItems) expect(authorIds.has(item.id)).toBe(false);

    // And one person's id is not found for another, never forbidden: the
    // difference would confirm that it exists.
    const stolen = await reviewer.client.post(`${API}/notifications/${authorItems[0]!.id}/read`);
    expect(stolen.status).toBe(404);
    expect(stolen.body.error.code).toBe('NOTIFICATION_NOT_FOUND');
  });

  it('marks as read once, and keeps the first answer', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    await drainNotifications(context);

    const before = await author.client.get(`${API}/notifications/unread-count`);
    expect(before.body.unread).toBeGreaterThan(0);

    const items = (await author.client.get(`${API}/notifications`)).body.items as Array<{
      id: string;
    }>;
    const first = await author.client.post(`${API}/notifications/${items[0]!.id}/read`);
    expect(first.status).toBe(201);
    expect(first.body.readAt).not.toBeNull();

    context.clock.advanceMinutes(1);
    const again = await author.client.post(`${API}/notifications/${items[0]!.id}/read`);
    // read_at is the first time they saw it, not the last time they asked.
    expect(again.body.readAt).toBe(first.body.readAt);

    await author.client.post(`${API}/notifications/read-all`);
    expect((await author.client.get(`${API}/notifications/unread-count`)).body.unread).toBe(0);
  });

  it('sends workflow email to a verified active address, and records what it sent', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    await drainNotifications(context);

    const sent = mailAbout(context, author.email, 'Your submission was approved');
    expect(sent).toBeDefined();
    // The exact verified address, bare — never `Display Name <address>`.
    expect(sent?.to).toBe(author.email);
    expect(sent?.subject).toBe('Your submission was approved');
    // A link into the application, never a signed storage URL.
    expect(sent?.text).toContain('/en/submissions/');
    expect(sent?.html).not.toContain('X-Amz-Signature');

    const delivered = await context.adminDb.notificationDelivery.findMany({
      where: { channel: 'EMAIL' },
    });
    expect(delivered.some((row) => row.status === 'DELIVERED')).toBe(true);
    // The attempt history carries no address and no message content.
    for (const attempt of await context.adminDb.notificationDeliveryAttempt.findMany()) {
      expect(JSON.stringify(attempt)).not.toContain('@example.com');
    }
  });

  it('records why an email was not sent, rather than failing silently', async () => {
    await context.adminDb.notificationPreference.create({
      data: {
        userId: author.userId,
        notificationType: 'SUBMISSION_APPROVED',
        emailEnabled: false,
        updatedAt: new Date(),
      },
    });

    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    // Wait for issuance before draining. This test asserts on the certificate
    // mail, and issuance is asynchronous by design — draining a queue the
    // certificate's notification has not been enqueued into yet is racing the
    // worker rather than testing it.
    await waitForCertificate(context, revisionId);
    await drainNotifications(context);

    // No decision email, and the reason is recorded rather than lost. The
    // certificate mail the same approval caused is a different type with its
    // own preference, and still arrives.
    expect(mailAbout(context, author.email, 'Your submission was approved')).toBeUndefined();
    expect(mailAbout(context, author.email, 'Your certificate has been issued')).toBeDefined();

    const approvedEvent = await context.adminDb.domainEvent.findFirstOrThrow({
      where: { eventType: 'SUBMISSION_APPROVED' },
    });
    const copy = await context.adminDb.userNotification.findFirstOrThrow({
      where: { sourceEventId: approvedEvent.id },
    });
    const delivery = await context.adminDb.notificationDelivery.findFirstOrThrow({
      where: { notificationId: copy.id, channel: 'EMAIL' },
    });
    expect([delivery.status, delivery.skipReason]).toEqual(['SKIPPED', 'PREFERENCE_DISABLED']);

    // The in-app copy still exists: turning email off is a choice about mail,
    // not about being told.
    expect(copy.readAt).toBeNull();
  });

  it('reads account status before the verified-address flag', async () => {
    // Hardening §5, and the order is the point. A row that is not ACTIVE but
    // carries an email_verified_at timestamp is a contradiction, and the safe
    // reading of a contradiction is "do not send" rather than "one of these
    // two columns must be right".
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    // Suspended after the handoff and before the decision, which is the shape
    // this actually takes: the submission is already with the institution, and
    // the reviewer's decision does not depend on the author being able to sign
    // in. Suspending first would only prove that a suspended person cannot
    // upload a document, which is Phase 1's business.
    await context.adminDb.user.update({
      where: { id: author.userId },
      data: { status: 'SUSPENDED', emailVerifiedAt: new Date() },
    });

    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'UNDER_REVIEW',
    });
    await drainNotifications(context);

    expect(mailAbout(context, author.email, 'Your submission is under review')).toBeUndefined();

    // The author's own copy, not any delivery: the READY event legitimately
    // produced email for the organization's reviewers too, and theirs was
    // sent — one suspended account is not an outage.
    const copy = await context.adminDb.userNotification.findFirstOrThrow({
      where: { recipientUserId: author.userId, notificationType: 'SUBMISSION_UNDER_REVIEW' },
    });
    const delivery = await context.adminDb.notificationDelivery.findFirstOrThrow({
      where: { notificationId: copy.id, channel: 'EMAIL' },
    });
    // ACCOUNT_INELIGIBLE, not NO_VERIFIED_EMAIL: the address was verified, and
    // saying otherwise would send somebody to re-verify an address that is not
    // the problem.
    expect([delivery.status, delivery.skipReason]).toEqual(['SKIPPED', 'ACCOUNT_INELIGIBLE']);

    // The in-app copy still exists. Being suspended is not being erased.
    expect(copy.readAt).toBeNull();
  });

  it('emails a revocation even to somebody who turned every other type off', async () => {
    // The one type that is not a preference. A revocation is a material change
    // to the validity of something the holder may already have shown an
    // employer, and letting it arrive only as a badge in an inbox they have no
    // reason to open would be PalCert deciding that for them.
    for (const type of [
      'SUBMISSION_APPROVED',
      'SUBMISSION_UNDER_REVIEW',
      'CERTIFICATE_ISSUED',
    ] as const) {
      const off = await author.client.put(`${API}/notifications/preferences/${type}`, {
        emailEnabled: false,
      });
      expect(off.status).toBe(200);
    }

    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });

    const certificate = await waitForIssuedCertificate(context, revisionId);
    const revoked = await revokeCertificate(
      university.owner.client,
      university.organizationId,
      certificate.id,
      { reasonCode: 'ISSUED_IN_ERROR', comment: 'Approved against the wrong standard version.' },
    );
    expect(revoked.status).toBe(200);
    await drainNotifications(context);

    // Nothing they switched off arrived.
    expect(mailAbout(context, author.email, 'Your submission was approved')).toBeUndefined();
    expect(mailAbout(context, author.email, 'Your certificate has been issued')).toBeUndefined();

    // The one they could not arrived, from the certificate's own event.
    const revocationMail = mailAbout(context, author.email, 'Your certificate has been revoked');
    expect(revocationMail).toBeDefined();
    expect(revocationMail?.text).toContain(`/en/certificates/${certificate.id}`);
    // And never the code that would let the reader verify it.
    expect(revocationMail?.text).not.toMatch(/PC-[0-9A-Z]{8}/);

    const event = await context.adminDb.domainEvent.findFirstOrThrow({
      where: { eventType: 'CERTIFICATE_REVOKED' },
    });
    expect(event.sourceType).toBe('CERTIFICATE_EVENT');
    expect(event.aggregateType).toBe('COMPLIANCE_CERTIFICATE');
    expect(event.aggregateId).toBe(certificate.id);
  });

  it('will not let a person switch off the one email that matters', async () => {
    const listed = await author.client.get(`${API}/notifications/preferences`);
    expect(listed.status).toBe(200);
    const rows = listed.body as Array<{
      notificationType: string;
      emailEnabled: boolean;
      mandatory: boolean;
    }>;
    // Every type, including the ones they have never touched.
    expect(rows).toHaveLength(NOTIFICATION_TYPES.length);
    expect(rows.find((row) => row.notificationType === 'CERTIFICATE_REVOKED')?.mandatory).toBe(
      true,
    );
    // A revoked attestation is told as insistently as a revoked certificate.
    expect(rows.find((row) => row.notificationType === 'ATTESTATION_REVOKED')?.mandatory).toBe(
      true,
    );

    const refused = await author.client.put(
      `${API}/notifications/preferences/CERTIFICATE_REVOKED`,
      { emailEnabled: false },
    );
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('NOTIFICATION_TYPE_MANDATORY');

    // And the database refuses the row even without the route.
    await expect(
      context.adminDb.notificationPreference.create({
        data: {
          userId: author.userId,
          notificationType: 'CERTIFICATE_REVOKED',
          emailEnabled: false,
          updatedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/mandatory_email_stays_on/);

    const allowed = await author.client.put(
      `${API}/notifications/preferences/SUBMISSION_APPROVED`,
      {
        emailEnabled: false,
      },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body.emailEnabled).toBe(false);
  });
});
