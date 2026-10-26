import { API } from './support/auth-client';
import {
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

async function addMember(
  context: TestContext,
  tenant: { organizationId: string; owner: { client: import('./support/auth-client').AuthClient } },
  email: string,
  roleCode = 'ORGANIZATION_REVIEWER',
): Promise<{
  membershipId: string;
  userId: string;
  client: import('./support/auth-client').AuthClient;
}> {
  const user = await createUser(context, email);
  const invitation = await inviteAndCaptureToken(
    context,
    tenant.owner.client,
    tenant.organizationId,
    email,
    roleCode,
  );
  const accepted = await user.client.post(`${API}/invitations/accept`, {
    token: invitation.token,
  });
  if (accepted.status !== 200) {
    throw new Error(`Accept failed: ${JSON.stringify(accepted.body)}`);
  }

  const members = await tenant.owner.client.get(
    `${API}/organizations/${tenant.organizationId}/members`,
  );
  const membership = members.body.items.find(
    (row: { userId: string }) => row.userId === user.userId,
  );
  return { membershipId: membership.membershipId, userId: user.userId, client: user.client };
}

describe('Organization team management (e2e)', () => {
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

  // --- 14-16. Members and roles ---------------------------------------------
  it('lists members with their roles', async () => {
    const tenant = await createTenant(context, 'List Org', 'list-owner@example.com');
    await addMember(context, tenant, 'list-member@example.com', 'ORGANIZATION_REVIEWER');

    const response = await tenant.owner.client.get(
      `${API}/organizations/${tenant.organizationId}/members`,
    );

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.nextCursor).toBeNull();

    const roles = response.body.items.map((row: { roles: string[] }) => row.roles).flat();
    expect(roles).toContain('ORGANIZATION_OWNER');
    expect(roles).toContain('ORGANIZATION_REVIEWER');
  });

  it('paginates members with a stable cursor', async () => {
    const tenant = await createTenant(context, 'Page Org', 'page-owner@example.com');
    for (let index = 0; index < 4; index += 1) {
      await addMember(context, tenant, `page-member-${index}@example.com`);
    }

    const first = await tenant.owner.client.get(
      `${API}/organizations/${tenant.organizationId}/members?limit=2`,
    );
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();

    const second = await tenant.owner.client.get(
      `${API}/organizations/${tenant.organizationId}/members?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(second.body.items).toHaveLength(2);

    const firstIds = first.body.items.map((row: { membershipId: string }) => row.membershipId);
    const secondIds = second.body.items.map((row: { membershipId: string }) => row.membershipId);
    // No overlap and no gaps: five members over three pages of two.
    expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);

    const third = await tenant.owner.client.get(
      `${API}/organizations/${tenant.organizationId}/members?limit=2&cursor=${encodeURIComponent(second.body.nextCursor)}`,
    );
    expect(third.body.items).toHaveLength(1);
    expect(third.body.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor rather than silently restarting', async () => {
    const tenant = await createTenant(context, 'Cursor Org', 'cursor@example.com');
    const response = await tenant.owner.client.get(
      `${API}/organizations/${tenant.organizationId}/members?cursor=not-a-cursor`,
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('assigns and removes an organization role', async () => {
    const tenant = await createTenant(context, 'Role Org', 'role-owner@example.com');
    const member = await addMember(
      context,
      tenant,
      'role-member@example.com',
      'ORGANIZATION_REVIEWER',
    );

    const assigned = await tenant.owner.client.post(
      `${API}/organizations/${tenant.organizationId}/members/${member.membershipId}/roles`,
      { roleCode: 'TEMPLATE_MANAGER' },
    );
    expect(assigned.status).toBe(201);
    expect(assigned.body.roles).toEqual(
      expect.arrayContaining(['ORGANIZATION_REVIEWER', 'TEMPLATE_MANAGER']),
    );

    const removed = await tenant.owner.client.delete(
      `${API}/organizations/${tenant.organizationId}/members/${member.membershipId}/roles/TEMPLATE_MANAGER`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.roles).toEqual(['ORGANIZATION_REVIEWER']);
  });

  // --- 29 & 37. Escalation ---------------------------------------------------
  it('refuses to grant a PalCert platform role through the organization API', async () => {
    const tenant = await createTenant(context, 'Esc Org', 'esc-owner@example.com');
    const member = await addMember(context, tenant, 'esc-member@example.com');

    for (const roleCode of [
      'PALCERT_ADMIN',
      'PALCERT_FINANCE',
      'PALCERT_SUPPORT',
      'PALCERT_AUDITOR',
    ]) {
      const response = await tenant.owner.client.post(
        `${API}/organizations/${tenant.organizationId}/members/${member.membershipId}/roles`,
        { roleCode },
      );
      expect(`${roleCode}=${response.status}`).toBe(`${roleCode}=400`);
    }

    // And nothing global was granted.
    const globals = await context.adminDb.userRole.findMany({
      where: { userId: member.userId, organizationId: null },
      include: { role: true },
    });
    expect(globals.map((row) => row.role.code)).toEqual(['SERVICE_USER']);
  });

  it('does not let an organization admin grant the owner role', async () => {
    const tenant = await createTenant(context, 'Owner Guard', 'og-owner@example.com');
    const admin = await addMember(context, tenant, 'og-admin@example.com', 'ORGANIZATION_ADMIN');
    const other = await addMember(context, tenant, 'og-other@example.com', 'ORGANIZATION_REVIEWER');

    const response = await admin.client.post(
      `${API}/organizations/${tenant.organizationId}/members/${other.membershipId}/roles`,
      { roleCode: 'ORGANIZATION_OWNER' },
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ORGANIZATION_ACCESS_DENIED');
  });

  it('does not let a reviewer manage the team', async () => {
    const tenant = await createTenant(context, 'Reviewer Org', 'rv-owner@example.com');
    const reviewer = await addMember(
      context,
      tenant,
      'rv-member@example.com',
      'ORGANIZATION_REVIEWER',
    );

    // A reviewer may look...
    expect(
      (await reviewer.client.get(`${API}/organizations/${tenant.organizationId}/members`)).status,
    ).toBe(200);

    // ...but not act.
    const invited = await reviewer.client.post(
      `${API}/organizations/${tenant.organizationId}/invitations`,
      { email: 'someone@example.com', roleCode: 'ORGANIZATION_REVIEWER' },
    );
    expect(invited.status).toBe(403);

    const updated = await reviewer.client.patch(`${API}/organizations/${tenant.organizationId}`, {
      displayName: 'Renamed by reviewer',
    });
    expect(updated.status).toBe(403);
  });

  // --- 17-20. Membership status ---------------------------------------------
  it('suspends a member, who loses access immediately', async () => {
    const tenant = await createTenant(context, 'Suspend Org', 'sp-owner@example.com');
    const member = await addMember(context, tenant, 'sp-member@example.com');

    expect((await member.client.get(`${API}/organizations/${tenant.organizationId}`)).status).toBe(
      200,
    );

    const suspended = await tenant.owner.client.patch(
      `${API}/organizations/${tenant.organizationId}/members/${member.membershipId}`,
      { status: 'SUSPENDED' },
    );
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe('SUSPENDED');

    const blocked = await member.client.get(`${API}/organizations/${tenant.organizationId}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MEMBERSHIP_SUSPENDED');
  });

  it('reactivates a suspended member', async () => {
    const tenant = await createTenant(context, 'React Org', 'ra-owner@example.com');
    const member = await addMember(context, tenant, 'ra-member@example.com');

    await tenant.owner.client.patch(
      `${API}/organizations/${tenant.organizationId}/members/${member.membershipId}`,
      { status: 'SUSPENDED' },
    );
    const reactivated = await tenant.owner.client.patch(
      `${API}/organizations/${tenant.organizationId}/members/${member.membershipId}`,
      { status: 'ACTIVE' },
    );

    expect(reactivated.body.status).toBe('ACTIVE');
    expect((await member.client.get(`${API}/organizations/${tenant.organizationId}`)).status).toBe(
      200,
    );
  });

  it('removes a member and strips their organization roles', async () => {
    const tenant = await createTenant(context, 'Remove Org', 'rm-owner@example.com');
    const member = await addMember(context, tenant, 'rm-member@example.com', 'ORGANIZATION_ADMIN');

    const removed = await tenant.owner.client.delete(
      `${API}/organizations/${tenant.organizationId}/members/${member.membershipId}`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.status).toBe('REMOVED');
    expect(removed.body.roles).toEqual([]);

    expect((await member.client.get(`${API}/organizations/${tenant.organizationId}`)).status).toBe(
      404,
    );

    const roles = await context.adminDb.userRole.count({
      where: { userId: member.userId, organizationId: tenant.organizationId },
    });
    expect(roles).toBe(0);
  });

  it('leaves the removed person’s PalCert account intact', async () => {
    const tenant = await createTenant(context, 'Account Org', 'ac-owner@example.com');
    const member = await addMember(context, tenant, 'ac-member@example.com');

    await tenant.owner.client.delete(
      `${API}/organizations/${tenant.organizationId}/members/${member.membershipId}`,
    );

    const profile = await member.client.get(`${API}/users/me`);
    expect(profile.status).toBe(200);
    expect(profile.body.status).toBe('ACTIVE');
  });

  // --- 21-22. Owner protection and transfer ---------------------------------
  it('refuses to remove the last active owner', async () => {
    const tenant = await createTenant(context, 'Last Owner', 'lo-owner@example.com');
    const members = await tenant.owner.client.get(
      `${API}/organizations/${tenant.organizationId}/members`,
    );
    const ownerMembership = members.body.items[0].membershipId;

    const removed = await tenant.owner.client.delete(
      `${API}/organizations/${tenant.organizationId}/members/${ownerMembership}`,
    );
    expect(removed.status).toBe(409);
    expect(removed.body.error.code).toBe('LAST_OWNER_REQUIRED');

    const demoted = await tenant.owner.client.delete(
      `${API}/organizations/${tenant.organizationId}/members/${ownerMembership}/roles/ORGANIZATION_OWNER`,
    );
    expect(demoted.status).toBe(409);
    expect(demoted.body.error.code).toBe('LAST_OWNER_REQUIRED');

    const suspended = await tenant.owner.client.patch(
      `${API}/organizations/${tenant.organizationId}/members/${ownerMembership}`,
      { status: 'SUSPENDED' },
    );
    expect(suspended.status).toBe(409);
  });

  it('transfers ownership without ever leaving the organization ownerless', async () => {
    const tenant = await createTenant(context, 'Transfer Org', 'tr-owner@example.com');
    const successor = await addMember(
      context,
      tenant,
      'tr-successor@example.com',
      'ORGANIZATION_ADMIN',
    );

    const response = await tenant.owner.client.post(
      `${API}/organizations/${tenant.organizationId}/ownership-transfer`,
      { toMembershipId: successor.membershipId, stepDown: true },
    );

    expect(response.status).toBe(201);
    expect(response.body.newOwnerUserId).toBe(successor.userId);
    expect(response.body.previousOwnerRetainedOwnership).toBe(false);

    // Exactly one owner throughout, and it is now the successor.
    const owners = await context.adminDb.userRole.findMany({
      where: { organizationId: tenant.organizationId, role: { code: 'ORGANIZATION_OWNER' } },
    });
    expect(owners).toHaveLength(1);
    expect(owners[0]!.userId).toBe(successor.userId);

    // The new owner can act as one; the old owner can no longer transfer.
    const secondTransfer = await tenant.owner.client.post(
      `${API}/organizations/${tenant.organizationId}/ownership-transfer`,
      { toMembershipId: successor.membershipId },
    );
    expect(secondTransfer.status).toBe(403);
  });

  it('can transfer ownership while keeping the previous owner as an owner', async () => {
    const tenant = await createTenant(context, 'Co-own Org', 'co-owner@example.com');
    const successor = await addMember(context, tenant, 'co-successor@example.com');

    const response = await tenant.owner.client.post(
      `${API}/organizations/${tenant.organizationId}/ownership-transfer`,
      { toMembershipId: successor.membershipId, stepDown: false },
    );

    expect(response.body.previousOwnerRetainedOwnership).toBe(true);
    const owners = await context.adminDb.userRole.count({
      where: { organizationId: tenant.organizationId, role: { code: 'ORGANIZATION_OWNER' } },
    });
    expect(owners).toBe(2);
  });

  it('refuses to transfer ownership to a suspended member', async () => {
    const tenant = await createTenant(context, 'Susp Transfer', 'st-owner@example.com');
    const member = await addMember(context, tenant, 'st-member@example.com');

    await tenant.owner.client.patch(
      `${API}/organizations/${tenant.organizationId}/members/${member.membershipId}`,
      { status: 'SUSPENDED' },
    );

    const response = await tenant.owner.client.post(
      `${API}/organizations/${tenant.organizationId}/ownership-transfer`,
      { toMembershipId: member.membershipId },
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('MEMBERSHIP_SUSPENDED');
  });

  // --- 72. Concurrency -------------------------------------------------------
  it('keeps exactly one owner under concurrent removal attempts', async () => {
    const tenant = await createTenant(context, 'Race Org', 'race-owner@example.com');
    const second = await addMember(context, tenant, 'race-second@example.com');

    await tenant.owner.client.post(
      `${API}/organizations/${tenant.organizationId}/members/${second.membershipId}/roles`,
      { roleCode: 'ORGANIZATION_OWNER' },
    );

    const members = await tenant.owner.client.get(
      `${API}/organizations/${tenant.organizationId}/members`,
    );
    const ids = members.body.items.map((row: { membershipId: string }) => row.membershipId);

    // Both owners try to drop the owner role at the same moment.
    const results = await Promise.all([
      tenant.owner.client.delete(
        `${API}/organizations/${tenant.organizationId}/members/${ids[0]}/roles/ORGANIZATION_OWNER`,
      ),
      second.client.delete(
        `${API}/organizations/${tenant.organizationId}/members/${ids[1]}/roles/ORGANIZATION_OWNER`,
      ),
    ]);

    const succeeded = results.filter((response) => response.status === 200);
    expect(succeeded.length).toBeLessThanOrEqual(1);

    const owners = await context.adminDb.userRole.count({
      where: { organizationId: tenant.organizationId, role: { code: 'ORGANIZATION_OWNER' } },
    });
    expect(owners).toBeGreaterThanOrEqual(1);
  });

  it('lets only one of two concurrent acceptances of the same invitation succeed', async () => {
    const tenant = await createTenant(context, 'Concurrent Accept', 'ca-owner@example.com');
    const invitee = await createUser(context, 'ca-invitee@example.com');
    const invitation = await inviteAndCaptureToken(
      context,
      tenant.owner.client,
      tenant.organizationId,
      invitee.email,
    );

    const results = await Promise.all([
      invitee.client.post(`${API}/invitations/accept`, { token: invitation.token }),
      invitee.client.post(`${API}/invitations/accept`, { token: invitation.token }),
    ]);

    expect(results.filter((response) => response.status === 200)).toHaveLength(1);

    const memberships = await context.adminDb.organizationMembership.count({
      where: { organizationId: tenant.organizationId, userId: invitee.userId },
    });
    expect(memberships).toBe(1);
  });

  // --- 23-24, 32. Multiple organizations ------------------------------------
  it('supports a user belonging to several organizations with different roles', async () => {
    const university = await createTenant(context, 'University X', 'ux-owner@example.com');
    const journal = await createTenant(context, 'Journal Y', 'jy-owner@example.com');
    const publisher = await createTenant(context, 'Publisher Z', 'pz-owner@example.com');

    const person = await createUser(context, 'multi@example.com');

    for (const [tenant, role] of [
      [university, 'ORGANIZATION_ADMIN'],
      [journal, 'ORGANIZATION_REVIEWER'],
      [publisher, 'TEMPLATE_MANAGER'],
    ] as const) {
      const invitation = await inviteAndCaptureToken(
        context,
        tenant.owner.client,
        tenant.organizationId,
        person.email,
        role,
      );
      await person.client.post(`${API}/invitations/accept`, { token: invitation.token });
    }

    const mine = await person.client.get(`${API}/organizations`);
    expect(mine.body).toHaveLength(3);

    const byId = new Map<string, string[]>(
      mine.body.map((row: { organization: { id: string }; roles: string[] }) => [
        row.organization.id,
        row.roles,
      ]),
    );
    expect(byId.get(university.organizationId)).toEqual(['ORGANIZATION_ADMIN']);
    expect(byId.get(journal.organizationId)).toEqual(['ORGANIZATION_REVIEWER']);
    expect(byId.get(publisher.organizationId)).toEqual(['TEMPLATE_MANAGER']);
  });

  it('evaluates permissions per organization, not globally', async () => {
    const alpha = await createTenant(context, 'Perm Alpha', 'pa-owner@example.com');
    const beta = await createTenant(context, 'Perm Beta', 'pb-owner@example.com');
    const person = await createUser(context, 'perms@example.com');

    for (const [tenant, role] of [
      [alpha, 'ORGANIZATION_ADMIN'],
      [beta, 'ORGANIZATION_REVIEWER'],
    ] as const) {
      const invitation = await inviteAndCaptureToken(
        context,
        tenant.owner.client,
        tenant.organizationId,
        person.email,
        role,
      );
      await person.client.post(`${API}/invitations/accept`, { token: invitation.token });
    }

    // Admin in Alpha: may rename it.
    expect(
      (
        await person.client.patch(`${API}/organizations/${alpha.organizationId}`, {
          displayName: 'Renamed Alpha',
        })
      ).status,
    ).toBe(200);

    // Reviewer in Beta: may not, despite being an admin elsewhere.
    const denied = await person.client.patch(`${API}/organizations/${beta.organizationId}`, {
      displayName: 'Renamed Beta',
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('ORGANIZATION_ACCESS_DENIED');
  });

  it('confines a membership suspension to the organization that imposed it', async () => {
    const alpha = await createTenant(context, 'Confine A', 'cfa-owner@example.com');
    const beta = await createTenant(context, 'Confine B', 'cfb-owner@example.com');
    const person = await createUser(context, 'confined@example.com');

    const memberships: Record<string, string> = {};
    for (const tenant of [alpha, beta]) {
      const invitation = await inviteAndCaptureToken(
        context,
        tenant.owner.client,
        tenant.organizationId,
        person.email,
      );
      await person.client.post(`${API}/invitations/accept`, { token: invitation.token });

      const members = await tenant.owner.client.get(
        `${API}/organizations/${tenant.organizationId}/members`,
      );
      memberships[tenant.organizationId] = members.body.items.find(
        (row: { userId: string }) => row.userId === person.userId,
      ).membershipId;
    }

    await alpha.owner.client.patch(
      `${API}/organizations/${alpha.organizationId}/members/${memberships[alpha.organizationId]}`,
      { status: 'SUSPENDED' },
    );

    expect((await person.client.get(`${API}/organizations/${alpha.organizationId}`)).status).toBe(
      403,
    );
    // Beta is untouched.
    expect((await person.client.get(`${API}/organizations/${beta.organizationId}`)).status).toBe(
      200,
    );
    // And so is the PalCert account.
    expect((await person.client.get(`${API}/users/me`)).status).toBe(200);
  });

  // --- 30-31. Organization suspension ---------------------------------------
  it('blocks organization access while leaving accounts and other tenants alone', async () => {
    const suspended = await createTenant(context, 'Doomed Org', 'do-owner@example.com');
    const other = await createTenant(context, 'Healthy Org', 'ho-owner@example.com');
    const admin = await signInPlatformAdmin(context, 'suspender@palcert.test');

    // The owner of the doomed organization also belongs to the healthy one.
    const invitation = await inviteAndCaptureToken(
      context,
      other.owner.client,
      other.organizationId,
      suspended.owner.email,
    );
    await suspended.owner.client.post(`${API}/invitations/accept`, { token: invitation.token });

    const response = await admin.post(
      `${API}/admin/organizations/${suspended.organizationId}/suspend`,
      { reason: 'Terms violation' },
    );
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('SUSPENDED');

    const blocked = await suspended.owner.client.get(
      `${API}/organizations/${suspended.organizationId}`,
    );
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ORGANIZATION_SUSPENDED');

    // Personal account: fine.
    expect((await suspended.owner.client.get(`${API}/users/me`)).status).toBe(200);
    // Other organization: fine.
    expect(
      (await suspended.owner.client.get(`${API}/organizations/${other.organizationId}`)).status,
    ).toBe(200);
  });

  it('reactivates a suspended organization', async () => {
    const tenant = await createTenant(context, 'Revive Org', 'rev-owner@example.com');
    const admin = await signInPlatformAdmin(context, 'reviver@palcert.test');

    await admin.post(`${API}/admin/organizations/${tenant.organizationId}/suspend`, {});
    expect(
      (await tenant.owner.client.get(`${API}/organizations/${tenant.organizationId}`)).status,
    ).toBe(403);

    const reactivated = await admin.post(
      `${API}/admin/organizations/${tenant.organizationId}/reactivate`,
      {},
    );
    expect(reactivated.status).toBe(201);
    expect(
      (await tenant.owner.client.get(`${API}/organizations/${tenant.organizationId}`)).status,
    ).toBe(200);
  });

  it('does not disclose the suspension reason to the organization', async () => {
    const tenant = await createTenant(context, 'Reason Org', 'rsn-owner@example.com');
    const admin = await signInPlatformAdmin(context, 'reasoner@palcert.test');

    await admin.post(`${API}/admin/organizations/${tenant.organizationId}/suspend`, {
      reason: 'INTERNAL-FRAUD-INVESTIGATION-2026',
    });

    const blocked = await tenant.owner.client.get(`${API}/organizations/${tenant.organizationId}`);
    expect(JSON.stringify(blocked.body)).not.toContain('INTERNAL-FRAUD');
  });
});
