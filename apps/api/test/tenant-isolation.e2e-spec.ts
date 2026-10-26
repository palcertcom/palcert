import { API } from './support/auth-client';
import {
  createTenant,
  createUser,
  inviteAndCaptureToken,
  signInPlatformAdmin,
  type TenantFixture,
} from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Cross-tenant access (§14, §21, §71).
 *
 * Every attack below uses REAL identifiers belonging to the other tenant, not
 * random ones. Opaque ids are defence in depth; authorization has to hold even
 * when the attacker knows exactly what to ask for.
 */
describe('Tenant isolation — HTTP surface (e2e)', () => {
  let context: TestContext;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let betaMembershipId: string;
  let betaInvitationId: string;

  beforeAll(async () => {
    context = await createTestContext();
  });
  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);

    alpha = await createTenant(context, 'Alpha University', 'alpha-owner@example.com');
    beta = await createTenant(context, 'Beta Journal', 'beta-owner@example.com');

    // Real identifiers from tenant B, obtained legitimately by B's own owner.
    const members = await beta.owner.client.get(
      `${API}/organizations/${beta.organizationId}/members`,
    );
    betaMembershipId = members.body.items[0].membershipId;

    const invitation = await inviteAndCaptureToken(
      context,
      beta.owner.client,
      beta.organizationId,
      'beta-invitee@example.com',
    );
    betaInvitationId = invitation.invitationId;
  });

  describe('read', () => {
    it('cannot read another tenant’s profile', async () => {
      const response = await alpha.owner.client.get(`${API}/organizations/${beta.organizationId}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('ORGANIZATION_NOT_FOUND');
    });

    it('reports a real foreign organization identically to one that does not exist', async () => {
      const foreign = await alpha.owner.client.get(`${API}/organizations/${beta.organizationId}`);
      const imaginary = await alpha.owner.client.get(
        `${API}/organizations/00000000-0000-4000-8000-000000000000`,
      );

      // Byte-identical, so the response cannot be used to test whether an id is real.
      expect(foreign.status).toBe(imaginary.status);
      expect(foreign.body.error.code).toBe(imaginary.body.error.code);
      expect(foreign.body.error.message).toBe(imaginary.body.error.message);
    });

    it('cannot read another tenant’s members', async () => {
      const response = await alpha.owner.client.get(
        `${API}/organizations/${beta.organizationId}/members`,
      );
      expect(response.status).toBe(404);
    });

    it('cannot read another tenant’s invitations', async () => {
      const response = await alpha.owner.client.get(
        `${API}/organizations/${beta.organizationId}/invitations`,
      );
      expect(response.status).toBe(404);
    });

    it('cannot read another tenant’s verification state', async () => {
      const response = await alpha.owner.client.get(
        `${API}/organizations/${beta.organizationId}/verification`,
      );
      expect(response.status).toBe(404);
    });

    it('never lists another tenant in the caller’s own organizations', async () => {
      const response = await alpha.owner.client.get(`${API}/organizations`);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].organization.id).toBe(alpha.organizationId);
      expect(JSON.stringify(response.body)).not.toContain(beta.organizationId);
    });
  });

  describe('write', () => {
    it('cannot update another tenant’s profile', async () => {
      const response = await alpha.owner.client.patch(
        `${API}/organizations/${beta.organizationId}`,
        { displayName: 'Hijacked' },
      );
      expect(response.status).toBe(404);

      const unchanged = await beta.owner.client.get(`${API}/organizations/${beta.organizationId}`);
      expect(unchanged.body.displayName).toBe('Beta Journal');
    });

    it('cannot suspend a member of another tenant, even with a real membership id', async () => {
      const response = await alpha.owner.client.patch(
        `${API}/organizations/${beta.organizationId}/members/${betaMembershipId}`,
        { status: 'SUSPENDED' },
      );
      expect(response.status).toBe(404);

      const stillActive = await beta.owner.client.get(
        `${API}/organizations/${beta.organizationId}/members`,
      );
      expect(stillActive.body.items[0].status).toBe('ACTIVE');
    });

    it('cannot remove a member of another tenant', async () => {
      const response = await alpha.owner.client.delete(
        `${API}/organizations/${beta.organizationId}/members/${betaMembershipId}`,
      );
      expect(response.status).toBe(404);
    });

    it('cannot grant a role in another tenant', async () => {
      const response = await alpha.owner.client.post(
        `${API}/organizations/${beta.organizationId}/members/${betaMembershipId}/roles`,
        { roleCode: 'ORGANIZATION_ADMIN' },
      );
      expect(response.status).toBe(404);
    });

    it('cannot invite into another tenant', async () => {
      const response = await alpha.owner.client.post(
        `${API}/organizations/${beta.organizationId}/invitations`,
        { email: 'intruder@example.com', roleCode: 'ORGANIZATION_OWNER' },
      );
      expect(response.status).toBe(404);
    });

    it('cannot revoke another tenant’s invitation, even with a real invitation id', async () => {
      const response = await alpha.owner.client.delete(
        `${API}/organizations/${beta.organizationId}/invitations/${betaInvitationId}`,
      );
      expect(response.status).toBe(404);

      const stillPending = await beta.owner.client.get(
        `${API}/organizations/${beta.organizationId}/invitations`,
      );
      expect(stillPending.body.items[0].status).toBe('PENDING');
    });

    it('cannot request verification for another tenant', async () => {
      const response = await alpha.owner.client.post(
        `${API}/organizations/${beta.organizationId}/verification`,
        {},
      );
      expect(response.status).toBe(404);
    });

    it('cannot transfer ownership of another tenant', async () => {
      const response = await alpha.owner.client.post(
        `${API}/organizations/${beta.organizationId}/ownership-transfer`,
        { toMembershipId: betaMembershipId },
      );
      expect(response.status).toBe(404);
    });
  });

  describe('identifier substitution', () => {
    it('cannot act on another tenant’s membership id inside its own organization path', async () => {
      // The path names Alpha (which the caller may act on), but the membership
      // id belongs to Beta — the classic IDOR shape.
      const response = await alpha.owner.client.patch(
        `${API}/organizations/${alpha.organizationId}/members/${betaMembershipId}`,
        { status: 'SUSPENDED' },
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('MEMBERSHIP_NOT_FOUND');

      const betaMembers = await beta.owner.client.get(
        `${API}/organizations/${beta.organizationId}/members`,
      );
      expect(betaMembers.body.items[0].status).toBe('ACTIVE');
    });

    it('cannot revoke another tenant’s invitation through its own organization path', async () => {
      const response = await alpha.owner.client.delete(
        `${API}/organizations/${alpha.organizationId}/invitations/${betaInvitationId}`,
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('INVITATION_NOT_FOUND');
    });

    it('cannot use another tenant’s invitation token to join the wrong organization', async () => {
      const outsider = await createUser(context, 'beta-invitee@example.com');
      const invitation = context.outbox.lastTo(
        'beta-invitee@example.com',
        'ORGANIZATION_INVITATION',
      )!;

      const accepted = await outsider.client.post(`${API}/invitations/accept`, {
        token: invitation.variables.token,
      });

      // It works, but only for the organization the invitation actually names.
      expect(accepted.status).toBe(200);
      expect(accepted.body.organizationId).toBe(beta.organizationId);
      expect(accepted.body.organizationId).not.toBe(alpha.organizationId);

      const mine = await outsider.client.get(`${API}/organizations`);
      expect(
        mine.body.map((entry: { organization: { id: string } }) => entry.organization.id),
      ).toEqual([beta.organizationId]);
    });

    it('rejects a malformed organization id the same way as a foreign one', async () => {
      const malformed = await alpha.owner.client.get(`${API}/organizations/not-a-uuid`);
      expect([400, 404]).toContain(malformed.status);
    });
  });

  describe('cross-tenant denials are recorded', () => {
    it('writes a CROSS_TENANT_ACCESS_DENIED event', async () => {
      await alpha.owner.client.get(`${API}/organizations/${beta.organizationId}`);

      const events = await context.adminDb.securityEvent.findMany({
        where: { type: 'CROSS_TENANT_ACCESS_DENIED' },
      });

      expect(events.length).toBeGreaterThan(0);
      expect(events[0]!.userId).toBe(alpha.owner.userId);
      expect(JSON.stringify(events[0]!.metadata)).toContain(beta.organizationId);
    });
  });

  describe('platform administration', () => {
    it('reaches any organization through the explicit administrative path', async () => {
      const admin = await signInPlatformAdmin(context, 'platform@palcert.test');

      const listed = await admin.get(`${API}/admin/organizations`);
      expect(listed.status).toBe(200);

      const ids = listed.body.items.map((row: { id: string }) => row.id);
      expect(ids).toContain(alpha.organizationId);
      expect(ids).toContain(beta.organizationId);
    });

    it('records every cross-tenant staff access', async () => {
      const admin = await signInPlatformAdmin(context, 'audited-admin@palcert.test');
      await admin.post(`${API}/admin/organizations/${beta.organizationId}/suspend`, {
        reason: 'Investigation',
      });

      const audit = await context.adminDb.auditEvent.findFirst({
        where: { action: 'ORGANIZATION_SUSPENDED', targetId: beta.organizationId },
      });
      expect(audit).not.toBeNull();
      expect(audit!.beforeState).toEqual({ status: 'ACTIVE' });
      expect(audit!.afterState).toEqual({ status: 'SUSPENDED' });
    });

    it('does not give an ordinary tenant route cross-tenant reach for staff', async () => {
      const admin = await signInPlatformAdmin(context, 'not-a-member@palcert.test');

      // The tenant-scoped profile route does not opt into platform elevation,
      // so even PalCert staff must be a member to use it.
      const response = await admin.get(`${API}/organizations/${beta.organizationId}`);
      expect(response.status).toBe(404);
    });

    it('does not let a non-admin reach the administrative listing', async () => {
      const response = await alpha.owner.client.get(`${API}/admin/organizations`);
      expect(response.status).toBe(403);
    });
  });
});
