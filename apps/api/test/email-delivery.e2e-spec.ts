import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { EmailSettingsService } from '../src/infrastructure/email/email-settings.service';
import { NotificationEmailRouter } from '../src/infrastructure/email/notification-email-router';
import { signSvix } from '../src/infrastructure/email/svix-signature';
import { ManagedMailDelivery } from '../src/modules/auth/mail/managed-mail-delivery';
import { API, AuthClient, lastResetToken, lastVerificationToken } from './support/auth-client';
import { createUser, signInGlobalRole, signInPlatformAdmin } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Admin-managed transactional email (ADR-0146), end to end.
 *
 * The Resend API is a local fake on 127.0.0.1: no test sends real mail. The
 * keys below are test-only strings in Resend's shape, not credentials.
 */
const API_KEY = 're_TESTONLY_e2e_fake_key_7XQ';
const SECOND_KEY = 're_TESTONLY_e2e_other_key_ABC';
const WEBHOOK_SECRET = `whsec_${Buffer.from('e2e-test-only-webhook-secret-0123').toString('base64')}`;
const ROOT_KEY = randomBytes(32).toString('base64');

interface Captured {
  readonly headers: IncomingMessage['headers'];
  readonly body: Record<string, unknown>;
}

class FakeResend {
  readonly requests: Captured[] = [];
  private queue: Array<{ status: number; body: unknown }> = [];
  private counter = 0;
  private server!: Server;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
          string,
          unknown
        >;
        this.requests.push({ headers: req.headers, body });
        const next = this.queue.shift() ?? {
          status: 200,
          body: { id: `em_fake_${++this.counter}` },
        };
        res.writeHead(next.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  respondNext(status: number, body: unknown, times = 1): void {
    for (let i = 0; i < times; i += 1) this.queue.push({ status, body });
  }

  reset(): void {
    this.requests.length = 0;
    this.queue = [];
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const baseSettings = {
  provider: 'RESEND',
  enabled: true,
  sendingDomain: 'palcert.com',
  fromEmail: 'no-reply@palcert.com',
  fromName: 'PalCert',
  replyToEmail: null,
  authVerificationEnabled: true,
  authPasswordResetEnabled: true,
  authInvitationEnabled: true,
  workflowEmailEnabled: true,
  deliveryTrackingEnabled: true,
};

describe('Admin-managed email (e2e)', () => {
  const fake = new FakeResend();
  let context: TestContext;

  beforeAll(async () => {
    await fake.start();
    context = await createTestContext(
      {
        EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID: 'e2e1',
        EMAIL_SETTINGS_ENCRYPTION_KEYS: `e2e1:${ROOT_KEY}`,
        RESEND_API_BASE_URL: fake.url,
        RESEND_TIMEOUT_MS: '2000',
        EMAIL_SETTINGS_CACHE_SECONDS: '0',
      },
      { realMailDelivery: true },
    );
  });

  afterAll(async () => {
    await destroyTestContext(context);
    await fake.stop();
  });

  beforeEach(async () => {
    await resetState(context);
    await context.adminDb.emailProviderEvent.deleteMany({});
    context.app.get(EmailSettingsService).invalidate();
    fake.reset();
  });

  const drain = () => context.app.get(ManagedMailDelivery).drain();

  async function enableResend(admin: AuthClient, extra: Record<string, unknown> = {}) {
    const response = await admin.put(`${API}/admin/email-settings`, {
      ...baseSettings,
      apiKey: API_KEY,
      ...extra,
    });
    expect(response.status).toBe(200);
    return response;
  }

  describe('before any administrator has saved settings', () => {
    it('reports defaults and sends nothing through the provider', async () => {
      const admin = await signInPlatformAdmin(context, 'admin-defaults@palcert.test');
      const view = await admin.get(`${API}/admin/email-settings`);
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({
        provider: 'DISABLED',
        enabled: false,
        sendingDomain: 'palcert.com',
        fromEmail: 'no-reply@palcert.com',
        fromName: 'PalCert',
        apiKeyConfigured: false,
        apiKeyDisplayHint: null,
        encryptionAvailable: true,
        isDefault: true,
      });

      await createUser(context, 'legacy-user@example.com');
      await drain();
      expect(fake.requests).toHaveLength(0);
      expect(await context.adminDb.emailDelivery.count()).toBe(0);
      expect(await context.adminDb.platformEmailSettings.count()).toBe(0);
    });
  });

  describe('permissions', () => {
    it('lets auditors read but not change or test; refuses finance and ordinary users', async () => {
      const auditor = await signInGlobalRole(
        context,
        'auditor-email@palcert.test',
        'PALCERT_AUDITOR',
      );
      const finance = await signInGlobalRole(
        context,
        'finance-email@palcert.test',
        'PALCERT_FINANCE',
      );
      const user = await createUser(context, 'plain-email@example.com');

      expect((await auditor.get(`${API}/admin/email-settings`)).status).toBe(200);
      expect((await auditor.get(`${API}/admin/email-deliveries`)).status).toBe(200);
      expect(
        (await auditor.put(`${API}/admin/email-settings`, { ...baseSettings, apiKey: API_KEY }))
          .status,
      ).toBe(403);
      expect(
        (
          await auditor.post(`${API}/admin/email-settings/test`, {
            recipient: 'a@example.org',
            locale: 'en',
          })
        ).status,
      ).toBe(403);

      expect((await finance.get(`${API}/admin/email-settings`)).status).toBe(403);
      expect((await finance.get(`${API}/admin/email-deliveries`)).status).toBe(403);
      expect((await user.client.get(`${API}/admin/email-settings`)).status).toBe(403);
      expect((await new AuthClient(context.app).get(`${API}/admin/email-settings`)).status).toBe(
        401,
      );
    });
  });

  describe('saving settings', () => {
    it('validates, refuses enabling without a key, and never returns or stores the key in plaintext', async () => {
      const admin = await signInPlatformAdmin(context, 'admin-save@palcert.test');

      const invalid = await admin.put(`${API}/admin/email-settings`, {
        ...baseSettings,
        fromEmail: 'no-reply@palcert.com\r\nBcc: x@evil.example',
        apiKey: API_KEY,
      });
      expect(invalid.status).toBe(422);
      expect(invalid.body.error?.code ?? invalid.body.code).toBe('EMAIL_SETTINGS_INVALID');

      const noKey = await admin.put(`${API}/admin/email-settings`, baseSettings);
      expect(noKey.status).toBe(422);

      const badKey = await admin.put(`${API}/admin/email-settings`, {
        ...baseSettings,
        apiKey: 'whsec_wrongkind',
      });
      expect(badKey.status).toBe(422);
      expect(JSON.stringify(badKey.body)).not.toContain('whsec_wrongkind');

      const saved = await enableResend(admin);
      expect(saved.body).toMatchObject({
        provider: 'RESEND',
        enabled: true,
        apiKeyConfigured: true,
      });
      expect(saved.body.apiKeyDisplayHint).toBe('re_••••••••7XQ');
      const serialized = JSON.stringify(saved.body);
      expect(serialized).not.toContain(API_KEY);
      expect(serialized).not.toMatch(/ciphertext|authTag|"iv"|kid/i);

      const row = await context.adminDb.platformEmailSettings.findUniqueOrThrow({
        where: { id: 1 },
      });
      expect(row.apiKeyCiphertext).not.toBeNull();
      expect(JSON.stringify(row)).not.toContain(API_KEY);
      expect(row.apiKeyKid).toBe('e2e1');

      const audits = await context.adminDb.auditEvent.findMany({
        where: { targetType: 'PLATFORM_EMAIL_SETTINGS' },
      });
      const actions = audits.map((a) => a.action).sort();
      expect(actions).toEqual([
        'EMAIL_PROVIDER_ENABLED',
        'EMAIL_PROVIDER_SECRET_REPLACED',
        'EMAIL_SETTINGS_UPDATED',
      ]);
      expect(JSON.stringify(audits)).not.toContain(API_KEY);
      expect(audits.find((a) => a.action === 'EMAIL_PROVIDER_SECRET_REPLACED')?.afterState).toEqual(
        {
          provider: 'RESEND',
          apiKeyChanged: true,
        },
      );
    });

    it('keeps the stored key when the field is left blank, and replaces it when given', async () => {
      const admin = await signInPlatformAdmin(context, 'admin-keep@palcert.test');
      await enableResend(admin);
      const before = await context.adminDb.platformEmailSettings.findUniqueOrThrow({
        where: { id: 1 },
      });

      const kept = await admin.put(`${API}/admin/email-settings`, {
        ...baseSettings,
        fromName: 'PalCert Mail',
        apiKey: '',
      });
      expect(kept.status).toBe(200);
      const after = await context.adminDb.platformEmailSettings.findUniqueOrThrow({
        where: { id: 1 },
      });
      expect(after.apiKeyCiphertext).toBe(before.apiKeyCiphertext);
      expect(after.fromName).toBe('PalCert Mail');

      await admin.put(`${API}/admin/email-settings`, { ...baseSettings, apiKey: SECOND_KEY });
      const replaced = await context.adminDb.platformEmailSettings.findUniqueOrThrow({
        where: { id: 1 },
      });
      expect(replaced.apiKeyCiphertext).not.toBe(before.apiKeyCiphertext);
      expect(replaced.apiKeyDisplayHint).toBe('re_••••••••ABC');
    });

    it('applies a change to the next send without a restart', async () => {
      const admin = await signInPlatformAdmin(context, 'admin-runtime@palcert.test');
      await enableResend(admin);
      await admin.put(`${API}/admin/email-settings`, { ...baseSettings, enabled: false });
      await createUser(context, 'after-disable@example.com');
      await drain();
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe('test email', () => {
    it('sends through the provider with the stored key and records metadata only', async () => {
      const admin = await signInPlatformAdmin(context, 'admin-test@palcert.test');
      await enableResend(admin, { enabled: false });

      const result = await admin.post(`${API}/admin/email-settings/test`, {
        recipient: 'ops@example.org',
        locale: 'ar',
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ accepted: true, status: 'ACCEPTED', failure: null });

      expect(fake.requests).toHaveLength(1);
      const sent = fake.requests[0]!;
      expect(sent.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(sent.body).toMatchObject({
        from: 'PalCert <no-reply@palcert.com>',
        to: ['ops@example.org'],
        subject: 'اختبار إعدادات البريد الإلكتروني في PalCert',
      });
      expect(String(sent.body.html)).toContain('dir="rtl"');
      expect(String(sent.body.text)).not.toContain(API_KEY);

      const row = await context.adminDb.emailDelivery.findUniqueOrThrow({
        where: { id: result.body.deliveryId },
      });
      expect(row).toMatchObject({
        category: 'TEST',
        template: 'CONFIGURATION_TEST',
        status: 'ACCEPTED',
        provider: 'resend',
      });
      expect(row.providerMessageId).toMatch(/^em_fake_/);

      const audit = await context.adminDb.auditEvent.findFirstOrThrow({
        where: { action: 'EMAIL_TEST_REQUESTED' },
      });
      expect(JSON.stringify(audit)).not.toContain(API_KEY);
    });

    it('reports a provider rejection as a category, never the provider text', async () => {
      const admin = await signInPlatformAdmin(context, 'admin-test-fail@palcert.test');
      await enableResend(admin);
      fake.respondNext(403, {
        name: 'validation_error',
        message: 'The palcert.com domain is not verified. SECRET-DETAIL',
      });

      const result = await admin.post(`${API}/admin/email-settings/test`, {
        recipient: 'ops@example.org',
        locale: 'en',
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        accepted: false,
        status: 'FAILED',
        failure: 'SENDER_REJECTED',
      });
      expect(JSON.stringify(result.body)).not.toContain('SECRET-DETAIL');
      const row = await context.adminDb.emailDelivery.findUniqueOrThrow({
        where: { id: result.body.deliveryId },
      });
      expect(JSON.stringify(row)).not.toContain('SECRET-DETAIL');
    });

    it('refuses when no provider is configured and rate-limits per administrator', async () => {
      const admin = await signInPlatformAdmin(context, 'admin-test-limit@palcert.test');
      const none = await admin.post(`${API}/admin/email-settings/test`, {
        recipient: 'ops@example.org',
        locale: 'en',
      });
      expect(none.status).toBe(409);

      await enableResend(admin);
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push(
          (
            await admin.post(`${API}/admin/email-settings/test`, {
              recipient: 'ops@example.org',
              locale: 'en',
            })
          ).status,
        );
      }
      // The refused-for-no-provider attempt above counted too.
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    });
  });

  describe('authentication mail', () => {
    it('sends verification and reset mail through Resend with APP_PUBLIC_WEB_URL links, and stores no token', async () => {
      const admin = await signInPlatformAdmin(context, 'admin-auth@palcert.test');
      await enableResend(admin);
      fake.reset();

      const registered = await new AuthClient(context.app).post(`${API}/auth/register`, {
        email: 'new-person@example.org',
        password: 'a-correct-horse-battery-staple',
        locale: 'en',
      });
      expect(registered.status).toBe(202);
      await drain();

      const token = lastVerificationToken(context, 'new-person@example.org');
      const verification = fake.requests.find(
        (r) => (r.body.to as string[])[0] === 'new-person@example.org',
      );
      expect(verification?.body.subject).toBe('Verify your PalCert email address');
      expect(String(verification?.body.text)).toContain(
        `http://localhost:3000/en/verify-email?token=${encodeURIComponent(token)}`,
      );

      const verified = await new AuthClient(context.app).post(`${API}/auth/email/verify`, {
        token,
      });
      expect(verified.status).toBe(200);

      await new AuthClient(context.app).post(`${API}/auth/password/forgot`, {
        email: 'new-person@example.org',
      });
      await drain();
      const resetToken = lastResetToken(context, 'new-person@example.org');
      expect(fake.requests.some((r) => r.body.subject === 'Reset your PalCert password')).toBe(
        true,
      );

      const rows = await context.adminDb.emailDelivery.findMany({});
      expect(rows.map((r) => r.template).sort()).toEqual(['EMAIL_VERIFICATION', 'PASSWORD_RESET']);
      expect(rows.every((r) => r.status === 'ACCEPTED' && r.category === 'AUTH')).toBe(true);
      const everything = JSON.stringify([
        rows,
        await context.adminDb.auditEvent.findMany({}),
        await context.adminDb.securityEvent.findMany({}),
      ]);
      expect(everything).not.toContain(token);
      expect(everything).not.toContain(resetToken);
    });

    it('preserves anti-enumeration: unknown accounts and provider failures look the same to the caller', async () => {
      const admin = await signInPlatformAdmin(context, 'admin-enum@palcert.test');
      await enableResend(admin);
      await createUser(context, 'exists@example.org');
      await drain();
      fake.reset();

      const unknown = await new AuthClient(context.app).post(`${API}/auth/password/forgot`, {
        email: 'nobody@example.org',
      });
      fake.respondNext(500, { name: 'application_error' }, 3);
      const known = await new AuthClient(context.app).post(`${API}/auth/password/forgot`, {
        email: 'exists@example.org',
      });
      expect(known.status).toBe(unknown.status);
      expect(known.body).toEqual(unknown.body);

      await drain();
      expect(fake.requests.every((r) => (r.body.to as string[])[0] !== 'nobody@example.org')).toBe(
        true,
      );
      const failed = await context.adminDb.emailDelivery.findFirstOrThrow({
        where: { recipient: 'exists@example.org', template: 'PASSWORD_RESET' },
      });
      expect(failed.status).toBe('FAILED');
      expect(failed.failureCode).toBe('PROVIDER_UNAVAILABLE');
      expect(failed.attemptCount).toBe(3);
    });

    it('honours the per-template switch', async () => {
      const admin = await signInPlatformAdmin(context, 'admin-switch@palcert.test');
      await enableResend(admin, { authVerificationEnabled: false });
      fake.reset();
      await new AuthClient(context.app).post(`${API}/auth/register`, {
        email: 'switched@example.org',
        password: 'a-correct-horse-battery-staple',
        locale: 'en',
      });
      await drain();
      expect(fake.requests).toHaveLength(0);
      const row = await context.adminDb.emailDelivery.findFirstOrThrow({
        where: { recipient: 'switched@example.org' },
      });
      expect(row).toMatchObject({ status: 'SKIPPED', skipReason: 'CATEGORY_DISABLED' });
    });
  });

  describe('workflow notification routing', () => {
    it('uses the environment provider until Resend is enabled, then Resend, and honours the switch', async () => {
      const router = context.workerApp.get(NotificationEmailRouter);
      const ctx = {
        notificationDeliveryId: '00000000-0000-4000-8000-000000000001',
        notificationType: 'CERTIFICATE_ISSUED',
      };

      expect(await router.resolve(ctx)).toBe(context.emailProvider);

      const admin = await signInPlatformAdmin(context, 'admin-workflow@palcert.test');
      await enableResend(admin);
      context.workerApp.get(EmailSettingsService).invalidate();
      const managed = await router.resolve(ctx);
      expect(managed.provider).toBe('resend');
      expect(managed.enabled).toBe(true);

      await admin.put(`${API}/admin/email-settings`, {
        ...baseSettings,
        workflowEmailEnabled: false,
      });
      context.workerApp.get(EmailSettingsService).invalidate();
      expect((await router.resolve(ctx)).enabled).toBe(false);
    });
  });

  describe('delivery history and webhook', () => {
    async function signedPost(
      body: string,
      id = `msg_${randomBytes(6).toString('hex')}`,
      secret = WEBHOOK_SECRET,
    ) {
      const ts = String(Math.floor(Date.now() / 1000));
      return request(context.app.getHttpServer())
        .post(`${API}/webhooks/resend`)
        .set('content-type', 'application/json')
        .set('svix-id', id)
        .set('svix-timestamp', ts)
        .set('svix-signature', signSvix(secret, id, ts, body))
        .send(body);
    }

    it('lists deliveries without bodies, applies signed events once and never moves backwards', async () => {
      const admin = await signInPlatformAdmin(context, 'admin-hook@palcert.test');
      await enableResend(admin, { webhookSecret: WEBHOOK_SECRET });
      const test = await admin.post(`${API}/admin/email-settings/test`, {
        recipient: 'ops@example.org',
        locale: 'en',
      });
      const delivery = await context.adminDb.emailDelivery.findUniqueOrThrow({
        where: { id: test.body.deliveryId },
      });
      const emailId = delivery.providerMessageId!;

      const list = await admin.get(`${API}/admin/email-deliveries?category=TEST`);
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(1);
      expect(Object.keys(list.body.items[0])).not.toEqual(
        expect.arrayContaining(['html', 'text', 'subject']),
      );

      const bounced = JSON.stringify({
        type: 'email.bounced',
        created_at: new Date().toISOString(),
        data: { email_id: emailId, bounce: { message: 'mailbox full at mx.example.org' } },
      });
      const first = await signedPost(bounced, 'msg_fixed_1');
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ received: true, duplicate: false });
      expect((await signedPost(bounced, 'msg_fixed_1')).body.duplicate).toBe(true);

      const late = JSON.stringify({
        type: 'email.delivered',
        created_at: new Date().toISOString(),
        data: { email_id: emailId },
      });
      expect((await signedPost(late)).status).toBe(200);

      const one = await admin.get(`${API}/admin/email-deliveries/${delivery.id}`);
      expect(one.body.status).toBe('BOUNCED');
      expect(one.body.failureCode).toBe('RECIPIENT_REJECTED');
      expect(JSON.stringify(one.body)).not.toContain('mailbox full');

      const events = await context.adminDb.emailProviderEvent.findMany({});
      expect(events.map((e) => e.outcome).sort()).toEqual(['APPLIED', 'STALE']);
      expect(JSON.stringify(events)).not.toContain('mailbox full');
    });

    it('rejects an unsigned, wrongly signed or unconfigured webhook with no effect', async () => {
      const admin = await signInPlatformAdmin(context, 'admin-hook-bad@palcert.test');
      const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_x' } });
      expect((await signedPost(body)).status).toBe(400); // no secret configured yet

      await enableResend(admin, { webhookSecret: WEBHOOK_SECRET });
      const wrong = `whsec_${Buffer.from('a-different-test-secret-xxxxxxx').toString('base64')}`;
      expect((await signedPost(body, undefined, wrong)).status).toBe(400);
      const unsigned = await request(context.app.getHttpServer())
        .post(`${API}/webhooks/resend`)
        .set('content-type', 'application/json')
        .send(body);
      expect(unsigned.status).toBe(400);
      expect(await context.adminDb.emailProviderEvent.count()).toBe(0);
    });
  });
});

describe('Admin-managed email without a root key (e2e)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext({ EMAIL_SETTINGS_CACHE_SECONDS: '0' });
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
  });

  it('boots, says secure configuration is unavailable, and refuses to store a credential', async () => {
    const admin = await signInPlatformAdmin(context, 'admin-nokey@palcert.test');
    const view = await admin.get(`${API}/admin/email-settings`);
    expect(view.status).toBe(200);
    expect(view.body.encryptionAvailable).toBe(false);
    expect(view.body.warnings).toContain('ENCRYPTION_UNAVAILABLE');

    const refused = await admin.put(`${API}/admin/email-settings`, {
      ...baseSettings,
      apiKey: API_KEY,
    });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).not.toContain(API_KEY);
    expect(await context.adminDb.platformEmailSettings.count()).toBe(0);
  });
});
