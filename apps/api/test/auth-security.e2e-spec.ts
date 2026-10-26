import { RoleCode } from '@palcert/contracts';
import {
  API,
  AuthClient,
  grantGlobalRole,
  lastResetToken,
  registerAndVerify,
  parseSetCookie,
  signIn,
} from './support/auth-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

const PASSWORD = 'a-correct-horse-battery-staple';

describe('Authentication security (e2e)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
  });
  afterAll(async () => {
    await destroyTestContext(context);
  });
  beforeEach(async () => {
    await resetState(context);
  });

  // --- 11-13. RBAC and privilege escalation ---------------------------------
  describe('authorization', () => {
    it('allows a permitted action (RBAC positive)', async () => {
      const user = await registerAndVerify(context, 'positive@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      // profile:read:self is granted to SERVICE_USER.
      expect((await client.get(`${API}/users/me`)).status).toBe(200);
    });

    it('denies an action the role does not grant (RBAC negative)', async () => {
      const user = await registerAndVerify(context, 'negative@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const response = await client.get(`${API}/admin/users`);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
      expect(response.body.error.details.required).toContain('admin:user:read');
    });

    it('refuses every admin route to an ordinary user', async () => {
      const user = await registerAndVerify(context, 'nosy@example.com');
      const victim = await registerAndVerify(context, 'victim@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      for (const call of [
        client.get(`${API}/admin/users`),
        client.get(`${API}/admin/users/${victim.userId}`),
        client.post(`${API}/admin/users/${victim.userId}/suspend`, {}),
        client.post(`${API}/admin/users/${victim.userId}/roles`, { roleCode: 'PALCERT_ADMIN' }),
        client.delete(`${API}/admin/users/${victim.userId}/roles/SERVICE_USER`),
      ]) {
        expect((await call).status).toBe(403);
      }
    });

    it('rejects an unauthenticated request to a protected route', async () => {
      const response = await new AuthClient(context.app).get(`${API}/users/me`);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('never accepts a session identifier from the query string', async () => {
      const user = await registerAndVerify(context, 'urltoken@example.com');
      const client = await signIn(context, user.email, PASSWORD);
      const token = client.sessionCookie!;

      const bare = new AuthClient(context.app);
      const response = await bare.get(
        `${API}/users/me?session=${encodeURIComponent(token)}&token=${encodeURIComponent(token)}`,
      );

      expect(response.status).toBe(401);
    });

    // --- horizontal authorization ------------------------------------------
    it("cannot revoke another user's session", async () => {
      const attacker = await registerAndVerify(context, 'attacker@example.com');
      const victim = await registerAndVerify(context, 'victim2@example.com');

      const victimClient = await signIn(context, victim.email, PASSWORD);
      const attackerClient = await signIn(context, attacker.email, PASSWORD);

      const victimSession = await context.prisma.session.findFirstOrThrow({
        where: { userId: victim.userId, revokedAt: null },
      });

      const response = await attackerClient.delete(`${API}/auth/sessions/${victimSession.id}`);

      // Indistinguishable from a session that does not exist.
      expect(response.status).toBe(404);
      expect((await victimClient.get(`${API}/users/me`)).status).toBe(200);
    });

    it("only ever lists the caller's own sessions", async () => {
      const a = await registerAndVerify(context, 'tenant-a@example.com');
      await registerAndVerify(context, 'tenant-b@example.com');
      await signIn(context, 'tenant-b@example.com', PASSWORD);
      const clientA = await signIn(context, a.email, PASSWORD);

      const response = await clientA.get(`${API}/auth/sessions`);
      expect(response.body).toHaveLength(1);
    });

    // --- privilege escalation ----------------------------------------------
    it('cannot grant itself a role through the profile endpoint', async () => {
      const user = await registerAndVerify(context, 'escalate@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const response = await client.patch(`${API}/users/me`, {
        displayName: 'Legitimate Name',
        roles: ['PALCERT_ADMIN'],
        permissions: ['admin:role:assign'],
        status: 'ACTIVE',
        emailVerifiedAt: new Date().toISOString(),
        passwordHash: 'injected',
        mfaRequiredOverride: false,
      });

      // forbidNonWhitelisted rejects the whole request rather than ignoring it.
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');

      const profile = await client.get(`${API}/users/me`);
      expect(profile.body.roles).toEqual(['SERVICE_USER']);
    });

    it('cannot escalate by posting a role to the admin endpoint', async () => {
      const user = await registerAndVerify(context, 'selfpromote@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const response = await client.post(`${API}/admin/users/${user.userId}/roles`, {
        roleCode: 'PALCERT_ADMIN',
      });

      expect(response.status).toBe(403);
      const assignments = await context.prisma.userRole.findMany({
        where: { userId: user.userId },
        include: { role: true },
      });
      expect(assignments.map((a) => a.role.code)).toEqual(['SERVICE_USER']);
    });

    it('does not let support staff assign roles or suspend accounts', async () => {
      const support = await registerAndVerify(context, 'support@example.com');
      const victim = await registerAndVerify(context, 'target@example.com');
      await grantGlobalRole(context, support.userId, RoleCode.PALCERT_SUPPORT);

      const client = await signIn(context, support.email, PASSWORD);

      // Support can read...
      expect((await client.get(`${API}/admin/users`)).status).toBe(200);
      // ...but must not be a route to becoming an administrator.
      expect(
        (
          await client.post(`${API}/admin/users/${victim.userId}/roles`, {
            roleCode: 'PALCERT_ADMIN',
          })
        ).status,
      ).toBe(403);
      expect((await client.post(`${API}/admin/users/${victim.userId}/suspend`, {})).status).toBe(
        403,
      );
    });

    it('refuses to grant an organization-scoped role globally', async () => {
      const admin = await registerAndVerify(context, 'admin-org@example.com');
      const target = await registerAndVerify(context, 'target-org@example.com');
      await grantGlobalRole(context, admin.userId, RoleCode.PALCERT_ADMIN);
      await context.prisma.user.update({
        where: { id: admin.userId },
        data: { mfaRequiredOverride: false },
      });

      const client = await signInWithMfaBypass(context, admin.email);

      const response = await client.post(`${API}/admin/users/${target.userId}/roles`, {
        roleCode: 'ORGANIZATION_OWNER',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      await expect(
        context.prisma.userRole.count({ where: { userId: target.userId, scope: 'ORGANIZATION' } }),
      ).resolves.toBe(0);
    });

    it('lets an administrator suspend a user and kill their sessions', async () => {
      const admin = await registerAndVerify(context, 'real-admin@example.com');
      const victim = await registerAndVerify(context, 'to-suspend@example.com');
      await grantGlobalRole(context, admin.userId, RoleCode.PALCERT_ADMIN);

      const victimClient = await signIn(context, victim.email, PASSWORD);
      const adminClient = await signInWithMfaBypass(context, admin.email);

      const response = await adminClient.post(`${API}/admin/users/${victim.userId}/suspend`, {
        reason: 'Policy violation',
      });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('SUSPENDED');
      expect((await victimClient.get(`${API}/users/me`)).status).toBe(403);
    });

    it('prevents an administrator from suspending themselves', async () => {
      const admin = await registerAndVerify(context, 'self-suspend@example.com');
      await grantGlobalRole(context, admin.userId, RoleCode.PALCERT_ADMIN);
      const client = await signInWithMfaBypass(context, admin.email);

      const response = await client.post(`${API}/admin/users/${admin.userId}/suspend`, {});
      expect(response.status).toBe(400);
    });

    it('records an audit event with actor and before/after state', async () => {
      const admin = await registerAndVerify(context, 'auditing-admin@example.com');
      const victim = await registerAndVerify(context, 'audited-user@example.com');
      await grantGlobalRole(context, admin.userId, RoleCode.PALCERT_ADMIN);
      const client = await signInWithMfaBypass(context, admin.email);

      await client.post(`${API}/admin/users/${victim.userId}/suspend`, {});

      const audit = await context.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'ACCOUNT_SUSPENDED' },
      });
      expect(audit.actorUserId).toBe(admin.userId);
      expect(audit.targetId).toBe(victim.userId);
      expect(audit.beforeState).toEqual({ status: 'ACTIVE' });
      expect(audit.afterState).toEqual({ status: 'SUSPENDED' });
    });
  });

  // --- session fixation ------------------------------------------------------
  describe('session fixation', () => {
    it('issues a brand-new identifier at login, ignoring any planted cookie', async () => {
      const user = await registerAndVerify(context, 'fixation@example.com');

      const client = new AuthClient(context.app);
      // Attacker plants a session identifier of their choosing.
      client.adoptSession('attacker-chosen-session-value', 'attacker-chosen-csrf');

      const response = await client.post(`${API}/auth/login`, {
        email: user.email,
        password: PASSWORD,
      });
      expect(response.status).toBe(200);

      // The authenticated session is not the planted one.
      expect(client.sessionCookie).not.toBe('attacker-chosen-session-value');

      // And the planted value authenticates nothing.
      const attacker = new AuthClient(context.app);
      attacker.adoptSession('attacker-chosen-session-value', 'attacker-chosen-csrf');
      expect((await attacker.get(`${API}/users/me`)).status).toBe(401);
    });

    it('changes the identifier when MFA completes, retiring the pre-auth session', async () => {
      const { client, preAuthToken } = await enrollAndChallenge(
        context,
        'fixation-mfa@example.com',
      );

      expect(client.sessionCookie).not.toBe(preAuthToken);

      const replay = new AuthClient(context.app);
      replay.adoptSession(preAuthToken);
      const response = await replay.get(`${API}/users/me`);
      expect(response.status).toBe(401);
    });
  });

  // --- 17. CSRF --------------------------------------------------------------
  describe('CSRF protection', () => {
    it('rejects a state-changing request from an untrusted origin', async () => {
      const user = await registerAndVerify(context, 'csrf-origin@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const response = await client.post(
        `${API}/auth/logout-all`,
        {},
        { origin: 'https://evil.example.com' },
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CSRF_INVALID');
    });

    it('rejects a state-changing request with no CSRF header', async () => {
      const user = await registerAndVerify(context, 'csrf-header@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const response = await client.post(`${API}/auth/logout-all`, {}, { omitCsrf: true });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CSRF_INVALID');
    });

    it('rejects a CSRF token belonging to a different session', async () => {
      const a = await registerAndVerify(context, 'csrf-a@example.com');
      const b = await registerAndVerify(context, 'csrf-b@example.com');
      const clientA = await signIn(context, a.email, PASSWORD);
      const clientB = await signIn(context, b.email, PASSWORD);

      const response = await clientA.post(
        `${API}/auth/logout-all`,
        {},
        { csrfToken: clientB.csrfCookie! },
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CSRF_INVALID');
      // The victim is still signed in — the forgery changed nothing.
      expect((await clientA.get(`${API}/users/me`)).status).toBe(200);
    });

    it('rejects login CSRF from an untrusted origin even with no session', async () => {
      await registerAndVerify(context, 'login-csrf@example.com');
      const client = new AuthClient(context.app);

      const response = await client.post(
        `${API}/auth/login`,
        { email: 'login-csrf@example.com', password: PASSWORD },
        { origin: 'https://evil.example.com' },
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CSRF_INVALID');
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('accepts a matching token from a trusted origin', async () => {
      const user = await registerAndVerify(context, 'csrf-ok@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      expect((await client.post(`${API}/auth/logout-all`, {})).status).toBe(200);
    });

    it('allows any configured origin, not only the first', async () => {
      await registerAndVerify(context, 'second-origin@example.com');
      const client = new AuthClient(context.app, 'https://app.palcert.test');

      const response = await client.post(`${API}/auth/login`, {
        email: 'second-origin@example.com',
        password: PASSWORD,
      });
      expect(response.status).toBe(200);
    });

    it('does not require CSRF for safe methods', async () => {
      const user = await registerAndVerify(context, 'safe-method@example.com');
      const client = await signIn(context, user.email, PASSWORD);
      client.setOrigin(null);

      expect((await client.get(`${API}/users/me`)).status).toBe(200);
    });

    it('binds a fresh CSRF token to a rotated session', async () => {
      const user = await registerAndVerify(context, 'csrf-rotate@example.com');
      const client = await signIn(context, user.email, PASSWORD);
      const before = client.csrfCookie;

      await client.post(`${API}/auth/password/change`, {
        currentPassword: PASSWORD,
        newPassword: 'another-good-passphrase',
      });

      expect(client.csrfCookie).not.toBe(before);
      // The new pairing works...
      expect((await client.get(`${API}/auth/sessions`)).status).toBe(200);
      // ...and the retired CSRF token does not.
      const stale = await client.post(`${API}/auth/logout-all`, {}, { csrfToken: before! });
      expect(stale.status).toBe(403);
    });
  });

  // --- 18. throttling --------------------------------------------------------
  describe('login throttling', () => {
    it('throttles repeated failures against one account', async () => {
      await registerAndVerify(context, 'bruteforce@example.com');
      const client = new AuthClient(context.app);

      // The account limit is 5 in the test environment.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await client.post(`${API}/auth/login`, {
          email: 'bruteforce@example.com',
          password: `wrong-password-${attempt}`,
        });
        expect(response.status).toBe(401);
      }

      const throttled = await client.post(`${API}/auth/login`, {
        email: 'bruteforce@example.com',
        password: PASSWORD,
      });

      expect(throttled.status).toBe(429);
      expect(throttled.body.error.code).toBe('RATE_LIMITED');
      expect(throttled.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('records a security event when throttling engages', async () => {
      await registerAndVerify(context, 'throttle-event@example.com');
      const client = new AuthClient(context.app);

      for (let attempt = 0; attempt < 6; attempt += 1) {
        await client.post(`${API}/auth/login`, {
          email: 'throttle-event@example.com',
          password: 'wrong-password-value',
        });
      }

      await expect(
        context.prisma.securityEvent.count({ where: { type: 'LOGIN_THROTTLED' } }),
      ).resolves.toBeGreaterThan(0);
    });

    it('does not lock an account permanently — the counter is per window', async () => {
      const user = await registerAndVerify(context, 'no-lockout@example.com');
      const client = new AuthClient(context.app);

      for (let attempt = 0; attempt < 6; attempt += 1) {
        await client.post(`${API}/auth/login`, { email: user.email, password: 'wrong-pass-here' });
      }
      expect(
        (await client.post(`${API}/auth/login`, { email: user.email, password: PASSWORD })).status,
      ).toBe(429);

      // The Redis key carries a TTL rather than a permanent flag, so the block
      // lifts on its own. Simulate the window elapsing by dropping the counter.
      const keys = await context.redis.client.keys('palcert:throttle:login:account:*');
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(await context.redis.client.ttl(key)).toBeGreaterThan(0);
      }
      await context.redis.client.del(...keys);

      expect(
        (await client.post(`${API}/auth/login`, { email: user.email, password: PASSWORD })).status,
      ).toBe(200);
    });

    it('clears the account counter after a successful sign-in', async () => {
      const user = await registerAndVerify(context, 'forgiving@example.com');
      const client = new AuthClient(context.app);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await client.post(`${API}/auth/login`, { email: user.email, password: 'mistyped-pass-xx' });
      }
      expect(
        (await client.post(`${API}/auth/login`, { email: user.email, password: PASSWORD })).status,
      ).toBe(200);

      // A fresh run of failures gets the full budget again.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await client.post(`${API}/auth/login`, {
          email: user.email,
          password: 'mistyped-pass-yy',
        });
        expect(response.status).toBe(401);
      }
    });

    it('throttles password reset requests', async () => {
      const user = await registerAndVerify(context, 'reset-throttle@example.com');
      const client = new AuthClient(context.app);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(
          (await client.post(`${API}/auth/password/forgot`, { email: user.email })).status,
        ).toBe(202);
      }

      const throttled = await client.post(`${API}/auth/password/forgot`, { email: user.email });
      expect(throttled.status).toBe(429);
    });
  });

  // --- 34. account enumeration ----------------------------------------------
  describe('account enumeration', () => {
    it('gives an identical registration response for a new and an existing address', async () => {
      await registerAndVerify(context, 'existing@example.com');
      const client = new AuthClient(context.app);

      const fresh = await client.post(`${API}/auth/register`, {
        email: 'brand-new@example.com',
        password: PASSWORD,
      });
      const duplicate = await client.post(`${API}/auth/register`, {
        email: 'existing@example.com',
        password: PASSWORD,
      });

      expect(duplicate.status).toBe(fresh.status);
      expect(duplicate.body).toEqual(fresh.body);
    });

    it('does not overwrite an existing account when its address is re-registered', async () => {
      const user = await registerAndVerify(context, 'protected@example.com');

      await new AuthClient(context.app).post(`${API}/auth/register`, {
        email: 'protected@example.com',
        password: 'attacker-chosen-passphrase',
      });

      // The original password still works; the attacker's does not.
      expect(
        (
          await new AuthClient(context.app).post(`${API}/auth/login`, {
            email: user.email,
            password: 'attacker-chosen-passphrase',
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await new AuthClient(context.app).post(`${API}/auth/login`, {
            email: user.email,
            password: PASSWORD,
          })
        ).status,
      ).toBe(200);
      await expect(
        context.prisma.user.count({ where: { normalizedEmail: 'protected@example.com' } }),
      ).resolves.toBe(1);
    });

    it('gives an identical forgot-password response for known and unknown addresses', async () => {
      await registerAndVerify(context, 'real-user@example.com');
      const client = new AuthClient(context.app);

      const known = await client.post(`${API}/auth/password/forgot`, {
        email: 'real-user@example.com',
      });
      const unknown = await client.post(`${API}/auth/password/forgot`, {
        email: 'ghost@example.com',
      });

      expect(unknown.status).toBe(known.status);
      expect(unknown.body).toEqual(known.body);
    });

    it('gives an identical resend response for known and unknown addresses', async () => {
      await registerAndVerify(context, 'resend-known@example.com');
      const client = new AuthClient(context.app);

      const known = await client.post(`${API}/auth/email/resend`, {
        email: 'resend-known@example.com',
      });
      const unknown = await client.post(`${API}/auth/email/resend`, {
        email: 'resend-ghost@example.com',
      });

      expect(unknown.status).toBe(known.status);
      expect(unknown.body).toEqual(known.body);
    });
  });

  // --- secret leakage --------------------------------------------------------
  describe('secret handling', () => {
    it('never returns a hash, secret or token in any authenticated response', async () => {
      const user = await registerAndVerify(context, 'no-leak@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const stored = await context.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });

      for (const path of [`${API}/users/me`, `${API}/auth/sessions`]) {
        const body = JSON.stringify((await client.get(path)).body);
        expect(body).not.toContain(stored.passwordHash);
        expect(body).not.toContain(PASSWORD);
        expect(body.toLowerCase()).not.toContain('passwordhash');
        expect(body.toLowerCase()).not.toContain('tokenhash');
        expect(body.toLowerCase()).not.toContain('csrftokenhash');
      }
    });

    it('does not expose credential material through the admin user list', async () => {
      const admin = await registerAndVerify(context, 'leak-admin@example.com');
      await registerAndVerify(context, 'listed@example.com');
      await grantGlobalRole(context, admin.userId, RoleCode.PALCERT_ADMIN);
      const client = await signInWithMfaBypass(context, admin.email);

      const body = JSON.stringify((await client.get(`${API}/admin/users`)).body);

      expect(body.toLowerCase()).not.toContain('passwordhash');
      expect(body).not.toContain('$argon2');
    });

    it('keeps reset and verification tokens out of security event records', async () => {
      const user = await registerAndVerify(context, 'event-leak@example.com');
      await new AuthClient(context.app).post(`${API}/auth/password/forgot`, { email: user.email });
      const token = lastResetToken(context, user.email);

      const events = await context.prisma.securityEvent.findMany();
      const serialized = JSON.stringify(events);

      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(PASSWORD);
    });

    it('stores the TOTP secret encrypted, never in plaintext', async () => {
      const user = await registerAndVerify(context, 'totp-at-rest@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const enrollment = await client.post(`${API}/auth/mfa/enroll`, {});
      const secret = enrollment.body.secret as string;

      const stored = await context.prisma.mfaAuthenticator.findFirstOrThrow({
        where: { userId: user.userId },
      });
      expect(stored.secretCiphertext).not.toContain(secret);
      expect(JSON.stringify(stored)).not.toContain(secret);
    });

    it('stores recovery codes only as digests', async () => {
      const { recoveryCodes, userId } = await enrollMfa(context, 'recovery-at-rest@example.com');

      const stored = await context.prisma.mfaRecoveryCode.findMany({ where: { userId } });
      const serialized = JSON.stringify(stored);

      expect(stored).toHaveLength(10);
      for (const code of recoveryCodes) {
        expect(serialized).not.toContain(code);
        expect(serialized).not.toContain(code.replace(/-/g, ''));
      }
    });
  });

  // --- cookie attributes -----------------------------------------------------
  describe('cookie attributes', () => {
    it('sets HttpOnly, SameSite and Path on the session cookie', async () => {
      await registerAndVerify(context, 'cookie-attrs@example.com');
      const client = new AuthClient(context.app);
      const response = await client.post(`${API}/auth/login`, {
        email: 'cookie-attrs@example.com',
        password: PASSWORD,
      });

      const session = parseSetCookie(response, 'palcert_session')!;
      expect(session.httponly).toBe('true');
      expect(session.samesite?.toLowerCase()).toBe('lax');
      expect(session.path).toBe('/');
      expect(session.expires).toBeDefined();
    });

    it('makes the CSRF cookie readable so the client can echo it, but not the session cookie', async () => {
      await registerAndVerify(context, 'csrf-readable@example.com');
      const client = new AuthClient(context.app);
      const response = await client.post(`${API}/auth/login`, {
        email: 'csrf-readable@example.com',
        password: PASSWORD,
      });

      const csrf = parseSetCookie(response, 'palcert_csrf')!;
      expect(csrf.httponly).toBeUndefined();
      expect(csrf.samesite?.toLowerCase()).toBe('lax');
    });

    it('omits Secure outside production, so local HTTP development works', async () => {
      await registerAndVerify(context, 'insecure-dev@example.com');
      const client = new AuthClient(context.app);
      const response = await client.post(`${API}/auth/login`, {
        email: 'insecure-dev@example.com',
        password: PASSWORD,
      });

      // NODE_ENV is `test` here. The production path is covered by the
      // configuration test that rejects an unhardened production environment.
      expect(parseSetCookie(response, 'palcert_session')!.secure).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sign in a privileged account by completing a real MFA enrollment and
 * challenge. Named "bypass" only in the sense that the test does not need to
 * care about the ceremony — the ceremony genuinely happens.
 */
async function signInWithMfaBypass(context: TestContext, email: string): Promise<AuthClient> {
  const client = new AuthClient(context.app);
  const login = await client.post(`${API}/auth/login`, { email, password: PASSWORD });

  if (login.body.status === 'AUTHENTICATED') return client;

  if (login.body.status === 'MFA_ENROLLMENT_REQUIRED') {
    const enrollment = await client.post(`${API}/auth/mfa/enroll`, {});
    const code = generateTotp(enrollment.body.secret, context.clock.now());
    const confirmed = await client.post(`${API}/auth/mfa/confirm`, { code });
    if (confirmed.status !== 200) {
      throw new Error(`MFA confirm failed: ${JSON.stringify(confirmed.body)}`);
    }
    // Confirming from a pre-authentication session completes the login.
    return client;
  }

  const code = await currentTotpFor(context, email);
  const challenge = await client.post(`${API}/auth/mfa/challenge`, { code });
  if (challenge.status !== 200) {
    throw new Error(`MFA challenge failed: ${JSON.stringify(challenge.body)}`);
  }
  return client;
}

async function enrollMfa(
  context: TestContext,
  email: string,
): Promise<{ recoveryCodes: string[]; userId: string; client: AuthClient }> {
  const user = await registerAndVerify(context, email);
  const client = await signIn(context, email, PASSWORD);

  const enrollment = await client.post(`${API}/auth/mfa/enroll`, {});
  const code = generateTotp(enrollment.body.secret, context.clock.now());
  const confirmed = await client.post(`${API}/auth/mfa/confirm`, { code });

  if (confirmed.status !== 200) {
    throw new Error(`MFA confirm failed: ${JSON.stringify(confirmed.body)}`);
  }
  return { recoveryCodes: confirmed.body.recoveryCodes, userId: user.userId, client };
}

async function enrollAndChallenge(
  context: TestContext,
  email: string,
): Promise<{ client: AuthClient; preAuthToken: string }> {
  await enrollMfa(context, email);

  const client = new AuthClient(context.app);
  await client.post(`${API}/auth/login`, { email, password: PASSWORD });
  const preAuthToken = client.sessionCookie!;

  // Move to a new TOTP time step: the enrollment code has already been spent,
  // and replay protection correctly refuses to accept it a second time.
  context.clock.advanceMinutes(1);
  const code = await currentTotpFor(context, email);
  await client.post(`${API}/auth/mfa/challenge`, { code });

  return { client, preAuthToken };
}

async function currentTotpFor(context: TestContext, email: string): Promise<string> {
  const user = await context.prisma.user.findFirstOrThrow({
    where: { normalizedEmail: email.toLowerCase() },
  });
  const authenticator = await context.prisma.mfaAuthenticator.findFirstOrThrow({
    where: { userId: user.id, confirmedAt: { not: null } },
  });

  const { openSecret } = await import('../src/common/crypto/secret-box');
  const secret = openSecret(
    {
      ciphertext: authenticator.secretCiphertext,
      iv: authenticator.secretIv,
      authTag: authenticator.secretAuthTag,
    },
    Buffer.from(process.env.AUTH_MFA_SECRET_KEY!, 'base64'),
  );
  return generateTotp(secret, context.clock.now());
}

export function generateTotp(secretBase32: string, at: Date): string {
  // Uses the same library the server does, so the test proves interoperability
  // rather than re-implementing (and possibly mirroring) a bug.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Secret, TOTP } = require('otpauth') as typeof import('otpauth');
  return new TOTP({
    issuer: 'PalCert',
    label: 'test',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  }).generate({ timestamp: at.getTime() });
}
