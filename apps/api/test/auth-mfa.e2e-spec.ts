import { RoleCode } from '@palcert/contracts';
import { API, AuthClient, grantGlobalRole, registerAndVerify, signIn } from './support/auth-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';
import { generateTotp } from './auth-security.e2e-spec';

const PASSWORD = 'a-correct-horse-battery-staple';

describe('Multi-factor authentication (e2e)', () => {
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

  // --- 14. privileged user MFA flow -----------------------------------------
  describe('privileged accounts', () => {
    it('requires enrollment before a privileged account can do anything', async () => {
      const admin = await registerAndVerify(context, 'new-admin@example.com');
      await grantGlobalRole(context, admin.userId, RoleCode.PALCERT_ADMIN);

      const client = new AuthClient(context.app);
      const login = await client.post(`${API}/auth/login`, {
        email: admin.email,
        password: PASSWORD,
      });

      expect(login.status).toBe(200);
      expect(login.body.status).toBe('MFA_ENROLLMENT_REQUIRED');

      // The pre-authentication session cannot reach anything else.
      const blocked = await client.get(`${API}/users/me`);
      expect(blocked.status).toBe(401);
      expect(blocked.body.error.code).toBe('MFA_REQUIRED');
      expect((await client.get(`${API}/admin/users`)).status).toBe(401);
    });

    it('completes the login when enrollment is confirmed', async () => {
      const admin = await registerAndVerify(context, 'enrolling-admin@example.com');
      await grantGlobalRole(context, admin.userId, RoleCode.PALCERT_ADMIN);

      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/login`, { email: admin.email, password: PASSWORD });

      const enrollment = await client.post(`${API}/auth/mfa/enroll`, {});
      expect(enrollment.status).toBe(200);
      expect(enrollment.body.provisioningUri).toMatch(/^otpauth:\/\/totp\//);
      expect(enrollment.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

      const confirmed = await client.post(`${API}/auth/mfa/confirm`, {
        code: generateTotp(enrollment.body.secret, context.clock.now()),
      });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.recoveryCodes).toHaveLength(10);

      // Now fully authenticated at AAL2 and able to use admin capability.
      const profile = await client.get(`${API}/users/me`);
      expect(profile.status).toBe(200);
      expect(profile.body.mfaEnrolled).toBe(true);
      expect(profile.body.mfaRequired).toBe(true);
      expect((await client.get(`${API}/admin/users`)).status).toBe(200);
    });

    it('challenges a privileged user at every later sign-in', async () => {
      const admin = await enrollPrivileged(context, 'returning-admin@example.com');

      const client = new AuthClient(context.app);
      const login = await client.post(`${API}/auth/login`, {
        email: admin.email,
        password: PASSWORD,
      });
      expect(login.body.status).toBe('MFA_REQUIRED');
      expect((await client.get(`${API}/admin/users`)).status).toBe(401);

      context.clock.advanceMinutes(1);
      const challenge = await client.post(`${API}/auth/mfa/challenge`, {
        code: await currentCode(context, admin.email),
      });
      expect(challenge.status).toBe(200);
      expect((await client.get(`${API}/admin/users`)).status).toBe(200);
    });

    it('gives a privileged session the stricter idle timeout', async () => {
      const admin = await enrollPrivileged(context, 'strict-timeout@example.com');
      const client = await signInPrivileged(context, admin.email);

      expect((await client.get(`${API}/users/me`)).status).toBe(200);

      // Privileged idle window is 15 minutes; the standard one is 60.
      context.clock.advanceMinutes(16);

      const response = await client.get(`${API}/users/me`);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('SESSION_EXPIRED');
    });

    it('expires the pre-authentication session quickly', async () => {
      const admin = await enrollPrivileged(context, 'pending-expiry@example.com');

      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/login`, { email: admin.email, password: PASSWORD });

      // Pending-MFA window is 5 minutes.
      context.clock.advanceMinutes(6);

      const response = await client.post(`${API}/auth/mfa/challenge`, { code: '123456' });
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('SESSION_EXPIRED');
    });

    it('refuses to let a privileged user disable MFA', async () => {
      const admin = await enrollPrivileged(context, 'cannot-disable@example.com');
      const client = await signInPrivileged(context, admin.email);

      context.clock.advanceMinutes(1);
      const response = await client.delete(`${API}/auth/mfa`, {
        password: PASSWORD,
        code: await currentCode(context, admin.email),
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
      await expect(
        context.prisma.mfaAuthenticator.count({ where: { userId: admin.userId } }),
      ).resolves.toBe(1);
    });
  });

  // --- 15. invalid MFA -------------------------------------------------------
  describe('challenge failures', () => {
    it('rejects a wrong code and leaves the session unauthenticated', async () => {
      const admin = await enrollPrivileged(context, 'wrong-code@example.com');
      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/login`, { email: admin.email, password: PASSWORD });

      const response = await client.post(`${API}/auth/mfa/challenge`, { code: '000000' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('MFA_INVALID');
      expect((await client.get(`${API}/users/me`)).status).toBe(401);
    });

    it('rejects a code from a distant time window', async () => {
      const admin = await enrollPrivileged(context, 'stale-code@example.com');
      const staleCode = await currentCode(context, admin.email);

      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/login`, { email: admin.email, password: PASSWORD });

      // Three minutes is six TOTP steps away — far outside the ±1 step skew
      // tolerance, while staying inside the 5-minute pending-MFA window so the
      // code check is what rejects this, not session expiry.
      context.clock.advanceMinutes(3);
      const response = await client.post(`${API}/auth/mfa/challenge`, { code: staleCode });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('MFA_INVALID');
    });

    it('refuses to replay a code already accepted', async () => {
      const admin = await enrollPrivileged(context, 'code-replay@example.com');

      context.clock.advanceMinutes(1);
      const code = await currentCode(context, admin.email);

      const first = new AuthClient(context.app);
      await first.post(`${API}/auth/login`, { email: admin.email, password: PASSWORD });
      expect((await first.post(`${API}/auth/mfa/challenge`, { code })).status).toBe(200);

      // An attacker who observed the code tries it inside the same window.
      const second = new AuthClient(context.app);
      await second.post(`${API}/auth/login`, { email: admin.email, password: PASSWORD });
      const replay = await second.post(`${API}/auth/mfa/challenge`, { code });

      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('MFA_INVALID');
    });

    it('throttles repeated MFA guesses', async () => {
      const admin = await enrollPrivileged(context, 'mfa-throttle@example.com');
      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/login`, { email: admin.email, password: PASSWORD });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await client.post(`${API}/auth/mfa/challenge`, { code: '000000' });
        expect(response.status).toBe(401);
      }

      const throttled = await client.post(`${API}/auth/mfa/challenge`, { code: '000000' });
      expect(throttled.status).toBe(429);
      expect(throttled.body.error.code).toBe('RATE_LIMITED');
    });

    it('records a security event for each failed challenge', async () => {
      const admin = await enrollPrivileged(context, 'mfa-events@example.com');
      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/login`, { email: admin.email, password: PASSWORD });
      await client.post(`${API}/auth/mfa/challenge`, { code: '000000' });

      const events = await context.prisma.securityEvent.findMany({
        where: { type: 'MFA_CHALLENGE_FAILED' },
      });
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0]!.metadata)).not.toContain('000000');
    });

    it('rejects a non-numeric or wrongly sized code without a server error', async () => {
      const admin = await enrollPrivileged(context, 'malformed-code@example.com');
      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/login`, { email: admin.email, password: PASSWORD });

      for (const code of ['abcdef', '12345', '1234567890']) {
        const response = await client.post(`${API}/auth/mfa/challenge`, { code });
        expect([400, 401]).toContain(response.status);
      }
    });
  });

  // --- 16. recovery codes ----------------------------------------------------
  describe('recovery codes', () => {
    it('accepts a recovery code and consumes it exactly once', async () => {
      const { admin, recoveryCodes } = await enrollPrivilegedWithCodes(
        context,
        'recovery@example.com',
      );
      const [code] = recoveryCodes;

      const first = new AuthClient(context.app);
      await first.post(`${API}/auth/login`, { email: admin.email, password: PASSWORD });
      const accepted = await first.post(`${API}/auth/mfa/challenge`, {
        code,
        useRecoveryCode: true,
      });
      expect(accepted.status).toBe(200);
      expect((await first.get(`${API}/users/me`)).status).toBe(200);

      // The same code must never work twice.
      const second = new AuthClient(context.app);
      await second.post(`${API}/auth/login`, { email: admin.email, password: PASSWORD });
      const replay = await second.post(`${API}/auth/mfa/challenge`, {
        code,
        useRecoveryCode: true,
      });
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('MFA_INVALID');
    });

    it('accepts a recovery code regardless of case and spacing', async () => {
      const { admin, recoveryCodes } = await enrollPrivilegedWithCodes(
        context,
        'recovery-format@example.com',
      );

      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/login`, { email: admin.email, password: PASSWORD });
      const response = await client.post(`${API}/auth/mfa/challenge`, {
        code: recoveryCodes[1]!.toLowerCase().replace(/-/g, ' '),
        useRecoveryCode: true,
      });

      expect(response.status).toBe(200);
    });

    it('records use of a recovery code with the number remaining', async () => {
      const { admin, recoveryCodes } = await enrollPrivilegedWithCodes(
        context,
        'recovery-event@example.com',
      );

      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/login`, { email: admin.email, password: PASSWORD });
      await client.post(`${API}/auth/mfa/challenge`, {
        code: recoveryCodes[0],
        useRecoveryCode: true,
      });

      const event = await context.prisma.securityEvent.findFirstOrThrow({
        where: { type: 'MFA_RECOVERY_USED' },
      });
      expect(event.userId).toBe(admin.userId);
      expect(event.metadata).toEqual({ remaining: 9 });
      expect(JSON.stringify(event.metadata)).not.toContain(recoveryCodes[0]);
    });

    it('rejects a recovery code that was never issued', async () => {
      const { admin } = await enrollPrivilegedWithCodes(context, 'fake-recovery@example.com');

      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/login`, { email: admin.email, password: PASSWORD });
      const response = await client.post(`${API}/auth/mfa/challenge`, {
        code: 'AAAAA-BBBBB-CCCCC-DDDDD',
        useRecoveryCode: true,
      });

      expect(response.status).toBe(401);
    });

    it("does not accept another user's recovery code", async () => {
      const victim = await enrollPrivilegedWithCodes(context, 'victim-codes@example.com');
      const attacker = await enrollPrivileged(context, 'attacker-codes@example.com');

      const client = new AuthClient(context.app);
      await client.post(`${API}/auth/login`, { email: attacker.email, password: PASSWORD });
      const response = await client.post(`${API}/auth/mfa/challenge`, {
        code: victim.recoveryCodes[0],
        useRecoveryCode: true,
      });

      expect(response.status).toBe(401);
      // The victim's code is still unused.
      await expect(
        context.prisma.mfaRecoveryCode.count({
          where: { userId: victim.admin.userId, consumedAt: null },
        }),
      ).resolves.toBe(10);
    });
  });

  // --- ordinary users --------------------------------------------------------
  describe('optional MFA for ordinary users', () => {
    it('lets an ordinary user enrol and then requires it at sign-in', async () => {
      const user = await registerAndVerify(context, 'optional-mfa@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const enrollment = await client.post(`${API}/auth/mfa/enroll`, {});
      const confirmed = await client.post(`${API}/auth/mfa/confirm`, {
        code: generateTotp(enrollment.body.secret, context.clock.now()),
      });
      expect(confirmed.status).toBe(200);

      const next = new AuthClient(context.app);
      const login = await next.post(`${API}/auth/login`, {
        email: user.email,
        password: PASSWORD,
      });
      expect(login.body.status).toBe('MFA_REQUIRED');
    });

    it('lets an ordinary user disable MFA with password and a current code', async () => {
      const user = await registerAndVerify(context, 'disable-mfa@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const enrollment = await client.post(`${API}/auth/mfa/enroll`, {});
      await client.post(`${API}/auth/mfa/confirm`, {
        code: generateTotp(enrollment.body.secret, context.clock.now()),
      });

      context.clock.advanceMinutes(1);
      const response = await client.delete(`${API}/auth/mfa`, {
        password: PASSWORD,
        code: generateTotp(enrollment.body.secret, context.clock.now()),
      });

      expect(response.status).toBe(200);
      await expect(
        context.prisma.mfaAuthenticator.count({ where: { userId: user.userId } }),
      ).resolves.toBe(0);
      await expect(
        context.prisma.mfaRecoveryCode.count({ where: { userId: user.userId } }),
      ).resolves.toBe(0);
    });

    it('refuses to disable MFA without the password', async () => {
      const user = await registerAndVerify(context, 'disable-needs-password@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const enrollment = await client.post(`${API}/auth/mfa/enroll`, {});
      await client.post(`${API}/auth/mfa/confirm`, {
        code: generateTotp(enrollment.body.secret, context.clock.now()),
      });

      context.clock.advanceMinutes(1);
      const response = await client.delete(`${API}/auth/mfa`, {
        password: 'not-the-real-password',
        code: generateTotp(enrollment.body.secret, context.clock.now()),
      });

      expect(response.status).toBe(401);
      await expect(
        context.prisma.mfaAuthenticator.count({ where: { userId: user.userId } }),
      ).resolves.toBe(1);
    });

    it('does not treat an unconfirmed authenticator as enrolled', async () => {
      const user = await registerAndVerify(context, 'unconfirmed@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      await client.post(`${API}/auth/mfa/enroll`, {});

      // A secret exists, but possession was never proven.
      await expect(
        context.prisma.mfaAuthenticator.count({ where: { userId: user.userId } }),
      ).resolves.toBe(1);
      expect((await client.get(`${API}/users/me`)).body.mfaEnrolled).toBe(false);

      const next = new AuthClient(context.app);
      const login = await next.post(`${API}/auth/login`, {
        email: user.email,
        password: PASSWORD,
      });
      expect(login.body.status).toBe('AUTHENTICATED');
    });

    it('refuses a second enrollment while one is active', async () => {
      const user = await registerAndVerify(context, 'double-enroll@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      const enrollment = await client.post(`${API}/auth/mfa/enroll`, {});
      await client.post(`${API}/auth/mfa/confirm`, {
        code: generateTotp(enrollment.body.secret, context.clock.now()),
      });

      const second = await client.post(`${API}/auth/mfa/enroll`, {});
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('MFA_ALREADY_ENROLLED');
    });

    it('rejects confirmation with a wrong code and leaves MFA off', async () => {
      const user = await registerAndVerify(context, 'bad-confirm@example.com');
      const client = await signIn(context, user.email, PASSWORD);

      await client.post(`${API}/auth/mfa/enroll`, {});
      const response = await client.post(`${API}/auth/mfa/confirm`, { code: '000000' });

      expect(response.status).toBe(401);
      expect((await client.get(`${API}/users/me`)).body.mfaEnrolled).toBe(false);
    });
  });

  // --- turning MFA off, attempted directly against the API ------------------
  // The profile page hides the control from an account that must keep its
  // second factor; these prove the API refuses regardless of what a client
  // shows or sends.
  describe('DELETE /auth/mfa, called directly', () => {
    async function authenticators(userId: string): Promise<number> {
      return context.prisma.mfaAuthenticator.count({ where: { userId } });
    }

    it.each([RoleCode.PALCERT_ADMIN, RoleCode.PALCERT_FINANCE, RoleCode.PALCERT_AUDITOR])(
      'refuses a %s even with the right password and a current code',
      async (role) => {
        const email = `direct-${role.toLowerCase().replace(/_/g, '-')}@example.com`;
        const admin = await enrollPrivileged(context, email, role);
        const client = await signInPrivileged(context, admin.email);
        expect((await client.get(`${API}/users/me`)).body.mfaRequired).toBe(true);

        context.clock.advanceMinutes(1);
        const response = await client.delete(`${API}/auth/mfa`, {
          password: PASSWORD,
          code: await currentCode(context, admin.email),
        });

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('PERMISSION_DENIED');
        await expect(authenticators(admin.userId)).resolves.toBe(1);
        await expect(
          context.prisma.securityEvent.count({
            where: { userId: admin.userId, type: 'MFA_DISABLED' },
          }),
        ).resolves.toBe(0);
      },
    );

    it('refuses a privileged account before looking at the password', async () => {
      // Policy first: a wrong password gets the same refusal, so the endpoint
      // is not a password oracle for an account that could never use it.
      const admin = await enrollPrivileged(context, 'direct-wrong-password@example.com');
      const client = await signInPrivileged(context, admin.email);
      context.clock.advanceMinutes(1);

      const response = await client.delete(`${API}/auth/mfa`, {
        password: 'not-the-real-password',
        code: '000000',
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
      await expect(authenticators(admin.userId)).resolves.toBe(1);
    });

    it('refuses an ordinary account an administrator has required MFA for', async () => {
      const { user } = await enrollOrdinary(context, 'direct-override@example.com');
      await context.prisma.user.update({
        where: { id: user.userId },
        data: { mfaRequiredOverride: true },
      });
      // With the override the account needs a second-factor sign-in (AAL2).
      const client = await signInPrivileged(context, user.email);
      expect((await client.get(`${API}/users/me`)).body.mfaRequired).toBe(true);

      context.clock.advanceMinutes(1);
      const response = await client.delete(`${API}/auth/mfa`, {
        password: PASSWORD,
        code: await currentCode(context, user.email),
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
      await expect(authenticators(user.userId)).resolves.toBe(1);
    });

    it('lets an ordinary account turn it off, and says so everywhere', async () => {
      const { user, client, secret } = await enrollOrdinary(context, 'direct-ok@example.com');
      const code = generateTotp(secret, context.clock.now());
      expect((await client.get(`${API}/users/me`)).body).toMatchObject({
        mfaEnrolled: true,
        mfaRequired: false,
      });

      const response = await client.delete(`${API}/auth/mfa`, { password: PASSWORD, code });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ acknowledged: true });
      // The session that did it stays signed in, and the account reads off.
      expect((await client.get(`${API}/users/me`)).body.mfaEnrolled).toBe(false);
      const events = await context.prisma.securityEvent.findMany({
        where: { userId: user.userId, type: 'MFA_DISABLED' },
      });
      expect(events).toHaveLength(1);
      const recorded = JSON.stringify(events[0]);
      expect(recorded).not.toContain(PASSWORD);
      expect(recorded).not.toContain(code);
      expect(recorded).not.toContain(secret);
    });

    it('rejects a wrong code, and a code from a distant window, and keeps the factor', async () => {
      const { user, client, secret } = await enrollOrdinary(context, 'direct-bad-code@example.com');

      const wrong = await client.delete(`${API}/auth/mfa`, { password: PASSWORD, code: '000000' });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe('MFA_INVALID');

      const stale = await client.delete(`${API}/auth/mfa`, {
        password: PASSWORD,
        code: generateTotp(secret, new Date(context.clock.now().getTime() - 10 * 60_000)),
      });
      expect(stale.status).toBe(401);
      expect(stale.body.error.code).toBe('MFA_INVALID');
      await expect(authenticators(user.userId)).resolves.toBe(1);
    });

    it('rejects a wrong password with a current code, and keeps the factor', async () => {
      const { user, client, secret } = await enrollOrdinary(context, 'direct-bad-pw@example.com');
      const response = await client.delete(`${API}/auth/mfa`, {
        password: 'not-the-real-password',
        code: generateTotp(secret, context.clock.now()),
      });
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_FAILED');
      await expect(authenticators(user.userId)).resolves.toBe(1);
    });

    it('needs a session, a live one, and the CSRF header', async () => {
      const { user, client, secret } = await enrollOrdinary(context, 'direct-session@example.com');
      const body = () => ({ password: PASSWORD, code: generateTotp(secret, context.clock.now()) });

      const anonymous = await new AuthClient(context.app).delete(`${API}/auth/mfa`, body());
      expect(anonymous.status).toBe(401);

      const forged = await client.delete(`${API}/auth/mfa`, body(), { omitCsrf: true });
      expect(forged.status).toBe(403);
      expect(forged.body.error.code).toBe('CSRF_INVALID');

      // The standard idle window is 60 minutes.
      context.clock.advanceMinutes(61);
      const expired = await client.delete(`${API}/auth/mfa`, body());
      expect(expired.status).toBe(401);
      expect(expired.body.error.code).toBe('SESSION_EXPIRED');

      await expect(authenticators(user.userId)).resolves.toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function enrollPrivilegedWithCodes(
  context: TestContext,
  email: string,
  role: RoleCode = RoleCode.PALCERT_ADMIN,
): Promise<{ admin: { email: string; userId: string }; recoveryCodes: string[] }> {
  const admin = await registerAndVerify(context, email);
  await grantGlobalRole(context, admin.userId, role);

  const client = new AuthClient(context.app);
  await client.post(`${API}/auth/login`, { email, password: PASSWORD });
  const enrollment = await client.post(`${API}/auth/mfa/enroll`, {});
  const confirmed = await client.post(`${API}/auth/mfa/confirm`, {
    code: generateTotp(enrollment.body.secret, context.clock.now()),
  });
  if (confirmed.status !== 200) {
    throw new Error(`Enrollment failed: ${JSON.stringify(confirmed.body)}`);
  }

  return { admin, recoveryCodes: confirmed.body.recoveryCodes };
}

async function enrollPrivileged(
  context: TestContext,
  email: string,
  role: RoleCode = RoleCode.PALCERT_ADMIN,
): Promise<{ email: string; userId: string }> {
  return (await enrollPrivilegedWithCodes(context, email, role)).admin;
}

/** An ordinary account, signed in, with a confirmed authenticator. */
async function enrollOrdinary(
  context: TestContext,
  email: string,
): Promise<{ user: { email: string; userId: string }; client: AuthClient; secret: string }> {
  const user = await registerAndVerify(context, email);
  const client = await signIn(context, user.email, PASSWORD);
  const enrollment = await client.post(`${API}/auth/mfa/enroll`, {});
  const confirmed = await client.post(`${API}/auth/mfa/confirm`, {
    code: generateTotp(enrollment.body.secret, context.clock.now()),
  });
  if (confirmed.status !== 200) {
    throw new Error(`Enrollment failed: ${JSON.stringify(confirmed.body)}`);
  }
  // The next code, so a disable is never a replay of the confirmation.
  context.clock.advanceMinutes(1);
  return { user, client, secret: enrollment.body.secret };
}

async function signInPrivileged(context: TestContext, email: string): Promise<AuthClient> {
  const client = new AuthClient(context.app);
  await client.post(`${API}/auth/login`, { email, password: PASSWORD });
  context.clock.advanceMinutes(1);
  const response = await client.post(`${API}/auth/mfa/challenge`, {
    code: await currentCode(context, email),
  });
  if (response.status !== 200) {
    throw new Error(`Challenge failed: ${JSON.stringify(response.body)}`);
  }
  return client;
}

async function currentCode(context: TestContext, email: string): Promise<string> {
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
