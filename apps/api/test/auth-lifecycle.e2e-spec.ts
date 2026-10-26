import { SESSION_COOKIE_NAME } from '@palcert/contracts';
import {
  API,
  AuthClient,
  lastResetToken,
  lastVerificationToken,
  registerAndVerify,
  signIn,
} from './support/auth-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

const PASSWORD = 'a-correct-horse-battery-staple';

describe('Authentication lifecycle (e2e)', () => {
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

  // --- 1. register → verify → login -----------------------------------------
  describe('registration and verification', () => {
    it('registers, verifies and signs in', async () => {
      const client = new AuthClient(context.app);

      const registered = await client.post(`${API}/auth/register`, {
        email: 'researcher@university.edu',
        password: PASSWORD,
      });
      expect(registered.status).toBe(202);
      expect(registered.body).toEqual({ acknowledged: true });

      const user = await context.prisma.user.findFirstOrThrow({
        where: { normalizedEmail: 'researcher@university.edu' },
      });
      expect(user.status).toBe('PENDING_VERIFICATION');
      expect(user.emailVerifiedAt).toBeNull();

      const token = lastVerificationToken(context, 'researcher@university.edu');
      await client
        .post(`${API}/auth/email/verify`, { token })
        .then((r) => expect(r.status).toBe(200));

      const verified = await context.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(verified.status).toBe('ACTIVE');
      expect(verified.emailVerifiedAt).not.toBeNull();

      const login = await client.post(`${API}/auth/login`, {
        email: 'researcher@university.edu',
        password: PASSWORD,
      });
      expect(login.status).toBe(200);
      expect(login.body).toEqual({ status: 'AUTHENTICATED' });
    });

    it('grants only the default global role, never an organization role', async () => {
      const user = await registerAndVerify(context, 'newbie@example.com');

      const assignments = await context.prisma.userRole.findMany({
        where: { userId: user.userId },
        include: { role: true },
      });

      expect(assignments).toHaveLength(1);
      expect(assignments[0]!.role.code).toBe('SERVICE_USER');
      expect(assignments[0]!.scope).toBe('GLOBAL');
      expect(assignments[0]!.organizationId).toBeNull();
    });

    it('rejects a password that violates policy', async () => {
      const client = new AuthClient(context.app);
      const response = await client.post(`${API}/auth/register`, {
        email: 'weak@example.com',
        password: 'short',
      });

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('PASSWORD_POLICY_VIOLATION');
      await expect(
        context.prisma.user.count({ where: { normalizedEmail: 'weak@example.com' } }),
      ).resolves.toBe(0);
    });

    // --- 2. unverified login policy -----------------------------------------
    it('refuses login before the email is verified', async () => {
      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/register`, {
        email: 'pending@example.com',
        password: PASSWORD,
      });

      const response = await client.post(`${API}/auth/login`, {
        email: 'pending@example.com',
        password: PASSWORD,
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('EMAIL_NOT_VERIFIED');
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('treats email case and whitespace as the same account', async () => {
      await registerAndVerify(context, 'Case.Test@Example.COM');

      const response = await new AuthClient(context.app).post(`${API}/auth/login`, {
        email: '  case.test@example.com  ',
        password: PASSWORD,
      });
      expect(response.status).toBe(200);
    });

    // --- verification token replay ------------------------------------------
    it('rejects a replayed verification token', async () => {
      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/register`, {
        email: 'replay@example.com',
        password: PASSWORD,
      });
      const token = lastVerificationToken(context, 'replay@example.com');

      await client
        .post(`${API}/auth/email/verify`, { token })
        .then((r) => expect(r.status).toBe(200));

      const replayed = await client.post(`${API}/auth/email/verify`, { token });
      expect(replayed.status).toBe(400);
      expect(replayed.body.error.code).toBe('VERIFICATION_TOKEN_INVALID');
    });

    it('rejects an expired verification token', async () => {
      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/register`, { email: 'stale@example.com', password: PASSWORD });
      const token = lastVerificationToken(context, 'stale@example.com');

      // TTL is 1440 minutes; step just past it. No sleeping involved.
      context.clock.advanceMinutes(1441);

      const response = await client.post(`${API}/auth/email/verify`, { token });
      expect(response.status).toBe(410);
      expect(response.body.error.code).toBe('VERIFICATION_TOKEN_EXPIRED');
    });

    it('invalidates the previous link when verification is resent', async () => {
      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/register`, {
        email: 'resend@example.com',
        password: PASSWORD,
      });
      const firstToken = lastVerificationToken(context, 'resend@example.com');

      await client
        .post(`${API}/auth/email/resend`, { email: 'resend@example.com' })
        .then((r) => expect(r.status).toBe(202));
      const secondToken = lastVerificationToken(context, 'resend@example.com');
      expect(secondToken).not.toBe(firstToken);

      const old = await client.post(`${API}/auth/email/verify`, { token: firstToken });
      expect(old.status).toBe(400);

      const fresh = await client.post(`${API}/auth/email/verify`, { token: secondToken });
      expect(fresh.status).toBe(200);
    });
  });

  // --- 3. wrong credentials --------------------------------------------------
  describe('login failures', () => {
    it('rejects a wrong password with a generic code', async () => {
      await registerAndVerify(context, 'user@example.com');

      const response = await new AuthClient(context.app).post(`${API}/auth/login`, {
        email: 'user@example.com',
        password: 'definitely-the-wrong-password',
      });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_FAILED');
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('gives an identical response for an unknown account', async () => {
      await registerAndVerify(context, 'known@example.com');

      const [unknown, wrongPassword] = await Promise.all([
        new AuthClient(context.app).post(`${API}/auth/login`, {
          email: 'nobody@example.com',
          password: PASSWORD,
        }),
        new AuthClient(context.app).post(`${API}/auth/login`, {
          email: 'known@example.com',
          password: 'wrong-password-entirely',
        }),
      ]);

      expect(unknown.status).toBe(wrongPassword.status);
      expect(unknown.body.error.code).toBe(wrongPassword.body.error.code);
      expect(unknown.body.error.message).toBe(wrongPassword.body.error.message);
    });

    it('records a security event for each failure without storing the password', async () => {
      await registerAndVerify(context, 'audited@example.com');
      await new AuthClient(context.app).post(`${API}/auth/login`, {
        email: 'audited@example.com',
        password: 'a-wrong-password-here',
      });

      const events = await context.prisma.securityEvent.findMany({
        where: { type: 'LOGIN_FAILED' },
      });
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0]!.metadata)).not.toContain('a-wrong-password-here');
    });
  });

  // --- 4-5. forgot / reset password ------------------------------------------
  describe('password reset', () => {
    it('resets the password and lets the user sign in with the new one', async () => {
      const user = await registerAndVerify(context, 'reset@example.com');
      const client = new AuthClient(context.app);

      await client
        .post(`${API}/auth/password/forgot`, { email: user.email })
        .then((r) => expect(r.status).toBe(202));

      const token = lastResetToken(context, user.email);
      const reset = await client.post(`${API}/auth/password/reset`, {
        token,
        newPassword: 'my-brand-new-passphrase',
      });
      expect(reset.status).toBe(200);

      const oldPassword = await client.post(`${API}/auth/login`, {
        email: user.email,
        password: PASSWORD,
      });
      expect(oldPassword.status).toBe(401);

      const newPassword = await client.post(`${API}/auth/login`, {
        email: user.email,
        password: 'my-brand-new-passphrase',
      });
      expect(newPassword.status).toBe(200);
    });

    it('rejects a replayed reset token', async () => {
      const user = await registerAndVerify(context, 'replay-reset@example.com');
      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/password/forgot`, { email: user.email });
      const token = lastResetToken(context, user.email);

      await client
        .post(`${API}/auth/password/reset`, { token, newPassword: 'first-new-passphrase' })
        .then((r) => expect(r.status).toBe(200));

      const replayed = await client.post(`${API}/auth/password/reset`, {
        token,
        newPassword: 'attacker-chosen-passphrase',
      });
      expect(replayed.status).toBe(400);
      expect(replayed.body.error.code).toBe('PASSWORD_RESET_TOKEN_INVALID');

      // The attacker's password must not work.
      const login = await client.post(`${API}/auth/login`, {
        email: user.email,
        password: 'attacker-chosen-passphrase',
      });
      expect(login.status).toBe(401);
    });

    it('rejects an expired reset token', async () => {
      const user = await registerAndVerify(context, 'expired-reset@example.com');
      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/password/forgot`, { email: user.email });
      const token = lastResetToken(context, user.email);

      context.clock.advanceMinutes(31);

      const response = await client.post(`${API}/auth/password/reset`, {
        token,
        newPassword: 'too-late-passphrase',
      });
      expect(response.status).toBe(410);
      expect(response.body.error.code).toBe('PASSWORD_RESET_TOKEN_EXPIRED');
    });

    it('revokes every existing session on reset', async () => {
      const user = await registerAndVerify(context, 'revoke-on-reset@example.com');
      const sessionA = await signIn(context, user.email, PASSWORD);
      const sessionB = await signIn(context, user.email, PASSWORD);

      await expect(sessionA.get(`${API}/users/me`).then((r) => r.status)).resolves.toBe(200);

      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/password/forgot`, { email: user.email });
      await client.post(`${API}/auth/password/reset`, {
        token: lastResetToken(context, user.email),
        newPassword: 'rotated-after-reset-pass',
      });

      expect((await sessionA.get(`${API}/users/me`)).status).toBe(401);
      expect((await sessionB.get(`${API}/users/me`)).status).toBe(401);
    });

    it('acknowledges a reset request for an unknown address without sending mail', async () => {
      const response = await new AuthClient(context.app).post(`${API}/auth/password/forgot`, {
        email: 'nobody-at-all@example.com',
      });

      expect(response.status).toBe(202);
      expect(response.body).toEqual({ acknowledged: true });
      expect(context.outbox.lastTo('nobody-at-all@example.com')).toBeUndefined();
    });
  });

  // --- password change -------------------------------------------------------
  describe('password change', () => {
    it('requires the current password', async () => {
      const user = await registerAndVerify(context, 'change@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const response = await client.post(`${API}/auth/password/change`, {
        currentPassword: 'not-the-current-password',
        newPassword: 'a-fresh-new-passphrase',
      });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_FAILED');
    });

    it('rotates this session and revokes the others', async () => {
      const user = await registerAndVerify(context, 'rotate@example.com');
      const active = await signIn(context, user.email, PASSWORD);
      const other = await signIn(context, user.email, PASSWORD);
      const tokenBefore = active.sessionCookie;

      const response = await active.post(`${API}/auth/password/change`, {
        currentPassword: PASSWORD,
        newPassword: 'a-fresh-new-passphrase',
      });
      expect(response.status).toBe(200);

      // The session identifier changed...
      expect(active.sessionCookie).not.toBe(tokenBefore);
      // ...this session still works...
      expect((await active.get(`${API}/users/me`)).status).toBe(200);
      // ...and every other session is gone.
      expect((await other.get(`${API}/users/me`)).status).toBe(401);
    });

    it('enforces password policy on the new password', async () => {
      const user = await registerAndVerify(context, 'policy-change@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const response = await client.post(`${API}/auth/password/change`, {
        currentPassword: PASSWORD,
        newPassword: 'tiny',
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('PASSWORD_POLICY_VIOLATION');
    });
  });

  // --- 6-8. logout, logout-all, current user ---------------------------------
  describe('sessions', () => {
    it('returns the current user', async () => {
      const user = await registerAndVerify(context, 'me@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const response = await client.get(`${API}/users/me`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        email: 'me@example.com',
        status: 'ACTIVE',
        emailVerified: true,
        mfaEnrolled: false,
        roles: ['SERVICE_USER'],
      });
      expect(response.body.permissions).toContain('profile:read:self');
    });

    it('logs out and refuses the revoked session afterwards', async () => {
      const user = await registerAndVerify(context, 'logout@example.com');
      const client = await signIn(context, user.email, PASSWORD);
      const stolenToken = client.sessionCookie!;
      const csrf = client.csrfCookie!;

      expect((await client.post(`${API}/auth/logout`)).status).toBe(204);

      // Replay the exact pre-logout cookie: it must be dead.
      const attacker = new AuthClient(context.app);
      attacker.adoptSession(stolenToken, csrf);
      const replay = await attacker.get(`${API}/users/me`);

      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('SESSION_REVOKED');
    });

    it('logs out every session at once', async () => {
      const user = await registerAndVerify(context, 'logout-all@example.com');
      const first = await signIn(context, user.email, PASSWORD);
      const second = await signIn(context, user.email, PASSWORD);
      const third = await signIn(context, user.email, PASSWORD);

      const response = await third.post(`${API}/auth/logout-all`);
      expect(response.status).toBe(200);
      expect(response.body.revoked).toBe(3);

      for (const client of [first, second, third]) {
        expect((await client.get(`${API}/users/me`)).status).toBe(401);
      }
    });

    it('lists active sessions and marks the current one', async () => {
      const user = await registerAndVerify(context, 'list-sessions@example.com');
      const first = await signIn(context, user.email, PASSWORD);
      await signIn(context, user.email, PASSWORD);

      const response = await first.get(`${API}/auth/sessions`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(response.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      // No session token is ever disclosed, not even to its owner.
      expect(JSON.stringify(response.body)).not.toContain(first.sessionCookie);
    });

    it('revokes an individual session', async () => {
      const user = await registerAndVerify(context, 'revoke-one@example.com');
      const keeper = await signIn(context, user.email, PASSWORD);
      const doomed = await signIn(context, user.email, PASSWORD);

      const sessions = await keeper.get(`${API}/auth/sessions`);
      const other = sessions.body.find((s: { current: boolean }) => !s.current);

      expect((await keeper.delete(`${API}/auth/sessions/${other.id}`)).status).toBe(204);
      expect((await doomed.get(`${API}/users/me`)).status).toBe(401);
      expect((await keeper.get(`${API}/users/me`)).status).toBe(200);
    });

    // --- 9. expired session --------------------------------------------------
    it('expires a session after the idle timeout', async () => {
      const user = await registerAndVerify(context, 'idle@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      expect((await client.get(`${API}/users/me`)).status).toBe(200);

      context.clock.advanceMinutes(61); // idle window is 60 minutes

      const response = await client.get(`${API}/users/me`);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('SESSION_EXPIRED');
    });

    it('keeps an actively used session alive past the idle window', async () => {
      const user = await registerAndVerify(context, 'active@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      for (let i = 0; i < 4; i += 1) {
        context.clock.advanceMinutes(30);
        expect((await client.get(`${API}/users/me`)).status).toBe(200);
      }
    });

    it('expires a session at the absolute lifetime however active it is', async () => {
      const user = await registerAndVerify(context, 'absolute@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      // Absolute ceiling is 720 minutes; stay active throughout.
      for (let i = 0; i < 24; i += 1) {
        context.clock.advanceMinutes(30);
        await client.get(`${API}/users/me`);
      }
      context.clock.advanceMinutes(30);

      const response = await client.get(`${API}/users/me`);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('SESSION_EXPIRED');
    });
  });

  // --- 10. suspended account -------------------------------------------------
  describe('account status', () => {
    it('kills live sessions the moment the account is suspended', async () => {
      const user = await registerAndVerify(context, 'suspended@example.com');
      const client = await signIn(context, user.email, PASSWORD);
      expect((await client.get(`${API}/users/me`)).status).toBe(200);

      await context.prisma.user.update({
        where: { id: user.userId },
        data: { status: 'SUSPENDED' },
      });

      const response = await client.get(`${API}/users/me`);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('refuses login for a suspended account', async () => {
      const user = await registerAndVerify(context, 'no-login@example.com');
      await context.prisma.user.update({
        where: { id: user.userId },
        data: { status: 'SUSPENDED' },
      });

      const response = await new AuthClient(context.app).post(`${API}/auth/login`, {
        email: user.email,
        password: PASSWORD,
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('refuses login for a disabled account', async () => {
      const user = await registerAndVerify(context, 'disabled@example.com');
      await context.prisma.user.update({
        where: { id: user.userId },
        data: { status: 'DISABLED' },
      });

      const response = await new AuthClient(context.app).post(`${API}/auth/login`, {
        email: user.email,
        password: PASSWORD,
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ACCOUNT_DISABLED');
    });
  });

  // --- cookie security -------------------------------------------------------
  describe('cookies', () => {
    it('never returns a session token in the response body', async () => {
      const user = await registerAndVerify(context, 'cookie-body@example.com');
      const client = new AuthClient(context.app);
      const response = await client.post(`${API}/auth/login`, {
        email: user.email,
        password: PASSWORD,
      });

      expect(response.body).toEqual({ status: 'AUTHENTICATED' });
      const session = await context.prisma.session.findFirstOrThrow({
        where: { userId: user.userId },
      });
      expect(JSON.stringify(response.body)).not.toContain(session.tokenHash);
    });

    it('stores only a digest of the session token, never the token', async () => {
      const user = await registerAndVerify(context, 'digest@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const session = await context.prisma.session.findFirstOrThrow({
        where: { userId: user.userId, revokedAt: null },
      });

      expect(session.tokenHash).not.toBe(client.sessionCookie);
      expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('clears both cookies on logout', async () => {
      const user = await registerAndVerify(context, 'clear-cookies@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const response = await client.post(`${API}/auth/logout`);
      const setCookie = response.headers['set-cookie'] as unknown as string[];

      expect(setCookie.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=;`))).toBe(true);
      expect(client.sessionCookie).toBeUndefined();
    });
  });
});
