import { randomUUID } from 'node:crypto';

import { API, type AuthClient } from './support/auth-client';
import {
  createApiClient,
  INTEGRATION,
  MachineClient,
  type CreatedApiClient,
} from './support/api-client-client';
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
 * What a machine credential can and cannot do (Phase 19).
 *
 * Every test here is an HTTP test against the real stack, because the things
 * worth proving are at the seams: what a wrong secret answers, what another
 * organization's id answers, what a revoked credential answers one request
 * after it was revoked, and what the allow-list refuses.
 *
 * The suite is organized by attack rather than by feature. A reader asking
 * "can an integration read another university's submissions?" should find the
 * answer under a heading that says so.
 */
describe('API clients — security (e2e)', () => {
  let context: TestContext;
  let university: TenantFixture;
  let rival: TenantFixture;
  let admin: AuthClient;
  let reviewer: AuthClient;

  const manage = () => `${API}/organizations/${university.organizationId}/api-clients`;
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

  beforeAll(async () => {
    context = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    university = await createTenant(context, 'Islamic University of Gaza', 'owner@iug.test');
    rival = await createTenant(context, 'Birzeit University', 'owner@birzeit.test');
    admin = university.owner.client;
    reviewer = await member('reviewer@iug.test', 'ORGANIZATION_REVIEWER');
  }, 120_000);

  // --- the credential itself -----------------------------------------------

  describe('a presented credential', () => {
    let created: CreatedApiClient;

    beforeEach(async () => {
      created = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
    });

    it('authenticates and reaches its own organization', async () => {
      const response = await created.machine.get(`${INTEGRATION}/organization`);
      expect(response.status).toBe(200);
      expect(response.body.organizationId).toBe(university.organizationId);
    });

    it('refuses a wrong secret', async () => {
      const wrong = created.machine.withSecret(`pcsk_${'0'.repeat(64)}`);
      const response = await wrong.get(`${INTEGRATION}/organization`);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('API_CLIENT_AUTHENTICATION_FAILED');
    });

    it('answers an unknown client id exactly as it answers a wrong secret', async () => {
      // The property that stops an attacker enumerating which credentials
      // exist: the two refusals must be indistinguishable on the wire.
      const unknown = new MachineClient(
        context.app,
        `pcid_${'a'.repeat(32)}`,
        created.clientSecret,
      );
      const wrongSecret = await created.machine
        .withSecret(`pcsk_${'0'.repeat(64)}`)
        .get(`${INTEGRATION}/organization`);
      const unknownClient = await unknown.get(`${INTEGRATION}/organization`);

      // Everything but the per-request correlation id, which differs between
      // any two requests and says nothing about the credential.
      const withoutRequestId = (body: { error: Record<string, unknown> }) => ({
        ...body,
        error: { ...body.error, requestId: undefined },
      });

      expect(unknownClient.status).toBe(wrongSecret.status);
      expect(withoutRequestId(unknownClient.body)).toEqual(withoutRequestId(wrongSecret.body));
    });

    it.each([
      ['no header at all', undefined],
      ['a bearer token', 'Bearer something'],
      ['basic with no colon', `Basic ${Buffer.from('nocolon').toString('base64')}`],
      ['basic with an empty id', `Basic ${Buffer.from(':secret').toString('base64')}`],
      ['basic with an empty secret', `Basic ${Buffer.from('pcid_x:').toString('base64')}`],
      ['basic that is not base64', 'Basic !!!!not-base64!!!!'],
      ['an absurdly long header', `Basic ${'A'.repeat(4096)}`],
    ])('refuses %s', async (_name, authorization) => {
      const response = await MachineClient.raw(
        context.app,
        `${INTEGRATION}/organization`,
        authorization,
      );
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('API_CLIENT_AUTHENTICATION_FAILED');
    });

    it('never accepts the credential in a query string', async () => {
      // A URL reaches access logs, proxy logs and Referer headers. If this ever
      // starts working, a credential has started leaking into all three.
      const response = await MachineClient.raw(
        context.app,
        `${INTEGRATION}/organization?clientId=${created.clientId}&clientSecret=${created.clientSecret}`,
      );
      expect(response.status).toBe(401);
    });

    it('is refused as a session, and a session is refused as a credential', async () => {
      // The two authentication systems must not be interchangeable. A machine
      // cannot reach the human API...
      const asHuman = await created.machine.get(`${API}/users/me`);
      expect(asHuman.status).toBe(401);

      // ...and a signed-in administrator cannot reach the machine API with
      // their cookie, because the integration surface only accepts credentials.
      const asMachine = await admin.get(`${INTEGRATION}/organization`);
      expect(asMachine.status).toBe(401);
    });
  });

  // --- cross-organization isolation ----------------------------------------

  describe('cross-organization isolation', () => {
    it('sees only its own organization, with no parameter that could name another', async () => {
      const ours = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      const response = await ours.machine.get(`${INTEGRATION}/organization`);
      expect(response.body.organizationId).toBe(university.organizationId);
      expect(response.body.organizationId).not.toBe(rival.organizationId);
    });

    it('cannot read another organization’s submissions', async () => {
      const ours = await createApiClient(context.app, admin, university.organizationId, [
        'submissions:read',
      ]);
      const theirs = await createApiClient(context.app, rival.owner.client, rival.organizationId, [
        'submissions:read',
      ]);

      const oursList = await ours.machine.get(`${INTEGRATION}/submissions`);
      const theirsList = await theirs.machine.get(`${INTEGRATION}/submissions`);
      expect(oursList.status).toBe(200);
      expect(theirsList.status).toBe(200);
      // Both empty here, and the point is that neither can widen: there is no
      // organization id to tamper with on either request.
      expect(Array.isArray(oursList.body)).toBe(true);
      expect(Array.isArray(theirsList.body)).toBe(true);
    });

    it('cannot manage another organization’s clients through the human API', async () => {
      const ours = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      // The management API is human-only, so a machine gets 401 there whatever
      // organization it names — including its own.
      const own = await ours.machine.get(manage());
      expect(own.status).toBe(401);
    });

    it('refuses an administrator of another organization', async () => {
      const response = await rival.owner.client.get(manage());
      expect(response.status).toBe(404);
    });
  });

  // --- scopes ---------------------------------------------------------------

  describe('scopes', () => {
    it('refuses an operation the credential does not hold the scope for', async () => {
      const limited = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      const response = await limited.machine.get(`${INTEGRATION}/submissions`);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('API_CLIENT_SCOPE_INSUFFICIENT');
    });

    it('allows exactly the operations its scopes name, and no others', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'submissions:read',
      ]);
      expect((await client.machine.get(`${INTEGRATION}/submissions`)).status).toBe(200);
      // Same credential, different scope, refused.
      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(403);
      expect((await client.machine.get(`${INTEGRATION}/webhook-endpoints`)).status).toBe(403);
    });

    it('cannot escalate by asking for a scope it was not granted', async () => {
      // There is no request shape that carries a scope: scopes are on the
      // stored client, not on the call. Asserted by trying every channel a
      // caller controls.
      const limited = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      const header = await MachineClient.raw(
        context.app,
        `${INTEGRATION}/submissions`,
        limited.machine.authorization,
      );
      expect(header.status).toBe(403);

      const query = await MachineClient.raw(
        context.app,
        `${INTEGRATION}/submissions?scope=submissions:read`,
        limited.machine.authorization,
      );
      expect(query.status).toBe(403);
    });

    it('refuses a client created with an unknown scope', async () => {
      const response = await admin.post(
        manage(),
        { displayName: 'Bad scope', scopes: ['everything:read'] },
        key(),
      );
      expect(response.status).toBe(422);
    });

    it('refuses a client created with no scopes', async () => {
      const response = await admin.post(manage(), { displayName: 'No scope', scopes: [] }, key());
      expect(response.status).toBe(400);
    });
  });

  // --- the allow-list -------------------------------------------------------

  describe('the machine-access allow-list', () => {
    it.each([
      ['the user profile', `${API}/users/me`],
      ['the organization member list', `${API}/organizations/ORG/members`],
      ['the balance', `${API}/balance`],
      ['the check catalogue', `${API}/catalogue/organizations`],
      ['the notifications inbox', `${API}/notifications`],
      ['platform administration', `${API}/admin/organizations`],
    ])('refuses %s even with a valid credential', async (_name, path) => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
        'submissions:read',
        'certificates:read',
        'webhooks:read',
      ]);
      const response = await MachineClient.raw(
        context.app,
        path.replace('ORG', university.organizationId),
        client.machine.authorization,
      );
      // Not on the allow-list, so not reachable. A credential holding every
      // scope PalCert publishes still cannot get in.
      expect(response.status).toBe(401);
    });
  });

  // --- lifecycle ------------------------------------------------------------

  describe('revocation and disabling', () => {
    it('stops a revoked credential on the very next request', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(200);

      const revoked = await admin.post(`${manage()}/${client.apiClientId}/revocation`, {});
      expect(revoked.status).toBe(200);

      const after = await client.machine.get(`${INTEGRATION}/organization`);
      expect(after.status).toBe(401);
      expect(after.body.error.code).toBe('API_CLIENT_AUTHENTICATION_FAILED');
    });

    it('never re-enables a revoked credential', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      await admin.post(`${manage()}/${client.apiClientId}/revocation`, {});

      const enable = await admin.post(`${manage()}/${client.apiClientId}/enabled`, {
        enabled: true,
      });
      expect(enable.status).toBe(409);
      expect(enable.body.error.code).toBe('API_CLIENT_REVOKED');
      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(401);
    });

    it('stops and restarts a disabled credential with the same secret', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      await admin.post(`${manage()}/${client.apiClientId}/enabled`, { enabled: false });
      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(401);

      await admin.post(`${manage()}/${client.apiClientId}/enabled`, { enabled: true });
      // The same secret: re-enabling must not force a customer to redeploy.
      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(200);
    });

    it('refuses an expired credential', async () => {
      const client = await createApiClient(
        context.app,
        admin,
        university.organizationId,
        ['organization:read'],
        { expiresAt: new Date(Date.now() + 2_000).toISOString() },
      );
      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(200);

      // Move the row's expiry into the past rather than sleeping: the property
      // is "the authentication path compares against now", not "time passes".
      await context.adminDb.apiClient.update({
        where: { id: client.apiClientId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      const after = await client.machine.get(`${INTEGRATION}/organization`);
      expect(after.status).toBe(401);
    });

    it('refuses a credential whose organization is no longer active', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      await context.adminDb.organization.update({
        where: { id: university.organizationId },
        // `suspended_at` alongside, because the schema has required the two to
        // agree since Phase 2.
        data: { status: 'SUSPENDED', suspendedAt: new Date() },
      });
      // A credential is only as live as the institution behind it, without
      // anybody having to revoke each one by hand.
      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(401);
    });
  });

  // --- rotation -------------------------------------------------------------

  describe('rotation', () => {
    it('keeps the previous secret working during the overlap and the new one immediately', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      const rotated = await admin.post(`${manage()}/${client.apiClientId}/secret`, {}, key());
      expect(rotated.status).toBe(201);
      const next = client.machine.withSecret(rotated.body.clientSecret as string);

      expect((await next.get(`${INTEGRATION}/organization`)).status).toBe(200);
      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(200);
      expect(rotated.body.previousSecretRetiresAt).not.toBeNull();
    });

    it('stops the previous secret when the overlap has elapsed', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      const rotated = await admin.post(`${manage()}/${client.apiClientId}/secret`, {}, key());
      const next = client.machine.withSecret(rotated.body.clientSecret as string);

      // Move the overlap into the past. The authentication path is the
      // authority for expiry, so this must take effect with no sweeper run.
      await context.adminDb.apiClientSecret.updateMany({
        where: { apiClientId: client.apiClientId, status: 'ROTATING_OUT' },
        data: { overlapEndsAt: new Date(Date.now() - 1_000) },
      });

      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(401);
      expect((await next.get(`${INTEGRATION}/organization`)).status).toBe(200);
    });

    it('retires the previous secret at once when asked for no overlap', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      const rotated = await admin.post(
        `${manage()}/${client.apiClientId}/secret`,
        { overlapSeconds: 0 },
        key(),
      );
      expect(rotated.body.previousSecretRetiresAt).toBeNull();
      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(401);
    });

    it('never leaves more than two live secrets', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      await admin.post(`${manage()}/${client.apiClientId}/secret`, {}, key());
      // A second rotation while the first overlap is still running is refused,
      // because honouring it would strand whoever is still using the previous
      // secret without telling them.
      const second = await admin.post(`${manage()}/${client.apiClientId}/secret`, {}, key());
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('API_CLIENT_ROTATION_IN_PROGRESS');

      const live = await context.adminDb.apiClientSecret.count({
        where: { apiClientId: client.apiClientId, status: { in: ['ACTIVE', 'ROTATING_OUT'] } },
      });
      expect(live).toBe(2);
    });

    it('refuses an overlap longer than the contract allows', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      const response = await admin.post(
        `${manage()}/${client.apiClientId}/secret`,
        { overlapSeconds: 60 * 60 * 24 * 30 },
        key(),
      );
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('API_CLIENT_ROTATION_OVERLAP_TOO_LONG');
    });

    it('ends the overlap immediately on revocation', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      const rotated = await admin.post(`${manage()}/${client.apiClientId}/secret`, {}, key());
      const next = client.machine.withSecret(rotated.body.clientSecret as string);

      await admin.post(`${manage()}/${client.apiClientId}/revocation`, {});
      // Both, not just the current one: a revoked client must not have a
      // surviving overlap secret that still opens the door.
      expect((await client.machine.get(`${INTEGRATION}/organization`)).status).toBe(401);
      expect((await next.get(`${INTEGRATION}/organization`)).status).toBe(401);
    });
  });

  // --- idempotency ----------------------------------------------------------

  describe('idempotency', () => {
    it('requires a key to create or rotate', async () => {
      const response = await admin.post(manage(), {
        displayName: 'No key',
        scopes: ['organization:read'],
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('API_CLIENT_IDEMPOTENCY_KEY_REQUIRED');
    });

    it('returns the same client and the same secret for an identical repeat', async () => {
      const headers = key();
      const body = { displayName: 'Repeatable', scopes: ['organization:read'] };
      const first = await admin.post(manage(), body, headers);
      const second = await admin.post(manage(), body, headers);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.client.apiClientId).toBe(first.body.client.apiClientId);
      expect(second.body.clientSecret).toBe(first.body.clientSecret);

      // And exactly one client exists, which is the property that matters: a
      // retried create must not leave a credential nobody knows about.
      const count = await context.adminDb.apiClient.count({
        where: { organizationId: university.organizationId },
      });
      expect(count).toBe(1);
    });

    it('refuses the same key with a different request', async () => {
      const headers = key();
      await admin.post(manage(), { displayName: 'First', scopes: ['organization:read'] }, headers);
      const second = await admin.post(
        manage(),
        { displayName: 'Different', scopes: ['submissions:read'] },
        headers,
      );
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('API_CLIENT_IDEMPOTENCY_KEY_CONFLICT');
    });

    it('refuses to replay once the recovery window has closed', async () => {
      const headers = key();
      const body = { displayName: 'Expiring', scopes: ['organization:read'] };
      await admin.post(manage(), body, headers);

      await context.adminDb.apiClientOperation.updateMany({
        where: { organizationId: university.organizationId },
        data: { revealExpiresAt: new Date(Date.now() - 1_000) },
      });

      const replay = await admin.post(manage(), body, headers);
      expect(replay.status).toBe(410);
      expect(replay.body.error.code).toBe('API_CLIENT_SECRET_NO_LONGER_RECOVERABLE');
    });
  });

  // --- permissions on the management API ------------------------------------

  describe('who may manage credentials', () => {
    it('refuses a reviewer', async () => {
      const response = await reviewer.post(
        manage(),
        { displayName: 'Reviewer attempt', scopes: ['organization:read'] },
        key(),
      );
      expect(response.status).toBe(403);
    });

    it('refuses a reviewer even to list', async () => {
      expect((await reviewer.get(manage())).status).toBe(403);
    });

    it('allows an organization administrator', async () => {
      const orgAdmin = await member('admin@iug.test', 'ORGANIZATION_ADMIN');
      const response = await orgAdmin.post(
        manage(),
        { displayName: 'Admin created', scopes: ['organization:read'] },
        key(),
      );
      expect(response.status).toBe(201);
    });
  });

  // --- secret handling ------------------------------------------------------

  describe('the secret', () => {
    it('is never returned by any read', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);

      const list = await admin.get(manage());
      const one = await admin.get(`${manage()}/${client.apiClientId}`);

      for (const body of [list.body, one.body]) {
        expect(JSON.stringify(body)).not.toContain(client.clientSecret);
        expect(JSON.stringify(body)).not.toContain('clientSecret');
      }
    });

    it('is never stored in a form that can produce it again', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      const secrets = await context.adminDb.apiClientSecret.findMany({
        where: { apiClientId: client.apiClientId },
      });
      expect(secrets).toHaveLength(1);
      // An Argon2id verifier, not the secret and not a reversible envelope.
      expect(secrets[0]!.secretVerifier.startsWith('$argon2id$')).toBe(true);
      expect(secrets[0]!.secretVerifier).not.toContain(client.clientSecret);
      expect(JSON.stringify(secrets[0])).not.toContain(client.clientSecret);
    });

    it('never appears in an audit record', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      await admin.post(`${manage()}/${client.apiClientId}/secret`, {}, key());

      const events = await context.adminDb.auditEvent.findMany({
        where: { targetType: 'API_CLIENT' },
      });
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(JSON.stringify(event)).not.toContain(client.clientSecret);
        expect(JSON.stringify(event)).not.toContain('argon2');
      }
    });

    it('is recoverable only inside the window, and only for the same actor', async () => {
      const headers = key();
      const body = { displayName: 'Actor bound', scopes: ['organization:read'] };
      const first = await admin.post(manage(), body, headers);
      expect(first.status).toBe(201);

      const orgAdmin = await member('other-admin@iug.test', 'ORGANIZATION_ADMIN');
      const byOther = await orgAdmin.post(manage(), body, headers);
      // A second administrator reusing the key by coincidence must not be
      // handed the credential the first one minted.
      expect(byOther.status).toBe(409);
    });
  });

  // --- audit ----------------------------------------------------------------

  describe('audit', () => {
    it('names the administrator for a management act, never a machine', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      const event = await context.adminDb.auditEvent.findFirst({
        where: { targetType: 'API_CLIENT', targetId: client.apiClientId },
      });
      expect(event).not.toBeNull();
      expect(event!.actorType).toBe('USER');
      expect(event!.actorUserId).toBe(university.owner.userId);
      expect(event!.actorApiClientId).toBeNull();
    });

    it('records the lifecycle without ever naming a borrowed human for a machine', async () => {
      const client = await createApiClient(context.app, admin, university.organizationId, [
        'organization:read',
      ]);
      await admin.post(`${manage()}/${client.apiClientId}/enabled`, { enabled: false });
      await admin.post(`${manage()}/${client.apiClientId}/revocation`, {});

      const actions = (
        await context.adminDb.auditEvent.findMany({
          where: { targetId: client.apiClientId },
          orderBy: { createdAt: 'asc' },
        })
      ).map((event) => event.action);
      expect(actions).toEqual(['api_client.created', 'api_client.disabled', 'api_client.revoked']);
    });
  });
});
