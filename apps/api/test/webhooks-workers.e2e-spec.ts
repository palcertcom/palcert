import { randomUUID } from 'node:crypto';

import {
  buildWebhookTestBody,
  canonicalWebhookBody,
  ProcessingJobStatus,
  ProcessingJobType,
  sha256Hex,
  webhookBodyHash,
  WebhookDeliveryStatus,
} from '@palcert/contracts';

import { WebhookDeliverySweeper } from '../src/modules/webhooks/services/webhook-delivery-sweeper.service';
import { WebhookFanoutReconciler } from '../src/modules/webhooks/services/webhook-fanout-reconciler.service';
import { WebhookCryptoService } from '../src/modules/webhooks/services/webhook-crypto.service';
import { WebhookDeliveryService } from '../src/modules/webhooks/services/webhook-delivery.service';
import { WebhookVerificationService } from '../src/modules/webhooks/services/webhook-verification.service';
import { WebhookRevealSweeper } from '../src/modules/webhooks/services/webhook-reveal-sweeper.service';
import { WebhookJobHandler } from '../src/worker/webhook-job.handler';
import {
  TenantPrismaService,
  type TenantClient,
} from '../src/infrastructure/tenant/tenant-prisma.service';
import { createTenant, createUser, type TenantFixture } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * The webhook workers: what runs, what retries, and what survives a crash.
 *
 * The suite is deliberately about the *seams* rather than about sending — the
 * SSRF guard refuses every address a sandbox can host, which is correct and
 * means a real socket cannot be part of an e2e run here. So the network edge is
 * covered by the unit suites around `SafeWebhookHttpClient`, and this covers
 * everything on either side of it: scheduling, idempotence, state machines and
 * recovery.
 */
describe('Webhooks — workers, reconciler and retries (e2e)', () => {
  let context: TestContext;
  let tenant: TenantPrismaService;
  let university: TenantFixture;
  let actorUserId: string;
  let endpointId: string;
  let configId: string;

  const reconciler = () => context.workerApp.get(WebhookFanoutReconciler);
  const deliverySweeper = () => context.workerApp.get(WebhookDeliverySweeper);
  const revealSweeper = () => context.workerApp.get(WebhookRevealSweeper);
  const handler = () => context.workerApp.get(WebhookJobHandler);
  const deliveryService = () => context.workerApp.get(WebhookDeliveryService);
  const verificationService = () => context.workerApp.get(WebhookVerificationService);

  async function asTenant<T>(fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    return tenant.withTenant(
      { organizationId: university.organizationId, userId: actorUserId },
      fn,
    );
  }

  /** An ACTIVE endpoint with a verified configuration, built the real way. */
  async function activeEndpoint(): Promise<void> {
    endpointId = randomUUID();
    await context.adminDb.$executeRawUnsafe(
      `INSERT INTO "webhook_endpoints"
         ("id","organization_id","description","status","slot","created_by_user_id","updated_at")
       VALUES ($1::uuid,$2::uuid,'primary','PENDING_VERIFICATION',1,$3::uuid,now())`,
      endpointId,
      university.organizationId,
      actorUserId,
    );

    // Sealed for real, under the process's own active key. Fake ciphertext
    // would fail to open, and a key this process does not hold is now an
    // infrastructure fault rather than a configuration one — so a fixture that
    // could not be decrypted would have every delivery throwing at the wrong
    // seam instead of reaching the one under test.
    configId = randomUUID();
    const crypto = context.workerApp.get(WebhookCryptoService);
    const url = 'https://receiver.example/hooks/palcert';
    const secret = crypto.newSigningSecret();
    const sealedUrl = crypto.sealUrl(url, endpointId, configId);
    const sealedSecret = crypto.sealSigningSecret(secret, endpointId, configId);
    await asTenant(async (tx) =>
      tx.$executeRawUnsafe(
        `SELECT app_webhook_config_create(
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7,'receiver.example',443,
           $8, $9, $10, $11, $12)`,
        configId,
        endpointId,
        sealedUrl.ciphertext,
        sealedUrl.iv,
        sealedUrl.authTag,
        sealedUrl.kid,
        sha256Hex(url),
        sealedSecret.ciphertext,
        sealedSecret.iv,
        sealedSecret.authTag,
        sealedSecret.kid,
        crypto.fingerprint(secret),
      ),
    );

    const [operation] = await asTenant(async (tx) =>
      tx.$queryRawUnsafe<Array<{ app_webhook_management_operation_create: string }>>(
        `SELECT app_webhook_management_operation_create(
           gen_random_uuid(),'VERIFY_CONFIG',$1,$2,$3::uuid,$4::uuid,NULL,NULL,NULL,NULL,NULL,NULL)`,
        'd'.repeat(64),
        'e'.repeat(64),
        endpointId,
        configId,
      ),
    );
    const operationId = operation!.app_webhook_management_operation_create;

    const [attempt] = await context.prisma.$queryRawUnsafe<
      Array<{ app_webhook_verification_attempt_open: string }>
    >(
      `SELECT app_webhook_verification_attempt_open($1::uuid,$2::uuid, now())`,
      operationId,
      configId,
    );
    const attemptId = attempt!.app_webhook_verification_attempt_open;
    await context.prisma.$executeRawUnsafe(
      `SELECT app_webhook_verification_attempt_close($1::uuid,'SUCCEEDED',NULL,200,20)`,
      attemptId,
    );
    await context.prisma.$executeRawUnsafe(
      `SELECT app_webhook_config_activate($1::uuid)`,
      attemptId,
    );
  }

  async function subscribe(eventType = 'submission.approved'): Promise<void> {
    await asTenant(async (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "webhook_subscriptions"("id","endpoint_id","organization_id","event_type")
         VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3::"WebhookEventType")
         ON CONFLICT DO NOTHING`,
        endpointId,
        university.organizationId,
        eventType,
      ),
    );
  }

  /** A committed, webhook-eligible DomainEvent, written the way a producer does. */
  async function eligibleEvent(eligible = true, ageMinutes = 0): Promise<string> {
    const id = randomUUID();
    await context.adminDb.$executeRawUnsafe(
      `INSERT INTO "domain_events"
         ("id","event_type","event_schema_version","source_type","source_id",
          "aggregate_type","aggregate_id","owner_user_id","organization_id",
          "occurred_at","payload","webhook_eligible","created_at")
       VALUES ($1::uuid,'SUBMISSION_APPROVED',1,'SUBMISSION_DECISION_EVENT',gen_random_uuid(),
               'OFFICIAL_SUBMISSION',gen_random_uuid(),$2::uuid,$3::uuid,now(),
               $4::jsonb,$5::boolean,$6::timestamptz)`,
      id,
      actorUserId,
      university.organizationId,
      JSON.stringify({
        submissionId: randomUUID(),
        submissionRevisionId: randomUUID(),
        institutionDecisionStatus: 'APPROVED',
      }),
      eligible,
      new Date(context.clock.now().getTime() - ageMinutes * 60_000),
    );
    return id;
  }

  /** Finish a job the way a worker does: claim, start, succeed. */
  async function finishJob(jobId: string): Promise<void> {
    await context.jobs.claimDue(10, jobId);
    await context.jobs.start(jobId, 'test-worker');
    await context.jobs.succeed(jobId);
  }

  /**
   * Begin a real attempt the only way there is one.
   *
   * Moving the delivery to SENDING and opening its attempt used to be two
   * calls, and the fixtures made the same two calls the service did. They are
   * one doorway now, which is the point: there is no second way to start.
   */
  async function beginAttempt(
    deliveryId: string,
    startedAt: Date = context.clock.now(),
  ): Promise<{ attemptId: string; attemptNumber: number }> {
    const [row] = await context.prisma.$queryRawUnsafe<
      Array<{ attempt_id: string; attempt_number: number }>
    >(
      `SELECT * FROM app_webhook_delivery_attempt_begin($1::uuid, $2::timestamptz)`,
      deliveryId,
      startedAt,
    );
    return { attemptId: row!.attempt_id, attemptNumber: row!.attempt_number };
  }

  /** When the delivery says it is next owed an attempt. */
  async function dueAt(deliveryId: string): Promise<Date> {
    const [row] = await context.adminDb.$queryRawUnsafe<Array<{ next_attempt_at: Date }>>(
      `SELECT "next_attempt_at" FROM "webhook_deliveries" WHERE "id" = $1::uuid`,
      deliveryId,
    );
    return row!.next_attempt_at;
  }

  /** The one open attempt a mid-flight delivery has. */
  /**
   * A TEST delivery whose stored body hash is the real one.
   *
   * A fixture hash would be refused before any network — correctly, since a
   * delivery whose stored hash does not describe its own body is a row that no
   * longer describes itself — and the test would never reach the seam it is
   * about.
   */
  async function deliverableTestDelivery(): Promise<string> {
    const occurredAt = context.clock.now();
    const body = canonicalWebhookBody(buildWebhookTestBody(occurredAt));
    const [row] = await asTenant(async (tx) =>
      tx.$queryRawUnsafe<Array<{ app_webhook_delivery_create_test: string }>>(
        `SELECT app_webhook_delivery_create_test($1::uuid, $2::timestamptz, $3)`,
        endpointId,
        occurredAt,
        webhookBodyHash(body),
      ),
    );
    return row!.app_webhook_delivery_create_test;
  }

  /**
   * A delivery that made one real attempt and was told to wait.
   *
   * Written the only way a receiver's answer can be written: the attempt and
   * the delivery move together, so the fixture cannot set up a state the
   * service could never produce.
   */
  async function answeredWith503(deliveryId: string, dueInMs: number): Promise<void> {
    const { attemptId } = await beginAttempt(deliveryId);
    await context.prisma.$executeRawUnsafe(
      `SELECT app_webhook_delivery_attempt_finish(
         $1::uuid,'FAILED_RETRYABLE','HTTP_RETRYABLE',503,7,'FAILED_RETRYABLE',$2::timestamptz)`,
      attemptId,
      new Date(context.clock.now().getTime() + dueInMs),
    );
  }

  async function openAttemptIdOf(deliveryId: string): Promise<string> {
    const [row] = await context.adminDb.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "webhook_delivery_attempts"
        WHERE "delivery_id" = $1::uuid AND "outcome" IS NULL`,
      deliveryId,
    );
    return row!.id;
  }

  async function attemptCount(deliveryId: string): Promise<number> {
    const [row] = await context.adminDb.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM "webhook_delivery_attempts" WHERE "delivery_id" = $1::uuid`,
      deliveryId,
    );
    return Number(row!.count);
  }

  async function fanoutJobsFor(domainEventId: string) {
    return context.adminDb.processingJob.findMany({
      where: { jobType: ProcessingJobType.WEBHOOK_FANOUT, resourceId: domainEventId },
    });
  }

  async function deliveriesFor(eventId: string) {
    return context.adminDb.$queryRawUnsafe<Array<{ id: string; status: string; kind: string }>>(
      `SELECT "id","status","kind" FROM "webhook_deliveries" WHERE "webhook_event_id" = $1::uuid`,
      eventId,
    );
  }

  beforeAll(async () => {
    context = await createTestContext();
    tenant = context.app.get(TenantPrismaService);
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    const owner = await createUser(context, 'integration-owner@example.com');
    actorUserId = owner.userId;
    university = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
    await activeEndpoint();
  });

  describe('fan-out', () => {
    it('projects an eligible event and creates one delivery per subscribed endpoint', async () => {
      await subscribe();
      const domainEventId = await eligibleEvent();

      await handler().fanOut({ resourceId: domainEventId } as never);

      const [event] = await context.adminDb.$queryRawUnsafe<Array<{ id: string; data: unknown }>>(
        `SELECT "id","data" FROM "webhook_events" WHERE "domain_event_id" = $1::uuid`,
        domainEventId,
      );
      expect(event).toBeDefined();
      // Derived by the database from the DomainEvent's payload, through the
      // same allowlist the contracts package enforces.
      expect(event!.data).toEqual({
        submissionId: expect.any(String),
        submissionRevisionId: expect.any(String),
        institutionDecisionStatus: 'APPROVED',
      });

      const deliveries = await deliveriesFor(event!.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.kind).toBe('ORIGINAL');
    });

    it('is idempotent when the job is redelivered', async () => {
      await subscribe();
      const domainEventId = await eligibleEvent();

      await handler().fanOut({ resourceId: domainEventId } as never);
      await handler().fanOut({ resourceId: domainEventId } as never);
      await handler().fanOut({ resourceId: domainEventId } as never);

      const events = await context.adminDb.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "webhook_events" WHERE "domain_event_id" = $1::uuid`,
        domainEventId,
      );
      expect(events).toHaveLength(1);
      expect(await deliveriesFor(events[0]!.id)).toHaveLength(1);
    });

    it('creates nothing for an endpoint that is not subscribed', async () => {
      const domainEventId = await eligibleEvent();
      await handler().fanOut({ resourceId: domainEventId } as never);

      const [event] = await context.adminDb.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "webhook_events" WHERE "domain_event_id" = $1::uuid`,
        domainEventId,
      );
      // The projection still exists — it is a fact about the organization —
      // but nobody asked to hear about it.
      expect(event).toBeDefined();
      expect(await deliveriesFor(event!.id)).toHaveLength(0);
    });

    it('refuses to project a historical, ineligible event', async () => {
      await subscribe();
      const domainEventId = await eligibleEvent(false);

      await handler().fanOut({ resourceId: domainEventId } as never);

      const events = await context.adminDb.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "webhook_events" WHERE "domain_event_id" = $1::uuid`,
        domainEventId,
      );
      expect(events).toHaveLength(0);
    });
  });

  describe('the fan-out reconciler', () => {
    it('creates exactly one missing job, however often it runs', async () => {
      // The mixed-version case: a Phase 16 process wrote an eligible event and
      // no fan-out job, because its code had never heard of that job type.
      // Older than the grace period, so the reconciler is not racing a producer
      // whose transaction is still open.
      const domainEventId = await eligibleEvent(true, 10);
      expect(await fanoutJobsFor(domainEventId)).toHaveLength(0);

      expect(await reconciler().reconcile()).toBe(1);
      expect(await fanoutJobsFor(domainEventId)).toHaveLength(1);

      expect(await reconciler().reconcile()).toBe(0);
      expect(await reconciler().reconcile()).toBe(0);
      expect(await fanoutJobsFor(domainEventId)).toHaveLength(1);
    });

    it('never touches a historical event', async () => {
      const domainEventId = await eligibleEvent(false, 60 * 24 * 365);

      await reconciler().reconcile();
      expect(await fanoutJobsFor(domainEventId)).toHaveLength(0);
    });

    it('leaves a fresh event to its producer', async () => {
      // Written just now: the producer's transaction may still be open, and
      // adopting it would race a job that is about to exist.
      await eligibleEvent();
      expect(await reconciler().reconcile()).toBe(0);
    });

    it('revives a fan-out job that died, rather than losing the event', async () => {
      const domainEventId = await eligibleEvent(true, 10);
      // Enqueued the way the producer does, but never dispatched: the queue
      // never sees it, so the live worker in this context cannot settle it out
      // from under the test and the job's whole life belongs here.
      const job = await context.prisma.$transaction((tx) =>
        context.jobs.enqueueInTransaction(tx, {
          type: ProcessingJobType.WEBHOOK_FANOUT,
          resourceType: 'DOMAIN_EVENT',
          resourceId: domainEventId,
        }),
      );
      // Exhaust it the way the queue does, rather than writing DEAD directly:
      // the job state machine is a database guard and refuses a jump.
      await context.jobs.claimDue(10, job!.id);
      await context.jobs.start(job!.id, 'test-worker');
      let result: string = 'retry';
      while (result !== 'dead') {
        result = await context.jobs.failTransient(job!.id, {
          code: 'WORKER_ERROR',
          message: 'interrupted',
        });
        if (result !== 'dead') {
          await context.jobs.claimDue(10, job!.id);
          await context.jobs.start(job!.id, 'test-worker');
        }
      }

      expect(await reconciler().reconcile()).toBe(1);
      const jobs = await fanoutJobsFor(domainEventId);
      // One job for the event's whole life: revived, not duplicated.
      expect(jobs).toHaveLength(1);
      // Alive again. The exact status is not asserted: the reconciler dispatches
      // what it revives, so a live worker may have claimed it already — but
      // nothing clears `deadAt` except the revival itself.
      expect(jobs[0]!.status).not.toBe(ProcessingJobStatus.DEAD);
      expect(jobs[0]!.deadAt).toBeNull();
    });
  });

  describe('the retry ladders stay separate', () => {
    /**
     * A delivery with no job of its own yet.
     *
     * Created through the TEST doorway rather than by fan-out, because fan-out
     * enqueues a job immediately and the live worker in this context would
     * claim it and settle the delivery before the test has set the state it
     * means to assert on. Here the test owns the job's whole life.
     */
    async function pendingDelivery(): Promise<string> {
      const [row] = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<{ app_webhook_delivery_create_test: string }>>(
          `SELECT app_webhook_delivery_create_test($1::uuid, $2::timestamptz, $3)`,
          endpointId,
          context.clock.now(),
          'c'.repeat(64),
        ),
      );
      return row!.app_webhook_delivery_create_test;
    }

    it('does not re-arm a delivery before its business retry time', async () => {
      const deliveryId = await pendingDelivery();

      await answeredWith503(deliveryId, 5 * 60_000);

      // This is the property the whole design turns on: a 503 leaves the job
      // finished and the delivery waiting. Nothing is owed an attempt yet.
      expect(await deliverySweeper().sweep()).toBe(0);
    });

    it('re-arms the one job when the business retry time arrives', async () => {
      const deliveryId = await pendingDelivery();

      // The job a delivery gets when it is first scheduled, then finished by a
      // worker: the attempt ran and the answer was recorded, which is what that
      // job is for.
      const before = await context.prisma.$transaction((tx) =>
        context.jobs.enqueueInTransaction(tx, {
          type: ProcessingJobType.WEBHOOK_DELIVER,
          resourceType: 'WEBHOOK_DELIVERY',
          resourceId: deliveryId,
        }),
      );
      await finishJob(before.id);

      await answeredWith503(deliveryId, -60_000);

      expect(await deliverySweeper().sweep()).toBe(1);

      const after = await context.adminDb.processingJob.findMany({
        where: { jobType: ProcessingJobType.WEBHOOK_DELIVER, resourceId: deliveryId },
      });
      // Re-armed rather than duplicated: one job per delivery for its whole
      // life, so the idempotency key keeps meaning what it says. The status is
      // asserted in the test below instead, where nothing is dispatched and a
      // live worker cannot move it.
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(before.id);
    });

    it('moves the finished job itself back to PENDING, keeping its identity', async () => {
      const deliveryId = await pendingDelivery();
      const before = await context.prisma.$transaction((tx) =>
        context.jobs.enqueueInTransaction(tx, {
          type: ProcessingJobType.WEBHOOK_DELIVER,
          resourceType: 'WEBHOOK_DELIVERY',
          resourceId: deliveryId,
        }),
      );
      await finishJob(before.id);
      const finished = await context.adminDb.processingJob.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(finished.status).toBe(ProcessingJobStatus.SUCCEEDED);
      expect(finished.completedAt).not.toBeNull();

      // The business-retry doorway, called directly and never dispatched, so
      // what it writes is what the test reads. `enqueueInTransaction` would
      // have returned this job untouched — that is the whole reason the second
      // doorway exists, and the database guard has one edge for it.
      const rearmed = await context.prisma.$transaction((tx) =>
        context.jobs.rearmForBusinessRetry(tx, {
          type: ProcessingJobType.WEBHOOK_DELIVER,
          resourceType: 'WEBHOOK_DELIVERY',
          resourceId: deliveryId,
        }),
      );

      expect(rearmed.id).toBe(before.id);
      expect(rearmed.status).toBe(ProcessingJobStatus.PENDING);
      expect(rearmed.completedAt).toBeNull();
      expect(rearmed.deadAt).toBeNull();
      expect(rearmed.leaseExpiresAt).toBeNull();
      expect(rearmed.workerId).toBeNull();
    });

    it('does not re-arm a delivery that is already owed an attempt', async () => {
      const deliveryId = await pendingDelivery();
      await answeredWith503(deliveryId, -60_000);

      await context.prisma.$transaction((tx) =>
        context.jobs.enqueueInTransaction(tx, {
          type: ProcessingJobType.WEBHOOK_DELIVER,
          resourceType: 'WEBHOOK_DELIVERY',
          resourceId: deliveryId,
        }),
      );

      // That job is still PENDING, so the sweep must not stack a second
      // attempt on top of the one already waiting.
      await deliverySweeper().sweep();
      const jobs = await context.adminDb.processingJob.findMany({
        where: { jobType: ProcessingJobType.WEBHOOK_DELIVER, resourceId: deliveryId },
      });
      expect(jobs).toHaveLength(1);
    });

    it('never re-arms a settled delivery', async () => {
      const deliveryId = await pendingDelivery();
      const { attemptId } = await beginAttempt(deliveryId);
      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_delivery_attempt_finish(
           $1::uuid,'SUCCEEDED',NULL,200,5,'DELIVERED',NULL)`,
        attemptId,
      );
      expect(await deliverySweeper().sweep()).toBe(0);
    });
  });

  describe('an early queue redelivery', () => {
    /**
     * The mandatory chain, end to end against the real database.
     *
     * A 503 was recorded with a business time five minutes out, and then the
     * process died before the job could succeed. The queue redelivers within
     * seconds. What must happen — and what the delivery service is asked to do
     * here directly, as the worker would — is nothing at all until that time
     * arrives, and then exactly one re-arm.
     *
     * The request count itself is asserted in the delivery service's unit
     * suite, where the HTTP client is a stub: no socket can be opened in an e2e
     * run, because the SSRF guard refuses every address a sandbox can host.
     */
    it('waits for the business time instead of attempting again', async () => {
      await subscribe();
      const domainEventId = await eligibleEvent();
      await handler().fanOut({ resourceId: domainEventId } as never);
      const [event] = await context.adminDb.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "webhook_events" WHERE "domain_event_id" = $1::uuid`,
        domainEventId,
      );
      const deliveryId = (await deliveriesFor(event!.id))[0]!.id;

      // The attempt that already ran, and the receiver asking for five minutes.
      const due = new Date(context.clock.now().getTime() + 5 * 60_000);
      await answeredWith503(deliveryId, 5 * 60_000);
      const attemptsBefore = await attemptCount(deliveryId);

      const outcome = await deliveryService().attempt(deliveryId);

      expect(outcome.kind).toBe('WAITING');
      // No attempt opened, and nothing about the delivery changed.
      expect(await attemptCount(deliveryId)).toBe(attemptsBefore);
      const [row] = await context.adminDb.$queryRawUnsafe<
        Array<{ status: string; next_attempt_at: Date; attempt_count: number }>
      >(
        `SELECT "status","next_attempt_at","attempt_count" FROM "webhook_deliveries"
          WHERE "id" = $1::uuid`,
        deliveryId,
      );
      expect(row!.status).toBe(WebhookDeliveryStatus.FAILED_RETRYABLE);
      expect(row!.next_attempt_at.toISOString()).toBe(due.toISOString());
      expect(row!.attempt_count).toBe(1);

      // And the sweeper agrees: nothing is owed yet.
      expect(await deliverySweeper().sweep()).toBe(0);
    });

    it('cannot leave a retryable delivery without a time to wait for', async () => {
      // The row the early-redelivery check would otherwise have to guess about
      // simply cannot exist, and the schema owner cannot make one either.
      const [row] = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<{ app_webhook_delivery_create_test: string }>>(
          `SELECT app_webhook_delivery_create_test($1::uuid, $2::timestamptz, $3)`,
          endpointId,
          context.clock.now(),
          'f'.repeat(64),
        ),
      );
      const deliveryId = row!.app_webhook_delivery_create_test;
      await answeredWith503(deliveryId, 60_000);

      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE "webhook_deliveries" SET "next_attempt_at" = NULL WHERE "id" = $1::uuid`,
          deliveryId,
        ),
      ).rejects.toThrow(/webhook_deliveries_retryable_has_next_attempt/);
    });
  });

  describe('crash recovery', () => {
    /**
     * A delivery mid-attempt, owned entirely by the test.
     *
     * A TEST delivery rather than a fan-out one, because the live worker in
     * this context would claim a fan-out delivery's job and begin its own
     * attempt before the test could set the state it means to assert on.
     */
    async function sendingDelivery(): Promise<string> {
      const deliveryId = await deliverableTestDelivery();
      await beginAttempt(deliveryId);
      return deliveryId;
    }

    /** A delivery that has not begun an attempt: nothing counted, nothing sent. */
    const untouchedDelivery = deliverableTestDelivery;

    it('closes an attempt a dead worker left open, and keeps the delivery alive', async () => {
      const deliveryId = await sendingDelivery();
      const attemptId = await openAttemptIdOf(deliveryId);

      // The worker died here: SENDING, one attempt open, outcome unknown.
      await handler().failExhaustedDelivery({ resourceId: deliveryId } as never);

      const [attempt] = await context.adminDb.$queryRawUnsafe<
        Array<{ outcome: string; error_code: string }>
      >(
        `SELECT "outcome","error_code" FROM "webhook_delivery_attempts" WHERE "id" = $1::uuid`,
        attemptId,
      );
      expect(attempt!.outcome).toBe('FAILED_RETRYABLE');
      expect(attempt!.error_code).toBe('WORKER_INTERRUPTED');

      const [delivery] = await context.adminDb.$queryRawUnsafe<
        Array<{ status: string; next_attempt_at: Date | null }>
      >(
        `SELECT "status","next_attempt_at" FROM "webhook_deliveries" WHERE "id" = $1::uuid`,
        deliveryId,
      );
      // Retryable, not permanently failed: PalCert was interrupted, and a
      // PalCert outage must not cancel an organization's webhook.
      expect(delivery!.status).toBe(WebhookDeliveryStatus.FAILED_RETRYABLE);
      expect(delivery!.next_attempt_at).not.toBeNull();
    });

    it('leaves no delivery stuck in SENDING after a dead job', async () => {
      const deliveryId = await sendingDelivery();
      await handler().failExhaustedDelivery({ resourceId: deliveryId } as never);

      const [row] = await context.adminDb.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT "status" FROM "webhook_deliveries" WHERE "id" = $1::uuid`,
        deliveryId,
      );
      expect(row!.status).not.toBe('SENDING');
    });

    it('costs nothing when the crash happened before the attempt began', async () => {
      // This used to be the expensive window. The delivery had already been
      // moved to SENDING with its counter incremented, and no attempt row
      // existed — so the recovery spent a second rung putting that right. Now
      // the begin is one write, so a crash before it commits leaves the
      // delivery exactly as it was.
      const deliveryId = await untouchedDelivery();

      await handler().failExhaustedDelivery({ resourceId: deliveryId } as never);

      const [row] = await context.adminDb.$queryRawUnsafe<
        Array<{ status: string; attempt_count: number }>
      >(
        `SELECT "status","attempt_count" FROM "webhook_deliveries" WHERE "id" = $1::uuid`,
        deliveryId,
      );
      // Retryable so the sweeper picks it up, and not one rung spent.
      expect(row!.status).toBe(WebhookDeliveryStatus.FAILED_RETRYABLE);
      expect(row!.attempt_count).toBe(0);
      expect(await attemptCount(deliveryId)).toBe(0);
    });

    it('recovers on the first reclaim, without waiting for the queue to give up', async () => {
      // The correction this test exists for: recovery used to wait until the
      // job had spent its whole attempt budget and gone DEAD. A reclaimed job
      // owns the lease, so the worker that left this delivery SENDING is
      // already gone — there is nothing to wait for.
      const deliveryId = await sendingDelivery();
      const interrupted = await openAttemptIdOf(deliveryId);

      // One ordinary run of the delivery service, exactly as a reclaimed job
      // would drive it. Whatever the network then does is beside the point.
      await deliveryService().attempt(deliveryId);

      const [attempt] = await context.adminDb.$queryRawUnsafe<
        Array<{ outcome: string; error_code: string }>
      >(
        `SELECT "outcome","error_code" FROM "webhook_delivery_attempts" WHERE "id" = $1::uuid`,
        interrupted,
      );
      expect(attempt!.outcome).toBe('FAILED_RETRYABLE');
      expect(attempt!.error_code).toBe('WORKER_INTERRUPTED');

      // And it did not stop there: the same run went on to make a new attempt.
      expect(await attemptCount(deliveryId)).toBe(2);

      const [delivery] = await context.adminDb.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT "status" FROM "webhook_deliveries" WHERE "id" = $1::uuid`,
        deliveryId,
      );
      expect(delivery!.status).not.toBe(WebhookDeliveryStatus.SENDING);
    });

    it('does not resurrect a delivery that already settled', async () => {
      const deliveryId = await sendingDelivery();
      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_delivery_attempt_finish(
           $1::uuid,'SUCCEEDED',NULL,200,5,'DELIVERED',NULL)`,
        await openAttemptIdOf(deliveryId),
      );

      await handler().failExhaustedDelivery({ resourceId: deliveryId } as never);

      const [delivery] = await context.adminDb.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT "status" FROM "webhook_deliveries" WHERE "id" = $1::uuid`,
        deliveryId,
      );
      expect(delivery!.status).toBe(WebhookDeliveryStatus.DELIVERED);
    });
  });

  describe('beginning an attempt is one write', () => {
    /**
     * The invariant this whole doorway exists for.
     *
     * `attempt_count` indexes the business retry ladder, so a number that can
     * move without an attempt having happened is a ladder that PalCert's own
     * crashes can climb. After every committed begin the counter and the rows
     * agree, because one statement pair writes both.
     */
    async function expectCounterMatchesRows(deliveryId: string): Promise<number> {
      const [row] = await context.adminDb.$queryRawUnsafe<
        Array<{ attempt_count: number; rows: bigint }>
      >(
        `SELECT d."attempt_count",
                (SELECT count(*) FROM "webhook_delivery_attempts" a
                  WHERE a."delivery_id" = d."id") AS rows
           FROM "webhook_deliveries" d WHERE d."id" = $1::uuid`,
        deliveryId,
      );
      expect(row!.attempt_count).toBe(Number(row!.rows));
      return row!.attempt_count;
    }

    it('moves the delivery, counts the attempt and opens it together', async () => {
      const deliveryId = await deliverableTestDelivery();
      const begun = await beginAttempt(deliveryId);

      expect(begun.attemptNumber).toBe(1);
      const [row] = await context.adminDb.$queryRawUnsafe<
        Array<{ status: string; attempt_count: number; next_attempt_at: Date | null }>
      >(
        `SELECT "status","attempt_count","next_attempt_at" FROM "webhook_deliveries"
          WHERE "id" = $1::uuid`,
        deliveryId,
      );
      expect(row!.status).toBe(WebhookDeliveryStatus.SENDING);
      expect(row!.next_attempt_at).toBeNull();
      expect(await expectCounterMatchesRows(deliveryId)).toBe(1);
    });

    it('increments exactly once per attempt across the ladder', async () => {
      const deliveryId = await deliverableTestDelivery();
      const first = await beginAttempt(deliveryId);
      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_delivery_attempt_finish(
           $1::uuid,'FAILED_RETRYABLE','HTTP_RETRYABLE',503,5,'FAILED_RETRYABLE',$2::timestamptz)`,
        first.attemptId,
        new Date(context.clock.now().getTime() - 1),
      );
      expect(await expectCounterMatchesRows(deliveryId)).toBe(1);

      const second = await beginAttempt(deliveryId);
      expect(second.attemptNumber).toBe(2);
      expect(await expectCounterMatchesRows(deliveryId)).toBe(2);
    });

    it('does not let repeated infrastructure crashes spend business rungs', async () => {
      // The defect, exactly. Each cycle below is a worker that claimed the job
      // and died before anything reached the wire. Under the old split start
      // each one incremented the counter, so a handful of restarts could
      // exhaust an organization's retries without a single request.
      const deliveryId = await deliverableTestDelivery();
      for (let crash = 0; crash < 4; crash += 1) {
        await handler().failExhaustedDelivery({ resourceId: deliveryId } as never);
        expect(await expectCounterMatchesRows(deliveryId)).toBe(0);
      }

      // The first attempt that actually happens is still the first.
      const begun = await beginAttempt(deliveryId, await dueAt(deliveryId));
      expect(begun.attemptNumber).toBe(1);
      expect(await expectCounterMatchesRows(deliveryId)).toBe(1);
    });

    it('takes the first business rung after a crash that never attempted', async () => {
      const deliveryId = await deliverableTestDelivery();
      await handler().failExhaustedDelivery({ resourceId: deliveryId } as never);
      await handler().failExhaustedDelivery({ resourceId: deliveryId } as never);

      const begun = await beginAttempt(deliveryId, await dueAt(deliveryId));
      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_delivery_attempt_finish(
           $1::uuid,'FAILED_RETRYABLE','HTTP_RETRYABLE',503,5,'FAILED_RETRYABLE',$2::timestamptz)`,
        begun.attemptId,
        new Date(context.clock.now().getTime() + 60_000),
      );

      const [row] = await context.adminDb.$queryRawUnsafe<Array<{ next_attempt_at: Date }>>(
        `SELECT "next_attempt_at" FROM "webhook_deliveries" WHERE "id" = $1::uuid`,
        deliveryId,
      );
      // One minute: the ladder's first rung, not its second.
      expect(row!.next_attempt_at.getTime()).toBe(context.clock.now().getTime() + 60_000);
    });

    it('will not begin before the delivery is due, and will once it is', async () => {
      // The service checks the business time before calling; the doorway now
      // checks it too, so a future worker bug cannot ask a receiver that wanted
      // twelve hours to answer again immediately.
      const deliveryId = await deliverableTestDelivery();
      await answeredWith503(deliveryId, 5 * 60_000);
      const before = await expectCounterMatchesRows(deliveryId);
      const due = await dueAt(deliveryId);

      await expect(beginAttempt(deliveryId, context.clock.now())).rejects.toThrow(
        /is not due until/,
      );
      // Nothing moved: not the status, not the counter, not the rows.
      const [row] = await context.adminDb.$queryRawUnsafe<
        Array<{ status: string; next_attempt_at: Date }>
      >(
        `SELECT "status","next_attempt_at" FROM "webhook_deliveries" WHERE "id" = $1::uuid`,
        deliveryId,
      );
      expect(row!.status).toBe(WebhookDeliveryStatus.FAILED_RETRYABLE);
      expect(row!.next_attempt_at.toISOString()).toBe(due.toISOString());
      expect(await expectCounterMatchesRows(deliveryId)).toBe(before);

      // A minute past due is due.
      const begun = await beginAttempt(deliveryId, new Date(due.getTime() + 60_000));
      expect(begun.attemptNumber).toBe(2);
      expect(await expectCounterMatchesRows(deliveryId)).toBe(before + 1);
    });

    it('has no second way to open an attempt', async () => {
      // The old standalone doorway created an attempt without touching its
      // parent, which is the shape everything above exists to prevent.
      const [row] = await context.adminDb.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM pg_proc WHERE proname = 'app_webhook_attempt_open'`,
      );
      expect(Number(row!.count)).toBe(0);
    });
  });

  describe('an attempt and its parent are one write', () => {
    async function sendingTestDelivery(): Promise<string> {
      const [row] = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<{ app_webhook_delivery_create_test: string }>>(
          `SELECT app_webhook_delivery_create_test($1::uuid, $2::timestamptz, $3)`,
          endpointId,
          context.clock.now(),
          'a'.repeat(64),
        ),
      );
      return row!.app_webhook_delivery_create_test;
    }

    /** A delivery mid-attempt. There is one way to get there, and this is it. */
    async function sendingWithAttempt(): Promise<{ deliveryId: string; attemptId: string }> {
      const deliveryId = await sendingTestDelivery();
      return { deliveryId, attemptId: (await beginAttempt(deliveryId)).attemptId };
    }

    it('records a receiver answer and its delivery together, or not at all', async () => {
      const { attemptId } = await sendingWithAttempt();

      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_delivery_attempt_finish(
           $1::uuid,'FAILED_RETRYABLE','HTTP_RETRYABLE',503,12,'FAILED_RETRYABLE',$2::timestamptz)`,
        attemptId,
        new Date(context.clock.now().getTime() + 5 * 60_000),
      );

      const [row] = await context.adminDb.$queryRawUnsafe<
        Array<{
          outcome: string;
          status: string;
          next_attempt_at: Date | null;
          last_http_status: number;
        }>
      >(
        `SELECT a."outcome", d."status", d."next_attempt_at", d."last_http_status"
           FROM "webhook_delivery_attempts" a
           JOIN "webhook_deliveries" d ON d."id" = a."delivery_id"
          WHERE a."id" = $1::uuid`,
        attemptId,
      );
      expect(row!.outcome).toBe('FAILED_RETRYABLE');
      expect(row!.status).toBe(WebhookDeliveryStatus.FAILED_RETRYABLE);
      expect(row!.next_attempt_at).not.toBeNull();
      expect(row!.last_http_status).toBe(503);
    });

    it('refuses to record a receiver answer on an attempt alone', async () => {
      // The structural half. There is no doorway that closes an attempt with a
      // status or an HTTP error code without moving its delivery, so the state
      // the reclaim logic used to misread — a finished attempt beside a SENDING
      // delivery — cannot be written at all.
      const { attemptId } = await sendingWithAttempt();

      await expect(
        context.prisma.$executeRawUnsafe(
          `SELECT app_webhook_attempt_close($1::uuid,'SUCCEEDED',NULL,200,5)`,
          attemptId,
        ),
      ).rejects.toThrow(/must finish atomically/);
      await expect(
        context.prisma.$executeRawUnsafe(
          `SELECT app_webhook_attempt_close($1::uuid,'FAILED_RETRYABLE','HTTP_RETRYABLE',503,5)`,
          attemptId,
        ),
      ).rejects.toThrow(/must finish atomically/);

      // What remains is the honest use: a worker died and somebody says so.
      await expect(
        context.prisma.$executeRawUnsafe(
          `SELECT app_webhook_attempt_close($1::uuid,'FAILED_RETRYABLE','WORKER_INTERRUPTED',NULL,5)`,
          attemptId,
        ),
      ).resolves.toBeDefined();
    });

    it('refuses an outcome pairing that would make the two rows disagree', async () => {
      const { attemptId } = await sendingWithAttempt();

      await expect(
        context.prisma.$executeRawUnsafe(
          `SELECT app_webhook_delivery_attempt_finish(
             $1::uuid,'SUCCEEDED',NULL,200,5,'FAILED_PERMANENT',NULL)`,
          attemptId,
        ),
      ).rejects.toThrow(/cannot finish as/);
      // A retryable delivery must still carry the time it waits for.
      await expect(
        context.prisma.$executeRawUnsafe(
          `SELECT app_webhook_delivery_attempt_finish(
             $1::uuid,'FAILED_RETRYABLE','HTTP_RETRYABLE',503,5,'FAILED_RETRYABLE',NULL)`,
          attemptId,
        ),
      ).rejects.toThrow(/cannot finish as/);
    });

    it('will not finish an attempt against a delivery that is no longer mid-attempt', async () => {
      const { deliveryId, attemptId } = await sendingWithAttempt();
      // The recovery path moved the delivery on while this attempt was still
      // open — the shape a crash between closing and normalizing would leave.
      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_delivery_transition(
           $1::uuid,'FAILED_RETRYABLE',NULL,'WORKER_INTERRUPTED',NULL,$2::timestamptz,false)`,
        deliveryId,
        context.clock.now(),
      );

      await expect(
        context.prisma.$executeRawUnsafe(
          `SELECT app_webhook_delivery_attempt_finish(
             $1::uuid,'SUCCEEDED',NULL,200,5,'DELIVERED',NULL)`,
          attemptId,
        ),
      ).rejects.toThrow(/is not mid-attempt/);
    });

    it('allows only one open attempt per delivery', async () => {
      const { deliveryId } = await sendingWithAttempt();
      // The delivery is mid-attempt, so the begin doorway refuses outright —
      // and even reaching the insert would meet the partial unique index.
      await expect(beginAttempt(deliveryId)).rejects.toThrow(/cannot begin an attempt/);

      await expect(
        context.adminDb.$executeRawUnsafe(
          `INSERT INTO "webhook_delivery_attempts"("id","delivery_id","attempt_number","started_at")
           VALUES (gen_random_uuid(), $1::uuid, 99, now())`,
          deliveryId,
        ),
      ).rejects.toThrow(/Key \(delivery_id\)=.* already exists/);
    });
  });

  describe('a verification job the queue gave up on', () => {
    /** A second configuration waiting to be verified, with an intent of its own. */
    async function pendingVerification(keySeed: string): Promise<{
      operationId: string;
      configVersionId: string;
    }> {
      const crypto = context.workerApp.get(WebhookCryptoService);
      const configVersionId = randomUUID();
      const url = 'https://receiver.example/hooks/second';
      const secret = crypto.newSigningSecret();
      const sealedUrl = crypto.sealUrl(url, endpointId, configVersionId);
      const sealedSecret = crypto.sealSigningSecret(secret, endpointId, configVersionId);
      await asTenant(async (tx) =>
        tx.$executeRawUnsafe(
          `SELECT app_webhook_config_create(
             $1::uuid, $2::uuid, $3, $4, $5, $6, $7,'receiver.example',443,
             $8, $9, $10, $11, $12)`,
          configVersionId,
          endpointId,
          sealedUrl.ciphertext,
          sealedUrl.iv,
          sealedUrl.authTag,
          sealedUrl.kid,
          sha256Hex(url),
          sealedSecret.ciphertext,
          sealedSecret.iv,
          sealedSecret.authTag,
          sealedSecret.kid,
          crypto.fingerprint(secret),
        ),
      );

      const [operation] = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<{ app_webhook_management_operation_create: string }>>(
          `SELECT app_webhook_management_operation_create(
             gen_random_uuid(),'VERIFY_CONFIG',$1,$2,$3::uuid,$4::uuid,NULL,NULL,NULL,NULL,NULL,NULL)`,
          keySeed.repeat(64).slice(0, 64),
          'e'.repeat(64),
          endpointId,
          configVersionId,
        ),
      );
      return {
        operationId: operation!.app_webhook_management_operation_create,
        configVersionId,
      };
    }

    async function operationRow(operationId: string) {
      const [row] = await context.adminDb.$queryRawUnsafe<
        Array<{ settled_at: Date | null; settled_error_code: string | null }>
      >(
        `SELECT "settled_at","settled_error_code" FROM "webhook_management_operations"
          WHERE "id" = $1::uuid`,
        operationId,
      );
      return row!;
    }

    it('closes the attempt it left open and settles the intent', async () => {
      const { operationId, configVersionId } = await pendingVerification('1');
      const [opened] = await context.prisma.$queryRawUnsafe<
        Array<{ app_webhook_verification_attempt_open: string }>
      >(
        `SELECT app_webhook_verification_attempt_open($1::uuid,$2::uuid, now())`,
        operationId,
        configVersionId,
      );
      const attemptId = opened!.app_webhook_verification_attempt_open;

      await handler().failExhaustedVerification({ resourceId: operationId } as never);

      const [attempt] = await context.adminDb.$queryRawUnsafe<
        Array<{ outcome: string; error_code: string }>
      >(
        `SELECT "outcome","error_code" FROM "webhook_verification_attempts"
          WHERE "id" = $1::uuid`,
        attemptId,
      );
      // No attempt may stay open once its only job is dead.
      expect(attempt!.outcome).toBe('FAILED_RETRYABLE');
      expect(attempt!.error_code).toBe('WORKER_INTERRUPTED');

      const settled = await operationRow(operationId);
      // And no intent may stay "in progress" with nothing left to run it.
      expect(settled.settled_at).not.toBeNull();
      expect(settled.settled_error_code).toBe('WORKER_INTERRUPTED');

      // The configuration is untouched: nothing proved it, so nothing activated
      // it, and a later ask is an explicit act with a new idempotency key.
      const [config] = await context.adminDb.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT "status" FROM "webhook_endpoint_config_versions" WHERE "id" = $1::uuid`,
        configVersionId,
      );
      expect(config!.status).toBe('PENDING');
    });

    it('finishes from a proof already on disk rather than throwing it away', async () => {
      const { operationId, configVersionId } = await pendingVerification('2');
      const [opened] = await context.prisma.$queryRawUnsafe<
        Array<{ app_webhook_verification_attempt_open: string }>
      >(
        `SELECT app_webhook_verification_attempt_open($1::uuid,$2::uuid, now())`,
        operationId,
        configVersionId,
      );
      const attemptId = opened!.app_webhook_verification_attempt_open;
      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_verification_attempt_close($1::uuid,'SUCCEEDED',NULL,200,20)`,
        attemptId,
      );
      // The process died here: the handshake succeeded and the configuration
      // was never activated.

      await handler().failExhaustedVerification({ resourceId: operationId } as never);

      const [config] = await context.adminDb.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT "status" FROM "webhook_endpoint_config_versions" WHERE "id" = $1::uuid`,
        configVersionId,
      );
      expect(config!.status).toBe('VERIFIED');
      const settled = await operationRow(operationId);
      expect(settled.settled_at).not.toBeNull();
      expect(settled.settled_error_code).toBeNull();
    });

    it('closes an attempt left open, on the first reclaim rather than at the end', async () => {
      // The previous worker died mid-handshake. This run holds the lease, so it
      // closes that attempt and opens its own — which the one-open-attempt index
      // requires anyway. The endpoint is unreachable from a sandbox, so the run
      // ends on the transport path; what matters is what happened to the rows.
      const { operationId, configVersionId } = await pendingVerification('4');
      const [opened] = await context.prisma.$queryRawUnsafe<
        Array<{ app_webhook_verification_attempt_open: string }>
      >(
        `SELECT app_webhook_verification_attempt_open($1::uuid,$2::uuid, now())`,
        operationId,
        configVersionId,
      );
      const interrupted = opened!.app_webhook_verification_attempt_open;

      await verificationService()
        .verify(operationId)
        .catch(() => undefined);

      const rows = await context.adminDb.$queryRawUnsafe<
        Array<{ id: string; outcome: string | null; error_code: string | null }>
      >(
        `SELECT "id","outcome","error_code" FROM "webhook_verification_attempts"
          WHERE "operation_id" = $1::uuid ORDER BY "attempt_number"`,
        operationId,
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        id: interrupted,
        outcome: 'FAILED_RETRYABLE',
        error_code: 'WORKER_INTERRUPTED',
      });
      // A new attempt, so a new id on the wire and a new challenge with it.
      expect(rows[1]!.id).not.toBe(interrupted);
    });

    it('leaves the intent open when nothing was heard from the receiver', async () => {
      // The sandbox cannot resolve the host, so this is a transport failure:
      // no answer, so no settlement, and the same job may try again.
      const { operationId } = await pendingVerification('5');

      await verificationService()
        .verify(operationId)
        .catch(() => undefined);

      const settled = await operationRow(operationId);
      expect(settled.settled_at).toBeNull();
    });

    it('makes no network request for an endpoint the organization disabled', async () => {
      const { operationId, configVersionId } = await pendingVerification('3');
      await asTenant(async (tx) =>
        tx.$executeRawUnsafe(
          `SELECT app_webhook_endpoint_lifecycle($1::uuid,'DISABLED'::"WebhookEndpointStatus")`,
          endpointId,
        ),
      );

      const outcome = await verificationService().verify(operationId);

      expect(outcome).toMatchObject({ kind: 'SETTLED', errorCode: 'ENDPOINT_DISABLED' });
      const attempts = await context.adminDb.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM "webhook_verification_attempts"
          WHERE "operation_id" = $1::uuid`,
        operationId,
      );
      // Nothing was sent, so nothing claims to have been sent.
      expect(Number(attempts[0]!.count)).toBe(0);

      const [config] = await context.adminDb.$queryRawUnsafe<
        Array<{ status: string; last_verification_error: string | null }>
      >(
        `SELECT "status","last_verification_error" FROM "webhook_endpoint_config_versions"
          WHERE "id" = $1::uuid`,
        configVersionId,
      );
      expect(config!.status).toBe('PENDING');
      expect(config!.last_verification_error).toBe('ENDPOINT_DISABLED');
    });
  });

  describe('the reveal sweeper', () => {
    it('clears expired material and keeps the tombstone', async () => {
      const [operation] = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<{ app_webhook_management_operation_create: string }>>(
          `SELECT app_webhook_management_operation_create(
             gen_random_uuid(),'ROTATE_SECRET',$1,$2,$3::uuid,$4::uuid,NULL,
             'rev-c','rev-i','rev-t','k2',$5::timestamptz)`,
          'f'.repeat(64),
          'e'.repeat(64),
          endpointId,
          configId,
          new Date(context.clock.now().getTime() - 3_600_000),
        ),
      );
      const operationId = operation!.app_webhook_management_operation_create;

      expect(await revealSweeper().sweep()).toBe(1);

      const [row] = await context.adminDb.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM "webhook_management_operations" WHERE "id" = $1::uuid`,
        operationId,
      );
      expect(row!.reveal_ciphertext).toBeNull();
      expect(row!.reveal_encryption_key_id).toBeNull();
      // The window and the tombstone survive, so the key can never quietly
      // produce a second side effect later.
      expect(row!.reveal_expires_at).not.toBeNull();
      expect(row!.operation).toBe('ROTATE_SECRET');

      // Nothing left to do on a second pass.
      expect(await revealSweeper().sweep()).toBe(0);
    });

    it('leaves an unexpired reveal alone', async () => {
      await asTenant(async (tx) =>
        tx.$queryRawUnsafe(
          `SELECT app_webhook_management_operation_create(
             gen_random_uuid(),'ROTATE_SECRET',$1,$2,$3::uuid,$4::uuid,NULL,
             'rev-c','rev-i','rev-t','k2',$5::timestamptz)`,
          'a'.repeat(64),
          'e'.repeat(64),
          endpointId,
          configId,
          new Date(context.clock.now().getTime() + 3_600_000),
        ),
      );
      expect(await revealSweeper().sweep()).toBe(0);
    });
  });
});
