import { API, AuthClient, registerAndVerify, signIn } from './auth-client';
import type { TestContext } from './test-app';

export const PASSWORD = 'a-correct-horse-battery-staple';

export interface TenantFixture {
  readonly organizationId: string;
  readonly slug: string;
  readonly owner: { email: string; userId: string; client: AuthClient };
}

export async function createUser(
  context: TestContext,
  email: string,
  locale: 'en' | 'ar' = 'en',
): Promise<{ email: string; userId: string; client: AuthClient }> {
  const user = await registerAndVerify(context, email, PASSWORD, locale);
  const client = await signIn(context, email, PASSWORD);
  return { email, userId: user.userId, client };
}

export async function createOrganization(
  client: AuthClient,
  overrides: Partial<{
    type: string;
    displayName: string;
    legalName: string;
    slug: string;
    countryCode: string;
    timezone: string;
    website: string;
    defaultLocale: string;
  }> = {},
): Promise<{ id: string; slug: string; body: Record<string, unknown> }> {
  const response = await client.post(`${API}/organizations`, {
    type: overrides.type ?? 'UNIVERSITY',
    displayName: overrides.displayName ?? 'Test University',
    legalName: overrides.legalName ?? 'Test University Legal Entity',
    countryCode: overrides.countryCode ?? 'PS',
    timezone: overrides.timezone ?? 'Asia/Hebron',
    ...(overrides.slug !== undefined ? { slug: overrides.slug } : {}),
    ...(overrides.website !== undefined ? { website: overrides.website } : {}),
    ...(overrides.defaultLocale !== undefined ? { defaultLocale: overrides.defaultLocale } : {}),
  });

  if (response.status !== 201) {
    throw new Error(
      `Organization creation failed (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }
  return { id: response.body.id, slug: response.body.slug, body: response.body };
}

/** A tenant with an owner, ready to use. */
export async function createTenant(
  context: TestContext,
  name: string,
  ownerEmail: string,
): Promise<TenantFixture> {
  const owner = await createUser(context, ownerEmail);
  const organization = await createOrganization(owner.client, {
    displayName: name,
    legalName: `${name} Legal`,
  });
  return { organizationId: organization.id, slug: organization.slug, owner };
}

/** Invite an address and return the raw token from the test outbox. */
export async function inviteAndCaptureToken(
  context: TestContext,
  inviter: AuthClient,
  organizationId: string,
  email: string,
  roleCode = 'ORGANIZATION_ADMIN',
): Promise<{ invitationId: string; token: string }> {
  const response = await inviter.post(`${API}/organizations/${organizationId}/invitations`, {
    email,
    roleCode,
  });
  if (response.status !== 201) {
    throw new Error(`Invite failed (${response.status}): ${JSON.stringify(response.body)}`);
  }

  const mail = context.outbox.lastTo(email, 'ORGANIZATION_INVITATION');
  if (mail === undefined) throw new Error(`No invitation mail for ${email}`);

  return { invitationId: response.body.id, token: mail.variables.token! };
}

/** Sign in a PalCert administrator, completing the mandatory MFA enrollment. */
/**
 * A signed-in holder of any global role.
 *
 * Generalized from {@link signInPlatformAdmin} so the financial suites can
 * exercise PALCERT_FINANCE and PALCERT_SUPPORT separately — proving that
 * support can read a payment and move no money is the point of §78 and §135,
 * and it cannot be proven with an administrator.
 */
export async function signInGlobalRole(
  context: TestContext,
  email: string,
  roleCode: 'PALCERT_ADMIN' | 'PALCERT_FINANCE' | 'PALCERT_SUPPORT' | 'PALCERT_AUDITOR',
): Promise<AuthClient> {
  return signInWithRole(context, email, roleCode);
}

export async function signInPlatformAdmin(
  context: TestContext,
  email: string,
): Promise<AuthClient> {
  return signInWithRole(context, email, 'PALCERT_ADMIN');
}

async function signInWithRole(
  context: TestContext,
  email: string,
  roleCode: string,
): Promise<AuthClient> {
  const user = await registerAndVerify(context, email, PASSWORD);

  const role = await context.adminDb.role.findUniqueOrThrow({ where: { code: roleCode } });
  await context.adminDb.$executeRawUnsafe('SET row_security = off');
  await context.adminDb.userRole.create({
    data: { userId: user.userId, roleId: role.id, organizationId: null, scope: 'GLOBAL' },
  });

  const client = new AuthClient(context.app);
  const login = await client.post(`${API}/auth/login`, { email, password: PASSWORD });

  if (login.body.status === 'MFA_ENROLLMENT_REQUIRED') {
    const enrollment = await client.post(`${API}/auth/mfa/enroll`, {});
    const { Secret, TOTP } = await import('otpauth');
    const code = new TOTP({
      issuer: 'PalCert',
      label: 'test',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(enrollment.body.secret as string),
    }).generate({ timestamp: context.clock.now().getTime() });

    const confirmed = await client.post(`${API}/auth/mfa/confirm`, { code });
    if (confirmed.status !== 200) {
      throw new Error(`Admin MFA enrollment failed: ${JSON.stringify(confirmed.body)}`);
    }
  }

  return client;
}

/**
 * Make an existing user a member of a tenant with the given role, through
 * the real invitation flow: the owner invites, the user accepts the token.
 */
export async function grantOrganizationRoleTo(
  context: TestContext,
  tenant: TenantFixture,
  user: { userId: string; client: AuthClient },
  roleCode: string,
): Promise<void> {
  const profile = await user.client.get(`${API}/users/me`);
  const email = profile.body.email as string;
  const { token } = await inviteAndCaptureToken(
    context,
    tenant.owner.client,
    tenant.organizationId,
    email,
    roleCode,
  );
  const accepted = await user.client.post(`${API}/invitations/accept`, { token });
  if (accepted.status !== 200 && accepted.status !== 201) {
    throw new Error(
      `Invitation acceptance failed (${accepted.status}): ${JSON.stringify(accepted.body)}`,
    );
  }
}
