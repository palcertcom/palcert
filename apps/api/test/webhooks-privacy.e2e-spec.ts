import { randomUUID } from 'node:crypto';

import { API, type AuthClient } from './support/auth-client';
import { createTenant, type TenantFixture } from './support/organization-client';
import { WebhookCryptoService } from '../src/modules/webhooks/services/webhook-crypto.service';
import { WebhookFanoutService } from '../src/modules/webhooks/services/webhook-fanout.service';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * What must not leave PalCert, proved by looking for it.
 *
 * Asserting that a DTO has no `url` key is a test of the DTO's shape, which a
 * refactor can satisfy while moving the value somewhere else. These tests plant
 * distinctive values — a person's name, an email address, a document title, the
 * prose of a comment, a signing secret and a URL path that says what it holds —
 * and then search the serialized output of every surface an organization or an
 * operator can reach.
 *
 * The webhook payload is the surface that matters most. A webhook is an
 * external projection, and an integrator's server is somebody else's machine:
 * whatever PalCert puts in that body has left the building.
 */
describe('Webhooks — privacy sentinels (e2e)', () => {
  let context: TestContext;
  let university: TenantFixture;
  let admin: AuthClient;

  const SENTINELS = {
    person: 'Wajdi Al-Sentinel',
    email: 'wajdi.sentinel@example.org',
    title: 'Master Thesis On Sentinel Values',
    prose: 'The reviewer said the margins were wrong, sentinel comment body.',
    path: '/hooks/sentinel-path-token',
  } as const;

  const base = () => `${API}/organizations/${university.organizationId}/webhooks`;
  const key = () => ({ headers: { 'idempotency-key': randomUUID() } });

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
  });

  /** An eligible DomainEvent whose payload is full of things that must not travel. */
  async function eventWithSentinels(): Promise<string> {
    const id = randomUUID();
    await context.adminDb.$executeRawUnsafe(
      `INSERT INTO "domain_events"
         ("id","event_type","event_schema_version","source_type","source_id",
          "aggregate_type","aggregate_id","owner_user_id","organization_id",
          "occurred_at","payload","webhook_eligible","created_at")
       VALUES ($1::uuid,'SUBMISSION_APPROVED',1,'SUBMISSION_DECISION_EVENT',gen_random_uuid(),
               'OFFICIAL_SUBMISSION',gen_random_uuid(),$2::uuid,$3::uuid,$4::timestamptz,
               $5::jsonb,true,$4::timestamptz)`,
      id,
      university.owner.userId,
      university.organizationId,
      context.clock.now(),
      JSON.stringify({
        submissionId: randomUUID(),
        submissionRevisionId: randomUUID(),
        revisionNumber: 2,
        institutionDecisionStatus: 'APPROVED',
        // None of this belongs in an external projection.
        holderName: SENTINELS.person,
        holderEmail: SENTINELS.email,
        documentTitle: SENTINELS.title,
        reviewerComment: SENTINELS.prose,
      }),
    );
    return id;
  }

  it('projects an event without carrying anything about the person into the body', async () => {
    const created = await admin.post(
      `${base()}/endpoints`,
      {
        description: 'Primary integration',
        url: `https://receiver.example${SENTINELS.path}`,
        eventTypes: ['submission.approved'],
      },
      key(),
    );
    expect(created.status).toBe(201);

    const domainEventId = await eventWithSentinels();
    await context.workerApp.get(WebhookFanoutService).fanOut(domainEventId);

    const [event] = await context.adminDb.$queryRawUnsafe<
      Array<{ data: Record<string, unknown>; body_sha256: string }>
    >(
      `SELECT "data","body_sha256" FROM "webhook_events" WHERE "domain_event_id" = $1::uuid`,
      domainEventId,
    );

    const serialized = JSON.stringify(event!.data);
    for (const sentinel of Object.values(SENTINELS)) {
      expect(serialized).not.toContain(sentinel);
    }
    // And what it does carry is the allow-listed set, not "everything minus
    // the things this test happened to plant".
    // The allow-list is per event type and tighter than the payload: an
    // approval carries the decision and the two ids, and not the revision
    // number a ready event would.
    expect(Object.keys(event!.data).sort()).toEqual([
      'institutionDecisionStatus',
      'submissionId',
      'submissionRevisionId',
    ]);
  });

  it('keeps every sentinel out of every read surface an organization can reach', async () => {
    const created = await admin.post(
      `${base()}/endpoints`,
      {
        description: 'Primary integration',
        url: `https://receiver.example${SENTINELS.path}`,
        eventTypes: ['submission.approved'],
      },
      key(),
    );
    const endpointId = created.body.endpointId as string;
    const secret = created.body.signingSecret as string;

    const domainEventId = await eventWithSentinels();
    await context.workerApp.get(WebhookFanoutService).fanOut(domainEventId);

    const surfaces = await Promise.all([
      admin.get(`${base()}/endpoints`),
      admin.get(`${base()}/endpoints/${endpointId}`),
      admin.get(`${base()}/endpoints/${endpointId}/config-versions`),
      admin.get(`${base()}/endpoints/${endpointId}/verification-attempts`),
      admin.get(`${base()}/endpoints/${endpointId}/operations`),
      admin.get(`${base()}/endpoints/${endpointId}/rotation-pending`),
      admin.get(`${base()}/deliveries`),
    ]);

    for (const response of surfaces) {
      expect(response.status).toBe(200);
      const serialized = JSON.stringify(response.body);
      for (const sentinel of Object.values(SENTINELS)) {
        expect(serialized).not.toContain(sentinel);
      }
      // The secret is shown once, by the operation that minted it, and never
      // by a read.
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('whsec_');
      // Nor the sealed material that protects it.
      for (const forbidden of ['ciphertext', 'authTag', 'reveal_']) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  it('never stores the signing secret it showed', async () => {
    const created = await admin.post(
      `${base()}/endpoints`,
      { description: 'Primary integration', url: 'https://receiver.example/hook', eventTypes: [] },
      key(),
    );
    const secret = created.body.signingSecret as string;

    // Every text column of every Phase 17 table, searched for the value.
    const tables = [
      'webhook_endpoints',
      'webhook_endpoint_config_versions',
      'webhook_management_operations',
      'webhook_deliveries',
      'webhook_delivery_attempts',
      'webhook_verification_attempts',
      'webhook_events',
    ];
    for (const table of tables) {
      const [row] = await context.adminDb.$queryRawUnsafe<Array<{ found: boolean }>>(
        `SELECT EXISTS (
           SELECT 1 FROM "${table}" t WHERE t::text LIKE $1
         ) AS found`,
        `%${secret}%`,
      );
      expect(row!.found).toBe(false);
    }

    // The fingerprint is stored, and it is not the secret.
    const fingerprint = context.workerApp.get(WebhookCryptoService).fingerprint(secret);
    const [stored] = await context.adminDb.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM "webhook_endpoint_config_versions"
        WHERE "secret_fingerprint" = $1`,
      fingerprint,
    );
    expect(Number(stored!.count)).toBe(1);
    expect(fingerprint).not.toContain(secret);
  });

  it('keeps the sealed URL out of every tenant projection', async () => {
    const created = await admin.post(
      `${base()}/endpoints`,
      {
        description: 'Primary integration',
        url: `https://receiver.example${SENTINELS.path}`,
        eventTypes: [],
      },
      key(),
    );
    const endpointId = created.body.endpointId as string;

    const detail = await admin.get(`${base()}/endpoints/${endpointId}`);
    const versions = await admin.get(`${base()}/endpoints/${endpointId}/config-versions`);

    // The host is shown, because the organization needs to recognise its own
    // integration. The path is not: it is sealed, and PalCert does not open it
    // for a request.
    expect(JSON.stringify(detail.body)).toContain('receiver.example');
    expect(JSON.stringify(detail.body)).not.toContain(SENTINELS.path);
    expect(JSON.stringify(versions.body)).not.toContain(SENTINELS.path);
  });
});
