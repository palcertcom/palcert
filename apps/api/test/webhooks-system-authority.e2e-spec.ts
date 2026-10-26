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
 * Which contexts may reach the system doorways, and what proof activation needs.
 *
 * Every PalCert process connects as the same `palcert_app` role, so the
 * database cannot tell a worker from a request by identity. What it can tell is
 * what scope is resolved, and the three cases below are genuinely different:
 *
 *   no user, no organization   — a worker
 *   user, no organization      — a self-service request
 *   user and organization      — an organization request
 *
 * Only the first is system. Testing only the organization would have called a
 * self-service request "system", which is the trap this suite exists to keep
 * shut.
 */
describe('Webhooks — system authority (e2e)', () => {
  let context: TestContext;
  let tenant: TenantPrismaService;
  let university: TenantFixture;
  let actorUserId: string;
  let endpointId: string;

  /** No user, no organization: the worker. */
  const asSystem = () => context.prisma;

  /** A user acting outside any organization: self-service. */
  async function asSelfService<T>(fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    return tenant.withUser(actorUserId, fn);
  }

  /** A user acting inside an organization: an ordinary request. */
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

  async function createVerifyOperation(configId: string, keySalt = 'd'): Promise<string> {
    const rows = await asTenant(async (tx) =>
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
    return rows[0]!.app_webhook_management_operation_create;
  }

  async function openAttempt(operationId: string, configId: string): Promise<string> {
    const rows = await asSystem().$queryRawUnsafe<
      Array<{ app_webhook_verification_attempt_open: string }>
    >(
      `SELECT app_webhook_verification_attempt_open($1::uuid, $2::uuid, now())`,
      operationId,
      configId,
    );
    return rows[0]!.app_webhook_verification_attempt_open;
  }

  async function settleResponse(
    attemptId: string,
    outcome: string,
    code: string,
    httpStatus: number,
  ) {
    await asSystem().$executeRawUnsafe(
      `SELECT app_webhook_verification_attempt_settle_response(
         $1::uuid, $2::"WebhookAttemptOutcome", $3, $4::integer, 30)`,
      attemptId,
      outcome,
      code,
      httpStatus,
    );
  }

  async function closeAttempt(attemptId: string, outcome: string, code: string | null) {
    await asSystem().$executeRawUnsafe(
      `SELECT app_webhook_verification_attempt_close($1::uuid, $2::"WebhookAttemptOutcome", $3, 200, 30)`,
      attemptId,
      outcome,
      code,
    );
  }

  async function endpointStatus(): Promise<string> {
    const [row] = await context.adminDb.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT "status" FROM "webhook_endpoints" WHERE "id"=$1::uuid`,
      endpointId,
    );
    return row!.status;
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

  describe('the three contexts', () => {
    it('recognises only "no user and no organization" as system', async () => {
      const read = async (tx: { $queryRawUnsafe: TenantClient['$queryRawUnsafe'] }) =>
        (
          await tx.$queryRawUnsafe<Array<{ system: boolean }>>(
            `SELECT app_is_webhook_system_context() AS system`,
          )
        )[0]!.system;

      expect(await read(asSystem())).toBe(true);
      // A person acting outside any organization is still a person.
      expect(await asSelfService(read)).toBe(false);
      expect(await asTenant(read)).toBe(false);
    });

    it('refuses every system doorway from a self-service and an organization request', async () => {
      const configId = await createPendingConfig();
      const operationId = await createVerifyOperation(configId);

      const calls: Array<[string, string, unknown[]]> = [
        [
          'event projection',
          `SELECT app_webhook_event_create($1::uuid, $2::uuid, $3)`,
          [randomUUID(), randomUUID(), 'c'.repeat(64)],
        ],
        [
          'fan-out',
          `SELECT app_webhook_delivery_create_original($1::uuid, $2::uuid)`,
          [randomUUID(), endpointId],
        ],
        [
          'delivery transition',
          `SELECT app_webhook_delivery_transition(
           $1::uuid, 'DELIVERED', NULL, NULL, 200, NULL, false)`,
          [randomUUID()],
        ],
        [
          'attempt begin',
          `SELECT * FROM app_webhook_delivery_attempt_begin($1::uuid, now())`,
          [randomUUID()],
        ],
        [
          'attempt close',
          `SELECT app_webhook_attempt_close(
           $1::uuid, 'SUCCEEDED', NULL, 200, 5)`,
          [randomUUID()],
        ],
        [
          'verification attempt open',
          `SELECT app_webhook_verification_attempt_open($1::uuid, $2::uuid, now())`,
          [operationId, configId],
        ],
        [
          'verification attempt close',
          `SELECT app_webhook_verification_attempt_close(
           $1::uuid, 'SUCCEEDED', NULL, 200, 5)`,
          [randomUUID()],
        ],
        ['activation', `SELECT app_webhook_config_activate($1::uuid)`, [randomUUID()]],
        [
          'verification response settle',
          `SELECT app_webhook_verification_attempt_settle_response(
           $1::uuid, 'FAILED_PERMANENT', 'HTTP_PERMANENT', 404, 5)`,
          [randomUUID()],
        ],
        [
          'delivery attempt finish',
          `SELECT app_webhook_delivery_attempt_finish(
           $1::uuid, 'SUCCEEDED', NULL, 200, 5, 'DELIVERED', NULL)`,
          [randomUUID()],
        ],
        ['operation settle', `SELECT app_webhook_operation_settle($1::uuid, NULL)`, [randomUUID()]],
        ['reveal clear', `SELECT app_webhook_reveal_clear($1::uuid)`, [randomUUID()]],
        ['config material', `SELECT * FROM app_webhook_config_material($1::uuid)`, [configId]],
        [
          'config rewrap',
          `SELECT app_webhook_config_rewrap(
           $1::uuid,'u','i','t','k1','s','i','t','k1')`,
          [configId],
        ],
        [
          'reveal rewrap',
          `SELECT app_webhook_reveal_rewrap($1::uuid,'c','i','t','k1')`,
          [randomUUID()],
        ],
        [
          'system event read',
          `SELECT * FROM app_webhook_event_system_get($1::uuid)`,
          [randomUUID()],
        ],
        [
          'system delivery read',
          `SELECT * FROM app_webhook_delivery_system_get($1::uuid)`,
          [randomUUID()],
        ],
        [
          'system attempts read',
          `SELECT * FROM app_webhook_delivery_attempts_system_get($1::uuid)`,
          [randomUUID()],
        ],
        [
          'system operation read',
          `SELECT * FROM app_webhook_verification_operation_system_get($1::uuid)`,
          [operationId],
        ],
        [
          'system verification attempts read',
          `SELECT * FROM app_webhook_verification_attempts_system_get($1::uuid)`,
          [operationId],
        ],
        [
          'verification refusal',
          `SELECT app_webhook_config_verification_refused($1::uuid,'URL_POLICY_VIOLATION')`,
          [operationId],
        ],
      ];

      const refusal = /system work|system data|not readable from a request|not a request/;

      /** Names the doorway in the failure, so a regression says which one. */
      async function expectRefused(label: string, run: () => Promise<unknown>): Promise<void> {
        let message = '';
        try {
          await run();
        } catch (error) {
          message = (error as Error).message;
        }
        if (!refusal.test(message)) {
          throw new Error(`${label} was not refused (got: ${message || 'no error'})`);
        }
      }

      for (const [label, sql, args] of calls) {
        await expectRefused(`self-service ${label}`, () =>
          asSelfService(async (tx) => tx.$queryRawUnsafe(sql, ...args)),
        );
        await expectRefused(`organization ${label}`, () =>
          asTenant(async (tx) => tx.$queryRawUnsafe(sql, ...args)),
        );
      }
    });
  });

  describe('activation is proved by a successful verification attempt', () => {
    it('activates from the attempt, and only from a successful one', async () => {
      const configId = await createPendingConfig();
      const operationId = await createVerifyOperation(configId);
      const attemptId = await openAttempt(operationId, configId);

      // Still open: nothing has been proved yet.
      await expect(
        asSystem().$executeRawUnsafe(`SELECT app_webhook_config_activate($1::uuid)`, attemptId),
      ).rejects.toThrow(/did not succeed/);
      expect(await endpointStatus()).toBe('PENDING_VERIFICATION');

      await closeAttempt(attemptId, 'SUCCEEDED', null);
      await asSystem().$executeRawUnsafe(`SELECT app_webhook_config_activate($1::uuid)`, attemptId);
      expect(await endpointStatus()).toBe('ACTIVE');
    });

    it('will not activate from a failed attempt', async () => {
      const configId = await createPendingConfig();
      const operationId = await createVerifyOperation(configId);
      const attemptId = await openAttempt(operationId, configId);
      await settleResponse(attemptId, 'FAILED_PERMANENT', 'CHALLENGE_MISMATCH', 200);

      await expect(
        asSystem().$executeRawUnsafe(`SELECT app_webhook_config_activate($1::uuid)`, attemptId),
      ).rejects.toThrow(/did not succeed/);
      expect(await endpointStatus()).toBe('PENDING_VERIFICATION');
    });

    it('will not accept a successful attempt that belongs to another endpoint', async () => {
      // A second endpoint, verified for real, whose attempt is then offered as
      // proof for the first. Cross-wiring a genuine success is the interesting
      // attack, because the row itself is entirely valid.
      const otherEndpointId = randomUUID();
      await context.adminDb.$executeRawUnsafe(
        `INSERT INTO "webhook_endpoints"
           ("id","organization_id","description","status","slot","created_by_user_id","updated_at")
         VALUES ($1::uuid,$2::uuid,'second','PENDING_VERIFICATION',2,$3::uuid,now())`,
        otherEndpointId,
        university.organizationId,
        actorUserId,
      );

      const mine = await createPendingConfig();
      const myOperation = await createVerifyOperation(mine);

      // An attempt whose operation points at *my* config but whose own config
      // is the other endpoint's cannot even be opened.
      const [otherConfig] = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<{ app_webhook_config_create: string }>>(
          `SELECT app_webhook_config_create(
             gen_random_uuid(), $1::uuid, 'url-c','url-i','url-t','k2', $2, 'other.example', 443,
             'sec-c','sec-i','sec-t','k2', $3)`,
          otherEndpointId,
          'a'.repeat(64),
          'b'.repeat(64),
        ),
      );

      await expect(
        openAttempt(myOperation, otherConfig!.app_webhook_config_create),
      ).rejects.toThrow(/is not a verification of config/);
      expect(await endpointStatus()).toBe('PENDING_VERIFICATION');
    });

    it('resumes activation after a crash without sending a second challenge', async () => {
      // The real sequence: challenge answered, attempt closed SUCCEEDED, process
      // dies before activation. The reclaimed job must find the proof already on
      // disk — manufacturing a new verification fact to finish an old one is
      // exactly what must not happen.
      const configId = await createPendingConfig();
      const operationId = await createVerifyOperation(configId);
      const attemptId = await openAttempt(operationId, configId);
      await closeAttempt(attemptId, 'SUCCEEDED', null);

      const [resume] = await asSystem().$queryRawUnsafe<
        Array<{ succeeded_attempt_id: string | null; attempt_count: bigint }>
      >(`SELECT * FROM app_webhook_verification_operation_system_get($1::uuid)`, operationId);

      expect(resume?.succeeded_attempt_id).toBe(attemptId);
      expect(Number(resume?.attempt_count)).toBe(1);

      await asSystem().$executeRawUnsafe(
        `SELECT app_webhook_config_activate($1::uuid)`,
        resume!.succeeded_attempt_id,
      );
      expect(await endpointStatus()).toBe('ACTIVE');

      // No second attempt was needed to get there.
      const [after] = await asSystem().$queryRawUnsafe<Array<{ attempt_count: bigint }>>(
        `SELECT * FROM app_webhook_verification_operation_system_get($1::uuid)`,
        operationId,
      );
      expect(Number(after?.attempt_count)).toBe(1);
    });

    it('is idempotent when the activation itself is replayed', async () => {
      const configId = await createPendingConfig();
      const operationId = await createVerifyOperation(configId);
      const attemptId = await openAttempt(operationId, configId);
      await closeAttempt(attemptId, 'SUCCEEDED', null);

      await asSystem().$executeRawUnsafe(`SELECT app_webhook_config_activate($1::uuid)`, attemptId);
      // A crash after activation but before the job was marked done replays it.
      await asSystem().$executeRawUnsafe(`SELECT app_webhook_config_activate($1::uuid)`, attemptId);
      expect(await endpointStatus()).toBe('ACTIVE');
    });

    it('binds a recorded failure to the attempt that failed', async () => {
      const configId = await createPendingConfig();
      const operationId = await createVerifyOperation(configId);
      const attemptId = await openAttempt(operationId, configId);

      // One call, and it is the only way a receiver's answer can be recorded:
      // the attempt, the configuration's history and the intent all move
      // together or not at all.
      await settleResponse(attemptId, 'FAILED_PERMANENT', 'CHALLENGE_MISMATCH', 200);

      const [row] = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<{ last_verification_error: string; status: string }>>(
          `SELECT "last_verification_error","status" FROM "webhook_config_version_safe"
            WHERE "id"=$1::uuid`,
          configId,
        ),
      );
      // The code an organization reads is the code the worker recorded, not one
      // a caller passed alongside an unrelated configuration id.
      expect(row?.last_verification_error).toBe('CHALLENGE_MISMATCH');
      expect(row?.status).toBe('PENDING');
      expect(await endpointStatus()).toBe('PENDING_VERIFICATION');
    });

    it('will not record a failure from an attempt that succeeded', async () => {
      const configId = await createPendingConfig();
      const operationId = await createVerifyOperation(configId);
      const attemptId = await openAttempt(operationId, configId);
      await closeAttempt(attemptId, 'SUCCEEDED', null);

      await expect(
        settleResponse(attemptId, 'FAILED_PERMANENT', 'CHALLENGE_MISMATCH', 200),
      ).rejects.toThrow(/is already SUCCEEDED/);
    });

    it('refuses to record a receiver answer without settling the intent', async () => {
      // The structural half of the atomicity: there is no doorway that closes a
      // verification attempt with a receiver's answer on its own, so no crash
      // can leave one durable while the same intent is still eligible for
      // another automatic request.
      const configId = await createPendingConfig();
      const operationId = await createVerifyOperation(configId);
      const attemptId = await openAttempt(operationId, configId);

      await expect(
        closeAttempt(attemptId, 'FAILED_PERMANENT', 'CHALLENGE_MISMATCH'),
      ).rejects.toThrow(/must settle atomically/);
      await expect(closeAttempt(attemptId, 'FAILED_RETRYABLE', 'HTTP_RETRYABLE')).rejects.toThrow(
        /must settle atomically/,
      );
      // A transport failure heard nothing at all, so it stays allowed.
      await expect(
        asSystem().$executeRawUnsafe(
          `SELECT app_webhook_verification_attempt_close(
             $1::uuid,'FAILED_RETRYABLE','CONNECT_TIMEOUT',NULL,30)`,
          attemptId,
        ),
      ).resolves.toBeDefined();
    });

    it('allows only one open attempt per verification operation', async () => {
      const configId = await createPendingConfig();
      const operationId = await createVerifyOperation(configId);
      await openAttempt(operationId, configId);

      // Storage truth rather than worker convention: a second worker cannot
      // open a parallel handshake for the same intent.
      await expect(openAttempt(operationId, configId)).rejects.toThrow(
        /Key \(operation_id\)=.* already exists/,
      );
    });
  });

  describe('the endpoint transition graph is closed', () => {
    async function activate(configId: string, salt = 'd'): Promise<void> {
      const operationId = await createVerifyOperation(configId, salt);
      const attemptId = await openAttempt(operationId, configId);
      await closeAttempt(attemptId, 'SUCCEEDED', null);
      await asSystem().$executeRawUnsafe(`SELECT app_webhook_config_activate($1::uuid)`, attemptId);
    }

    async function lifecycle(status: string): Promise<void> {
      await asTenant(async (tx) =>
        tx.$executeRawUnsafe(
          `SELECT app_webhook_endpoint_lifecycle($1::uuid, $2::"WebhookEndpointStatus")`,
          endpointId,
          status,
        ),
      );
    }

    it('walks ACTIVE → PAUSED → ACTIVE → DISABLED', async () => {
      await activate(await createPendingConfig());
      expect(await endpointStatus()).toBe('ACTIVE');

      await lifecycle('PAUSED');
      expect(await endpointStatus()).toBe('PAUSED');

      await lifecycle('ACTIVE');
      expect(await endpointStatus()).toBe('ACTIVE');

      await lifecycle('DISABLED');
      expect(await endpointStatus()).toBe('DISABLED');
    });

    it('refuses every edge outside the graph', async () => {
      // An unverified endpoint cannot be paused: pausing is what you do to
      // something that is running.
      await expect(lifecycle('PAUSED')).rejects.toThrow(/only an active webhook endpoint/);
      await expect(lifecycle('ACTIVE')).rejects.toThrow(/through verification/);

      await activate(await createPendingConfig());
      // Verified is verified. There is no route back to unverified.
      await expect(lifecycle('PENDING_VERIFICATION')).rejects.toThrow(
        /never returns to PENDING_VERIFICATION/,
      );

      await lifecycle('DISABLED');
      for (const status of ['ACTIVE', 'PAUSED', 'PENDING_VERIFICATION']) {
        await expect(lifecycle(status)).rejects.toThrow(/no further transitions/);
      }
    });

    it('treats a same-state request as a safe no-op', async () => {
      await activate(await createPendingConfig());
      await lifecycle('ACTIVE');
      expect(await endpointStatus()).toBe('ACTIVE');
      await lifecycle('PAUSED');
      await lifecycle('PAUSED');
      expect(await endpointStatus()).toBe('PAUSED');
    });
  });

  describe('the delivery transition graph is closed', () => {
    async function makeTestDelivery(): Promise<string> {
      const configId = await createPendingConfig();
      const operationId = await createVerifyOperation(configId);
      const attemptId = await openAttempt(operationId, configId);
      await closeAttempt(attemptId, 'SUCCEEDED', null);
      await asSystem().$executeRawUnsafe(`SELECT app_webhook_config_activate($1::uuid)`, attemptId);

      const [row] = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<{ app_webhook_delivery_create_test: string }>>(
          `SELECT app_webhook_delivery_create_test($1::uuid, now(), $2)`,
          endpointId,
          'c'.repeat(64),
        ),
      );
      return row!.app_webhook_delivery_create_test;
    }

    /** Another delivery for an endpoint that is already active. */
    async function anotherTestDelivery(salt: string): Promise<string> {
      const [row] = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<{ app_webhook_delivery_create_test: string }>>(
          `SELECT app_webhook_delivery_create_test($1::uuid, now(), $2)`,
          endpointId,
          salt.repeat(64).slice(0, 64),
        ),
      );
      return row!.app_webhook_delivery_create_test;
    }

    async function move(deliveryId: string, status: string, skip: string | null = null) {
      await asSystem().$executeRawUnsafe(
        `SELECT app_webhook_delivery_transition(
           $1::uuid, $2::"WebhookDeliveryStatus", $3::"WebhookSkipReason",
           -- The parent-only doorway carries only what PalCert knows without a
           -- receiver: an interruption, or a configuration that stopped
           -- describing itself.
           CASE $2 WHEN 'FAILED_RETRYABLE' THEN 'WORKER_INTERRUPTED'
                   WHEN 'FAILED_PERMANENT' THEN 'WEBHOOK_CONFIG_INTEGRITY_MISMATCH' END,
           NULL,
           -- A retryable delivery must carry the time it waits for; the schema
           -- refuses one that does not, so the fixture supplies it.
           CASE WHEN $2 = 'FAILED_RETRYABLE' THEN now() + interval '5 minutes' END,
           false)`,
        deliveryId,
        status,
        skip,
      );
    }

    /** The only way to start a real attempt: the delivery and its attempt move together. */
    async function begin(deliveryId: string): Promise<string> {
      const [row] = await asSystem().$queryRawUnsafe<Array<{ attempt_id: string }>>(
        `SELECT * FROM app_webhook_delivery_attempt_begin($1::uuid, now())`,
        deliveryId,
      );
      return row!.attempt_id;
    }

    it('walks PENDING → SENDING → DELIVERED', async () => {
      const deliveryId = await makeTestDelivery();
      const attemptId = await begin(deliveryId);
      await asSystem().$executeRawUnsafe(
        `SELECT app_webhook_delivery_attempt_finish(
           $1::uuid,'SUCCEEDED',NULL,200,5,'DELIVERED',NULL)`,
        attemptId,
      );

      const [row] = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<{ status: string }>>(
          `SELECT "status" FROM "webhook_delivery_safe" WHERE "id"=$1::uuid`,
          deliveryId,
        ),
      );
      expect(row?.status).toBe('DELIVERED');
    });

    it('will not move a delivery into SENDING without opening its attempt', async () => {
      // Starting is one write now. The parent-only transition keeps the moves
      // that are not a network attempt, and nothing else.
      const deliveryId = await makeTestDelivery();
      await expect(move(deliveryId, 'SENDING')).rejects.toThrow(
        /cannot move from PENDING to SENDING/,
      );
    });

    it('will not let the parent-only transition touch the attempt counter', async () => {
      const deliveryId = await makeTestDelivery();
      await expect(
        asSystem().$executeRawUnsafe(
          `SELECT app_webhook_delivery_transition(
             $1::uuid,'FAILED_PERMANENT',NULL,'HTTP_PERMANENT',404,NULL,true)`,
          deliveryId,
        ),
      ).rejects.toThrow(/counted by the doorway that opens it/);
    });

    it('lets a zero-network refusal settle without ever having been SENDING', async () => {
      // A destination refused by policy, a failed integrity check or a missing
      // key are all decided before a socket is opened. Forcing such a delivery
      // through SENDING would record a network attempt that never happened.
      const deliveryId = await makeTestDelivery();
      await move(deliveryId, 'FAILED_PERMANENT');
    });

    it('refuses to jump PENDING straight to DELIVERED', async () => {
      const deliveryId = await makeTestDelivery();
      await expect(move(deliveryId, 'DELIVERED')).rejects.toThrow(
        /cannot move from PENDING to DELIVERED/,
      );
    });

    it('keeps a terminal delivery terminal, and free of new attempts', async () => {
      const deliveryId = await makeTestDelivery();
      const attemptId = await begin(deliveryId);
      await asSystem().$executeRawUnsafe(
        `SELECT app_webhook_delivery_attempt_finish(
           $1::uuid,'SUCCEEDED',NULL,200,5,'DELIVERED',NULL)`,
        attemptId,
      );

      for (const status of ['PENDING', 'FAILED_RETRYABLE']) {
        await expect(move(deliveryId, status)).rejects.toThrow(/cannot move from DELIVERED/);
      }

      // A delivered row whose history shows PalCert still trying afterwards is
      // a log that cannot be trusted in either direction.
      await expect(begin(deliveryId)).rejects.toThrow(/cannot begin an attempt/);
    });

    it('lets a retryable failure be attempted again, but not before it is due', async () => {
      const deliveryId = await makeTestDelivery();
      const attemptId = await begin(deliveryId);
      await asSystem().$executeRawUnsafe(
        `SELECT app_webhook_delivery_attempt_finish(
           $1::uuid,'FAILED_RETRYABLE','HTTP_RETRYABLE',503,5,'FAILED_RETRYABLE',
           -- Truncated to milliseconds so the value survives the round trip
           -- through a JavaScript Date and "exactly due" can be tested exactly.
           date_trunc('milliseconds', now() + interval '5 minutes'))`,
        attemptId,
      );

      // The business schedule is the database's to enforce, not the worker's to
      // remember. A receiver that asked for five minutes gets five minutes even
      // if the code calling this is wrong.
      await expect(begin(deliveryId)).rejects.toThrow(/is not due until/);

      const [row] = await context.adminDb.$queryRawUnsafe<
        Array<{ status: string; attempt_count: number; rows: bigint }>
      >(
        `SELECT d."status", d."attempt_count",
                (SELECT count(*) FROM "webhook_delivery_attempts" a
                  WHERE a."delivery_id" = d."id") AS rows
           FROM "webhook_deliveries" d WHERE d."id" = $1::uuid`,
        deliveryId,
      );
      // Refused means refused: nothing moved, nothing counted, nothing opened.
      expect(row!.status).toBe('FAILED_RETRYABLE');
      expect(row!.attempt_count).toBe(1);
      expect(Number(row!.rows)).toBe(1);

      // Exactly due is due.
      const [due] = await context.adminDb.$queryRawUnsafe<Array<{ next_attempt_at: Date }>>(
        `SELECT "next_attempt_at" FROM "webhook_deliveries" WHERE "id" = $1::uuid`,
        deliveryId,
      );
      const [begun] = await asSystem().$queryRawUnsafe<Array<{ attempt_id: string }>>(
        `SELECT * FROM app_webhook_delivery_attempt_begin($1::uuid, $2::timestamptz)`,
        deliveryId,
        due!.next_attempt_at,
      );
      expect(begun!.attempt_id).toBeDefined();
    });

    it('lets a pending delivery begin immediately', async () => {
      const deliveryId = await makeTestDelivery();
      await expect(begin(deliveryId)).resolves.toBeDefined();
    });

    it('refuses to record a receiver status through the parent-only doorway', async () => {
      const deliveryId = await makeTestDelivery();
      await expect(
        asSystem().$executeRawUnsafe(
          `SELECT app_webhook_delivery_transition(
             $1::uuid,'FAILED_PERMANENT',NULL,'WEBHOOK_CONFIG_INTEGRITY_MISMATCH',404,NULL,false)`,
          deliveryId,
        ),
      ).rejects.toThrow(/receiver status belongs to the attempt/);
    });

    it.each([['HTTP_RETRYABLE'], ['HTTP_PERMANENT'], ['REDIRECT_REFUSED'], ['ENDPOINT_GONE']])(
      'refuses to manufacture a %s without an attempt',
      async (code) => {
        // Every one of these is something a receiver said. Saying it requires an
        // attempt that heard it, and the atomic finish is the only doorway that
        // can write one.
        const deliveryId = await makeTestDelivery();
        await expect(
          asSystem().$executeRawUnsafe(
            `SELECT app_webhook_delivery_transition(
             $1::uuid,'FAILED_PERMANENT',NULL,$2,NULL,NULL,false)`,
            deliveryId,
            code,
          ),
        ).rejects.toThrow(/cannot move from PENDING to FAILED_PERMANENT this way/);
      },
    );

    it('keeps the parent-only shapes that need no receiver', async () => {
      const skipped = await makeTestDelivery();
      await expect(
        asSystem().$executeRawUnsafe(
          `SELECT app_webhook_delivery_transition(
             $1::uuid,'SKIPPED','ENDPOINT_INACTIVE',NULL,NULL,NULL,false)`,
          skipped,
        ),
      ).resolves.toBeDefined();

      const refused = await anotherTestDelivery('1');
      await expect(
        asSystem().$executeRawUnsafe(
          `SELECT app_webhook_delivery_transition(
             $1::uuid,'FAILED_PERMANENT',NULL,'URL_POLICY_VIOLATION',NULL,NULL,false)`,
          refused,
        ),
      ).resolves.toBeDefined();

      const interrupted = await anotherTestDelivery('2');
      await expect(
        asSystem().$executeRawUnsafe(
          `SELECT app_webhook_delivery_transition(
             $1::uuid,'FAILED_RETRYABLE',NULL,'WORKER_INTERRUPTED',NULL,
             now() + interval '1 minute',false)`,
          interrupted,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('tenant support reads cannot cross an organization', () => {
    it('shows an organization its own rows and nobody else’s', async () => {
      const configId = await createPendingConfig();
      const operationId = await createVerifyOperation(configId);
      const attemptId = await openAttempt(operationId, configId);
      await closeAttempt(attemptId, 'SUCCEEDED', null);
      await asSystem().$executeRawUnsafe(`SELECT app_webhook_config_activate($1::uuid)`, attemptId);
      const [delivery] = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<{ app_webhook_delivery_create_test: string }>>(
          `SELECT app_webhook_delivery_create_test($1::uuid, now(), $2)`,
          endpointId,
          'c'.repeat(64),
        ),
      );
      // An attempt too, so the attempt projection has something to hide.
      await asSystem().$queryRawUnsafe(
        `SELECT * FROM app_webhook_delivery_attempt_begin($1::uuid, now())`,
        delivery!.app_webhook_delivery_create_test,
      );

      const other = await createUser(context, 'rival@example.com');
      const rival = await createTenant(context, 'Rival University', 'rival-admin@example.com');

      for (const view of [
        'webhook_delivery_safe',
        'webhook_delivery_attempt_safe',
        'webhook_verification_attempt_safe',
        'webhook_config_version_safe',
        'webhook_management_operation_safe',
        'webhook_event_safe',
      ]) {
        const mine = await asTenant(async (tx) =>
          tx.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${view}"`),
        );
        const theirs = await tenant.withTenant(
          { organizationId: rival.organizationId, userId: other.userId },
          async (tx) => tx.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${view}"`),
        );
        expect(theirs).toHaveLength(0);
        if (view !== 'webhook_event_safe') {
          expect(mine.length).toBeGreaterThan(0);
        }
      }
    });

    it('exposes only supportability fields, never anything sent or received', async () => {
      const configId = await createPendingConfig();
      const operationId = await createVerifyOperation(configId);
      const attemptId = await openAttempt(operationId, configId);
      await closeAttempt(attemptId, 'SUCCEEDED', null);

      const [row] = await asTenant(async (tx) =>
        tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT * FROM "webhook_verification_attempt_safe" WHERE "id"=$1::uuid`,
          attemptId,
        ),
      );
      const columns = Object.keys(row!);
      expect(columns).toContain('outcome');
      expect(columns).toContain('http_status');
      for (const forbidden of [
        'challenge',
        'signature',
        'url',
        'request_body',
        'response_body',
        'response_headers',
        'resolved_ip',
      ]) {
        expect(columns).not.toContain(forbidden);
      }
    });

    it('keeps every safe projection read-only', async () => {
      // The database grants `arwd` on each new relation by default and a
      // single-table view is auto-updatable, so a read projection is a write
      // path back into its base table unless the grant is taken away.
      for (const view of [
        'webhook_delivery_safe',
        'webhook_delivery_attempt_safe',
        'webhook_verification_attempt_safe',
        'webhook_config_version_safe',
        'webhook_management_operation_safe',
        'webhook_event_safe',
      ]) {
        const privileges = await context.adminDb.$queryRawUnsafe<Array<{ privilege_type: string }>>(
          `SELECT privilege_type FROM information_schema.role_table_grants
            WHERE grantee='palcert_app' AND table_name=$1`,
          view,
        );
        expect(privileges.map((p) => p.privilege_type).sort()).toEqual(['SELECT']);
      }
    });
  });

  describe('webhook event data is derived, never supplied', () => {
    it('projects only the approved fields from the domain event payload', async () => {
      const [derived] = await context.adminDb.$queryRawUnsafe<Array<{ data: unknown }>>(
        `SELECT app_webhook_event_data_of('SUBMISSION_APPROVED'::"NotificationType",
           $1::jsonb) AS data`,
        JSON.stringify({
          submissionId: 'sub_1',
          submissionRevisionId: 'rev_1',
          institutionDecisionStatus: 'APPROVED',
          revisionNumber: 3,
          reviewerDisplayName: 'Somebody',
          documentTitle: 'Thesis',
        }),
      );

      // `revisionNumber` is real but not part of this event type's contract, and
      // the two extra keys are exactly what must never reach a third party's
      // logs. All three are dropped by the projection rather than by a caller
      // remembering to leave them out.
      expect(derived?.data).toEqual({
        submissionId: 'sub_1',
        submissionRevisionId: 'rev_1',
        institutionDecisionStatus: 'APPROVED',
      });
    });

    it('takes no payload parameter at all', async () => {
      // The old signature accepted arbitrary JSONB. Its absence is the fix, so
      // the absence is what is asserted.
      const [row] = await context.adminDb.$queryRawUnsafe<Array<{ args: string }>>(
        `SELECT pg_get_function_identity_arguments(oid) AS args
           FROM pg_proc WHERE proname = 'app_webhook_event_create'`,
      );
      expect(row?.args).toBe('p_domain_event_id uuid, p_webhook_event_id uuid, p_body_sha256 text');
      expect(row?.args).not.toContain('jsonb');
    });
  });
});

/**
 * The mirror of the system matrix.
 *
 * The system boundary was made explicit; its complement was left implicit, and
 * an implicit complement is not a boundary. The ownership guard read "if an
 * organization is resolved and it is not this one, refuse" — which says nothing
 * when no organization is resolved, so a self-service caller passed it and
 * could then name any endpoint by UUID.
 *
 * A webhook management action requires a real person inside a real
 * organization. Both halves, always.
 */
describe('Webhooks — tenant actor authority (e2e)', () => {
  let context: TestContext;
  let tenant: TenantPrismaService;
  let university: TenantFixture;
  let rival: TenantFixture;
  let actorUserId: string;
  let rivalUserId: string;
  let endpointId: string;
  let configId: string;

  const asSystem = () => context.prisma;

  async function asTenantOf<T>(
    org: string,
    user: string,
    fn: (tx: TenantClient) => Promise<T>,
  ): Promise<T> {
    return tenant.withTenant({ organizationId: org, userId: user }, fn);
  }

  async function asUserOnly<T>(fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    return tenant.withUser(actorUserId, fn);
  }

  async function asOrganizationOnly<T>(fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    return context.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('palcert.current_organization_id', $1, true)`,
        university.organizationId,
      );
      return fn(tx as unknown as TenantClient);
    });
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

    const outsider = await createUser(context, 'rival-owner@example.com');
    rivalUserId = outsider.userId;
    rival = await createTenant(context, 'Rival University', 'rival-registrar@example.com');

    endpointId = randomUUID();
    await context.adminDb.$executeRawUnsafe(
      `INSERT INTO "webhook_endpoints"
         ("id","organization_id","description","status","slot","created_by_user_id","updated_at")
       VALUES ($1::uuid,$2::uuid,'primary','PENDING_VERIFICATION',1,$3::uuid,now())`,
      endpointId,
      university.organizationId,
      actorUserId,
    );

    const [row] = await asTenantOf(university.organizationId, actorUserId, async (tx) =>
      tx.$queryRawUnsafe<Array<{ app_webhook_config_create: string }>>(
        `SELECT app_webhook_config_create(
           gen_random_uuid(), $1::uuid, 'url-c','url-i','url-t','k2', $2, 'receiver.example', 443,
           'sec-c','sec-i','sec-t','k2', $3)`,
        endpointId,
        'a'.repeat(64),
        'b'.repeat(64),
      ),
    );
    configId = row!.app_webhook_config_create;
  });

  it('recognises only "a user inside an organization" as a tenant actor', async () => {
    const read = async (tx: { $queryRawUnsafe: TenantClient['$queryRawUnsafe'] }) =>
      (
        await tx.$queryRawUnsafe<Array<{ actor: boolean }>>(
          `SELECT app_is_webhook_tenant_actor_context() AS actor`,
        )
      )[0]!.actor;

    expect(await asTenantOf(university.organizationId, actorUserId, read)).toBe(true);
    expect(await read(asSystem())).toBe(false);
    expect(await asUserOnly(read)).toBe(false);
    expect(await asOrganizationOnly(read)).toBe(false);
  });

  describe('endpoint lifecycle', () => {
    async function lifecycle(
      run: (fn: (tx: TenantClient) => Promise<unknown>) => Promise<unknown>,
      status: string,
    ) {
      return run(async (tx) =>
        tx.$executeRawUnsafe(
          `SELECT app_webhook_endpoint_lifecycle($1::uuid, $2::"WebhookEndpointStatus")`,
          endpointId,
          status,
        ),
      );
    }

    it('allows a legal transition for the owning actor', async () => {
      await lifecycle((fn) => asTenantOf(university.organizationId, actorUserId, fn), 'DISABLED');
      const [row] = await context.adminDb.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT "status" FROM "webhook_endpoints" WHERE "id"=$1::uuid`,
        endpointId,
      );
      expect(row?.status).toBe('DISABLED');
    });

    it('refuses the wrong organization', async () => {
      await expect(
        lifecycle((fn) => asTenantOf(rival.organizationId, rivalUserId, fn), 'DISABLED'),
      ).rejects.toThrow(/is not the caller's/);
    });

    it('refuses a user with no organization', async () => {
      // This is the defect: the old guard only compared organizations when one
      // was resolved, so a self-service caller could disable somebody's
      // integration by knowing its UUID.
      await expect(lifecycle((fn) => asUserOnly(fn), 'DISABLED')).rejects.toThrow(
        /requires an organization actor/,
      );
    });

    it('refuses an organization with no user', async () => {
      await expect(lifecycle((fn) => asOrganizationOnly(fn), 'DISABLED')).rejects.toThrow(
        /requires an organization actor/,
      );
    });

    it('refuses a context with neither', async () => {
      await expect(
        asSystem().$executeRawUnsafe(
          `SELECT app_webhook_endpoint_lifecycle($1::uuid, 'DISABLED')`,
          endpointId,
        ),
      ).rejects.toThrow(/requires an organization actor/);

      const [row] = await context.adminDb.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT "status" FROM "webhook_endpoints" WHERE "id"=$1::uuid`,
        endpointId,
      );
      expect(row?.status).toBe('PENDING_VERIFICATION');
    });
  });

  describe('every tenant mutation takes the same matrix', () => {
    const calls = (): Array<[string, string, unknown[]]> => [
      [
        'config_create',
        `SELECT app_webhook_config_create(gen_random_uuid(), $1::uuid,'c','i','t','k2',$2,
           'receiver.example',443,'c','i','t','k2',$3)`,
        [endpointId, 'a'.repeat(64), 'b'.repeat(64)],
      ],
      [
        'management_operation_create',
        `SELECT app_webhook_management_operation_create(
           gen_random_uuid(),'VERIFY_CONFIG',$1,$2,$3::uuid,$4::uuid,NULL,NULL,NULL,NULL,NULL,NULL)`,
        ['d'.repeat(64), 'e'.repeat(64), endpointId, configId],
      ],
      [
        'delivery_create_test',
        `SELECT app_webhook_delivery_create_test($1::uuid, now(), $2)`,
        [endpointId, 'c'.repeat(64)],
      ],
      [
        'delivery_create_replay',
        `SELECT app_webhook_delivery_create_replay($1::uuid)`,
        [randomUUID()],
      ],
      [
        'reveal_read',
        `SELECT * FROM app_webhook_reveal_read($1::uuid,$2,$3,now())`,
        [randomUUID(), 'd'.repeat(64), 'e'.repeat(64)],
      ],
    ];

    async function expectRefused(
      label: string,
      run: () => Promise<unknown>,
      pattern: RegExp,
    ): Promise<void> {
      let message = '';
      try {
        await run();
      } catch (error) {
        message = (error as Error).message;
      }
      if (!pattern.test(message)) {
        throw new Error(`${label} was not refused (got: ${message || 'no error'})`);
      }
    }

    it('refuses a user with no organization, an organization with no user, and neither', async () => {
      for (const [label, sql, args] of calls()) {
        await expectRefused(
          `user-only ${label}`,
          () => asUserOnly(async (tx) => tx.$queryRawUnsafe(sql, ...args)),
          /requires an organization actor/,
        );
        await expectRefused(
          `organization-only ${label}`,
          () => asOrganizationOnly(async (tx) => tx.$queryRawUnsafe(sql, ...args)),
          /requires an organization actor/,
        );
        await expectRefused(
          `unscoped ${label}`,
          () => asSystem().$queryRawUnsafe(sql, ...args),
          /requires an organization actor/,
        );
      }
    });

    it('refuses another organization\u2019s actor before anything else is checked', async () => {
      for (const [label, sql, args] of calls()) {
        await expectRefused(
          `cross-tenant ${label}`,
          () =>
            asTenantOf(rival.organizationId, rivalUserId, async (tx) =>
              tx.$queryRawUnsafe(sql, ...args),
            ),
          /is not the caller's|does not exist|is not the caller's to recover/,
        );
      }
    });

    it('allows the owning actor once the domain prerequisites hold', async () => {
      // config_create needs only ownership; it supersedes the pending config
      // created in the fixture and returns a new one.
      const [created] = await asTenantOf(university.organizationId, actorUserId, async (tx) =>
        tx.$queryRawUnsafe<Array<{ app_webhook_config_create: string }>>(
          `SELECT app_webhook_config_create(gen_random_uuid(), $1::uuid,'c','i','t','k2',$2,
             'receiver.example',443,'c','i','t','k2',$3)`,
          endpointId,
          'a'.repeat(64),
          'b'.repeat(64),
        ),
      );
      expect(created?.app_webhook_config_create).toBeTruthy();

      const [operation] = await asTenantOf(university.organizationId, actorUserId, async (tx) =>
        tx.$queryRawUnsafe<Array<{ app_webhook_management_operation_create: string }>>(
          `SELECT app_webhook_management_operation_create(
             gen_random_uuid(),'VERIFY_CONFIG',$1,$2,$3::uuid,$4::uuid,NULL,NULL,NULL,NULL,NULL,NULL)`,
          'd'.repeat(64),
          'e'.repeat(64),
          endpointId,
          created!.app_webhook_config_create,
        ),
      );
      expect(operation?.app_webhook_management_operation_create).toBeTruthy();
    });

    it('will not let an operation name another organization\u2019s endpoint', async () => {
      // The foreign keys do not object to a valid id belonging to somebody
      // else, so the check has to be here.
      const rivalEndpoint = randomUUID();
      await context.adminDb.$executeRawUnsafe(
        `INSERT INTO "webhook_endpoints"
           ("id","organization_id","description","status","slot","created_by_user_id","updated_at")
         VALUES ($1::uuid,$2::uuid,'theirs','PENDING_VERIFICATION',1,$3::uuid,now())`,
        rivalEndpoint,
        rival.organizationId,
        rivalUserId,
      );

      await expect(
        asTenantOf(university.organizationId, actorUserId, async (tx) =>
          tx.$queryRawUnsafe(
            `SELECT app_webhook_management_operation_create(
               gen_random_uuid(),'TEST_ENDPOINT',$1,$2,$3::uuid,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
            'f'.repeat(64),
            'e'.repeat(64),
            rivalEndpoint,
          ),
        ),
      ).rejects.toThrow(/is not the caller's/);
    });
  });
});

/**
 * What a durable management operation is allowed to say.
 *
 * Two independent failures lived here. A composite foreign key with a nullable
 * column is not checked at all under MATCH SIMPLE, so an operation could name
 * another organization's configuration as long as it left the endpoint NULL.
 * And no rule required an operation to carry the resources its own type is
 * meaningless without.
 *
 * The row matters because it is what an idempotency key returns. An incomplete
 * or cross-tenant intent is not a request that fails later; it is a permanent
 * record that the request was legitimate.
 */
describe('Webhooks — management operation shape (e2e)', () => {
  let context: TestContext;
  let tenant: TenantPrismaService;
  let mine: TenantFixture;
  let theirs: TenantFixture;
  let myUserId: string;
  let theirUserId: string;
  let myEndpoint: string;
  let mySecondEndpoint: string;
  let theirEndpoint: string;
  let myConfig: string;
  let mySecondConfig: string;
  let theirConfig: string;
  let salt = 0;

  async function asActor<T>(
    org: string,
    user: string,
    fn: (tx: TenantClient) => Promise<T>,
  ): Promise<T> {
    return tenant.withTenant({ organizationId: org, userId: user }, fn);
  }

  async function makeEndpoint(org: string, user: string, slot: number): Promise<string> {
    const id = randomUUID();
    await context.adminDb.$executeRawUnsafe(
      `INSERT INTO "webhook_endpoints"
         ("id","organization_id","description","status","slot","created_by_user_id","updated_at")
       VALUES ($1::uuid,$2::uuid,'e','PENDING_VERIFICATION',$3::smallint,$4::uuid,now())`,
      id,
      org,
      slot,
      user,
    );
    return id;
  }

  async function makeConfig(org: string, user: string, endpoint: string): Promise<string> {
    const [row] = await asActor(org, user, async (tx) =>
      tx.$queryRawUnsafe<Array<{ app_webhook_config_create: string }>>(
        `SELECT app_webhook_config_create(
           gen_random_uuid(), $1::uuid,'c','i','t','k2',$2,'receiver.example',443,
           'c','i','t','k2',$3)`,
        endpoint,
        'a'.repeat(64),
        'b'.repeat(64),
      ),
    );
    return row!.app_webhook_config_create;
  }

  /** Each operation needs its own idempotency key; the index is per (org, type, key). */
  function nextKey(): string {
    salt += 1;
    return salt.toString(16).padStart(64, '0');
  }

  async function createOperation(
    operation: string,
    resources: { endpoint?: string | null; config?: string | null; delivery?: string | null },
    reveal = false,
    org = mine.organizationId,
    user = myUserId,
  ): Promise<string> {
    const [row] = await asActor(org, user, async (tx) =>
      tx.$queryRawUnsafe<Array<{ app_webhook_management_operation_create: string }>>(
        `SELECT app_webhook_management_operation_create(
           gen_random_uuid(), $1::"WebhookManagementOperationType", $2, $3,
           $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10, $11::timestamptz)`,
        operation,
        nextKey(),
        'e'.repeat(64),
        resources.endpoint ?? null,
        resources.config ?? null,
        resources.delivery ?? null,
        reveal ? 'rev-c' : null,
        reveal ? 'rev-i' : null,
        reveal ? 'rev-t' : null,
        reveal ? 'k2' : null,
        reveal ? new Date(Date.now() + 3_600_000).toISOString() : null,
      ),
    );
    return row!.app_webhook_management_operation_create;
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
    salt = 0;

    const owner = await createUser(context, 'mine-owner@example.com');
    myUserId = owner.userId;
    mine = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');

    const outsider = await createUser(context, 'theirs-owner@example.com');
    theirUserId = outsider.userId;
    theirs = await createTenant(context, 'Rival University', 'rival-registrar@example.com');

    myEndpoint = await makeEndpoint(mine.organizationId, myUserId, 1);
    mySecondEndpoint = await makeEndpoint(mine.organizationId, myUserId, 2);
    theirEndpoint = await makeEndpoint(theirs.organizationId, theirUserId, 1);

    myConfig = await makeConfig(mine.organizationId, myUserId, myEndpoint);
    mySecondConfig = await makeConfig(mine.organizationId, myUserId, mySecondEndpoint);
    theirConfig = await makeConfig(theirs.organizationId, theirUserId, theirEndpoint);
  });

  describe('configuration ownership', () => {
    it('refuses another organization\u2019s config when no endpoint is named', async () => {
      // The exact MATCH SIMPLE hole: the composite key is not checked when one
      // of its columns is NULL, so this row referenced nothing and satisfied
      // everything.
      await expect(
        createOperation('VERIFY_CONFIG', { endpoint: null, config: theirConfig }),
      ).rejects.toThrow(/config version .* is not the caller's/);
    });

    it('refuses another organization\u2019s config beside my own endpoint', async () => {
      await expect(
        createOperation('VERIFY_CONFIG', { endpoint: myEndpoint, config: theirConfig }),
      ).rejects.toThrow(/config version .* is not the caller's/);
    });

    it('refuses my own config from a different endpoint of mine', async () => {
      // Same tenant, so ownership passes; the two still describe different
      // integrations, and an operation about two things is an operation about
      // neither.
      await expect(
        createOperation('VERIFY_CONFIG', { endpoint: myEndpoint, config: mySecondConfig }),
      ).rejects.toThrow(/does not belong to endpoint/);
    });

    it('accepts the endpoint and config that belong together', async () => {
      await expect(
        createOperation('VERIFY_CONFIG', { endpoint: myEndpoint, config: myConfig }),
      ).resolves.toBeTruthy();
    });
  });

  describe('operation shape', () => {
    it('refuses VERIFY_CONFIG without an endpoint or without a config', async () => {
      await expect(
        createOperation('VERIFY_CONFIG', { endpoint: null, config: myConfig }),
      ).rejects.toThrow(/resource_shape/);
      await expect(
        createOperation('VERIFY_CONFIG', { endpoint: myEndpoint, config: null }),
      ).rejects.toThrow(/resource_shape/);
    });

    it('refuses ROTATE_SECRET with no recoverable secret', async () => {
      // A rotation whose secret was never recoverable is a rotation whose
      // result the caller can never have received.
      await expect(
        createOperation('ROTATE_SECRET', { endpoint: myEndpoint, config: myConfig }, false),
      ).rejects.toThrow(/complete reveal envelope/);
    });

    it('accepts the two secret-bearing operations when fully described', async () => {
      await expect(
        createOperation('CREATE_ENDPOINT', { endpoint: myEndpoint, config: myConfig }, true),
      ).resolves.toBeTruthy();
      await expect(
        createOperation('ROTATE_SECRET', { endpoint: myEndpoint, config: myConfig }, true),
      ).resolves.toBeTruthy();
    });

    it('refuses a secret on an operation that does not carry one', async () => {
      await expect(
        createOperation('UPDATE_URL', { endpoint: myEndpoint, config: myConfig }, true),
      ).rejects.toThrow(/no reveal material at all|does not carry a secret/);
    });

    it('refuses malformed TEST_ENDPOINT and REPLAY_DELIVERY shapes', async () => {
      // Both record a delivery and no configuration: the delivery already
      // carries the config it was sent under, and a second copy can drift.
      await expect(
        createOperation('TEST_ENDPOINT', { endpoint: myEndpoint, delivery: null }),
      ).rejects.toThrow(/resource_shape/);
      await expect(
        createOperation('REPLAY_DELIVERY', { endpoint: myEndpoint, delivery: null }),
      ).rejects.toThrow(/resource_shape/);
      await expect(
        createOperation('TEST_ENDPOINT', { endpoint: null, delivery: randomUUID() }),
      ).rejects.toThrow(/is not the caller's/);
    });

    /**
     * The exact bypass.
     *
     * `resource_shape` reads `reveal_expires_at` as proof that a secret was
     * issued — correct after cleanup, which removes the crypto columns and
     * leaves the window as history. At creation the two constraints together
     * accepted a row that set the window and stored nothing: one saw a non-null
     * expiry and called it secret-bearing, the other saw four NULLs and took
     * its "no material" branch.
     *
     * That is the worst shape this row can take. The caller is told to come
     * back within the window; when they do, recovery finds nothing, and the
     * record says PalCert issued a secret — so the absence reads as the
     * caller's mistake.
     */
    describe('creation-time reveal envelope', () => {
      /** Bypasses the function entirely, as a privileged direct write. */
      async function rawInsert(fields: {
        operation: string;
        ciphertext?: string | null;
        iv?: string | null;
        tag?: string | null;
        kid?: string | null;
        expires?: string | null;
      }): Promise<void> {
        await context.adminDb.$executeRawUnsafe(
          `INSERT INTO "webhook_management_operations"
             ("id","organization_id","operation","idempotency_key_hash","request_fingerprint",
              "actor_user_id","endpoint_id","config_version_id","delivery_id",
              "reveal_ciphertext","reveal_iv","reveal_auth_tag","reveal_encryption_key_id",
              "reveal_expires_at","updated_at")
           VALUES (gen_random_uuid(),$1::uuid,$2::"WebhookManagementOperationType",
                   $3,$4,$5::uuid,$6::uuid,$7::uuid,NULL,
                   $8,$9,$10,$11,$12::timestamptz,now())`,
          mine.organizationId,
          fields.operation,
          nextKey(),
          'e'.repeat(64),
          myUserId,
          myEndpoint,
          myConfig,
          fields.ciphertext ?? null,
          fields.iv ?? null,
          fields.tag ?? null,
          fields.kid ?? null,
          fields.expires ?? null,
        );
      }

      const future = () => new Date(Date.now() + 3_600_000).toISOString();

      it('refuses ROTATE_SECRET that claims a window but stores nothing', async () => {
        await expect(
          createOperation('ROTATE_SECRET', { endpoint: myEndpoint, config: myConfig }, false),
        ).rejects.toThrow(/complete reveal envelope/);

        // And with an expiry but no material, which is the
        // combination the two constraints used to wave through.
        await expect(rawInsert({ operation: 'ROTATE_SECRET', expires: future() })).rejects.toThrow(
          /complete reveal envelope/,
        );
      });

      it('refuses CREATE_ENDPOINT that claims a window but stores nothing', async () => {
        await expect(
          rawInsert({ operation: 'CREATE_ENDPOINT', expires: future() }),
        ).rejects.toThrow(/complete reveal envelope/);
      });

      it('refuses a partial envelope', async () => {
        // Material that cannot be opened, discovered only by whoever tries.
        await expect(
          rawInsert({ operation: 'ROTATE_SECRET', ciphertext: 'c', expires: future() }),
        ).rejects.toThrow(/complete reveal envelope/);
        await expect(
          rawInsert({
            operation: 'ROTATE_SECRET',
            ciphertext: 'c',
            iv: 'i',
            tag: 't',
            expires: future(),
          }),
        ).rejects.toThrow(/complete reveal envelope/);
        await expect(
          rawInsert({
            operation: 'ROTATE_SECRET',
            ciphertext: 'c',
            iv: 'i',
            tag: 't',
            kid: 'k2',
          }),
        ).rejects.toThrow(/complete reveal envelope|resource_shape/);
      });

      it('accepts both secret-bearing operations with a complete envelope', async () => {
        await expect(
          createOperation('CREATE_ENDPOINT', { endpoint: myEndpoint, config: myConfig }, true),
        ).resolves.toBeTruthy();
        await expect(
          createOperation('ROTATE_SECRET', { endpoint: myEndpoint, config: myConfig }, true),
        ).resolves.toBeTruthy();
      });

      it('refuses a non-secret operation carrying a window, or any crypto field', async () => {
        await expect(rawInsert({ operation: 'VERIFY_CONFIG', expires: future() })).rejects.toThrow(
          /no reveal material at all/,
        );
        await expect(rawInsert({ operation: 'VERIFY_CONFIG', ciphertext: 'c' })).rejects.toThrow(
          /no reveal material at all/,
        );
        await expect(rawInsert({ operation: 'UPDATE_URL', kid: 'k2' })).rejects.toThrow(
          /no reveal material at all/,
        );
      });

      it('still lets expiry cleanup leave a valid tombstone', async () => {
        const operationId = await createOperation(
          'ROTATE_SECRET',
          { endpoint: myEndpoint, config: myConfig },
          true,
        );

        await context.prisma.$executeRawUnsafe(
          `SELECT app_webhook_reveal_clear($1::uuid)`,
          operationId,
        );

        const [row] = await context.adminDb.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT * FROM "webhook_management_operations" WHERE "id"=$1::uuid`,
          operationId,
        );

        // The four crypto columns are gone; the window stays as history, which
        // is what keeps resource_shape satisfied for the tombstone.
        expect(row?.reveal_ciphertext).toBeNull();
        expect(row?.reveal_iv).toBeNull();
        expect(row?.reveal_auth_tag).toBeNull();
        expect(row?.reveal_encryption_key_id).toBeNull();
        expect(row?.reveal_expires_at).not.toBeNull();
        expect(row?.operation).toBe('ROTATE_SECRET');

        // The row is still a legal ROTATE_SECRET: touching an unrelated column
        // re-evaluates every CHECK on it, so this would fail if it were not.
        await expect(
          context.adminDb.$executeRawUnsafe(
            `UPDATE "webhook_management_operations" SET "updated_at"=now() WHERE "id"=$1::uuid`,
            operationId,
          ),
        ).resolves.toBeDefined();
      });
    });

    it('accepts a well-formed TEST_ENDPOINT once its delivery exists', async () => {
      const attemptId = await (async () => {
        const operationId = await createOperation('VERIFY_CONFIG', {
          endpoint: myEndpoint,
          config: myConfig,
        });
        const [opened] = await context.prisma.$queryRawUnsafe<
          Array<{ app_webhook_verification_attempt_open: string }>
        >(
          `SELECT app_webhook_verification_attempt_open($1::uuid, $2::uuid, now())`,
          operationId,
          myConfig,
        );
        const id = opened!.app_webhook_verification_attempt_open;
        await context.prisma.$executeRawUnsafe(
          `SELECT app_webhook_verification_attempt_close($1::uuid,'SUCCEEDED',NULL,200,20)`,
          id,
        );
        return id;
      })();

      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_config_activate($1::uuid)`,
        attemptId,
      );

      const [delivery] = await asActor(mine.organizationId, myUserId, async (tx) =>
        tx.$queryRawUnsafe<Array<{ app_webhook_delivery_create_test: string }>>(
          `SELECT app_webhook_delivery_create_test($1::uuid, now(), $2)`,
          myEndpoint,
          'c'.repeat(64),
        ),
      );

      await expect(
        createOperation('TEST_ENDPOINT', {
          endpoint: myEndpoint,
          delivery: delivery!.app_webhook_delivery_create_test,
        }),
      ).resolves.toBeTruthy();
    });
  });
});
