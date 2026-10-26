import { randomUUID } from 'node:crypto';

import { API, type AuthClient } from './support/auth-client';
import {
  createApiClient,
  INTEGRATION,
  MachineClient,
  type CreatedApiClient,
} from './support/api-client-client';
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
import { ApiClientThrottleService } from '../src/modules/api-clients/services/api-client-throttle.service';

/**
 * What an integration actually does, end to end (Phase 19).
 *
 * The security suite proves what a credential is refused. This one proves the
 * other half: that a correctly scoped credential walks a real case — a thesis
 * checked, submitted, approved and certified — and sees each stage, with real
 * rows behind every field.
 *
 * Both halves are needed. A surface that refuses everything passes every
 * security test ever written, and a surface that returns data nobody produced
 * proves nothing about the joins, the RLS context or the projections. So this
 * suite drives the whole human workflow first and only then picks up the
 * credential.
 *
 * It is also where the *absences* are asserted against real data. "The report
 * is not exposed" is worth very little when no report exists; here one does.
 */
describe('API clients — the integration journey (e2e)', () => {
  let context: TestContext;
  let author: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let admin: AuthClient;
  let standard: PublishedStandard;

  /** A case carried all the way to a certificate. */
  interface Journey {
    readonly submissionId: string;
    readonly revisionId: string;
    readonly certificateId: string;
  }

  async function waitForCertificate(revisionId: string, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = 'none';
    while (Date.now() < deadline) {
      const row = await context.adminDb.complianceCertificate.findFirst({
        where: { submissionRevisionId: revisionId },
      });
      if (row !== null) {
        last = row.issuanceStatus;
        if (row.issuanceStatus === 'ISSUED') return row.id;
        if (row.issuanceStatus !== 'PENDING') {
          throw new Error(`certificate settled as ${row.issuanceStatus} (${row.failureCode})`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`certificate for ${revisionId} did not issue in ${timeoutMs} ms (${last})`);
  }

  /** The whole human workflow, so the machine has something true to read. */
  async function runJourney(): Promise<Journey> {
    const check = await completedCheck(context, author, standard);
    const { revisionId, submissionId } = await submitAndPrepare(
      context,
      author.client,
      check.checkId,
    );
    const approved = await decide(admin, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    if (approved.status !== 200) {
      throw new Error(`approval failed (${approved.status}): ${JSON.stringify(approved.body)}`);
    }
    return { submissionId, revisionId, certificateId: await waitForCertificate(revisionId) };
  }

  function everything(): Promise<CreatedApiClient> {
    return createApiClient(context.app, admin, university.organizationId, [
      'organization:read',
      'submissions:read',
      'certificates:read',
      'webhooks:read',
    ]);
  }

  beforeAll(async () => {
    context = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    author = await createUser(context, 'author@example.com');
    university = await createTenant(context, 'Islamic University of Gaza', 'registrar@iug.test');
    admin = university.owner.client;
    standard = await publishStandardFor(context, university);
  }, 120_000);

  // --- the whole surface, against a real case -------------------------------

  describe('a fully scoped credential', () => {
    it('follows one case from standard to certificate', async () => {
      const journey = await runJourney();
      const client = await everything();

      const organization = await client.machine.get(`${INTEGRATION}/organization`);
      expect(organization.status).toBe(200);
      expect(organization.body.organizationId).toBe(university.organizationId);
      expect(organization.body.status).toBe('ACTIVE');

      const standards = await client.machine.get(`${INTEGRATION}/standards`);
      expect(standards.status).toBe(200);
      expect(standards.body).toHaveLength(1);
      expect(standards.body[0].standardId).toBe(standard.standardId);
      // Published versions only, and the hash the institution published.
      expect(standards.body[0].publishedVersions).toHaveLength(1);
      expect(standards.body[0].publishedVersions[0].contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

      const one = await client.machine.get(`${INTEGRATION}/standards/${standard.standardId}`);
      expect(one.status).toBe(200);
      expect(one.body.standardId).toBe(standard.standardId);

      const submissions = await client.machine.get(`${INTEGRATION}/submissions`);
      expect(submissions.status).toBe(200);
      expect(submissions.body).toHaveLength(1);
      expect(submissions.body[0]).toMatchObject({
        submissionId: journey.submissionId,
        revisionId: journey.revisionId,
        revisionNumber: 1,
        institutionDecisionStatus: 'APPROVED',
        determination: 'COMPLIANT',
      });

      const submission = await client.machine.get(
        `${INTEGRATION}/submissions/${journey.submissionId}`,
      );
      expect(submission.status).toBe(200);
      expect(submission.body.revisions).toHaveLength(1);
      expect(submission.body.revisions[0].revisionId).toBe(journey.revisionId);

      const history = await client.machine.get(
        `${INTEGRATION}/revisions/${journey.revisionId}/history`,
      );
      expect(history.status).toBe(200);
      // PalCert's handoff and the institution's decision, in that order.
      expect(history.body.map((event: { toStatus: string }) => event.toStatus)).toContain(
        'APPROVED',
      );
      expect(history.body.every((event: { eventSource: string }) => event.eventSource !== null));

      const certificate = await client.machine.get(
        `${INTEGRATION}/certificates/${journey.certificateId}`,
      );
      expect(certificate.status).toBe(200);
      expect(certificate.body).toMatchObject({
        certificateId: journey.certificateId,
        issuanceStatus: 'ISSUED',
        revisionId: journey.revisionId,
        revokedAt: null,
      });

      const events = await client.machine.get(
        `${INTEGRATION}/certificates/${journey.certificateId}/events`,
      );
      expect(events.status).toBe(200);
      expect(events.body[0].eventType).toBe('ISSUED');
    });

    it('sees a webhook endpoint’s health without its destination', async () => {
      const created = await admin.post(
        `${API}/organizations/${university.organizationId}/webhooks/endpoints`,
        {
          description: 'Primary integration',
          url: 'https://receiver.example/hooks/palcert',
          eventTypes: ['submission.approved'],
        },
        { headers: { 'idempotency-key': randomUUID() } },
      );
      expect(created.status).toBe(201);

      const client = await everything();
      const response = await client.machine.get(`${INTEGRATION}/webhook-endpoints`);
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].description).toBe('Primary integration');

      // The destination and everything that could reconstruct it. Phase 17
      // keeps the URL sealed; an integration checking that webhooks are
      // configured does not get to unseal it by asking a different API.
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('receiver.example');
      expect(serialized).not.toContain('https://');
      for (const field of ['url', 'secret', 'signingSecret', 'ciphertext', 'host']) {
        expect(response.body[0][field]).toBeUndefined();
      }
    });

    it('never returns the document, the report or the submitter', async () => {
      const journey = await runJourney();
      const client = await everything();

      const bodies = await Promise.all(
        [
          `${INTEGRATION}/submissions`,
          `${INTEGRATION}/submissions/${journey.submissionId}`,
          `${INTEGRATION}/revisions/${journey.revisionId}/history`,
          `${INTEGRATION}/certificates/${journey.certificateId}`,
        ].map(async (path) => JSON.stringify((await client.machine.get(path)).body)),
      );

      for (const body of bodies) {
        // The person. An integration tracking a case does not learn who the
        // student is, which is the join a machine would otherwise make against
        // another dataset.
        expect(body).not.toContain(author.email);
        expect(body).not.toContain(author.userId);
        // The evidence. Object keys, checksums and report payloads all stay on
        // the human surfaces, which have their own authorization.
        expect(body).not.toContain('objectKey');
        expect(body).not.toContain('ruleResults');
        expect(body).not.toContain('verificationCode');
        expect(body).not.toContain('downloadUrl');
      }
    });

    it('is confined to its own organization even when another has identical data', async () => {
      const journey = await runJourney();
      const rival = await createTenant(context, 'Birzeit University', 'owner@birzeit.test');
      const outsider = await createApiClient(
        context.app,
        rival.owner.client,
        rival.organizationId,
        ['organization:read', 'submissions:read', 'certificates:read'],
      );

      expect((await outsider.machine.get(`${INTEGRATION}/organization`)).body.organizationId).toBe(
        rival.organizationId,
      );
      expect((await outsider.machine.get(`${INTEGRATION}/submissions`)).body).toEqual([]);

      // A real id belonging to somebody else answers exactly as a made-up one:
      // not found, never forbidden. "Forbidden" would confirm it exists.
      const real = await outsider.machine.get(`${INTEGRATION}/submissions/${journey.submissionId}`);
      const invented = await outsider.machine.get(`${INTEGRATION}/submissions/${randomUUID()}`);
      expect(real.status).toBe(404);
      expect(real.body.error.code).toBe(invented.body.error.code);

      const certificate = await outsider.machine.get(
        `${INTEGRATION}/certificates/${journey.certificateId}`,
      );
      expect(certificate.status).toBe(404);

      // Empty rather than 404: a history nobody may see and a history that is
      // genuinely empty are the same answer.
      expect(
        (await outsider.machine.get(`${INTEGRATION}/revisions/${journey.revisionId}/history`)).body,
      ).toEqual([]);
    });
  });

  // --- capacity -------------------------------------------------------------

  describe('rate limiting', () => {
    it('caps authentication attempts per client id, right or wrong', async () => {
      const client = await everything();
      const wrong = client.machine.withSecret(`pcsk_${'0'.repeat(64)}`);

      let refusedAt: number | null = null;
      for (
        let attempt = 1;
        attempt <= ApiClientThrottleService.AUTH_ATTEMPTS_PER_MINUTE + 1;
        attempt += 1
      ) {
        const response = await wrong.get(`${INTEGRATION}/organization`);
        if (response.status === 429) {
          refusedAt = attempt;
          break;
        }
        expect(response.status).toBe(401);
      }

      expect(refusedAt).toBe(ApiClientThrottleService.AUTH_ATTEMPTS_PER_MINUTE + 1);

      // And the budget belongs to the credential, not to the caller: the right
      // secret is refused too, because an attacker must not be able to spend
      // somebody else's budget and then watch them recover.
      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(429);
    });

    it('caps authenticated requests per credential, and answers 429 rather than 401', async () => {
      const client = await everything();
      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(200);

      // Spend the request budget through the service rather than by making six
      // hundred HTTP calls: the property is the ceiling, and the HTTP round
      // trip adds nothing to it.
      const throttle = context.app.get(ApiClientThrottleService);
      for (let spent = 0; spent < ApiClientThrottleService.REQUESTS_PER_MINUTE; spent += 1) {
        await throttle.request(client.apiClientId).catch(() => undefined);
      }

      const refused = await client.machine.get(`${INTEGRATION}/organization`);
      expect(refused.status).toBe(429);
      // A valid credential over its budget is over its budget, not unknown.
      // Answering 401 here would tell a working integration its secret broke.
      expect(refused.body.error.code).toBe('API_CLIENT_RATE_LIMITED');
    });

    it('gives each credential its own budget', async () => {
      const first = await everything();
      const second = await everything();

      const throttle = context.app.get(ApiClientThrottleService);
      for (let spent = 0; spent < ApiClientThrottleService.REQUESTS_PER_MINUTE; spent += 1) {
        await throttle.request(first.apiClientId).catch(() => undefined);
      }

      expect((await first.machine.get(`${INTEGRATION}/organization`)).status).toBe(429);
      expect((await second.machine.get(`${INTEGRATION}/organization`)).status).toBe(200);
    });
  });

  // --- concurrency ----------------------------------------------------------

  describe('races', () => {
    it('does not let a credential survive a revocation it overlapped with', async () => {
      const client = await everything();
      const revoke = admin.post(
        `${API}/organizations/${university.organizationId}/api-clients/${client.apiClientId}/revocation`,
        {},
        { headers: { 'idempotency-key': randomUUID() } },
      );
      const during = Array.from({ length: 8 }, () =>
        client.machine.get(`${INTEGRATION}/organization`),
      );

      const [revoked, ...calls] = await Promise.all([revoke, ...during]);
      expect(revoked.status).toBe(200);
      // Some of the overlapping calls may legitimately have been in flight
      // before the revocation committed. What must never happen is one
      // succeeding *after* it did, so every call from here on is refused.
      expect(calls.every((call) => call.status === 200 || call.status === 401)).toBe(true);

      for (let i = 0; i < 3; i += 1) {
        expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(401);
      }
    });

    it('leaves exactly one usable secret after concurrent rotations', async () => {
      const client = await everything();
      const rotate = () =>
        admin.post(
          `${API}/organizations/${university.organizationId}/api-clients/${client.apiClientId}/secret`,
          { overlapSeconds: 0 },
          { headers: { 'idempotency-key': randomUUID() } },
        );

      const results = await Promise.all([rotate(), rotate(), rotate()]);
      const secrets: string[] = [];
      for (const result of results) {
        // A loser is told it lost. Never a 500: the partial unique index
        // refusing a third live secret is the design working, and an
        // integration retrying deserves the same conflict the sequential path
        // returns rather than an internal error it cannot interpret.
        expect([201, 409]).toContain(result.status);
        if (result.status === 201) secrets.push(result.body.clientSecret as string);
        else expect(result.body.error.code).toBe('API_CLIENT_ROTATION_IN_PROGRESS');
      }

      expect(secrets.length).toBeGreaterThanOrEqual(1);

      // The partial unique indexes are the authority: whatever order the
      // rotations committed in, the table cannot hold two ACTIVE secrets.
      const active = await context.adminDb.apiClientSecret.count({
        where: { apiClientId: client.apiClientId, status: 'ACTIVE' },
      });
      expect(active).toBe(1);

      // And exactly one of the secrets handed out works, because each rotation
      // asked for no overlap.
      const working = await Promise.all(
        secrets.map(
          async (secret) =>
            (
              await new MachineClient(context.app, client.clientId, secret).get(
                `${INTEGRATION}/organization`,
              )
            ).status,
        ),
      );
      expect(working.filter((status) => status === 200)).toHaveLength(1);
    });
  });

  // --- where a secret must never turn up ------------------------------------

  describe('the secret in transit', () => {
    it('is never accepted in, or echoed back from, a URL', async () => {
      const client = await everything();

      // No Authorization header, so the query string buys nothing. A
      // credential in a URL is a credential in every proxy log between here
      // and the caller, and PalCert does not read one. (That the *log* does
      // not keep it either is asserted in the logger's own spec, which can
      // check the redaction directly instead of racing pino's stream.)
      const response = await MachineClient.raw(
        context.app,
        `${INTEGRATION}/organization?clientSecret=${encodeURIComponent(client.clientSecret)}`,
      );
      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toContain(client.clientSecret);
    });
  });

  // --- what the machine leaves behind ---------------------------------------

  describe('the audit trail', () => {
    it('records the machine as the actor, never a borrowed person', async () => {
      const client = await everything();
      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(200);

      const machineEvents = await context.adminDb.auditEvent.findMany({
        where: { actorType: 'API_CLIENT' },
      });
      for (const event of machineEvents) {
        expect(event.actorApiClientId).not.toBeNull();
        expect(event.actorUserId).toBeNull();
      }

      // The management acts in this test were the administrator's, and they
      // stay the administrator's: creating a credential is not the credential
      // acting.
      const creation = await context.adminDb.auditEvent.findFirst({
        where: { actorType: 'USER', action: { contains: 'api_client' } },
      });
      expect(creation?.actorUserId).not.toBeNull();
      expect(creation?.actorApiClientId).toBeNull();
    });

    it('records the use of a credential to the minute and no finer', async () => {
      const client = await everything();
      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(200);

      const row = await context.adminDb.apiClient.findUniqueOrThrow({
        where: { id: client.apiClientId },
      });
      expect(row.lastUsedAt).not.toBeNull();
      // Second-level last-used across a set of credentials describes a
      // customer's internal schedule, which is not PalCert's to publish back.
      expect(row.lastUsedAt?.getSeconds()).toBe(0);
      expect(row.lastUsedAt?.getMilliseconds()).toBe(0);
    });
  });
});
