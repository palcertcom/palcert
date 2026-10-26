import { API, AuthClient, lastResetToken, lastVerificationToken } from './support/auth-client';
import {
  createOrganization,
  createUser,
  inviteAndCaptureToken,
} from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

const PASSWORD = 'a-correct-horse-battery-staple';

/**
 * End-to-end journeys in both supported locales (§38).
 *
 * These assert that locale travels with the user through the whole flow: it is
 * stored on the account, it determines the language the mail is generated in,
 * and it shapes the links the user is sent — so an Arabic-speaking user is
 * never dropped onto an English page mid-journey.
 */
describe.each([
  { locale: 'en' as const, name: 'English' },
  { locale: 'ar' as const, name: 'Arabic' },
])('$name authentication journey (e2e)', ({ locale }) => {
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

  it('completes register → verify → login → profile → logout', async () => {
    const email = `journey-${locale}@example.com`;
    const client = new AuthClient(context.app);

    // Register in this locale.
    const registered = await client.post(`${API}/auth/register`, {
      email,
      password: PASSWORD,
      displayName: locale === 'ar' ? 'رائد رشيد' : 'Raed Rasheed',
      locale,
    });
    expect(registered.status).toBe(202);

    // The verification mail is produced for this locale, and the link points at
    // the locale-prefixed route.
    const mail = context.outbox.lastTo(email, 'EMAIL_VERIFICATION')!;
    expect(mail.locale).toBe(locale);
    expect(mail.variables.url).toContain(`/${locale}/verify-email`);
    expect(mail.variables.url).toContain('token=');

    await client
      .post(`${API}/auth/email/verify`, { token: lastVerificationToken(context, email) })
      .then((response) => expect(response.status).toBe(200));

    const login = await client.post(`${API}/auth/login`, { email, password: PASSWORD });
    expect(login.status).toBe(200);

    const profile = await client.get(`${API}/users/me`);
    expect(profile.status).toBe(200);
    expect(profile.body.preferredLocale).toBe(locale);
    expect(profile.body.displayName).toBe(locale === 'ar' ? 'رائد رشيد' : 'Raed Rasheed');

    expect((await client.post(`${API}/auth/logout`)).status).toBe(204);
    expect((await client.get(`${API}/users/me`)).status).toBe(401);
  });

  it("sends the reset link in the user's locale", async () => {
    const email = `reset-${locale}@example.com`;
    const client = new AuthClient(context.app);

    await client.post(`${API}/auth/register`, { email, password: PASSWORD, locale });
    await client.post(`${API}/auth/email/verify`, {
      token: lastVerificationToken(context, email),
    });

    await client.post(`${API}/auth/password/forgot`, { email });

    const mail = context.outbox.lastTo(email, 'PASSWORD_RESET')!;
    expect(mail.locale).toBe(locale);
    expect(mail.variables.url).toContain(`/${locale}/reset-password`);

    const reset = await client.post(`${API}/auth/password/reset`, {
      token: lastResetToken(context, email),
      newPassword: 'a-new-localized-passphrase',
    });
    expect(reset.status).toBe(200);

    const login = await client.post(`${API}/auth/login`, {
      email,
      password: 'a-new-localized-passphrase',
    });
    expect(login.status).toBe(200);
  });

  it('keeps the locale when the user changes it on their profile', async () => {
    const email = `switch-${locale}@example.com`;
    const other = locale === 'en' ? 'ar' : 'en';
    const client = new AuthClient(context.app);

    await client.post(`${API}/auth/register`, { email, password: PASSWORD, locale });
    await client.post(`${API}/auth/email/verify`, {
      token: lastVerificationToken(context, email),
    });
    await client.post(`${API}/auth/login`, { email, password: PASSWORD });

    const updated = await client.patch(`${API}/users/me`, { preferredLocale: other });
    expect(updated.status).toBe(200);
    expect(updated.body.preferredLocale).toBe(other);

    // A later reset mail follows the new preference.
    await client.post(`${API}/auth/password/forgot`, { email });
    expect(context.outbox.lastTo(email, 'PASSWORD_RESET')!.locale).toBe(other);
  });

  it('completes an organization journey in this locale', async () => {
    const ownerEmail = `org-journey-${locale}@example.com`;
    const inviteeEmail = `org-invitee-${locale}@example.com`;

    const owner = await createUser(context, ownerEmail, locale);
    const organization = await createOrganization(owner.client, {
      displayName: locale === 'ar' ? 'الجامعة الإسلامية بغزة' : 'Islamic University of Gaza',
      legalName: locale === 'ar' ? 'الجامعة الإسلامية بغزة' : 'Islamic University of Gaza',
      defaultLocale: locale,
    });

    // A non-Latin display name still yields a usable handle.
    expect(organization.slug).toMatch(/^[a-z0-9-]{3,63}$/);
    expect(organization.body.defaultLocale).toBe(locale);
    expect(organization.body.displayName).toBe(
      locale === 'ar' ? 'الجامعة الإسلامية بغزة' : 'Islamic University of Gaza',
    );

    // The invitation mail follows the organization's language, and its link
    // points at the locale-prefixed acceptance route.
    const invitation = await inviteAndCaptureToken(
      context,
      owner.client,
      organization.id,
      inviteeEmail,
      'ORGANIZATION_ADMIN',
    );
    const mail = context.outbox.lastTo(inviteeEmail, 'ORGANIZATION_INVITATION')!;
    expect(mail.locale).toBe(locale);
    expect(mail.variables.url).toContain(`/${locale}/invitations/accept`);

    const invitee = await createUser(context, inviteeEmail, locale);
    const accepted = await invitee.client.post(`${API}/invitations/accept`, {
      token: invitation.token,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.organizationId).toBe(organization.id);

    const mine = await invitee.client.get(`${API}/organizations`);
    expect(mine.body).toHaveLength(1);
    // Enum values stay canonical regardless of locale; only labels are
    // translated, and that happens in the UI.
    expect(mine.body[0].roles).toEqual(['ORGANIZATION_ADMIN']);
    expect(mine.body[0].organization.status).toBe('ACTIVE');
  });

  it('rejects an unsupported locale rather than storing it', async () => {
    const response = await new AuthClient(context.app).post(`${API}/auth/register`, {
      email: `bad-locale-${locale}@example.com`,
      password: PASSWORD,
      locale: 'fr',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});
