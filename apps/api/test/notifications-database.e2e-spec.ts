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
 * What the database refuses about a notification (§13, §14, §45, §70).
 *
 * Every attempt below uses the schema-owning connection — the most privileged
 * identity in the system — because a guarantee that only holds while the
 * application behaves is not a guarantee. The whole premise of the phase is
 * that a notification reports an authoritative event and never becomes one, so
 * the interesting question is not "does the service refuse this" but "could
 * anything write it at all".
 */
describe('Notifications — database invariants (e2e)', () => {
  let context: TestContext;
  let author: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let standard: PublishedStandard;
  let reviewer: { email: string; userId: string; client: AuthClient };
  let eventId: string;
  let notificationId: string;

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

    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'UNDER_REVIEW',
    });

    for (let pass = 0; pass < 3; pass += 1) {
      const jobs = await context.adminDb.processingJob.findMany({
        where: {
          jobType: {
            in: [ProcessingJobType.NOTIFICATION_FANOUT, ProcessingJobType.NOTIFICATION_EMAIL_SEND],
          },
          status: { in: ['PENDING', 'DISPATCHED', 'RETRY_PENDING'] },
        },
      });
      if (jobs.length === 0) break;
      for (const job of jobs) await context.worker.processJobId(job.id);
    }

    const event = await context.adminDb.domainEvent.findFirstOrThrow({
      where: { eventType: 'SUBMISSION_UNDER_REVIEW' },
    });
    eventId = event.id;
    notificationId = (
      await context.adminDb.userNotification.findFirstOrThrow({ where: { sourceEventId: eventId } })
    ).id;
  });

  it('will not let anything rewrite or remove an event', async () => {
    // The log is what happened. A phase that could edit it would have replaced
    // a record of events with a record of opinions about them.
    await expect(
      context.adminDb.$executeRawUnsafe(
        `UPDATE "domain_events" SET "payload" = '{}'::jsonb WHERE "id" = $1::uuid`,
        eventId,
      ),
    ).rejects.toThrow(/immutable once written/);

    await expect(
      context.adminDb.$executeRawUnsafe(
        `DELETE FROM "domain_events" WHERE "id" = $1::uuid`,
        eventId,
      ),
    ).rejects.toThrow(/immutable once written/);
  });

  it('gives the application role no way to write an event at all', async () => {
    // Every event in PalCert is therefore the work of one of the four
    // emitters, not of anything that happens to hold a connection.
    const grants = await context.adminDb.$queryRaw<Array<{ privilege_type: string }>>`
      SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'palcert_app' AND table_name = 'domain_events'`;
    expect(grants.map((row) => row.privilege_type).sort()).toEqual(['SELECT']);
  });

  it('refuses a second event for the same source row and type', async () => {
    const event = await context.adminDb.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
    await expect(
      context.adminDb.domainEvent.create({
        data: {
          eventType: event.eventType,
          eventSchemaVersion: event.eventSchemaVersion,
          sourceType: event.sourceType,
          sourceId: event.sourceId,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          ownerUserId: event.ownerUserId,
          organizationId: event.organizationId,
          occurredAt: event.occurredAt,
          payload: event.payload ?? {},
        },
      }),
      // The producer-level idempotency root. One committed decision produces
      // one event however many times a job or a transaction is retried.
    ).rejects.toThrow(
      /Unique constraint failed[\s\S]*source_type[\s\S]*source_id[\s\S]*event_type/,
    );
  });

  it('refuses an event filed under a source that cannot produce it', async () => {
    const event = await context.adminDb.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
    await expect(
      context.adminDb.$executeRawUnsafe(
        `INSERT INTO "domain_events"
           ("id","event_type","event_schema_version","source_type","source_id",
            "aggregate_type","aggregate_id","owner_user_id","organization_id",
            "occurred_at","payload")
         VALUES (gen_random_uuid(),'CERTIFICATE_ISSUED',1,'SUBMISSION_REVISION',gen_random_uuid(),
                 'COMPLIANCE_CERTIFICATE',gen_random_uuid(),$1::uuid,$2::uuid,now(),'{}'::jsonb)`,
        event.ownerUserId,
        event.organizationId,
      ),
      // Without this the idempotency key would stop meaning anything: a
      // certificate event filed under a revision id could collide with a
      // genuine one, or silently never collide when it should.
    ).rejects.toThrow(/domain_events_source_matches_type/);
  });

  it('refuses an event whose aggregate does not match what happened', async () => {
    const event = await context.adminDb.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
    await expect(
      context.adminDb.$executeRawUnsafe(
        `INSERT INTO "domain_events"
           ("id","event_type","event_schema_version","source_type","source_id",
            "aggregate_type","aggregate_id","owner_user_id","organization_id",
            "occurred_at","payload")
         VALUES (gen_random_uuid(),'SUBMISSION_APPROVED',1,'SUBMISSION_DECISION_EVENT',gen_random_uuid(),
                 'COMPLIANCE_CERTIFICATE',gen_random_uuid(),$1::uuid,$2::uuid,now(),'{}'::jsonb)`,
        event.ownerUserId,
        event.organizationId,
      ),
    ).rejects.toThrow(/domain_events_aggregate_matches_type/);
  });

  it('keeps a rendered copy write-once except for read_at', async () => {
    // A later template, a renamed organization or an edited standard must
    // never change what an old notification says — and marking one read must
    // not be a way to rewrite its text.
    await expect(
      context.adminDb.userNotification.update({
        where: { id: notificationId },
        data: { title: 'Something else entirely' },
      }),
    ).rejects.toThrow(/write-once except for read_at/);

    const read = await context.adminDb.userNotification.update({
      where: { id: notificationId },
      data: { readAt: new Date() },
    });
    expect(read.readAt).not.toBeNull();
  });

  it('shows one person’s notification to nobody else through the request role', async () => {
    const stranger = await createUser(context, 'stranger@example.com');

    const asRecipient = await context.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT set_config('palcert.current_user_id', $1, true)`,
      author.userId,
    );
    expect(asRecipient).toBeDefined();

    // Read through the least-privileged connection, which is the one every
    // request actually uses, in each person's own scope.
    const mine = await context.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('palcert.current_user_id', $1, true)`,
        author.userId,
      );
      return tx.userNotification.findMany({ where: { id: notificationId } });
    });
    expect(mine).toHaveLength(1);

    const theirs = await context.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('palcert.current_user_id', $1, true)`,
        stranger.userId,
      );
      return tx.userNotification.findMany({ where: { id: notificationId } });
    });
    expect(theirs).toHaveLength(0);

    // And the organization the event happened in is not a second reader: the
    // id on the row is a label, not a grant.
    const asOrganization = await context.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('palcert.current_organization_id', $1, true)`,
        university.organizationId,
      );
      return tx.userNotification.findMany({ where: { id: notificationId } });
    });
    expect(asOrganization).toHaveLength(0);
  });

  it('will not let a settled delivery start over', async () => {
    const delivery = await context.adminDb.notificationDelivery.findFirstOrThrow({
      where: { notificationId, channel: 'EMAIL' },
    });
    expect(['DELIVERED', 'SKIPPED', 'FAILED_PERMANENT']).toContain(delivery.status);

    // Without this a stale worker could move a delivered email back to PENDING
    // and send it a second time.
    await expect(
      context.adminDb.notificationDelivery.update({
        where: { id: delivery.id },
        data: { status: 'PENDING' },
      }),
    ).rejects.toThrow(/is already/);
  });

  it('refuses a stored preference that switches off the one mandatory email', async () => {
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
  });

  it('will not resolve reviewers for anything holding a tenant scope', async () => {
    const stranger = await createUser(context, 'outsider@example.com');

    // Fan-out is PalCert's own work. Every request path sets a user scope
    // before it touches anything, so *having* one is the signal that this is
    // not fan-out — which is why an authenticated route cannot reach the
    // resolver however it is written, and why the worker no longer has to
    // borrow a customer's identity to be allowed to run.
    const asUser = context.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('palcert.current_user_id', $1, true)`,
        stranger.userId,
      );
      return tx.$queryRawUnsafe(
        `SELECT * FROM app_notification_submission_reviewers($1::uuid, 100, NULL)`,
        eventId,
      );
    });
    await expect(asUser).rejects.toThrow(/system work/);

    // The submission's own owner is refused too. That is the point: the old
    // guard let them through, and the worker used that to grant itself
    // authority it should never have needed.
    const asOwner = context.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('palcert.current_user_id', $1, true)`,
        author.userId,
      );
      return tx.$queryRawUnsafe(
        `SELECT * FROM app_notification_submission_reviewers($1::uuid, 100, NULL)`,
        eventId,
      );
    });
    await expect(asOwner).rejects.toThrow(/system work/);

    const asOrganization = context.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('palcert.current_organization_id', $1, true)`,
        university.organizationId,
      );
      return tx.$queryRawUnsafe(
        `SELECT * FROM app_notification_submission_reviewers($1::uuid, 100, NULL)`,
        eventId,
      );
    });
    await expect(asOrganization).rejects.toThrow(/system work/);
  });

  it('will not create a notification for anything holding a tenant scope', async () => {
    const readyEvent = await context.adminDb.domainEvent.findFirstOrThrow({
      where: { eventType: 'SUBMISSION_READY' },
    });

    await expect(
      context.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('palcert.current_user_id', $1, true)`,
          author.userId,
        );
        return tx.$queryRawUnsafe(
          `SELECT app_notification_create($1::uuid, $2::uuid, $3::uuid, 'v1', 'en', 't', 'b', '/en/x')`,
          randomUUID(),
          readyEvent.id,
          author.userId,
        );
      }),
    ).rejects.toThrow(/system work/);
  });

  it('refuses a recipient the event’s audience does not name', async () => {
    // The doorway used to be wider than the product rule: pass the caller
    // check and any user id was accepted. The service supplied the right one,
    // but "the caller is careful" is not an invariant — so a valid event plus
    // an arbitrary user id is now refused by the database itself.
    const outsider = await createUser(context, 'unrelated@example.com');

    const create = (eventIdToUse: string, recipientId: string): Promise<unknown> =>
      context.prisma.$queryRawUnsafe(
        `SELECT app_notification_create($1::uuid, $2::uuid, $3::uuid, 'v1', 'en', 't', 'b', '/en/x')`,
        randomUUID(),
        eventIdToUse,
        recipientId,
      );

    // An owner-audience event is for its owner and nobody else.
    const ownerEvent = await context.adminDb.domainEvent.findFirstOrThrow({
      where: { eventType: 'SUBMISSION_UNDER_REVIEW' },
    });
    await expect(create(ownerEvent.id, outsider.userId)).rejects.toThrow(/is for its owner/);
    await expect(create(ownerEvent.id, university.owner.userId)).rejects.toThrow(
      /is for its owner/,
    );

    const readyEvent = await context.adminDb.domainEvent.findFirstOrThrow({
      where: { eventType: 'SUBMISSION_READY' },
    });

    // A reviewer-audience event is for somebody who reviews for *that*
    // organization, right now.
    await expect(create(readyEvent.id, outsider.userId)).rejects.toThrow(/is not a reviewer/);
    // The submitter is not a reviewer of the institution they submitted to.
    await expect(create(readyEvent.id, author.userId)).rejects.toThrow(/is not a reviewer/);

    // A member of another organization, however senior there.
    const other = await createTenant(context, 'Birzeit University', 'other-registrar@example.com');
    await expect(create(readyEvent.id, other.owner.userId)).rejects.toThrow(/is not a reviewer/);

    // A member of the right organization who does not hold submission:review:read.
    const templateManager = await createUser(context, 'templates@example.com');
    await grantOrganizationRoleTo(context, university, templateManager, 'TEMPLATE_MANAGER');
    await expect(create(readyEvent.id, templateManager.userId)).rejects.toThrow(
      /is not a reviewer/,
    );

    // And the one that must work: an active reviewer of the right organization.
    await expect(create(readyEvent.id, reviewer.userId)).resolves.toBeDefined();
  });

  it('classifies every notification table, and forces RLS where a person owns the row', async () => {
    const rows = await context.adminDb.$queryRaw<
      Array<{ table_name: string; classification: string; tenant_column: string | null }>
    >`
      SELECT table_name, classification, tenant_column
        FROM table_isolation_classification
       WHERE table_name IN ('domain_events','user_notifications','notification_deliveries',
                            'notification_delivery_attempts','notification_preferences')
       ORDER BY table_name`;

    expect(rows).toEqual([
      { table_name: 'domain_events', classification: 'SYSTEM', tenant_column: null },
      { table_name: 'notification_deliveries', classification: 'SYSTEM', tenant_column: null },
      {
        table_name: 'notification_delivery_attempts',
        classification: 'SYSTEM',
        tenant_column: null,
      },
      {
        table_name: 'notification_preferences',
        classification: 'USER_SCOPED',
        tenant_column: 'user_id',
      },
      {
        table_name: 'user_notifications',
        classification: 'USER_SCOPED',
        tenant_column: 'recipient_user_id',
      },
    ]);

    const forced = await context.adminDb.$queryRaw<
      Array<{ relname: string; relforcerowsecurity: boolean }>
    >`
      SELECT relname, relforcerowsecurity FROM pg_class
       WHERE relname IN ('user_notifications','notification_preferences') ORDER BY relname`;
    // FORCE matters because these tables are owned by the migration role, and
    // PostgreSQL exempts an owner from its own policies unless forced.
    for (const row of forced)
      expect([row.relname, row.relforcerowsecurity]).toEqual([row.relname, true]);
  });
});
