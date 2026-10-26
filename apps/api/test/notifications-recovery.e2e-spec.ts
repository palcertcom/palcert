import { randomUUID } from 'node:crypto';
import { ProcessingJobType } from '@palcert/contracts';
import { OutboxDispatcher } from '../src/infrastructure/queue/outbox-dispatcher';
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

/**
 * The Message-ID production computes for one logical delivery.
 *
 * Spelled out here rather than imported so the test states the contract
 * independently: if the service changes shape, this fails rather than agreeing
 * with itself. The domain is the test environment's own
 * `NOTIFICATION_EMAIL_FROM`.
 */
function messageIdFor(id: string): string {
  return `<notification-delivery-${id}@palcert.test>`;
}

const NOTIFICATION_JOBS = [
  ProcessingJobType.NOTIFICATION_FANOUT,
  ProcessingJobType.NOTIFICATION_EMAIL_SEND,
];

/**
 * Wait for a delivery to reach a state it will not leave.
 *
 * The sweeper hands the revived job to the live worker, so whether this
 * process or that one runs it is a race — and asserting immediately would make
 * the test flaky rather than make the product wrong.
 */
async function waitForSettled(
  context: TestContext,
  deliveryId: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'unknown';
  while (Date.now() < deadline) {
    const row = await context.adminDb.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    last = row.status;
    if (['DELIVERED', 'SKIPPED', 'FAILED_PERMANENT'].includes(row.status)) return row.status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`delivery ${deliveryId} did not settle in ${timeoutMs} ms (${last})`);
}

async function drain(context: TestContext): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    const jobs = await context.adminDb.processingJob.findMany({
      where: {
        jobType: { in: NOTIFICATION_JOBS },
        status: { in: ['PENDING', 'DISPATCHED', 'RETRY_PENDING'] },
      },
    });
    if (jobs.length === 0) return;
    for (const job of jobs) await context.worker.processJobId(job.id);
  }
}

/**
 * Crashing, resuming and not sending twice by accident (§57, §58).
 *
 * The cases here are the ones that only exist because a process can stop
 * between two statements. They matter more than the happy path: a notification
 * nobody ever receives is the failure this phase was built to prevent, and a
 * worker that dies mid-send is the ordinary way that happens.
 */
describe('Notifications — interrupted delivery (e2e)', () => {
  let context: TestContext;
  let author: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let standard: PublishedStandard;
  let deliveryId: string;
  let sendJobId: string;

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

    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    // Fan out only, so the email job is still waiting and this suite can
    // decide for itself what happens to it.
    const fanouts = await context.adminDb.processingJob.findMany({
      where: { jobType: ProcessingJobType.NOTIFICATION_FANOUT },
    });
    for (const job of fanouts) await context.worker.processJobId(job.id);

    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'UNDER_REVIEW',
    });
    const more = await context.adminDb.processingJob.findMany({
      where: { jobType: ProcessingJobType.NOTIFICATION_FANOUT, status: { not: 'SUCCEEDED' } },
    });
    for (const job of more) await context.worker.processJobId(job.id);

    const notification = await context.adminDb.userNotification.findFirstOrThrow({
      where: { recipientUserId: author.userId, notificationType: 'SUBMISSION_UNDER_REVIEW' },
    });
    const delivery = await context.adminDb.notificationDelivery.findFirstOrThrow({
      where: { notificationId: notification.id, channel: 'EMAIL' },
    });
    deliveryId = delivery.id;

    const job = await context.adminDb.processingJob.findFirstOrThrow({
      where: {
        jobType: ProcessingJobType.NOTIFICATION_EMAIL_SEND,
        resourceId: deliveryId,
      },
    });
    sendJobId = job.id;
  });

  /**
   * Stop the worker where a crash would stop it: the attempt row is written
   * and the delivery says SENDING, and nothing else has happened.
   */
  async function simulateCrashMidSend(): Promise<void> {
    // Every timestamp here comes from the injected clock, because the queue's
    // reaper reads that clock too. Real wall-clock values would sit in the
    // future relative to it and the lease would look perfectly healthy.
    const now = context.clock.now();
    await context.adminDb.notificationDeliveryAttempt.create({
      data: {
        id: randomUUID(),
        deliveryId,
        attemptNumber: 1,
        startedAt: now,
      },
    });
    await context.adminDb.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: 'SENDING', attemptCount: 1, provider: 'fake' },
    });
    // And the job it was running under, whose lease its worker no longer
    // renews.
    await context.adminDb.processingJob.update({
      where: { id: sendJobId },
      data: {
        status: 'RUNNING',
        startedAt: now,
        leaseExpiresAt: new Date(now.getTime() - 60_000),
        workerId: 'worker-that-died',
      },
    });
  }

  it('A — a crash before the provider call retries and delivers', async () => {
    await simulateCrashMidSend();

    // The lease lapsed, so the queue's own reaper returns the job to the
    // outbox. This is the existing ownership signal, not a new timer.
    const reaped = await context.jobs.reapAbandoned();
    expect(reaped.requeued).toBe(1);

    await drain(context);

    const delivery = await context.adminDb.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(delivery.status).toBe('DELIVERED');
    expect(context.emailProvider.lastTo(author.email)).toBeDefined();

    // The interrupted attempt is closed honestly rather than left open or
    // relabelled as something the relay did.
    const attempts = await context.adminDb.notificationDeliveryAttempt.findMany({
      where: { deliveryId },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect([attempts[0]?.outcome, attempts[0]?.errorCode]).toEqual([
      'FAILED_RETRYABLE',
      'WORKER_INTERRUPTED',
    ]);
    expect(attempts[0]?.finishedAt).not.toBeNull();
    expect(attempts[attempts.length - 1]?.outcome).toBe('SUCCEEDED');
  });

  it('B — a crash after the provider accepted settles, at-least-once', async () => {
    // The provider took the message and the process died before the row said
    // so. PalCert cannot know it was accepted, so it asks again: the reader
    // may receive two copies. That is the limitation this phase accepts, and
    // the alternative — dropping it — is the failure it exists to prevent.
    context.emailProvider.mode = 'accept';
    await context.emailProvider.send({
      to: author.email,
      subject: 'Your submission is under review',
      text: 'sent before the crash',
      html: '<p>sent before the crash</p>',
      messageId: messageIdFor(deliveryId),
    });
    await simulateCrashMidSend();

    await context.jobs.reapAbandoned();
    await drain(context);

    const delivery = await context.adminDb.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    // Settled, and never left SENDING.
    expect(delivery.status).toBe('DELIVERED');

    const sent = context.emailProvider.all().filter((message) => message.to === author.email);
    expect(sent.length).toBe(2);
    // Both transmissions carry one logical identity, which is the whole point
    // of the stable Message-ID: a relay or a client is at least able to see
    // that these are the same PalCert email twice.
    expect(new Set(sent.map((message) => message.messageId)).size).toBe(1);
  });

  it('C — a crash before the SENDING transition is ordinary job recovery', async () => {
    // Nothing was written at all: no attempt, no status change. The delivery
    // is still PENDING and the job's lease has lapsed.
    const now = context.clock.now();
    await context.adminDb.processingJob.update({
      where: { id: sendJobId },
      data: {
        status: 'RUNNING',
        startedAt: now,
        leaseExpiresAt: new Date(now.getTime() - 60_000),
        workerId: 'worker-that-died',
      },
    });

    await context.jobs.reapAbandoned();
    await drain(context);

    const delivery = await context.adminDb.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(delivery.status).toBe('DELIVERED');
    // One attempt, because there was never an interrupted one to close.
    expect(await context.adminDb.notificationDeliveryAttempt.count({ where: { deliveryId } })).toBe(
      1,
    );
  });

  it('D — a live SENDING attempt is not picked up by a second worker', async () => {
    await simulateCrashMidSend();
    // This time the lease is *not* expired: the first worker is still alive.
    await context.adminDb.processingJob.update({
      where: { id: sendJobId },
      data: { leaseExpiresAt: new Date(context.clock.now().getTime() + 300_000) },
    });

    // The queue refuses to hand the job over, which is what stops a second
    // worker reaching the recovery path at all. The ownership signal is the
    // lease, not a guess about how long SENDING has lasted.
    const reaped = await context.jobs.reapAbandoned();
    expect(reaped.requeued).toBe(0);
    expect(reaped.dead).toEqual([]);

    await context.worker.processJobId(sendJobId);

    const delivery = await context.adminDb.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(delivery.status).toBe('SENDING');
    expect(delivery.attemptCount).toBe(1);
    expect(context.emailProvider.all()).toHaveLength(0);
    // And the open attempt is left open, because it is somebody else's.
    const attempts = await context.adminDb.notificationDeliveryAttempt.findMany({
      where: { deliveryId },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBeNull();
  });

  it('never leaves a delivery permanently SENDING', async () => {
    await simulateCrashMidSend();

    // Even when the queue's own attempt budget is spent, the delivery is
    // handed to the email ladder rather than left in a state no sweep sees.
    await context.adminDb.processingJob.update({
      where: { id: sendJobId },
      data: { attemptCount: 99, maxAttempts: 100 },
    });
    // The *worker's* dispatcher, not the API's. Only the worker process
    // registers a dead-job handler — the API reaps abandoned jobs but has no
    // business failing the resources behind them — so sweeping the API's
    // dispatcher would reap the job and leave the delivery untouched.
    const swept = await context.workerApp.get(OutboxDispatcher).sweep();
    expect(swept.dead).toBe(1);

    const delivery = await context.adminDb.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(delivery.status).not.toBe('SENDING');
    expect([delivery.status, delivery.lastErrorCode]).toEqual([
      'FAILED_RETRYABLE',
      'WORKER_INTERRUPTED',
    ]);
    expect(delivery.nextAttemptAt).not.toBeNull();

    // And the sweeper revives it when that time arrives.
    await context.adminDb.notificationDelivery.update({
      where: { id: deliveryId },
      data: { nextAttemptAt: new Date(context.clock.now().getTime() - 1000) },
    });
    expect(await context.notificationSweeper.sweep()).toBe(1);
    await drain(context);

    expect(await waitForSettled(context, deliveryId)).toBe('DELIVERED');
  });

  it('gives one logical delivery one Message-ID, on every attempt', async () => {
    context.emailProvider.mode = 'unavailable';
    await context.worker.processJobId(sendJobId).catch(() => undefined);

    context.emailProvider.mode = 'accept';
    await drain(context);

    const delivery = await context.adminDb.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(delivery.status).toBe('DELIVERED');
    // Two attempts on this delivery, and the second is the one that arrived.
    expect(delivery.attemptCount).toBeGreaterThanOrEqual(2);

    // Derived from the delivery, never from the attempt number, with a domain
    // from the deployment's own configured sender rather than from event or
    // user data.
    const mine = context.emailProvider
      .all()
      .filter((message) => message.messageId === messageIdFor(deliveryId));
    expect(mine).toHaveLength(1);

    // Other deliveries produced by the same fixtures carry their own identity,
    // so the id distinguishes logical emails rather than labelling them all
    // the same.
    const ids = new Set(context.emailProvider.all().map((message) => message.messageId));
    expect(ids.size).toBe(context.emailProvider.all().length);
    for (const id of ids) expect(id).toMatch(/^<notification-delivery-[0-9a-f-]+@palcert\.test>$/);
  });
});
