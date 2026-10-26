import { API, AuthClient, signIn } from './support/auth-client';
import {
  PASSWORD,
  createOrganization,
  createTenant,
  createUser,
  inviteAndCaptureToken,
  signInPlatformAdmin,
} from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

describe('Organizations (e2e)', () => {
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

  // --- 1-3. Creation, ownership, profile ------------------------------------
  describe('creation', () => {
    it('creates an organization and makes the creator its owner', async () => {
      const founder = await createUser(context, 'founder@university.edu');

      const response = await founder.client.post(`${API}/organizations`, {
        type: 'UNIVERSITY',
        displayName: 'Islamic University of Gaza',
        legalName: 'Islamic University of Gaza',
        countryCode: 'PS',
        timezone: 'Asia/Hebron',
        website: 'https://www.iugaza.edu.ps',
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        displayName: 'Islamic University of Gaza',
        type: 'UNIVERSITY',
        status: 'ACTIVE',
        verificationStatus: 'UNVERIFIED',
        countryCode: 'PS',
        memberCount: 1,
      });
      expect(response.body.slug).toBe('islamic-university-of-gaza');

      const mine = await founder.client.get(`${API}/organizations`);
      expect(mine.body).toHaveLength(1);
      expect(mine.body[0].roles).toEqual(['ORGANIZATION_OWNER']);
      expect(mine.body[0].membershipStatus).toBe('ACTIVE');
    });

    it('creates the organization, membership and owner role atomically', async () => {
      const founder = await createUser(context, 'atomic@example.com');
      const organization = await createOrganization(founder.client);

      await context.adminDb.$executeRawUnsafe('SET row_security = off');
      const [memberships, roles] = await Promise.all([
        context.adminDb.organizationMembership.count({
          where: { organizationId: organization.id },
        }),
        context.adminDb.userRole.count({ where: { organizationId: organization.id } }),
      ]);

      expect(memberships).toBe(1);
      expect(roles).toBe(1);
    });

    it('derives a unique slug when the name collides', async () => {
      const first = await createUser(context, 'slug1@example.com');
      const second = await createUser(context, 'slug2@example.com');

      const a = await createOrganization(first.client, { displayName: 'Shared Name' });
      const b = await createOrganization(second.client, { displayName: 'Shared Name' });

      expect(a.slug).toBe('shared-name');
      expect(b.slug).toBe('shared-name-2');
    });

    it('rejects a requested slug that is already taken', async () => {
      const first = await createUser(context, 'taken1@example.com');
      const second = await createUser(context, 'taken2@example.com');
      await createOrganization(first.client, { slug: 'unique-handle' });

      const response = await second.client.post(`${API}/organizations`, {
        type: 'PUBLISHER',
        displayName: 'Another',
        legalName: 'Another Legal',
        countryCode: 'PS',
        timezone: 'Asia/Hebron',
        slug: 'unique-handle',
      });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ORGANIZATION_SLUG_TAKEN');
    });

    it('rejects a reserved slug', async () => {
      const founder = await createUser(context, 'reserved@example.com');
      const response = await founder.client.post(`${API}/organizations`, {
        type: 'COMPANY',
        displayName: 'Admin Co',
        legalName: 'Admin Co',
        countryCode: 'PS',
        timezone: 'Asia/Hebron',
        slug: 'admin',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('produces a usable slug from a name with no Latin characters', async () => {
      const founder = await createUser(context, 'arabicname@example.com');
      const organization = await createOrganization(founder.client, {
        displayName: 'الجامعة الإسلامية بغزة',
        legalName: 'الجامعة الإسلامية بغزة',
      });

      expect(organization.slug).toMatch(/^[a-z0-9-]{3,63}$/);
    });

    it('validates country code and timezone against standards', async () => {
      const founder = await createUser(context, 'standards@example.com');

      const badCountry = await founder.client.post(`${API}/organizations`, {
        type: 'COMPANY',
        displayName: 'X',
        legalName: 'X Legal',
        countryCode: 'Palestine',
        timezone: 'Asia/Hebron',
      });
      expect(badCountry.status).toBe(400);

      const badTimezone = await founder.client.post(`${API}/organizations`, {
        type: 'COMPANY',
        displayName: 'Y Org',
        legalName: 'Y Legal',
        countryCode: 'PS',
        timezone: 'GMT+3 Palestine Time',
      });
      expect(badTimezone.status).toBe(400);
    });

    it('supports every organization type without special-casing', async () => {
      const types = [
        'UNIVERSITY',
        'SCIENTIFIC_JOURNAL',
        'PUBLISHER',
        'RESEARCH_INSTITUTION',
        'GOVERNMENT',
        'COMPANY',
        'OTHER',
      ];

      for (const [index, type] of types.entries()) {
        const founder = await createUser(context, `type-${index}@example.com`);
        const organization = await createOrganization(founder.client, {
          type,
          displayName: `Org ${type}`,
        });
        expect(organization.body.type).toBe(type);
      }
    });
  });

  describe('profile', () => {
    it('reads and updates the profile', async () => {
      const tenant = await createTenant(context, 'Profile Org', 'profile@example.com');

      const read = await tenant.owner.client.get(`${API}/organizations/${tenant.organizationId}`);
      expect(read.status).toBe(200);
      expect(read.body.displayName).toBe('Profile Org');

      const updated = await tenant.owner.client.patch(
        `${API}/organizations/${tenant.organizationId}`,
        { displayName: 'Renamed Org', website: 'https://example.org', countryCode: 'JO' },
      );

      expect(updated.status).toBe(200);
      expect(updated.body.displayName).toBe('Renamed Org');
      expect(updated.body.countryCode).toBe('JO');
      // The slug is navigation, not identity — it does not follow a rename.
      expect(updated.body.slug).toBe(tenant.slug);
    });

    it('refuses to let an organization change its own verification or status', async () => {
      const tenant = await createTenant(context, 'Escalate Org', 'escalate-org@example.com');

      const response = await tenant.owner.client.patch(
        `${API}/organizations/${tenant.organizationId}`,
        {
          displayName: 'Legitimate',
          verificationStatus: 'VERIFIED',
          status: 'ACTIVE',
          createdByUserId: tenant.owner.userId,
          suspensionReason: null,
        },
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');

      const profile = await tenant.owner.client.get(
        `${API}/organizations/${tenant.organizationId}`,
      );
      expect(profile.body.verificationStatus).toBe('UNVERIFIED');
    });

    it('does not expose PalCert-internal fields to members', async () => {
      const tenant = await createTenant(context, 'Internal Org', 'internal@example.com');
      const body = JSON.stringify(
        (await tenant.owner.client.get(`${API}/organizations/${tenant.organizationId}`)).body,
      );

      expect(body).not.toContain('suspensionReason');
      expect(body).not.toContain('createdByUserId');
      expect(body).not.toContain('internalNotes');
    });
  });

  // --- 4-6. Verification -----------------------------------------------------
  describe('verification', () => {
    it('requests, then an administrator approves', async () => {
      const tenant = await createTenant(context, 'Verify Org', 'verify@example.com');
      const admin = await signInPlatformAdmin(context, 'admin-verify@palcert.test');

      const requested = await tenant.owner.client.post(
        `${API}/organizations/${tenant.organizationId}/verification`,
        { note: 'We are a registered university.' },
      );
      expect(requested.status).toBe(202);
      expect(requested.body.status).toBe('PENDING');
      expect(requested.body.canRequest).toBe(false);

      const queue = await admin.get(`${API}/admin/organizations/verification-queue`);
      expect(queue.status).toBe(200);
      expect(queue.body).toHaveLength(1);
      expect(queue.body[0].organizationId).toBe(tenant.organizationId);

      const decision = await admin.post(
        `${API}/admin/organizations/${tenant.organizationId}/verification`,
        { approve: true, decisionReason: 'Identity confirmed.' },
      );
      expect(decision.status).toBe(201);
      expect(decision.body.status).toBe('VERIFIED');

      const view = await tenant.owner.client.get(
        `${API}/organizations/${tenant.organizationId}/verification`,
      );
      expect(view.body.status).toBe('VERIFIED');
      expect(view.body.decisionReason).toBe('Identity confirmed.');
    });

    it('rejects, and the organization may resubmit', async () => {
      const tenant = await createTenant(context, 'Reject Org', 'reject@example.com');
      const admin = await signInPlatformAdmin(context, 'admin-reject@palcert.test');

      await tenant.owner.client.post(
        `${API}/organizations/${tenant.organizationId}/verification`,
        {},
      );
      const decision = await admin.post(
        `${API}/admin/organizations/${tenant.organizationId}/verification`,
        {
          approve: false,
          decisionReason: 'Could not confirm the registration number.',
          internalNotes: 'Registry lookup returned nothing; possible shell entity.',
        },
      );
      expect(decision.body.status).toBe('REJECTED');

      // A rejection does not delete or suspend the organization.
      const profile = await tenant.owner.client.get(
        `${API}/organizations/${tenant.organizationId}`,
      );
      expect(profile.status).toBe(200);
      expect(profile.body.status).toBe('ACTIVE');

      const view = await tenant.owner.client.get(
        `${API}/organizations/${tenant.organizationId}/verification`,
      );
      expect(view.body.canRequest).toBe(true);

      const resubmitted = await tenant.owner.client.post(
        `${API}/organizations/${tenant.organizationId}/verification`,
        {},
      );
      expect(resubmitted.status).toBe(202);
      expect(resubmitted.body.status).toBe('PENDING');
    });

    it('never discloses reviewer internal notes to the organization', async () => {
      const tenant = await createTenant(context, 'Notes Org', 'notes@example.com');
      const admin = await signInPlatformAdmin(context, 'admin-notes@palcert.test');

      await tenant.owner.client.post(
        `${API}/organizations/${tenant.organizationId}/verification`,
        {},
      );
      await admin.post(`${API}/admin/organizations/${tenant.organizationId}/verification`, {
        approve: false,
        decisionReason: 'Please resubmit with registration details.',
        internalNotes: 'SECRET-REVIEWER-NOTE-do-not-disclose',
      });

      const view = await tenant.owner.client.get(
        `${API}/organizations/${tenant.organizationId}/verification`,
      );
      const profile = await tenant.owner.client.get(
        `${API}/organizations/${tenant.organizationId}`,
      );

      expect(JSON.stringify(view.body)).not.toContain('SECRET-REVIEWER-NOTE');
      expect(JSON.stringify(profile.body)).not.toContain('SECRET-REVIEWER-NOTE');
    });

    it('refuses a second request while one is pending', async () => {
      const tenant = await createTenant(context, 'Dup Org', 'dup-verify@example.com');
      await tenant.owner.client.post(
        `${API}/organizations/${tenant.organizationId}/verification`,
        {},
      );

      const second = await tenant.owner.client.post(
        `${API}/organizations/${tenant.organizationId}/verification`,
        {},
      );
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('ORGANIZATION_VERIFICATION_PENDING');
    });

    it('refuses verification requests from an ordinary member', async () => {
      const tenant = await createTenant(context, 'Member Verify', 'mv-owner@example.com');
      const member = await createUser(context, 'mv-member@example.com');
      const invitation = await inviteAndCaptureToken(
        context,
        tenant.owner.client,
        tenant.organizationId,
        member.email,
        'ORGANIZATION_REVIEWER',
      );
      await member.client.post(`${API}/invitations/accept`, { token: invitation.token });

      const response = await member.client.post(
        `${API}/organizations/${tenant.organizationId}/verification`,
        {},
      );
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ORGANIZATION_ACCESS_DENIED');
    });

    it('refuses to let a non-admin reach the verification queue', async () => {
      const tenant = await createTenant(context, 'Queue Org', 'queue@example.com');
      const response = await tenant.owner.client.get(
        `${API}/admin/organizations/verification-queue`,
      );
      expect(response.status).toBe(403);
    });
  });

  // --- 7-13. Invitations -----------------------------------------------------
  describe('invitations', () => {
    it('invites an existing user who then accepts', async () => {
      const tenant = await createTenant(context, 'Invite Org', 'inviter@example.com');
      const invitee = await createUser(context, 'invitee@example.com');

      const invitation = await inviteAndCaptureToken(
        context,
        tenant.owner.client,
        tenant.organizationId,
        invitee.email,
        'ORGANIZATION_ADMIN',
      );

      const preview = await new AuthClient(context.app).post(`${API}/invitations/preview`, {
        token: invitation.token,
      });
      expect(preview.status).toBe(200);
      expect(preview.body).toEqual({
        organizationDisplayName: 'Invite Org',
        roleCode: 'ORGANIZATION_ADMIN',
        expiresAt: expect.any(String),
        requiresRegistration: false,
      });

      const accepted = await invitee.client.post(`${API}/invitations/accept`, {
        token: invitation.token,
      });
      expect(accepted.status).toBe(200);
      expect(accepted.body).toEqual({
        organizationId: tenant.organizationId,
        roleCode: 'ORGANIZATION_ADMIN',
      });

      const mine = await invitee.client.get(`${API}/organizations`);
      expect(mine.body).toHaveLength(1);
      expect(mine.body[0].roles).toEqual(['ORGANIZATION_ADMIN']);
    });

    it('tells a new recipient they must register first', async () => {
      const tenant = await createTenant(context, 'New Person Org', 'newperson@example.com');
      const invitation = await inviteAndCaptureToken(
        context,
        tenant.owner.client,
        tenant.organizationId,
        'not-yet-registered@example.com',
      );

      const preview = await new AuthClient(context.app).post(`${API}/invitations/preview`, {
        token: invitation.token,
      });
      expect(preview.body.requiresRegistration).toBe(true);

      // After registering with that address, acceptance works.
      const newcomer = await createUser(context, 'not-yet-registered@example.com');
      const accepted = await newcomer.client.post(`${API}/invitations/accept`, {
        token: invitation.token,
      });
      expect(accepted.status).toBe(200);
    });

    it('rejects an expired invitation', async () => {
      const tenant = await createTenant(context, 'Expiry Org', 'expiry@example.com');
      const invitee = await createUser(context, 'late@example.com');
      const invitation = await inviteAndCaptureToken(
        context,
        tenant.owner.client,
        tenant.organizationId,
        invitee.email,
      );

      // Invitations last seven days; step just past that with the fake clock.
      context.clock.advanceMinutes(7 * 24 * 60 + 1);

      // That also outlives the 12-hour session ceiling, so sign in again — the
      // account is unaffected, only the invitation has lapsed.
      const freshClient = await signIn(context, invitee.email, PASSWORD);
      const response = await freshClient.post(`${API}/invitations/accept`, {
        token: invitation.token,
      });
      expect(response.status).toBe(410);
      expect(response.body.error.code).toBe('INVITATION_EXPIRED');
    });

    it('rejects a replayed invitation', async () => {
      const tenant = await createTenant(context, 'Replay Org', 'replay-org@example.com');
      const invitee = await createUser(context, 'replay-invitee@example.com');
      const invitation = await inviteAndCaptureToken(
        context,
        tenant.owner.client,
        tenant.organizationId,
        invitee.email,
      );

      expect(
        (await invitee.client.post(`${API}/invitations/accept`, { token: invitation.token }))
          .status,
      ).toBe(200);

      const replay = await invitee.client.post(`${API}/invitations/accept`, {
        token: invitation.token,
      });
      expect(replay.status).toBe(410);
      expect(replay.body.error.code).toBe('INVITATION_ALREADY_USED');
    });

    it('rejects a revoked invitation', async () => {
      const tenant = await createTenant(context, 'Revoke Org', 'revoke-org@example.com');
      const invitee = await createUser(context, 'revoked-invitee@example.com');
      const invitation = await inviteAndCaptureToken(
        context,
        tenant.owner.client,
        tenant.organizationId,
        invitee.email,
      );

      const revoked = await tenant.owner.client.delete(
        `${API}/organizations/${tenant.organizationId}/invitations/${invitation.invitationId}`,
      );
      expect(revoked.status).toBe(204);

      const response = await invitee.client.post(`${API}/invitations/accept`, {
        token: invitation.token,
      });
      expect(response.status).toBe(410);
      expect(response.body.error.code).toBe('INVITATION_REVOKED');
    });

    it('refuses acceptance by anyone other than the invited address', async () => {
      const tenant = await createTenant(context, 'Mismatch Org', 'mismatch@example.com');
      const intended = await createUser(context, 'intended@example.com');
      const interceptor = await createUser(context, 'interceptor@example.com');

      const invitation = await inviteAndCaptureToken(
        context,
        tenant.owner.client,
        tenant.organizationId,
        intended.email,
      );

      const stolen = await interceptor.client.post(`${API}/invitations/accept`, {
        token: invitation.token,
      });
      expect(stolen.status).toBe(403);
      expect(stolen.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');

      // And the invitation is still usable by its intended recipient.
      expect(
        (await intended.client.post(`${API}/invitations/accept`, { token: invitation.token }))
          .status,
      ).toBe(200);
    });

    it('matches the invited address using the same normalization as sign-in', async () => {
      const tenant = await createTenant(context, 'Normalize Org', 'norm@example.com');
      const invitee = await createUser(context, 'Mixed.Case@Example.com');

      const invitation = await inviteAndCaptureToken(
        context,
        tenant.owner.client,
        tenant.organizationId,
        'mixed.case@example.com',
      );

      expect(
        (await invitee.client.post(`${API}/invitations/accept`, { token: invitation.token }))
          .status,
      ).toBe(200);
    });

    it('refuses a platform role in an invitation', async () => {
      const tenant = await createTenant(context, 'Escalation Org', 'esc-invite@example.com');

      for (const roleCode of [
        'PALCERT_ADMIN',
        'PALCERT_FINANCE',
        'PALCERT_SUPPORT',
        'PALCERT_AUDITOR',
      ]) {
        const response = await tenant.owner.client.post(
          `${API}/organizations/${tenant.organizationId}/invitations`,
          { email: 'target@example.com', roleCode },
        );
        expect(`${roleCode}:${response.status}`).toBe(`${roleCode}:400`);
      }
    });

    it('refuses a duplicate outstanding invitation', async () => {
      const tenant = await createTenant(context, 'Dup Invite', 'dupinvite@example.com');
      await inviteAndCaptureToken(
        context,
        tenant.owner.client,
        tenant.organizationId,
        'once@example.com',
      );

      const second = await tenant.owner.client.post(
        `${API}/organizations/${tenant.organizationId}/invitations`,
        { email: 'once@example.com', roleCode: 'ORGANIZATION_REVIEWER' },
      );
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('INVITATION_ALREADY_PENDING');
    });

    it('refuses to invite someone who is already a member', async () => {
      const tenant = await createTenant(context, 'Already Org', 'already@example.com');
      const response = await tenant.owner.client.post(
        `${API}/organizations/${tenant.organizationId}/invitations`,
        { email: tenant.owner.email, roleCode: 'ORGANIZATION_ADMIN' },
      );
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('MEMBERSHIP_ALREADY_EXISTS');
    });

    it('never returns or logs the invitation token', async () => {
      const tenant = await createTenant(context, 'Token Org', 'token-org@example.com');
      const created = await tenant.owner.client.post(
        `${API}/organizations/${tenant.organizationId}/invitations`,
        { email: 'secret@example.com', roleCode: 'ORGANIZATION_REVIEWER' },
      );

      const mail = context.outbox.lastTo('secret@example.com', 'ORGANIZATION_INVITATION')!;
      const token = mail.variables.token!;

      expect(JSON.stringify(created.body)).not.toContain(token);

      const listed = await tenant.owner.client.get(
        `${API}/organizations/${tenant.organizationId}/invitations`,
      );
      expect(JSON.stringify(listed.body)).not.toContain(token);

      const events = await context.adminDb.securityEvent.findMany();
      expect(JSON.stringify(events)).not.toContain(token);

      const audits = await context.adminDb.auditEvent.findMany();
      expect(JSON.stringify(audits)).not.toContain(token);

      // Only the digest is persisted.
      await context.adminDb.$executeRawUnsafe('SET row_security = off');
      const stored = await context.adminDb.organizationInvitation.findFirstOrThrow({
        where: { organizationId: tenant.organizationId },
      });
      expect(stored.tokenHash).not.toBe(token);
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
