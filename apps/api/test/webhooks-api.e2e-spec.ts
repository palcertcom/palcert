import { randomUUID } from 'node:crypto';

import { API, type AuthClient } from './support/auth-client';
import {
  createTenant,
  createUser,
  inviteAndCaptureToken,
  PASSWORD,
  type TenantFixture,
} from './support/organization-client';
import { signIn } from './support/auth-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * The organization's webhook API (§B12).
 *
 * Everything here is an HTTP test against the real stack, because the things
 * worth proving are at the seams: what a permission does and does not allow,
 * what another organization's id answers, and what a repeated request returns.
 *
 * No test here expects a receiver to be reached. The SSRF guard refuses every
 * address a sandbox can host, which is correct, so the network edge lives in
 * the unit suites and this suite covers the intents on either side of it.
 */
describe('Webhooks — organization API (e2e)', () => {
  let context: TestContext;
  let university: TenantFixture;
  let admin: AuthClient;
  let reviewer: AuthClient;
  let rival: TenantFixture;

  const base = () => `${API}/organizations/${university.organizationId}/webhooks`;
  const key = () => ({ headers: { 'idempotency-key': randomUUID() } });

  async function member(email: string, roleCode: string): Promise<AuthClient> {
    const user = await createUser(context, email);
    const invitation = await inviteAndCaptureToken(
      context,
      university.owner.client,
      university.organizationId,
      email,
      roleCode,
    );
    const accepted = await user.client.post(`${API}/invitations/accept`, {
      token: invitation.token,
    });
    if (accepted.status !== 200) {
      throw new Error(`accept failed (${accepted.status}): ${JSON.stringify(accepted.body)}`);
    }
    return signIn(context, email, PASSWORD);
  }

  async function createEndpoint(
    client: AuthClient = admin,
    url = 'https://receiver.example/hooks/palcert',
    eventTypes: string[] = ['submission.approved'],
  ) {
    return client.post(
      `${base()}/endpoints`,
      { description: 'Primary integration', url, eventTypes },
      key(),
    );
  }

  const rivalBase = () => `${API}/organizations/${rival.organizationId}/webhooks`;

  interface ConfigVersionRow {
    readonly id: string;
    readonly version_number: number;
    readonly url_sha256: string;
    readonly host: string;
    readonly port: number;
  }

  /**
   * The sealed configurations, read with the administrative connection.
   *
   * `url_sha256` is a digest over the whole normalized URL, so comparing two of
   * them proves the destination survived a rotation byte for byte without any
   * test — or any read surface — ever seeing the path.
   */
  async function configVersions(endpointId: string): Promise<ConfigVersionRow[]> {
    return context.adminDb.$queryRawUnsafe<ConfigVersionRow[]>(
      `SELECT "id","version_number","url_sha256","host","port"
         FROM "webhook_endpoint_config_versions"
        WHERE "endpoint_id" = $1::uuid ORDER BY "version_number"`,
      endpointId,
    );
  }

  /** Verify the pending configuration the way a successful handshake does. */
  async function activate(
    endpointId: string,
    client: AuthClient = admin,
    root: string = base(),
  ): Promise<void> {
    const [endpoint] = await context.adminDb.$queryRawUnsafe<
      Array<{ pending_config_version_id: string | null }>
    >(
      `SELECT "pending_config_version_id" FROM "webhook_endpoints" WHERE "id" = $1::uuid`,
      endpointId,
    );
    const configId = endpoint!.pending_config_version_id!;
    const asked = await client.post(`${root}/endpoints/${endpointId}/verify`, {}, key());
    const [opened] = await context.prisma.$queryRawUnsafe<
      Array<{ app_webhook_verification_attempt_open: string }>
    >(
      `SELECT app_webhook_verification_attempt_open($1::uuid,$2::uuid, now())`,
      asked.body.operationId,
      configId,
    );
    const attemptId = opened!.app_webhook_verification_attempt_open;
    await context.prisma.$executeRawUnsafe(
      `SELECT app_webhook_verification_attempt_close($1::uuid,'SUCCEEDED',NULL,200,10)`,
      attemptId,
    );
    await context.prisma.$executeRawUnsafe(
      `SELECT app_webhook_config_activate($1::uuid)`,
      attemptId,
    );
  }

  /**
   * One ORIGINAL delivery, created through the system path fan-out uses.
   *
   * No job is enqueued for it, so nothing races the assertions: the worker
   * only ever sees the deliveries a test asks for through the API.
   */
  async function businessDelivery(endpointId: string): Promise<string> {
    const domainEventId = randomUUID();
    await context.adminDb.$executeRawUnsafe(
      `INSERT INTO "domain_events"
         ("id","event_type","event_schema_version","source_type","source_id",
          "aggregate_type","aggregate_id","owner_user_id","organization_id",
          "occurred_at","payload","webhook_eligible","created_at")
       VALUES ($1::uuid,'SUBMISSION_APPROVED',1,'SUBMISSION_DECISION_EVENT',gen_random_uuid(),
               'OFFICIAL_SUBMISSION',gen_random_uuid(),$2::uuid,$3::uuid,now(),
               $4::jsonb,true,now())`,
      domainEventId,
      university.owner.userId,
      university.organizationId,
      JSON.stringify({
        submissionId: randomUUID(),
        submissionRevisionId: randomUUID(),
        institutionDecisionStatus: 'APPROVED',
      }),
    );
    const [event] = await context.prisma.$queryRawUnsafe<
      Array<{ app_webhook_event_create: string }>
    >(
      `SELECT app_webhook_event_create($1::uuid,$2::uuid,$3)`,
      domainEventId,
      randomUUID(),
      'a'.repeat(64),
    );
    const [delivery] = await context.prisma.$queryRawUnsafe<
      Array<{ app_webhook_delivery_create_original: string | null }>
    >(
      `SELECT app_webhook_delivery_create_original($1::uuid,$2::uuid)`,
      event!.app_webhook_event_create,
      endpointId,
    );
    const deliveryId = delivery!.app_webhook_delivery_create_original;
    if (deliveryId === null) throw new Error('fan-out created no delivery');
    return deliveryId;
  }

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    university = await createTenant(context, 'Test University', 'owner@example.com');
    admin = university.owner.client;
    rival = await createTenant(context, 'Rival University', 'rival-owner@example.com');
  });

  describe('creating an endpoint', () => {
    it('returns the signing secret exactly once, and never stores it', async () => {
      const response = await createEndpoint();

      expect(response.status).toBe(201);
      expect(response.body.signingSecret).toMatch(/^whsec_/);
      expect(response.body.recoverableUntil).toEqual(expect.any(String));
      // A response carrying a credential is never stored by anything between.
      expect(response.headers['cache-control']).toBe('no-store');

      const secret = response.body.signingSecret as string;
      const stored = await context.adminDb.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM "webhook_endpoint_config_versions"
          WHERE "secret_ciphertext" LIKE $1`,
        `%${secret.slice(6, 20)}%`,
      );
      expect(Number(stored[0]!.count)).toBe(0);

      // And no read surface will hand it back.
      const detail = await admin.get(`${base()}/endpoints/${response.body.endpointId}`);
      expect(JSON.stringify(detail.body)).not.toContain(secret);
    });

    it('starts PENDING_VERIFICATION with a pending configuration and no destination yet', async () => {
      const created = await createEndpoint();
      const detail = await admin.get(`${base()}/endpoints/${created.body.endpointId}`);

      expect(detail.status).toBe(200);
      expect(detail.body.status).toBe('PENDING_VERIFICATION');
      expect(detail.body.pendingConfig.destination).toBe('https://receiver.example');
      expect(detail.body.pendingConfig.configVersion).toBe(1);
      // Nothing is live until something answers.
      expect(detail.body.destination).toBe('');
      expect(detail.body.subscribedEventTypes).toEqual(['submission.approved']);
    });

    it('refuses a destination the policy will not call', async () => {
      for (const url of [
        'http://receiver.example/hook',
        'https://192.0.2.10/hook',
        'https://receiver.example/hook?token=abc',
        'https://receiver.example:8080/hook',
      ]) {
        const response = await createEndpoint(admin, url);
        expect(response.status).toBe(422);
        expect(response.body.error.code).toBe('WEBHOOK_URL_NOT_ALLOWED');
      }
    });

    it('refuses an event type that is not one of the nine', async () => {
      const response = await createEndpoint(admin, 'https://receiver.example/hook', [
        'submission.everything',
      ]);
      expect(response.status).toBe(400);
    });

    it('holds the ten-endpoint limit', async () => {
      for (let i = 0; i < 10; i += 1) {
        const response = await createEndpoint(admin, `https://receiver-${i}.example/hook`);
        expect(response.status).toBe(201);
      }
      const eleventh = await createEndpoint(admin, 'https://receiver-11.example/hook');
      expect(eleventh.status).toBe(409);
      expect(eleventh.body.error.code).toBe('WEBHOOK_ENDPOINT_LIMIT_REACHED');
    });

    it('requires an idempotency key', async () => {
      const response = await admin.post(`${base()}/endpoints`, {
        description: 'No key',
        url: 'https://receiver.example/hook',
        eventTypes: [],
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('WEBHOOK_IDEMPOTENCY_KEY_REQUIRED');
    });
  });

  describe('idempotency', () => {
    it('returns the identical secret for the identical repeated request', async () => {
      const headers = { headers: { 'idempotency-key': randomUUID() } };
      const body = {
        description: 'Primary integration',
        url: 'https://receiver.example/hooks/palcert',
        eventTypes: ['submission.approved'],
      };

      const first = await admin.post(`${base()}/endpoints`, body, headers);
      const second = await admin.post(`${base()}/endpoints`, body, headers);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.endpointId).toBe(first.body.endpointId);
      expect(second.body.signingSecret).toBe(first.body.signingSecret);

      // And exactly one endpoint exists, not two.
      const list = await admin.get(`${base()}/endpoints`);
      expect(list.body).toHaveLength(1);
    });

    it('refuses the same key from another actor', async () => {
      const other = await member('second-admin@example.com', 'ORGANIZATION_ADMIN');
      const headers = { headers: { 'idempotency-key': randomUUID() } };
      const body = {
        description: 'Primary integration',
        url: 'https://receiver.example/hooks/palcert',
        eventTypes: [],
      };

      expect((await admin.post(`${base()}/endpoints`, body, headers)).status).toBe(201);
      const conflict = await other.post(`${base()}/endpoints`, body, headers);
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('WEBHOOK_IDEMPOTENCY_KEY_CONFLICT');
    });

    it('refuses the same key for a changed request', async () => {
      const headers = { headers: { 'idempotency-key': randomUUID() } };
      const body = {
        description: 'Primary integration',
        url: 'https://receiver.example/hooks/palcert',
        eventTypes: [],
      };

      expect((await admin.post(`${base()}/endpoints`, body, headers)).status).toBe(201);
      const reused = await admin.post(
        `${base()}/endpoints`,
        { ...body, url: 'https://elsewhere.example/hook' },
        headers,
      );
      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe('WEBHOOK_IDEMPOTENCY_KEY_REUSED');
    });

    it('fingerprints the meaning of the request, not the JSON that carried it', async () => {
      const headers = { headers: { 'idempotency-key': randomUUID() } };
      const first = await admin.post(
        `${base()}/endpoints`,
        {
          description: 'Primary integration',
          url: 'https://receiver.example/hooks/palcert',
          eventTypes: ['submission.approved', 'certificate.issued'],
        },
        headers,
      );
      // The same set, listed the other way round, and the same URL.
      const second = await admin.post(
        `${base()}/endpoints`,
        {
          description: 'Primary integration',
          url: 'https://receiver.example/hooks/palcert',
          eventTypes: ['certificate.issued', 'submission.approved'],
        },
        headers,
      );

      expect(second.status).toBe(201);
      expect(second.body.endpointId).toBe(first.body.endpointId);
    });

    it('refuses to reveal a secret once the recovery window has closed', async () => {
      const headers = { headers: { 'idempotency-key': randomUUID() } };
      const body = {
        description: 'Primary integration',
        url: 'https://receiver.example/hooks/palcert',
        eventTypes: [],
      };
      const first = await admin.post(`${base()}/endpoints`, body, headers);
      expect(first.status).toBe(201);

      // The window closes because time passed, not because anything edited the
      // row — the operation is immutable, and the sweeper is not the authority
      // for expiry either. The read path refuses on the clock, before it
      // decrypts anything.
      context.clock.advanceMinutes(24 * 60 + 1);
      const later = await signIn(context, 'owner@example.com', PASSWORD);

      const expired = await later.post(`${base()}/endpoints`, body, headers);
      expect(expired.status).toBe(410);
      expect(expired.body.error.code).toBe('WEBHOOK_IDEMPOTENCY_KEY_EXPIRED');
      expect(JSON.stringify(expired.body)).not.toContain('whsec_');
    });
  });

  describe('authorization', () => {
    it('lets an owner and an admin manage, and refuses a reviewer', async () => {
      reviewer = await member('reviewer@example.com', 'ORGANIZATION_REVIEWER');

      expect((await admin.get(`${base()}/endpoints`)).status).toBe(200);
      expect((await reviewer.get(`${base()}/endpoints`)).status).toBe(403);
      expect((await createEndpoint(reviewer)).status).toBe(403);
    });

    it('refuses a template manager', async () => {
      const templates = await member('templates@example.com', 'TEMPLATE_MANAGER');
      expect((await templates.get(`${base()}/endpoints`)).status).toBe(403);
      expect((await createEndpoint(templates)).status).toBe(403);
    });
  });

  describe('tenant isolation', () => {
    it('answers not-found for another organization’s endpoint', async () => {
      const theirs = await rival.owner.client.post(
        `${API}/organizations/${rival.organizationId}/webhooks/endpoints`,
        {
          description: 'Rival integration',
          url: 'https://rival.example/hook',
          eventTypes: [],
        },
        key(),
      );
      expect(theirs.status).toBe(201);

      // A real id from a real organization, asked for by another. The answer is
      // the same as for an id that never existed: a different one would be an
      // existence oracle for anyone who can guess.
      const stolen = await admin.get(`${base()}/endpoints/${theirs.body.endpointId}`);
      const invented = await admin.get(`${base()}/endpoints/${randomUUID()}`);
      expect(stolen.status).toBe(404);
      expect(stolen.body.error.code).toBe('WEBHOOK_ENDPOINT_NOT_FOUND');
      expect(invented.status).toBe(stolen.status);
      expect(invented.body.error.code).toBe(stolen.body.error.code);
    });

    it('never lists another organization’s endpoints', async () => {
      await rival.owner.client.post(
        `${API}/organizations/${rival.organizationId}/webhooks/endpoints`,
        { description: 'Rival integration', url: 'https://rival.example/hook', eventTypes: [] },
        key(),
      );
      await createEndpoint();

      const mine = await admin.get(`${base()}/endpoints`);
      expect(mine.body).toHaveLength(1);
      expect(mine.body[0].description).toBe('Primary integration');
    });
  });

  describe('subscriptions', () => {
    it('defaults to none and replaces the exact set', async () => {
      const created = await createEndpoint(admin, 'https://receiver.example/hook', []);
      const endpointId = created.body.endpointId;

      expect((await admin.get(`${base()}/endpoints/${endpointId}/subscriptions`)).body).toEqual([]);

      const replaced = await admin.put(`${base()}/endpoints/${endpointId}/subscriptions`, {
        eventTypes: ['certificate.revoked', 'submission.ready'],
      });
      expect(replaced.status).toBe(200);
      expect(replaced.body).toEqual(['certificate.revoked', 'submission.ready']);

      const emptied = await admin.put(`${base()}/endpoints/${endpointId}/subscriptions`, {
        eventTypes: [],
      });
      expect(emptied.body).toEqual([]);
    });

    it('accepts every one of the nine public event types and nothing else', async () => {
      const created = await createEndpoint(admin, 'https://receiver.example/hook', []);
      const endpointId = created.body.endpointId;
      const all = [
        'submission.ready',
        'submission.revision_ready',
        'submission.under_review',
        'submission.approved',
        'submission.rejected',
        'submission.revision_requested',
        'submission.comment_added',
        'certificate.issued',
        'certificate.revoked',
      ];

      const response = await admin.put(`${base()}/endpoints/${endpointId}/subscriptions`, {
        eventTypes: all,
      });
      expect(response.body).toEqual([...all].sort());

      const wildcard = await admin.put(`${base()}/endpoints/${endpointId}/subscriptions`, {
        eventTypes: ['*'],
      });
      expect(wildcard.status).toBe(400);
    });
  });

  describe('lifecycle', () => {
    it('will not resume an endpoint that has never verified', async () => {
      const created = await createEndpoint();
      const response = await admin.post(
        `${base()}/endpoints/${created.body.endpointId}/resume`,
        {},
      );
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('WEBHOOK_ENDPOINT_NOT_VERIFIED');
    });

    it('disables terminally, frees the slot, and refuses everything afterwards', async () => {
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;

      expect((await admin.post(`${base()}/endpoints/${endpointId}/disable`, {})).status).toBe(204);

      const detail = await admin.get(`${base()}/endpoints/${endpointId}`);
      expect(detail.body.status).toBe('DISABLED');

      for (const action of ['resume', 'pause', 'disable']) {
        const response = await admin.post(`${base()}/endpoints/${endpointId}/${action}`, {});
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('WEBHOOK_ENDPOINT_DISABLED');
      }

      // The slot came back, so a replacement can be created.
      expect((await createEndpoint(admin, 'https://replacement.example/hook')).status).toBe(201);
    });
  });

  describe('verification', () => {
    it('accepts a verification intent and keys the job by the operation', async () => {
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;

      const response = await admin.post(`${base()}/endpoints/${endpointId}/verify`, {}, key());
      expect(response.status).toBe(202);
      expect(response.body.configVersion).toBe(1);

      const jobs = await context.adminDb.processingJob.findMany({
        where: { jobType: 'WEBHOOK_ENDPOINT_VERIFY', resourceId: response.body.operationId },
      });
      expect(jobs).toHaveLength(1);
    });

    it('creates no second intent for the same key, and one for a new key', async () => {
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;
      const headers = { headers: { 'idempotency-key': randomUUID() } };

      const first = await admin.post(`${base()}/endpoints/${endpointId}/verify`, {}, headers);
      const repeat = await admin.post(`${base()}/endpoints/${endpointId}/verify`, {}, headers);
      expect(repeat.body.operationId).toBe(first.body.operationId);

      const again = await admin.post(`${base()}/endpoints/${endpointId}/verify`, {}, key());
      expect(again.body.operationId).not.toBe(first.body.operationId);
      expect(again.body.configVersionId).toBe(first.body.configVersionId);
    });

    it('refuses when nothing is waiting to be verified', async () => {
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;
      // Clear the pending configuration the way a real verification does — by
      // activating it through the approved system path. Editing the row
      // directly is refused, which is the guard doing its job.
      const [config] = await context.adminDb.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "webhook_endpoint_config_versions" WHERE "endpoint_id" = $1::uuid`,
        endpointId,
      );
      const asked = await admin.post(`${base()}/endpoints/${endpointId}/verify`, {}, key());
      const [attempt] = await context.prisma.$queryRawUnsafe<
        Array<{ app_webhook_verification_attempt_open: string }>
      >(
        `SELECT app_webhook_verification_attempt_open($1::uuid,$2::uuid, now())`,
        asked.body.operationId,
        config!.id,
      );
      const attemptId = attempt!.app_webhook_verification_attempt_open;
      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_verification_attempt_close($1::uuid,'SUCCEEDED',NULL,200,10)`,
        attemptId,
      );
      await context.prisma.$executeRawUnsafe(
        `SELECT app_webhook_config_activate($1::uuid)`,
        attemptId,
      );

      const response = await admin.post(`${base()}/endpoints/${endpointId}/verify`, {}, key());
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('WEBHOOK_NO_PENDING_CONFIG');
    });
  });

  describe('history', () => {
    it('shows configuration versions without ever showing a URL or ciphertext', async () => {
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;
      await admin.put(
        `${base()}/endpoints/${endpointId}/url`,
        { url: 'https://receiver-two.example/hook' },
        key(),
      );

      const versions = await admin.get(`${base()}/endpoints/${endpointId}/config-versions`);
      expect(versions.status).toBe(200);
      expect(versions.body).toHaveLength(2);
      expect(versions.body[0].configVersion).toBe(2);
      expect(versions.body[0].destination).toBe('https://receiver-two.example');

      const serialized = JSON.stringify(versions.body);
      for (const forbidden of ['/hook', 'ciphertext', 'authTag', 'whsec_', 'url_iv']) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('pages delivery history and stays inside the organization', async () => {
      await createEndpoint();
      const page = await admin.get(`${base()}/deliveries?limit=5`);
      expect(page.status).toBe(200);
      expect(page.body.items).toEqual([]);
      expect(page.body.nextCursor).toBeNull();
    });
  });

  /**
   * Every management action leaves a trail, and an idempotent repeat does not
   * (§B18). The trail says who did what to which endpoint; the "what" lives in
   * the immutable configuration versions, which is why nothing here needs a URL
   * or a secret to be useful.
   */
  describe('the audit trail', () => {
    async function auditActions(endpointId: string): Promise<string[]> {
      const rows = await context.adminDb.auditEvent.findMany({
        where: { targetType: 'WebhookEndpoint', targetId: endpointId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((row) => row.action);
    }

    it('records every management action once, with nothing sensitive in it', async () => {
      const created = await createEndpoint(admin, 'https://receiver.example/hooks/palcert');
      const endpointId = created.body.endpointId;

      await admin.put(`${base()}/endpoints/${endpointId}/description`, { description: 'Renamed' });
      await admin.post(`${base()}/endpoints/${endpointId}/verify`, {}, key());
      await activate(endpointId);
      await admin.put(
        `${base()}/endpoints/${endpointId}/subscriptions`,
        { eventTypes: ['certificate.issued'] },
        key(),
      );
      await admin.post(`${base()}/endpoints/${endpointId}/test`, {}, key());
      await admin.post(`${base()}/endpoints/${endpointId}/pause`, {});
      await admin.post(`${base()}/endpoints/${endpointId}/resume`, {});
      await admin.put(
        `${base()}/endpoints/${endpointId}/url`,
        { url: 'https://receiver-two.example/hook' },
        key(),
      );
      await admin.post(`${base()}/endpoints/${endpointId}/rotate-secret`, {}, key());
      await admin.post(`${base()}/endpoints/${endpointId}/disable`, {});

      const actions = await auditActions(endpointId);
      for (const expected of [
        'WEBHOOK_ENDPOINT_CREATED',
        'WEBHOOK_ENDPOINT_RENAMED',
        'WEBHOOK_ENDPOINT_VERIFICATION_REQUESTED',
        'WEBHOOK_ENDPOINT_SUBSCRIPTIONS_REPLACED',
        'WEBHOOK_ENDPOINT_TEST_REQUESTED',
        'WEBHOOK_ENDPOINT_PAUSED',
        'WEBHOOK_ENDPOINT_ACTIVE',
        'WEBHOOK_ENDPOINT_URL_CHANGED',
        'WEBHOOK_ENDPOINT_SECRET_ROTATED',
        'WEBHOOK_ENDPOINT_DISABLED',
      ]) {
        expect(actions).toContain(expected);
      }

      const rows = await context.adminDb.auditEvent.findMany({
        where: { targetType: 'WebhookEndpoint', targetId: endpointId },
      });
      const serialized = JSON.stringify(rows);
      for (const forbidden of [
        '/hooks/palcert',
        'receiver.example',
        'whsec_',
        'ciphertext',
        'authTag',
        'auth_tag',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('records a replay once and an idempotent repeat not at all', async () => {
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;
      await activate(endpointId);
      const sourceId = await businessDelivery(endpointId);
      const headers = { headers: { 'idempotency-key': randomUUID() } };

      await admin.post(`${base()}/deliveries/${sourceId}/replay`, {}, headers);
      await admin.post(`${base()}/deliveries/${sourceId}/replay`, {}, headers);

      const replays = (await auditActions(endpointId)).filter(
        (action) => action === 'WEBHOOK_DELIVERY_REPLAYED',
      );
      expect(replays).toHaveLength(1);
    });

    it('does not record a second creation, rotation or control message for an idempotent repeat', async () => {
      const createHeaders = { headers: { 'idempotency-key': randomUUID() } };
      const body = {
        description: 'Primary integration',
        url: 'https://receiver.example/hooks/palcert',
        eventTypes: ['submission.approved'],
      };
      const created = await admin.post(`${base()}/endpoints`, body, createHeaders);
      await admin.post(`${base()}/endpoints`, body, createHeaders);
      const endpointId = created.body.endpointId;
      await activate(endpointId);

      const testHeaders = { headers: { 'idempotency-key': randomUUID() } };
      await admin.post(`${base()}/endpoints/${endpointId}/test`, {}, testHeaders);
      await admin.post(`${base()}/endpoints/${endpointId}/test`, {}, testHeaders);

      const rotateHeaders = { headers: { 'idempotency-key': randomUUID() } };
      await admin.post(`${base()}/endpoints/${endpointId}/rotate-secret`, {}, rotateHeaders);
      await admin.post(`${base()}/endpoints/${endpointId}/rotate-secret`, {}, rotateHeaders);

      const actions = await auditActions(endpointId);
      const count = (action: string) => actions.filter((entry) => entry === action).length;
      // An idempotent repeat is the same mutation being re-read. A second entry
      // would make the trail claim a business change that never happened.
      expect(count('WEBHOOK_ENDPOINT_CREATED')).toBe(1);
      expect(count('WEBHOOK_ENDPOINT_TEST_REQUESTED')).toBe(1);
      expect(count('WEBHOOK_ENDPOINT_SECRET_ROTATED')).toBe(1);
    });
  });

  /**
   * Rotation changes the secret and nothing else (§B18).
   *
   * The destination is re-sealed from the source configuration's own material,
   * so the path an organization typed survives — a rotation that rebuilt the
   * URL from the tenant-safe projection would quietly move where its events go,
   * and nothing on the outside would show it until deliveries started 404ing.
   */
  describe('secret rotation', () => {
    it('re-seals the exact URL, path and all', async () => {
      const created = await createEndpoint(admin, 'https://receiver.example/hooks/palcert');
      const endpointId = created.body.endpointId;

      const rotated = await admin.post(
        `${base()}/endpoints/${endpointId}/rotate-secret`,
        {},
        key(),
      );

      expect(rotated.status).toBe(200);
      expect(rotated.headers['cache-control']).toBe('no-store');
      expect(rotated.body.signingSecret).toMatch(/^whsec_/);
      expect(rotated.body.signingSecret).not.toBe(created.body.signingSecret);

      const versions = await configVersions(endpointId);
      expect(versions).toHaveLength(2);
      expect(versions[1]!.url_sha256).toBe(versions[0]!.url_sha256);
      // And the secret really is a different one at rest, not the same row.
      const fingerprints = await context.adminDb.$queryRawUnsafe<
        Array<{ secret_fingerprint: string }>
      >(
        `SELECT "secret_fingerprint" FROM "webhook_endpoint_config_versions"
          WHERE "endpoint_id" = $1::uuid ORDER BY "version_number"`,
        endpointId,
      );
      expect(fingerprints[1]!.secret_fingerprint).not.toBe(fingerprints[0]!.secret_fingerprint);
    });

    it('preserves a non-default port and a deep path', async () => {
      const url = 'https://receiver.example:8443/tenants/42/hooks/palcert';
      const created = await createEndpoint(admin, url);
      expect(created.status).toBe(201);
      const endpointId = created.body.endpointId;

      expect(
        (await admin.post(`${base()}/endpoints/${endpointId}/rotate-secret`, {}, key())).status,
      ).toBe(200);

      const versions = await configVersions(endpointId);
      expect(versions[1]!.url_sha256).toBe(versions[0]!.url_sha256);
      expect(versions[1]!.host).toBe('receiver.example');
      expect(versions[1]!.port).toBe(8443);
      // The projection still refuses to show the path, rotation or not.
      const detail = await admin.get(`${base()}/endpoints/${endpointId}`);
      expect(JSON.stringify(detail.body)).not.toContain('/tenants/42');
    });

    it('rotates the pending configuration when one is waiting, not the verified one', async () => {
      const created = await createEndpoint(admin, 'https://receiver.example/first');
      const endpointId = created.body.endpointId;
      await activate(endpointId);
      const changed = await admin.put(
        `${base()}/endpoints/${endpointId}/url`,
        { url: 'https://receiver-two.example/second' },
        key(),
      );
      expect(changed.status).toBe(200);

      expect(
        (await admin.post(`${base()}/endpoints/${endpointId}/rotate-secret`, {}, key())).status,
      ).toBe(200);

      const versions = await configVersions(endpointId);
      expect(versions).toHaveLength(3);
      // The URL change the organization most recently chose is carried forward,
      // not thrown away in favour of the one still serving.
      expect(versions[2]!.url_sha256).toBe(versions[1]!.url_sha256);
      expect(versions[2]!.url_sha256).not.toBe(versions[0]!.url_sha256);
    });

    it('answers an identical repeat with the identical secret, even after the new configuration is verified', async () => {
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;
      await activate(endpointId);
      const headers = { headers: { 'idempotency-key': randomUUID() } };

      const first = await admin.post(
        `${base()}/endpoints/${endpointId}/rotate-secret`,
        {},
        headers,
      );
      expect(first.status).toBe(200);
      // Activating the rotated configuration moves the endpoint's current
      // version. A fingerprint that included it would refuse the retry here,
      // which is exactly when a caller who lost the response needs it.
      await activate(endpointId);

      const repeat = await admin.post(
        `${base()}/endpoints/${endpointId}/rotate-secret`,
        {},
        headers,
      );

      expect(repeat.status).toBe(200);
      expect(repeat.body.signingSecret).toBe(first.body.signingSecret);
      expect(repeat.body.configVersion).toBe(first.body.configVersion);
      expect(await configVersions(endpointId)).toHaveLength(2);
    });

    it('refuses the repeat once the recovery window has closed', async () => {
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;
      const headers = { headers: { 'idempotency-key': randomUUID() } };
      const first = await admin.post(
        `${base()}/endpoints/${endpointId}/rotate-secret`,
        {},
        headers,
      );
      expect(first.status).toBe(200);

      context.clock.advanceMinutes(24 * 60 + 1);
      const later = await signIn(context, 'owner@example.com', PASSWORD);

      const expired = await later.post(
        `${base()}/endpoints/${endpointId}/rotate-secret`,
        {},
        headers,
      );

      expect(expired.status).toBe(410);
      expect(expired.body.error.code).toBe('WEBHOOK_IDEMPOTENCY_KEY_EXPIRED');
      expect(JSON.stringify(expired.body)).not.toContain('whsec_');
      // And an expired recovery is not a second rotation.
      expect(await configVersions(endpointId)).toHaveLength(2);
    });
  });

  /**
   * Every durable operation answers a lost response the same way (§B18).
   *
   * One row per operation type, because the guarantee is per operation and a
   * matrix with a hole in it is a matrix that has not been checked.
   */
  describe('the six durable operations', () => {
    it('answers an exact repeat of a URL change with the same operation', async () => {
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;
      const headers = { headers: { 'idempotency-key': randomUUID() } };
      const body = { url: 'https://receiver-two.example/hook' };

      const first = await admin.put(`${base()}/endpoints/${endpointId}/url`, body, headers);
      const repeat = await admin.put(`${base()}/endpoints/${endpointId}/url`, body, headers);

      expect(repeat.status).toBe(200);
      expect(repeat.body.operationId).toBe(first.body.operationId);
      expect(repeat.body.configVersionId).toBe(first.body.configVersionId);
      expect(await configVersions(endpointId)).toHaveLength(2);
    });

    it('refuses a URL-change key reused for a different URL, and one from another actor', async () => {
      const other = await member('url-admin@example.com', 'ORGANIZATION_ADMIN');
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;
      const headers = { headers: { 'idempotency-key': randomUUID() } };

      expect(
        (
          await admin.put(
            `${base()}/endpoints/${endpointId}/url`,
            { url: 'https://receiver-two.example/hook' },
            headers,
          )
        ).status,
      ).toBe(200);

      const reused = await admin.put(
        `${base()}/endpoints/${endpointId}/url`,
        { url: 'https://receiver-three.example/hook' },
        headers,
      );
      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe('WEBHOOK_IDEMPOTENCY_KEY_REUSED');

      const stolen = await other.put(
        `${base()}/endpoints/${endpointId}/url`,
        { url: 'https://receiver-two.example/hook' },
        headers,
      );
      expect(stolen.status).toBe(409);
      expect(stolen.body.error.code).toBe('WEBHOOK_IDEMPOTENCY_KEY_CONFLICT');
    });

    it('refuses a verification key from another actor', async () => {
      const other = await member('verify-admin@example.com', 'ORGANIZATION_ADMIN');
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;
      const headers = { headers: { 'idempotency-key': randomUUID() } };

      expect(
        (await admin.post(`${base()}/endpoints/${endpointId}/verify`, {}, headers)).status,
      ).toBe(202);
      const stolen = await other.post(`${base()}/endpoints/${endpointId}/verify`, {}, headers);

      expect(stolen.status).toBe(409);
      expect(stolen.body.error.code).toBe('WEBHOOK_IDEMPOTENCY_KEY_CONFLICT');
    });

    it('answers an exact repeat of a control message with the same delivery', async () => {
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;
      await activate(endpointId);
      const headers = { headers: { 'idempotency-key': randomUUID() } };

      const first = await admin.post(`${base()}/endpoints/${endpointId}/test`, {}, headers);
      const repeat = await admin.post(`${base()}/endpoints/${endpointId}/test`, {}, headers);

      expect(first.status).toBe(202);
      expect(repeat.status).toBe(202);
      expect(repeat.body.deliveryId).toBe(first.body.deliveryId);
      expect(repeat.body.operationId).toBe(first.body.operationId);

      const deliveries = await context.adminDb.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM "webhook_deliveries" WHERE "endpoint_id" = $1::uuid`,
        endpointId,
      );
      expect(Number(deliveries[0]!.count)).toBe(1);
    });

    it('refuses a control-message key reused for another endpoint', async () => {
      const first = await createEndpoint();
      const second = await admin.post(
        `${base()}/endpoints`,
        {
          description: 'Second integration',
          url: 'https://receiver-two.example/hook',
          eventTypes: [],
        },
        key(),
      );
      await activate(first.body.endpointId);
      await activate(second.body.endpointId);
      const headers = { headers: { 'idempotency-key': randomUUID() } };

      expect(
        (await admin.post(`${base()}/endpoints/${first.body.endpointId}/test`, {}, headers)).status,
      ).toBe(202);
      const reused = await admin.post(
        `${base()}/endpoints/${second.body.endpointId}/test`,
        {},
        headers,
      );

      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe('WEBHOOK_IDEMPOTENCY_KEY_REUSED');
    });

    it('answers an exact repeat of a replay with the same replay', async () => {
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;
      await activate(endpointId);
      const sourceId = await businessDelivery(endpointId);
      const headers = { headers: { 'idempotency-key': randomUUID() } };

      const first = await admin.post(`${base()}/deliveries/${sourceId}/replay`, {}, headers);
      const repeat = await admin.post(`${base()}/deliveries/${sourceId}/replay`, {}, headers);

      expect(first.status).toBe(202);
      expect(repeat.status).toBe(202);
      expect(repeat.body.deliveryId).toBe(first.body.deliveryId);
      expect(repeat.body.operationId).toBe(first.body.operationId);
      expect(first.body.deliveryId).not.toBe(sourceId);

      const replays = await context.adminDb.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM "webhook_deliveries"
          WHERE "replay_of_delivery_id" = $1::uuid`,
        sourceId,
      );
      expect(Number(replays[0]!.count)).toBe(1);
    });

    it('refuses a replay key reused for a different delivery', async () => {
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;
      await activate(endpointId);
      const first = await businessDelivery(endpointId);
      const second = await businessDelivery(endpointId);
      const headers = { headers: { 'idempotency-key': randomUUID() } };

      expect((await admin.post(`${base()}/deliveries/${first}/replay`, {}, headers)).status).toBe(
        202,
      );
      const reused = await admin.post(`${base()}/deliveries/${second}/replay`, {}, headers);

      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe('WEBHOOK_IDEMPOTENCY_KEY_REUSED');
    });
  });

  /**
   * A control message is not an event (§B18).
   *
   * It has no event type at all, and the read model says so rather than
   * inventing one — a projection that fabricated a type would invite an
   * operator to read a test as business traffic.
   */
  describe('control messages in the read model', () => {
    it('shows a TEST delivery with no event type and no fabricated fields', async () => {
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;
      await activate(endpointId);
      const sent = await admin.post(`${base()}/endpoints/${endpointId}/test`, {}, key());
      expect(sent.status).toBe(202);

      const page = await admin.get(`${base()}/deliveries?endpointId=${endpointId}`);

      expect(page.status).toBe(200);
      const delivery = page.body.items.find(
        (item: { id: string }) => item.id === sent.body.deliveryId,
      );
      expect(delivery).toBeDefined();
      expect(delivery.kind).toBe('TEST');
      expect(delivery.eventType).toBeNull();
      // Removed rather than invented: a control message has no body digest to
      // publish and no occurrence but its own creation.
      expect(delivery).not.toHaveProperty('bodySha256');
      expect(delivery).not.toHaveProperty('occurredAt');

      // A control message projects no event at all, so there is nothing for a
      // read model to name — the null in the view is the row, not a default.
      const row = await context.adminDb.$queryRawUnsafe<
        Array<{ kind: string; webhook_event_id: string | null }>
      >(
        `SELECT "kind","webhook_event_id" FROM "webhook_deliveries" WHERE "id" = $1::uuid`,
        sent.body.deliveryId as string,
      );
      expect(row[0]!.kind).toBe('TEST');
      expect(row[0]!.webhook_event_id).toBeNull();
    });

    it('shows an attempt still in flight with no outcome yet', async () => {
      const created = await createEndpoint();
      const endpointId = created.body.endpointId;
      await activate(endpointId);
      const deliveryId = await businessDelivery(endpointId);

      await context.prisma.$queryRawUnsafe(
        `SELECT * FROM app_webhook_delivery_attempt_begin($1::uuid, now())`,
        deliveryId,
      );

      const attempts = await admin.get(`${base()}/deliveries/${deliveryId}/attempts`);

      expect(attempts.status).toBe(200);
      expect(attempts.body).toHaveLength(1);
      expect(attempts.body[0].outcome).toBeNull();
      expect(attempts.body[0].finishedAt).toBeNull();
      expect(attempts.body[0].attemptNumber).toBe(1);
    });
  });

  /**
   * A resource id from another organization answers exactly what a made-up one
   * does (§B18). Anything else is an existence oracle for anyone who can guess.
   */
  describe('resource ids from outside the organization', () => {
    let foreignEndpointId: string;
    let invented: string;

    beforeEach(async () => {
      const created = await rival.owner.client.post(
        `${rivalBase()}/endpoints`,
        {
          description: 'Rival integration',
          url: 'https://rival-receiver.example/hook',
          eventTypes: ['submission.approved'],
        },
        key(),
      );
      expect(created.status).toBe(201);
      foreignEndpointId = created.body.endpointId;
      invented = randomUUID();
    });

    it('answers not-found for an endpoint detail either way', async () => {
      const foreign = await admin.get(`${base()}/endpoints/${foreignEndpointId}`);
      const made_up = await admin.get(`${base()}/endpoints/${invented}`);

      expect(foreign.status).toBe(404);
      expect(made_up.status).toBe(404);
      expect(foreign.body.error.code).toBe(made_up.body.error.code);
    });

    it('answers not-found for rotation state either way', async () => {
      const foreign = await admin.get(`${base()}/endpoints/${foreignEndpointId}/rotation-pending`);
      const made_up = await admin.get(`${base()}/endpoints/${invented}/rotation-pending`);

      expect(foreign.status).toBe(404);
      expect(made_up.status).toBe(404);
      expect(foreign.body.error.code).toBe(made_up.body.error.code);
    });

    it('answers an empty history either way', async () => {
      for (const suffix of ['config-versions', 'verification-attempts', 'operations']) {
        const foreign = await admin.get(`${base()}/endpoints/${foreignEndpointId}/${suffix}`);
        const made_up = await admin.get(`${base()}/endpoints/${invented}/${suffix}`);

        expect(foreign.status).toBe(200);
        expect(made_up.status).toBe(200);
        expect(foreign.body).toEqual([]);
        expect(made_up.body).toEqual([]);
      }
      // The rival really does have a configuration to hide — the empty answer
      // above is isolation working, not an endpoint that never existed.
      expect(
        (
          await rival.owner.client.get(
            `${rivalBase()}/endpoints/${foreignEndpointId}/config-versions`,
          )
        ).body,
      ).toHaveLength(1);
    });

    it('answers an empty attempt history for another organization’s delivery', async () => {
      // A delivery that genuinely exists, in the rival's organization.
      await activate(foreignEndpointId, rival.owner.client, rivalBase());
      const sent = await rival.owner.client.post(
        `${rivalBase()}/endpoints/${foreignEndpointId}/test`,
        {},
        key(),
      );
      expect(sent.status).toBe(202);

      const foreign = await admin.get(`${base()}/deliveries/${sent.body.deliveryId}/attempts`);
      const made_up = await admin.get(`${base()}/deliveries/${randomUUID()}/attempts`);

      expect(foreign.status).toBe(200);
      expect(made_up.status).toBe(200);
      expect(foreign.body).toEqual([]);
      expect(made_up.body).toEqual([]);

      // And the rival's own read of it is not empty, so the answer above is
      // isolation rather than a delivery that never existed.
      const own = await rival.owner.client.get(
        `${rivalBase()}/deliveries?endpointId=${foreignEndpointId}`,
      );
      expect(own.body.items).toHaveLength(1);
    });

    it('filters the delivery collection to nothing for a foreign endpoint id', async () => {
      const page = await admin.get(`${base()}/deliveries?endpointId=${foreignEndpointId}`);

      expect(page.status).toBe(200);
      expect(page.body.items).toEqual([]);
    });
  });
});
