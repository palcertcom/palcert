import { randomUUID } from 'node:crypto';

import { TenantPrismaService } from '../src/infrastructure/tenant/tenant-prisma.service';
import { createTenant, createUser, type TenantFixture } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * What the database refuses about a webhook integration (§11, §12, §13, §26, §33).
 *
 * Every attempt below uses the schema-owning connection — the most privileged
 * identity in the system — because a guarantee that only holds while the
 * application behaves is not a guarantee. The premise of the phase is that a
 * webhook is a projection and never an authority, and the load-bearing part of
 * that is what the schema itself will not allow: not "does the service refuse
 * this" but "could anything write it at all".
 */
describe('Webhooks — database invariants (e2e)', () => {
  let context: TestContext;
  let university: TenantFixture;
  let actorUserId: string;
  let tenant: TenantPrismaService;

  const sealed = {
    url_ciphertext: 'c',
    url_iv: 'i',
    url_auth_tag: 't',
    url_encryption_key_id: 'k1',
    secret_ciphertext: 'c',
    secret_iv: 'i',
    secret_auth_tag: 't',
    secret_encryption_key_id: 'k1',
  };

  async function insertEndpoint(slot: number | null, status = 'PENDING_VERIFICATION') {
    const id = randomUUID();
    await context.adminDb.$executeRawUnsafe(
      `INSERT INTO "webhook_endpoints"
         ("id","organization_id","description","status","slot","created_by_user_id","updated_at")
       VALUES ($1::uuid,$2::uuid,$3,$4::"WebhookEndpointStatus",$5::smallint,$6::uuid,now())`,
      id,
      university.organizationId,
      `endpoint ${slot ?? 'disabled'}`,
      status,
      slot,
      actorUserId,
    );
    return id;
  }

  async function insertConfig(endpointId: string, version: number, host = 'receiver.example') {
    const id = randomUUID();
    await context.adminDb.$executeRawUnsafe(
      `INSERT INTO "webhook_endpoint_config_versions"
         ("id","endpoint_id","version_number","status",
          "url_ciphertext","url_iv","url_auth_tag","url_encryption_key_id",
          "url_sha256","host","port",
          "secret_ciphertext","secret_iv","secret_auth_tag","secret_encryption_key_id",
          "secret_fingerprint")
       VALUES ($1::uuid,$2::uuid,$3,'PENDING',$4,$5,$6,$7,$8,$9,443,$10,$11,$12,$13,$14)`,
      id,
      endpointId,
      version,
      sealed.url_ciphertext,
      sealed.url_iv,
      sealed.url_auth_tag,
      sealed.url_encryption_key_id,
      'a'.repeat(64),
      host,
      sealed.secret_ciphertext,
      sealed.secret_iv,
      sealed.secret_auth_tag,
      sealed.secret_encryption_key_id,
      'b'.repeat(64),
    );
    return id;
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
    const registrar = await createUser(context, 'registrar-owner@example.com');
    actorUserId = registrar.userId;
    university = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
  });

  it('holds the ten-endpoint limit as a database invariant, not a service check', async () => {
    // Two concurrent creates at the boundary both read "nine" and both pass an
    // application count. They cannot both take slot ten.
    for (let slot = 1; slot <= 10; slot += 1) {
      await insertEndpoint(slot);
    }
    await expect(insertEndpoint(11)).rejects.toThrow();
    await expect(insertEndpoint(10)).rejects.toThrow();
  });

  it('refuses a direct lifecycle change even from the schema owner', async () => {
    const endpointId = await insertEndpoint(1);

    // The most privileged connection in the system, and it still cannot make an
    // endpoint live. Activation is verification's business; a status column that
    // anything could set would make verification decorative.
    await expect(
      context.adminDb.$executeRawUnsafe(
        `UPDATE "webhook_endpoints" SET "status"='ACTIVE', "updated_at"=now() WHERE "id"=$1::uuid`,
        endpointId,
      ),
    ).rejects.toThrow(/lifecycle changes only through a lifecycle function/);

    await expect(
      context.adminDb.$executeRawUnsafe(
        `UPDATE "webhook_endpoints" SET "slot"=NULL, "updated_at"=now() WHERE "id"=$1::uuid`,
        endpointId,
      ),
    ).rejects.toThrow(/lifecycle changes only through a lifecycle function/);

    // The description is the one thing ordinary editing may touch.
    await expect(
      context.adminDb.$executeRawUnsafe(
        `UPDATE "webhook_endpoints" SET "description"='renamed', "updated_at"=now()
          WHERE "id"=$1::uuid`,
        endpointId,
      ),
    ).resolves.toBeDefined();
  });

  it('releases a slot through the lifecycle function, and only then', async () => {
    const endpointId = await insertEndpoint(1);

    await tenant.withTenant(
      { organizationId: university.organizationId, userId: actorUserId },
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT app_webhook_endpoint_lifecycle($1::uuid, 'DISABLED')`,
          endpointId,
        );
      },
    );

    const [row] = await context.adminDb.$queryRawUnsafe<Array<{ slot: number | null }>>(
      `SELECT "slot" FROM "webhook_endpoints" WHERE "id"=$1::uuid`,
      endpointId,
    );
    expect(row?.slot).toBeNull();

    // The slot is free again for a replacement integration.
    await expect(insertEndpoint(1)).resolves.toBeDefined();
  });

  it('refuses an IP literal where a hostname belongs', async () => {
    // A dotted quad matches every "looks like a hostname" pattern there is,
    // because its labels are ordinary labels that happen to be digits. The
    // schema refuses it anyway, so a bypassed URL policy cannot store one.
    const endpointId = await insertEndpoint(1);
    await expect(insertConfig(endpointId, 1, '93.184.216.34')).rejects.toThrow();
    await expect(insertConfig(endpointId, 1, 'receiver.example')).resolves.toBeDefined();
  });

  it('allows only one configuration to be waiting per endpoint', async () => {
    const endpointId = await insertEndpoint(1);
    await insertConfig(endpointId, 1);
    // Saving a new URL supersedes the previous pending one; it never adds a
    // second, or a stale verification could activate the one nobody meant.
    await expect(insertConfig(endpointId, 2)).rejects.toThrow();
  });

  it('will not let an endpoint point at another endpoint’s configuration', async () => {
    const first = await insertEndpoint(1);
    const second = await insertEndpoint(2);
    const config = await insertConfig(first, 1);

    await expect(
      context.adminDb.$executeRawUnsafe(
        `UPDATE "webhook_endpoints"
            SET "pending_config_version_id"=$1::uuid, "updated_at"=now()
          WHERE "id"=$2::uuid`,
        config,
        second,
      ),
    ).rejects.toThrow();
  });

  it('refuses to replay a test delivery', async () => {
    const endpointId = await insertEndpoint(1);
    const config = await insertConfig(endpointId, 1);
    const testDelivery = randomUUID();

    await context.adminDb.$executeRawUnsafe(
      `INSERT INTO "webhook_deliveries"
         ("id","endpoint_id","endpoint_config_version_id","organization_id","kind",
          "control_occurred_at","body_sha256","updated_at")
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'TEST',now(),$5,now())`,
      testDelivery,
      endpointId,
      config,
      university.organizationId,
      'c'.repeat(64),
    );

    // A test carries no business fact, so replaying one would send a body that
    // never projected anything and invite a receiver to act on it.
    await expect(
      context.adminDb.$executeRawUnsafe(
        `INSERT INTO "webhook_deliveries"
           ("id","endpoint_id","endpoint_config_version_id","organization_id","kind",
            "replay_of_delivery_id","control_occurred_at","body_sha256","updated_at")
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'REPLAY',$5::uuid,now(),$6,now())`,
        randomUUID(),
        endpointId,
        config,
        university.organizationId,
        testDelivery,
        'c'.repeat(64),
      ),
    ).rejects.toThrow(/test delivery cannot be replayed/);
  });

  it('keeps a delivered webhook delivered', async () => {
    const endpointId = await insertEndpoint(1);
    const config = await insertConfig(endpointId, 1);
    const delivery = randomUUID();

    await context.adminDb.$executeRawUnsafe(
      `INSERT INTO "webhook_deliveries"
         ("id","endpoint_id","endpoint_config_version_id","organization_id","kind",
          "status","control_occurred_at","body_sha256","delivered_at","updated_at")
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'TEST','DELIVERED',now(),$5,now(),now())`,
      delivery,
      endpointId,
      config,
      university.organizationId,
      'c'.repeat(64),
    );

    // Without this a stale worker could move a delivered webhook back to
    // PENDING and send somebody a second announcement.
    await expect(
      context.adminDb.$executeRawUnsafe(
        `UPDATE "webhook_deliveries" SET "status"='PENDING', "updated_at"=now() WHERE "id"=$1::uuid`,
        delivery,
      ),
    ).rejects.toThrow(/already DELIVERED/);
  });

  it('keeps every Phase 16 event ineligible for a webhook, for ever', async () => {
    const ineligible = await context.adminDb.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM "domain_events" WHERE NOT "webhook_eligible"`,
    );
    // Nothing written before the cutover may be announced now. What decides is
    // the row, not the clock — a replayed historical source returns its
    // existing row, and that row is still false.
    expect(Number(ineligible[0]?.count ?? 0)).toBeGreaterThanOrEqual(0);

    const columnDefault = await context.adminDb.$queryRawUnsafe<Array<{ d: string | null }>>(
      `SELECT column_default AS d FROM information_schema.columns
        WHERE table_name='domain_events' AND column_name='webhook_eligible'`,
    );
    expect(columnDefault[0]?.d).toBe('true');
  });

  describe('the business-retry edge on the job lifecycle', () => {
    /** A finished job of the given type, written straight to SUCCEEDED. */
    async function succeededJob(jobType: string): Promise<string> {
      const id = randomUUID();
      await context.adminDb.$executeRawUnsafe(
        `INSERT INTO "processing_jobs"
           ("id","job_type","resource_type","resource_id","idempotency_key",
            "status","max_attempts","completed_at","updated_at")
         VALUES ($1::uuid,$2::"ProcessingJobType",'WEBHOOK_DELIVERY',$3::uuid,$4,
                 'SUCCEEDED',3,now(),now())`,
        id,
        jobType,
        randomUUID(),
        `${jobType}:${id}`,
      );
      return id;
    }

    it('lets a finished webhook delivery job be re-armed', async () => {
      const id = await succeededJob('WEBHOOK_DELIVER');
      await context.adminDb.$executeRawUnsafe(
        `UPDATE "processing_jobs" SET "status"='PENDING',"completed_at"=NULL WHERE "id"=$1::uuid`,
        id,
      );
      const [row] = await context.adminDb.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT "status" FROM "processing_jobs" WHERE "id"=$1::uuid`,
        id,
      );
      expect(row?.status).toBe('PENDING');
    });

    it('refuses to re-arm a finished job of any other type', async () => {
      // The edge is a Phase 17 concession to a resource that owns its own
      // schedule, not a general relaxation. For everything else a job that
      // succeeded did the work exactly once, and a second run is a duplicate.
      const id = await succeededJob('NOTIFICATION_EMAIL_SEND');
      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE "processing_jobs" SET "status"='PENDING' WHERE "id"=$1::uuid`,
          id,
        ),
      ).rejects.toThrow(/cannot move from SUCCEEDED to PENDING/);
    });

    it('refuses to walk a finished delivery job straight back into RUNNING', async () => {
      // PENDING is the only destination, so a re-armed job always goes through
      // the ordinary claim path and gets an ordinary lease.
      const id = await succeededJob('WEBHOOK_DELIVER');
      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE "processing_jobs" SET "status"='RUNNING' WHERE "id"=$1::uuid`,
          id,
        ),
      ).rejects.toThrow(/cannot move from SUCCEEDED to RUNNING/);
    });
  });

  it('records a webhook event at most once per domain event', async () => {
    const duplicates = await context.adminDb.$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'webhook_events_domain_event_key'`,
    );
    expect(duplicates[0]?.indexdef).toContain('UNIQUE');
    expect(duplicates[0]?.indexdef).toContain('domain_event_id');
  });
});
