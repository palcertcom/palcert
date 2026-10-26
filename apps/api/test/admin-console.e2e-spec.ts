import { API } from './support/auth-client';
import {
  createTenant,
  createUser,
  signInGlobalRole,
  signInPlatformAdmin,
} from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * The reads the staff console needs beyond what earlier phases shipped: one
 * organization in full, the platform counts, and finding a user.
 */
describe('Admin console reads (e2e)', () => {
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

  describe('one organization', () => {
    it('gives staff the real member count and the verification history', async () => {
      const tenant = await createTenant(context, 'Detail Org', 'detail@example.com');
      const admin = await signInPlatformAdmin(context, 'admin-detail@palcert.test');

      await tenant.owner.client.post(`${API}/organizations/${tenant.organizationId}/verification`, {
        note: 'Registered with the ministry.',
      });
      await admin.post(`${API}/admin/organizations/${tenant.organizationId}/verification`, {
        approve: false,
        decisionReason: 'Registration number not found.',
        internalNotes: 'Registry lookup returned nothing.',
      });

      const detail = await admin.get(`${API}/admin/organizations/${tenant.organizationId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.organization.id).toBe(tenant.organizationId);
      // Counted, not the listing's placeholder.
      expect(detail.body.organization.memberCount).toBe(1);
      expect(detail.body.suspendedAt).toBeNull();
      expect(detail.body.verificationRequests).toHaveLength(1);
      expect(detail.body.verificationRequests[0]).toMatchObject({
        status: 'REJECTED',
        submissionNote: 'Registered with the ministry.',
        decisionReason: 'Registration number not found.',
        internalNotes: 'Registry lookup returned nothing.',
      });
    });

    it('withholds internal review notes from staff who cannot decide verification', async () => {
      const tenant = await createTenant(context, 'Notes Org', 'notes@example.com');
      const admin = await signInPlatformAdmin(context, 'admin-notes@palcert.test');
      const support = await signInGlobalRole(
        context,
        'support-notes@palcert.test',
        'PALCERT_SUPPORT',
      );

      await tenant.owner.client.post(
        `${API}/organizations/${tenant.organizationId}/verification`,
        {},
      );
      await admin.post(`${API}/admin/organizations/${tenant.organizationId}/verification`, {
        approve: true,
        decisionReason: 'Confirmed.',
        internalNotes: 'Called the registrar.',
      });

      const detail = await support.get(`${API}/admin/organizations/${tenant.organizationId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.verificationRequests[0].decisionReason).toBe('Confirmed.');
      expect(JSON.stringify(detail.body)).not.toContain('Called the registrar.');
      expect(detail.body.verificationRequests[0]).not.toHaveProperty('internalNotes');
    });

    it('records a suspension and its reason', async () => {
      const tenant = await createTenant(context, 'Suspend Org', 'suspend@example.com');
      const admin = await signInPlatformAdmin(context, 'admin-suspend@palcert.test');

      const suspended = await admin.post(
        `${API}/admin/organizations/${tenant.organizationId}/suspend`,
        { reason: 'Payment dispute under review.' },
      );
      expect(suspended.status).toBe(201);

      const detail = await admin.get(`${API}/admin/organizations/${tenant.organizationId}`);
      expect(detail.body.organization.status).toBe('SUSPENDED');
      expect(detail.body.suspensionReason).toBe('Payment dispute under review.');
      expect(detail.body.suspendedAt).not.toBeNull();
    });

    it('refuses anyone who is not staff, including the organization’s own owner', async () => {
      const tenant = await createTenant(context, 'Private Org', 'private@example.com');
      const outsider = await createUser(context, 'outsider@example.com');

      expect(
        (await tenant.owner.client.get(`${API}/admin/organizations/${tenant.organizationId}`))
          .status,
      ).toBe(403);
      expect(
        (await outsider.client.get(`${API}/admin/organizations/${tenant.organizationId}`)).status,
      ).toBe(403);
    });

    it('answers not found for an organization that does not exist', async () => {
      const admin = await signInPlatformAdmin(context, 'admin-missing@palcert.test');
      const missing = await admin.get(
        `${API}/admin/organizations/00000000-0000-4000-8000-000000000000`,
      );
      expect(missing.status).toBe(404);
    });
  });

  describe('platform counts', () => {
    it('counts what exists, by status', async () => {
      const first = await createTenant(context, 'Count One', 'count1@example.com');
      await createTenant(context, 'Count Two', 'count2@example.com');
      const admin = await signInPlatformAdmin(context, 'admin-count@palcert.test');
      await admin.post(`${API}/admin/organizations/${first.organizationId}/suspend`, {});
      await first.owner.client.post(
        `${API}/organizations/${first.organizationId}/verification`,
        {},
      );

      const overview = await admin.get(`${API}/admin/overview`);
      expect(overview.status).toBe(200);
      expect(overview.body.organizations.total).toBe(2);
      expect(overview.body.organizations.byStatus).toMatchObject({ ACTIVE: 1, SUSPENDED: 1 });
      expect(overview.body.organizations.pendingVerificationRequests).toBeGreaterThanOrEqual(0);
      // Two owners and the administrator, all active.
      expect(overview.body.users.total).toBe(3);
      expect(overview.body.users.byStatus.ACTIVE).toBe(3);
    });

    it('is staff-only', async () => {
      const user = await createUser(context, 'plain@example.com');
      expect((await user.client.get(`${API}/admin/overview`)).status).toBe(403);

      const finance = await signInGlobalRole(context, 'finance@palcert.test', 'PALCERT_FINANCE');
      expect((await finance.get(`${API}/admin/overview`)).status).toBe(200);
    });
  });

  describe('finding a user', () => {
    it('matches part of an email address or a display name', async () => {
      await createUser(context, 'layla.haddad@example.com');
      await createUser(context, 'omar@example.com');
      const admin = await signInPlatformAdmin(context, 'admin-search@palcert.test');

      const byEmail = await admin.get(`${API}/admin/users?q=HADDAD`);
      expect(byEmail.status).toBe(200);
      expect(byEmail.body.map((user: { email: string }) => user.email)).toEqual([
        'layla.haddad@example.com',
      ]);

      const none = await admin.get(`${API}/admin/users?q=nobody-here`);
      expect(none.body).toEqual([]);

      const tooLong = await admin.get(`${API}/admin/users?q=${'x'.repeat(121)}`);
      expect(tooLong.status).toBe(400);
    });

    it('is refused to an ordinary user, search or not', async () => {
      const user = await createUser(context, 'curious@example.com');
      expect((await user.client.get(`${API}/admin/users?q=admin`)).status).toBe(403);
    });
  });
});
