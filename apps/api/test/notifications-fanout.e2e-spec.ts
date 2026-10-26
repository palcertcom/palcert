import { randomUUID } from 'node:crypto';
import { ProcessingJobType } from '@palcert/contracts';
import { type AuthClient } from './support/auth-client';
import { type PublishedStandard } from './support/checks-client';
import {
  createTenant,
  createUser,
  grantOrganizationRoleTo,
  type TenantFixture,
} from './support/organization-client';
import { completedCheck, publishStandardFor, submitAndPrepare } from './support/submissions-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/** Deliberately tiny, so a modest fixture still crosses several pages. */
const PAGE_SIZE = 7;
const REVIEWERS = 23;

async function drain(context: TestContext): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    const jobs = await context.adminDb.processingJob.findMany({
      where: {
        jobType: {
          in: [ProcessingJobType.NOTIFICATION_FANOUT, ProcessingJobType.NOTIFICATION_EMAIL_SEND],
        },
        status: { in: ['PENDING', 'DISPATCHED', 'RETRY_PENDING'] },
      },
    });
    if (jobs.length === 0) return;
    for (const job of jobs) await context.worker.processJobId(job.id);
  }
}

/**
 * Fan-out across more reviewers than one page holds (§23).
 *
 * The page size is configured down to seven so this stays a fast test that
 * genuinely exercises the loop. What it is really checking is that paging the
 * database is not undone by the application: an earlier version paged
 * correctly and then accumulated every page into one array before notifying
 * anybody, which is the same unbounded read with extra steps.
 */
describe('Notifications — fan-out across pages (e2e)', () => {
  let context: TestContext;
  let author: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let standard: PublishedStandard;

  beforeAll(async () => {
    context = await createTestContext({ NOTIFICATION_FANOUT_PAGE_SIZE: String(PAGE_SIZE) });
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

  it('notifies every reviewer exactly once across several pages', async () => {
    const reviewers: string[] = [];
    for (let i = 0; i < REVIEWERS; i += 1) {
      const reviewer = await createUser(context, `reviewer-${i}@example.com`);
      await grantOrganizationRoleTo(context, university, reviewer, 'ORGANIZATION_REVIEWER');
      reviewers.push(reviewer.userId);
    }

    // A neighbouring institution, whose reviewers must hear nothing.
    const other = await createTenant(context, 'Birzeit University', 'other@example.com');
    const outsider = await createUser(context, 'outside-reviewer@example.com');
    await grantOrganizationRoleTo(context, other, outsider, 'ORGANIZATION_REVIEWER');

    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    await drain(context);

    const event = await context.adminDb.domainEvent.findFirstOrThrow({
      where: { sourceType: 'SUBMISSION_REVISION', sourceId: revisionId },
    });
    const notified = await context.adminDb.userNotification.findMany({
      where: { sourceEventId: event.id },
      select: { recipientUserId: true },
    });

    const recipients = notified.map((row) => row.recipientUserId);
    // Exactly once each: the uniqueness is the database's, but paging is where
    // a duplicate or an omission would come from.
    expect(new Set(recipients).size).toBe(recipients.length);
    expect(recipients.length).toBeGreaterThan(PAGE_SIZE);

    for (const reviewer of reviewers) expect(recipients).toContain(reviewer);
    // The organization's owner reviews too; the author does not, and neither
    // does anybody from the other institution.
    expect(recipients).toContain(university.owner.userId);
    expect(recipients).not.toContain(author.userId);
    expect(recipients).not.toContain(outsider.userId);
    expect(recipients).not.toContain(other.owner.userId);
  });

  it('runs the fan-out again without notifying anybody twice', async () => {
    for (let i = 0; i < PAGE_SIZE + 3; i += 1) {
      const reviewer = await createUser(context, `reviewer-${i}@example.com`);
      await grantOrganizationRoleTo(context, university, reviewer, 'ORGANIZATION_REVIEWER');
    }

    const check = await completedCheck(context, author, standard);
    await submitAndPrepare(context, author.client, check.checkId);
    await drain(context);

    const before = await context.adminDb.userNotification.count();
    expect(before).toBeGreaterThan(PAGE_SIZE);

    const fanouts = await context.adminDb.processingJob.findMany({
      where: { jobType: ProcessingJobType.NOTIFICATION_FANOUT },
    });
    for (const job of fanouts) {
      await context.worker.processJobId(job.id);
      await context.worker.processJobId(job.id);
    }
    await drain(context);

    expect(await context.adminDb.userNotification.count()).toBe(before);
  });

  it('refuses an event written to a schema this build does not understand', async () => {
    const reviewer = await createUser(context, 'reviewer@example.com');
    await grantOrganizationRoleTo(context, university, reviewer, 'ORGANIZATION_REVIEWER');

    const check = await completedCheck(context, author, standard);
    const { revisionId, submissionId } = await submitAndPrepare(
      context,
      author.client,
      check.checkId,
    );

    // A version-2 event, as a later phase would write one. Inserted directly
    // because no emitter in this build can produce one — which is the point:
    // the fan-out must refuse it rather than read it with version 1's rules
    // and deliver a confidently wrong notification.
    const futureEventId = randomUUID();
    await context.adminDb.$executeRawUnsafe(
      `INSERT INTO "domain_events"
         ("id","event_type","event_schema_version","source_type","source_id",
          "aggregate_type","aggregate_id","owner_user_id","organization_id",
          "occurred_at","payload")
       VALUES ($1::uuid,'SUBMISSION_APPROVED',2,'SUBMISSION_DECISION_EVENT',$2::uuid,
               'OFFICIAL_SUBMISSION',$3::uuid,$4::uuid,$5::uuid,now(),$6::jsonb)`,
      futureEventId,
      randomUUID(),
      submissionId,
      author.userId,
      university.organizationId,
      JSON.stringify({ submissionId, submissionRevisionId: revisionId }),
    );

    const job = await context.adminDb.$transaction((tx) =>
      context.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.NOTIFICATION_FANOUT,
        resourceType: 'DOMAIN_EVENT',
        resourceId: futureEventId,
      }),
    );

    const before = await context.adminDb.userNotification.count();
    await expect(context.worker.processJobId(job.id)).resolves.toBeUndefined();

    // Nothing was written, and the job followed the ordinary failure ladder
    // rather than reporting a success it did not have.
    expect(
      await context.adminDb.userNotification.count({ where: { sourceEventId: futureEventId } }),
    ).toBe(0);
    expect(await context.adminDb.userNotification.count()).toBe(before);

    const after = await context.adminDb.processingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).not.toBe('SUCCEEDED');
    expect(['RETRY_PENDING', 'DEAD']).toContain(after.status);
    expect(after.attemptCount).toBeGreaterThan(0);

    // And no delivery, so nothing will try to send it either.
    const deliveries = await context.adminDb.notificationDelivery.findMany({
      where: { notification: { sourceEventId: futureEventId } },
    });
    expect(deliveries).toEqual([]);
  });
});
