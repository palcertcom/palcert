import { randomUUID } from 'node:crypto';

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
 * Who may write what, proved against the database rather than the services.
 *
 * The Phase 17 tables were created with the right classification and the wrong
 * privileges: `palcert_app` could insert a fabricated WebhookEvent, rewrite an
 * encrypted configuration, or move a delivery to DELIVERED without sending
 * anything. Those are the writes a route bug performs, so the tests below use
 * the application role directly — not the services, which currently behave.
 *
 * A guarantee that holds only while the service layer is correct is not a
 * guarantee; it is a coding convention with good intentions.
 */
describe('Webhooks — write authority (e2e)', () => {
  let context: TestContext;
  let tenant: TenantPrismaService;
  let university: TenantFixture;
  let actorUserId: string;
  let endpointId: string;

  /** Runs SQL as `palcert_app` with an organization resolved, like a request. */
  async function asTenant<T>(fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    return tenant.withTenant(
      { organizationId: university.organizationId, userId: actorUserId },
      fn,
    );
  }

  async function createPendingConfig(host = 'receiver.example'): Promise<string> {
    const rows = await asTenant(async (tx) =>
      tx.$queryRawUnsafe<Array<{ app_webhook_config_create: string }>>(
        `SELECT app_webhook_config_create(
           gen_random_uuid(), $1::uuid, 'url-c','url-i','url-t','k2', $2, $3, 443,
           'sec-c','sec-i','sec-t','k2', $4)`,
        endpointId,
        'a'.repeat(64),
        host,
        'b'.repeat(64),
      ),
    );
    return rows[0]!.app_webhook_config_create;
  }

  /**
   * The real activation chain: intent, a network attempt, its proof, and only
   * then the swap.
   *
   * The operation is the organization's request to verify. The attempt and its
   * SUCCEEDED closure are the worker's record that a signed challenge went out
   * and the exact nonce came back. Activation takes the attempt id and derives
   * everything else, so none of it can be asserted by a caller.
   */
  async function verifyConfig(configId: string, keySalt = 'd'): Promise<string> {
    const [op] = await asTenant(async (tx) =>
      tx.$queryRawUnsafe<Array<{ app_webhook_management_operation_create: string }>>(
        `SELECT app_webhook_management_operation_create(
           gen_random_uuid(), 'VERIFY_CONFIG', $1, $2, $3::uuid, $4::uuid, NULL,
           NULL, NULL, NULL, NULL, NULL)`,
        keySalt.repeat(64),
        'e'.repeat(64),
        endpointId,
        configId,
      ),
    );
    const operationId = op!.app_webhook_management_operation_create;

    const [attempt] = await context.prisma.$queryRawUnsafe<
      Array<{ app_webhook_verification_attempt_open: string }>
    >(
      `SELECT app_webhook_verification_attempt_open($1::uuid, $2::uuid, now())`,
      operationId,
      configId,
    );
    const attemptId = attempt!.app_webhook_verification_attempt_open;

    await context.prisma.$executeRawUnsafe(
      `SELECT app_webhook_verification_attempt_close($1::uuid, 'SUCCEEDED', NULL, 200, 30)`,
      attemptId,
    );
    return attemptId;
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

    endpointId = randomUUID();
    await context.adminDb.$executeRawUnsafe(
      `INSERT INTO "webhook_endpoints"
         ("id","organization_id","description","status","slot","created_by_user_id","updated_at")
       VALUES ($1::uuid,$2::uuid,'primary','PENDING_VERIFICATION',1,$3::uuid,now())`,
      endpointId,
      university.organizationId,
      actorUserId,
    );
  });

  describe('SYSTEM tables are not reachable by ordinary DML', () => {
    it('refuses a fabricated WebhookEvent from the application role', async () => {
      // The whole phase rests on a webhook being a projection of an
      // authoritative DomainEvent. If a route bug could insert one directly, it
      // could announce an approval that never happened.
      await expect(
        context.prisma.$executeRawUnsafe(
          `INSERT INTO "webhook_events"
             ("id","domain_event_id","organization_id","event_type","schema_version",
              "occurred_at","data","body_sha256")
           VALUES ($1::uuid,$2::uuid,$3::uuid,'submission.approved',1,now(),'{}'::jsonb,$4)`,
          randomUUID(),
          randomUUID(),
          university.organizationId,
          'c'.repeat(64),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('refuses a delivery, an attempt and a verification attempt just the same', async () => {
      for (const statement of [
        `INSERT INTO "webhook_deliveries"
           ("id","endpoint_id","endpoint_config_version_id","organization_id","kind","updated_at")
         VALUES (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
                 'ORIGINAL',now())`,
        `INSERT INTO "webhook_delivery_attempts"
           ("id","delivery_id","attempt_number","started_at")
         VALUES (gen_random_uuid(),gen_random_uuid(),1,now())`,
        `INSERT INTO "webhook_verification_attempts"
           ("id","operation_id","config_version_id","endpoint_id","attempt_number","started_at")
         VALUES (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1,now())`,
      ]) {
        await expect(context.prisma.$executeRawUnsafe(statement)).rejects.toThrow(
          /permission denied/i,
        );
      }
    });

    it('refuses to move a delivery’s state directly', async () => {
      await expect(
        context.prisma.$executeRawUnsafe(
          `UPDATE "webhook_deliveries" SET "status"='DELIVERED', "updated_at"=now()`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe('secret-bearing rows are not readable from a request', () => {
    it('cannot be selected directly, in tenant context or out of it', async () => {
      for (const table of [
        'webhook_endpoint_config_versions',
        'webhook_management_operations',
        'webhook_events',
        'webhook_deliveries',
        'webhook_delivery_attempts',
        'webhook_verification_attempts',
      ]) {
        await expect(
          context.prisma.$queryRawUnsafe(`SELECT * FROM "${table}" LIMIT 1`),
        ).rejects.toThrow(/permission denied/i);

        await expect(
          asTenant(async (tx) => tx.$queryRawUnsafe(`SELECT * FROM "${table}" LIMIT 1`)),
        ).rejects.toThrow(/permission denied/i);
      }
    });

    it('is read instead through a projection that carries no key material', async () => {
      const configId = await createPendingConfig();

      const rows = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT * FROM "webhook_config_version_safe" WHERE "id"=$1::uuid`,
          configId,
        ),
      );

      expect(rows).toHaveLength(1);
      const columns = Object.keys(rows[0]!);
      // What a screen needs, and nothing a screen could leak.
      expect(columns).toContain('host');
      expect(columns).toContain('port');
      expect(columns).toContain('status');
      for (const forbidden of [
        'url_ciphertext',
        'url_iv',
        'url_auth_tag',
        'url_encryption_key_id',
        'secret_ciphertext',
        'secret_iv',
        'secret_auth_tag',
        'secret_encryption_key_id',
      ]) {
        expect(columns).not.toContain(forbidden);
      }
    });

    it('will not hand sealed configuration to a tenant request', async () => {
      const configId = await createPendingConfig();
      await expect(
        asTenant(async (tx) =>
          tx.$queryRawUnsafe(`SELECT * FROM app_webhook_config_material($1::uuid)`, configId),
        ),
      ).rejects.toThrow(/not readable from a request/);
    });

    it('cannot be written through the projection either', async () => {
      // A single-table view is auto-updatable, and the database grants `arwd`
      // on every new relation by default — so without an explicit revoke the
      // read projection would have been a way back into the base table, using
      // the view owner's privileges.
      await expect(
        context.prisma.$executeRawUnsafe(
          `UPDATE "webhook_management_operation_safe" SET "settled_at"=now()`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe('configuration lifecycle and crypto are separate authorities', () => {
    it('refuses to activate a configuration from a tenant request', async () => {
      // Release-blocking regression. An organization request must never make an
      // endpoint live: activation is the consequence of a verification worker
      // getting its exact challenge back, and a route that could assert it
      // would make the whole handshake decorative.
      const configId = await createPendingConfig();

      await expect(
        asTenant(async (tx) =>
          tx.$executeRawUnsafe(`SELECT app_webhook_config_activate($1::uuid)`, configId),
        ),
      ).rejects.toThrow(/activation is system work/);

      const [endpoint] = await context.adminDb.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT "status" FROM "webhook_endpoints" WHERE "id"=$1::uuid`,
        endpointId,
      );
      expect(endpoint?.status).toBe('PENDING_VERIFICATION');
    });

    it('refuses a direct configuration update from the schema owner itself', async () => {
      const configId = await createPendingConfig();

      // No mode, no write. This is the default branch of the guard, and the
      // most privileged connection in the system lands in it.
      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE "webhook_endpoint_config_versions" SET "status"='VERIFIED' WHERE "id"=$1::uuid`,
          configId,
        ),
      ).rejects.toThrow(/lifecycle or rewrap function/);

      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE "webhook_endpoint_config_versions" SET "url_ciphertext"='tampered'
            WHERE "id"=$1::uuid`,
          configId,
        ),
      ).rejects.toThrow(/lifecycle or rewrap function/);
    });

    it('rewraps the envelope and nothing else', async () => {
      const configId = await createPendingConfig();

      // No organization in scope: a rewrap is maintenance, and refusing it
      // whenever a tenant is resolved is what keeps it out of every HTTP route.
      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_config_rewrap($1::uuid,'u2','i2','t2','k1','s2','i2','t2','k1')`,
        configId,
      );

      const [row] = await context.adminDb.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM "webhook_endpoint_config_versions" WHERE "id"=$1::uuid`,
        configId,
      );

      expect(row?.url_ciphertext).toBe('u2');
      expect(row?.url_encryption_key_id).toBe('k1');
      expect(row?.secret_ciphertext).toBe('s2');
      // Every semantic and lifecycle field is exactly as it was.
      expect(row?.status).toBe('PENDING');
      expect(row?.verified_at).toBeNull();
      expect(row?.retired_at).toBeNull();
      expect(row?.host).toBe('receiver.example');
      expect(row?.url_sha256).toBe('a'.repeat(64));
      expect(row?.secret_fingerprint).toBe('b'.repeat(64));
    });

    it('will not let a rewrap be reached from a tenant request', async () => {
      const configId = await createPendingConfig();
      await expect(
        asTenant(async (tx) =>
          tx.$executeRawUnsafe(
            `SELECT app_webhook_config_rewrap($1::uuid,'u2','i2','t2','k1','s2','i2','t2','k1')`,
            configId,
          ),
        ),
      ).rejects.toThrow(/not a request/);
    });

    it('leaves the crypto envelope untouched when a configuration is activated', async () => {
      const configId = await createPendingConfig();
      const [before] = await context.adminDb.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM "webhook_endpoint_config_versions" WHERE "id"=$1::uuid`,
        configId,
      );

      const attemptId = await verifyConfig(configId);
      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_config_activate($1::uuid)`,
        attemptId,
      );

      const [after] = await context.adminDb.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM "webhook_endpoint_config_versions" WHERE "id"=$1::uuid`,
        configId,
      );

      expect(after?.status).toBe('VERIFIED');
      for (const column of [
        'url_ciphertext',
        'url_iv',
        'url_auth_tag',
        'url_encryption_key_id',
        'secret_ciphertext',
        'secret_iv',
        'secret_auth_tag',
        'secret_encryption_key_id',
      ]) {
        expect(after?.[column]).toBe(before?.[column]);
      }
    });

    it('refuses a stale verification of a superseded configuration', async () => {
      const first = await createPendingConfig();
      const second = await createPendingConfig('receiver2.example');
      expect(second).not.toBe(first);

      // The first was superseded when the second was saved. A verification
      // still in flight for it must not activate a URL the organization has
      // already replaced.
      const staleAttempt = await verifyConfig(first, 'a');
      await expect(
        context.prisma.$executeRawUnsafe(
          `SELECT app_webhook_config_activate($1::uuid)`,
          staleAttempt,
        ),
      ).rejects.toThrow(/not the pending configuration/);
    });
  });

  describe('management operations keep their answer', () => {
    async function createOperation(): Promise<string> {
      // CREATE_ENDPOINT records the endpoint *and* the configuration it was
      // created with; the shape constraint refuses a half-described intent.
      const configId = await createPendingConfig();
      const rows = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<{ app_webhook_management_operation_create: string }>>(
          `SELECT app_webhook_management_operation_create(
             gen_random_uuid(), 'CREATE_ENDPOINT', $1, $2, $3::uuid, $4::uuid, NULL,
             'rev-c','rev-i','rev-t','k2', now() + interval '1 hour')`,
          'd'.repeat(64),
          'e'.repeat(64),
          endpointId,
          configId,
        ),
      );
      return rows[0]!.app_webhook_management_operation_create;
    }

    it('will not let a result resource be reassigned', async () => {
      const operationId = await createOperation();

      // The promise of an idempotency key is that it returns the same answer.
      // A swappable result id makes that promise unenforceable.
      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE "webhook_management_operations" SET "endpoint_id"=$1::uuid WHERE "id"=$2::uuid`,
          randomUUID(),
          operationId,
        ),
      ).rejects.toThrow(/result resources are immutable/);

      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE "webhook_management_operations" SET "delivery_id"=$1::uuid WHERE "id"=$2::uuid`,
          randomUUID(),
          operationId,
        ),
      ).rejects.toThrow(/result resources are immutable/);
    });

    it('will not let a reveal be replaced by a different secret', async () => {
      const operationId = await createOperation();

      // A caller recovering a lost response has no way to tell an issued secret
      // from one substituted afterwards. So substitution is not an operation.
      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE "webhook_management_operations" SET "reveal_ciphertext"='substituted'
            WHERE "id"=$1::uuid`,
          operationId,
        ),
      ).rejects.toThrow(/rewrapped or cleared/);
    });

    it('will not let the recovery window be extended', async () => {
      const operationId = await createOperation();
      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE "webhook_management_operations"
              SET "reveal_expires_at"=now() + interval '10 years' WHERE "id"=$1::uuid`,
          operationId,
        ),
      ).rejects.toThrow(/identity is immutable/);
    });

    it('rewraps a reveal, and clears it on expiry', async () => {
      const operationId = await createOperation();

      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_reveal_rewrap($1::uuid,'rev-c2','rev-i2','rev-t2','k1')`,
        operationId,
      );
      let [row] = await context.adminDb.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM "webhook_management_operations" WHERE "id"=$1::uuid`,
        operationId,
      );
      expect(row?.reveal_ciphertext).toBe('rev-c2');
      expect(row?.reveal_encryption_key_id).toBe('k1');
      // A rewrap is not a settlement and not an expiry.
      expect(row?.settled_at).toBeNull();
      expect(row?.reveal_expires_at).not.toBeNull();

      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_reveal_clear($1::uuid)`,
        operationId,
      );
      [row] = await context.adminDb.$queryRawUnsafe(
        `SELECT * FROM "webhook_management_operations" WHERE "id"=$1::uuid`,
        operationId,
      );
      expect(row?.reveal_ciphertext).toBeNull();
      expect(row?.reveal_iv).toBeNull();
      expect(row?.reveal_auth_tag).toBeNull();
      expect(row?.reveal_encryption_key_id).toBeNull();
      // The tombstone remains, so the same key can never quietly produce a
      // second side effect later.
      expect(row?.id).toBe(operationId);
      expect(row?.endpoint_id).toBe(endpointId);
    });

    it('refuses to recover a reveal for another actor or another key', async () => {
      const operationId = await createOperation();
      const other = await createUser(context, 'other-admin@example.com');

      await expect(
        asTenant(async (tx) =>
          tx.$queryRawUnsafe(
            `SELECT * FROM app_webhook_reveal_read($1::uuid, $2, $3, now())`,
            operationId,
            'f'.repeat(64),
            'e'.repeat(64),
          ),
        ),
      ).rejects.toThrow(/not the caller's to recover/);

      await expect(
        tenant.withTenant(
          { organizationId: university.organizationId, userId: other.userId },
          async (tx) =>
            tx.$queryRawUnsafe(
              `SELECT * FROM app_webhook_reveal_read($1::uuid, $2, $3, now())`,
              operationId,
              'd'.repeat(64),
              'e'.repeat(64),
            ),
        ),
      ).rejects.toThrow(/not the caller's to recover/);
    });
  });

  describe('attempts stay where they were written', () => {
    it('will not move a delivery attempt to another delivery', async () => {
      const configId = await createPendingConfig();
      const verificationAttemptId = await verifyConfig(configId);
      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_config_activate($1::uuid)`,
        verificationAttemptId,
      );

      const [delivery] = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<{ app_webhook_delivery_create_test: string }>>(
          `SELECT app_webhook_delivery_create_test($1::uuid, now(), $2)`,
          endpointId,
          'c'.repeat(64),
        ),
      );
      const deliveryId = delivery!.app_webhook_delivery_create_test;

      const [attempt] = await context.prisma.$queryRawUnsafe<Array<{ attempt_id: string }>>(
        `SELECT * FROM app_webhook_delivery_attempt_begin($1::uuid, now())`,
        deliveryId,
      );
      const attemptId = attempt!.attempt_id;

      // A movable attempt would let a failure be re-filed against a different
      // integration, which is how a delivery log stops being evidence.
      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE "webhook_delivery_attempts" SET "delivery_id"=$1::uuid WHERE "id"=$2::uuid`,
          randomUUID(),
          attemptId,
        ),
      ).rejects.toThrow(/cannot change delivery/);

      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE "webhook_delivery_attempts" SET "started_at"=now() WHERE "id"=$1::uuid`,
          attemptId,
        ),
      ).rejects.toThrow(/identity is immutable/);

      // A receiver's answer can only be recorded together with its delivery, so
      // there is no doorway that closes this attempt on its own.
      await expect(
        context.prisma.$executeRawUnsafe(
          `SELECT app_webhook_attempt_close($1::uuid, 'SUCCEEDED', NULL, 200, 42)`,
          attemptId,
        ),
      ).rejects.toThrow(/must finish atomically/);

      // Finishing once is allowed; finishing twice is not.
      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_delivery_attempt_finish(
           $1::uuid,'SUCCEEDED',NULL,200,42,'DELIVERED',NULL)`,
        attemptId,
      );
      await expect(
        context.prisma.$executeRawUnsafe(
          `SELECT app_webhook_delivery_attempt_finish(
             $1::uuid,'FAILED_PERMANENT','HTTP_PERMANENT',404,9,'FAILED_PERMANENT',NULL)`,
          attemptId,
        ),
      ).rejects.toThrow(/is already SUCCEEDED/);
    });
  });

  describe('default role membership', () => {
    it('gives the four integration permissions to owners and admins only', async () => {
      const rows = await context.adminDb.$queryRawUnsafe<
        Array<{ code: string; role_code: string }>
      >(`SELECT p."code", r."code" AS role_code
           FROM "role_permissions" rp
           JOIN "permissions" p ON p."id" = rp."permission_id"
           JOIN "roles" r ON r."id" = rp."role_id"
          WHERE p."code" LIKE 'integration:webhook:%'
          ORDER BY r."code", p."code"`);

      const byRole = new Map<string, string[]>();
      for (const row of rows) {
        byRole.set(row.role_code, [...(byRole.get(row.role_code) ?? []), row.code]);
      }

      expect([...byRole.keys()].sort()).toEqual(['ORGANIZATION_ADMIN', 'ORGANIZATION_OWNER']);
      for (const role of ['ORGANIZATION_ADMIN', 'ORGANIZATION_OWNER']) {
        expect(byRole.get(role)?.sort()).toEqual([
          'integration:webhook:manage',
          'integration:webhook:read',
          'integration:webhook:replay',
          'integration:webhook:secret:rotate',
        ]);
      }

      // Named roles rather than "whoever holds organization:profile:update",
      // which would hand a future custom role the authority to mint a secret.
      expect(byRole.has('ORGANIZATION_REVIEWER')).toBe(false);
      expect(byRole.has('TEMPLATE_MANAGER')).toBe(false);
    });
  });
});
