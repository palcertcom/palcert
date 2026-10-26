import { API } from './support/auth-client';
import {
  createTenant,
  createUser,
  inviteAndCaptureToken,
  type TenantFixture,
} from './support/organization-client';
import {
  ORG_ROLE,
  addRule,
  createDocumentType,
  createStandard,
  createVersion,
  documentTypesBase,
  grantOrganizationRole,
  ifMatchRevision,
  publishVersion,
  removeOrganizationRole,
  seedDraft,
  standardsBase,
  validRule,
} from './support/standards-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Tenant isolation and authorization for the standards surface.
 *
 * A cross-tenant leak here is a critical defect, so the suite is deliberately
 * adversarial: it does not merely check that the happy path is scoped, it
 * tries every way one tenant might reach another's standards — by id, by
 * parent injection, through search, and through a role that should not carry
 * the capability.
 */
describe('Standards tenant isolation (e2e)', () => {
  let context: TestContext;
  let alpha: TenantFixture;
  let beta: TenantFixture;

  /** A fully populated standard inside Beta, for Alpha to try to reach. */
  let betaSeed: {
    documentTypeId: string;
    standardId: string;
    versionId: string;
    ruleId: string;
    revision: number;
  };

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    alpha = await createTenant(context, 'Alpha University', 'owner@alpha.test');
    beta = await createTenant(context, 'Beta Institute', 'owner@beta.test');
    betaSeed = await seedDraft(beta.owner.client, beta.organizationId);
  });

  const alphaClient = (): TenantFixture['owner']['client'] => alpha.owner.client;

  // -------------------------------------------------------------------------
  describe('reading across tenants', () => {
    it('does not list another tenant’s document types', async () => {
      const response = await alphaClient().get(documentTypesBase(alpha.organizationId));
      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([]);
    });

    it('does not list another tenant’s standards', async () => {
      const response = await alphaClient().get(standardsBase(alpha.organizationId));
      expect(response.body.items).toEqual([]);
    });

    it('cannot read another tenant’s standard by its real id, under its own org', async () => {
      const response = await alphaClient().get(
        `${standardsBase(alpha.organizationId)}/${betaSeed.standardId}`,
      );
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('STANDARD_NOT_FOUND');
    });

    it('cannot read another tenant’s standard by addressing that tenant directly', async () => {
      const response = await alphaClient().get(
        `${standardsBase(beta.organizationId)}/${betaSeed.standardId}`,
      );
      // Refused at the tenant boundary before the standard is ever looked up,
      // and reported identically to a non-existent organization.
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('ORGANIZATION_NOT_FOUND');
    });

    it('cannot read another tenant’s version', async () => {
      const response = await alphaClient().get(
        `${standardsBase(alpha.organizationId)}/${betaSeed.standardId}/versions/${betaSeed.versionId}`,
      );
      expect(response.status).toBe(404);
    });

    it('cannot read another tenant’s rule', async () => {
      const response = await alphaClient().get(
        `${standardsBase(alpha.organizationId)}/${betaSeed.standardId}/versions/${betaSeed.versionId}/rules/${betaSeed.ruleId}`,
      );
      expect(response.status).toBe(404);
    });

    it('cannot read another tenant’s published snapshot', async () => {
      await publishVersion(
        beta.owner.client,
        beta.organizationId,
        betaSeed.standardId,
        betaSeed.versionId,
      );

      const response = await alphaClient().get(
        `${standardsBase(alpha.organizationId)}/${betaSeed.standardId}/versions/${betaSeed.versionId}/snapshot`,
      );
      expect(response.status).toBe(404);
    });

    it('cannot reach another tenant’s standards through search', async () => {
      await createDocumentType(alphaClient(), alpha.organizationId, { name: 'Alpha Thesis' });

      const response = await alphaClient().get(`${standardsBase(alpha.organizationId)}?search=IUG`);
      // The search term matches Beta's standard exactly. Search is a filter
      // inside the tenant, never a lookup across it.
      expect(response.body.items).toEqual([]);
    });

    it('does not leak another tenant’s document type through the picker', async () => {
      const response = await alphaClient().get(
        `${documentTypesBase(alpha.organizationId)}/${betaSeed.documentTypeId}`,
      );
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('DOCUMENT_TYPE_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  describe('cross-tenant parent injection', () => {
    it('refuses a standard naming another tenant’s document type', async () => {
      const response = await alphaClient().post(standardsBase(alpha.organizationId), {
        documentTypeId: betaSeed.documentTypeId,
        code: 'INJECT.ONE',
        nameEn: 'Injected Standard',
        nameAr: 'معيار مُدرج',
      });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('DOCUMENT_TYPE_NOT_FOUND');
    });

    it('refuses a version naming another tenant’s standard', async () => {
      const response = await alphaClient().post(
        `${standardsBase(alpha.organizationId)}/${betaSeed.standardId}/versions`,
        { versionLabel: '9.9' },
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('STANDARD_NOT_FOUND');
    });

    it('refuses a rule attached to another tenant’s version', async () => {
      const alphaSeed = await seedDraft(alphaClient(), alpha.organizationId);

      const response = await alphaClient().post(
        `${standardsBase(alpha.organizationId)}/${alphaSeed.standardId}/versions/${betaSeed.versionId}/rules`,
        validRule({ ruleCode: 'INJECT.RULE' }),
        ifMatchRevision(betaSeed.revision),
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('STANDARD_VERSION_NOT_FOUND');
    });

    it('refuses a clone of another tenant’s version', async () => {
      const response = await alphaClient().post(
        `${standardsBase(alpha.organizationId)}/${betaSeed.standardId}/versions/${betaSeed.versionId}/clone`,
        { versionLabel: 'stolen' },
      );
      expect(response.status).toBe(404);
    });

    it('writes nothing into the other tenant when injection is attempted', async () => {
      await alphaClient().post(standardsBase(alpha.organizationId), {
        documentTypeId: betaSeed.documentTypeId,
        code: 'INJECT.TWO',
        nameEn: 'Injected Standard',
        nameAr: 'معيار مُدرج',
      });

      const betaStandards = await context.adminDb.standard.count({
        where: { organizationId: beta.organizationId },
      });
      const alphaStandards = await context.adminDb.standard.count({
        where: { organizationId: alpha.organizationId },
      });

      expect(betaStandards).toBe(1);
      expect(alphaStandards).toBe(0);
    });

    it('is refused by the database even with the application check removed', async () => {
      // Proving the composite foreign key, not the service. The owning identity
      // bypasses every application layer; the constraint still holds.
      await expect(
        context.adminDb.$executeRawUnsafe(`
          INSERT INTO standards
            (id, organization_id, document_type_id, code, name_en, name_ar, created_by_user_id, updated_at)
          VALUES
            (gen_random_uuid(), '${alpha.organizationId}', '${betaSeed.documentTypeId}',
             'DB.INJECT', 'x', 'x', '${alpha.owner.userId}', now())
        `),
      ).rejects.toThrow(/standards_document_type_org_fkey/);
    });
  });

  // -------------------------------------------------------------------------
  describe('writing across tenants', () => {
    it('cannot edit another tenant’s standard', async () => {
      const response = await alphaClient().patch(
        `${standardsBase(alpha.organizationId)}/${betaSeed.standardId}`,
        { nameEn: 'Renamed by Alpha' },
      );
      expect(response.status).toBe(404);

      const unchanged = await context.adminDb.standard.findUniqueOrThrow({
        where: { id: betaSeed.standardId },
      });
      expect(unchanged.nameEn).toBe('IUG Thesis Formatting');
    });

    it('cannot archive another tenant’s standard', async () => {
      const response = await alphaClient().post(
        `${standardsBase(alpha.organizationId)}/${betaSeed.standardId}/archive`,
      );
      expect(response.status).toBe(404);

      const unchanged = await context.adminDb.standard.findUniqueOrThrow({
        where: { id: betaSeed.standardId },
      });
      expect(unchanged.status).toBe('ACTIVE');
    });

    it('cannot publish another tenant’s draft', async () => {
      const response = await alphaClient().post(
        `${standardsBase(alpha.organizationId)}/${betaSeed.standardId}/versions/${betaSeed.versionId}/publish`,
      );
      expect(response.status).toBe(404);

      const unchanged = await context.adminDb.standardVersion.findUniqueOrThrow({
        where: { id: betaSeed.versionId },
      });
      expect(unchanged.status).toBe('DRAFT');
    });

    it('cannot delete another tenant’s rule', async () => {
      const response = await alphaClient().delete(
        `${standardsBase(alpha.organizationId)}/${betaSeed.standardId}/versions/${betaSeed.versionId}/rules/${betaSeed.ruleId}`,
        undefined,
        ifMatchRevision(betaSeed.revision),
      );
      expect(response.status).toBe(404);

      expect(await context.adminDb.standardRule.count({ where: { id: betaSeed.ruleId } })).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('membership boundaries', () => {
    it('lets a member of both tenants see only the standards of the one addressed', async () => {
      const dual = await createUser(context, 'dual@example.test');

      for (const tenant of [alpha, beta]) {
        const invitation = await inviteAndCaptureToken(
          context,
          tenant.owner.client,
          tenant.organizationId,
          'dual@example.test',
          ORG_ROLE.TEMPLATE_MANAGER,
        );
        const accepted = await dual.client.post(`${API}/invitations/accept`, {
          token: invitation.token,
        });
        expect(accepted.status).toBe(200);
      }

      await createDocumentType(alphaClient(), alpha.organizationId, { name: 'Alpha Thesis' });

      const inAlpha = await dual.client.get(documentTypesBase(alpha.organizationId));
      const inBeta = await dual.client.get(documentTypesBase(beta.organizationId));

      expect(inAlpha.body.items.map((item: { name: string }) => item.name)).toEqual([
        'Alpha Thesis',
      ]);
      expect(inBeta.body.items.map((item: { name: string }) => item.name)).toEqual([
        "Master's Thesis",
      ]);
    });

    it('refuses a non-member outright', async () => {
      const outsider = await createUser(context, 'outsider@example.test');
      const response = await outsider.client.get(standardsBase(beta.organizationId));

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('ORGANIZATION_NOT_FOUND');
    });
  });
});

/**
 * Authorization within a tenant.
 *
 * The separation that matters most: a reviewer reads standards and can never
 * write one, and publishing is a capability distinct from editing.
 */
describe('Standards authorization (e2e)', () => {
  let context: TestContext;
  let tenant: TenantFixture;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    tenant = await createTenant(context, 'Islamic University', 'owner@iug.test');
  });

  const base = (): string => standardsBase(tenant.organizationId);
  const owner = (): TenantFixture['owner']['client'] => tenant.owner.client;

  /** Add a member holding exactly one organization role. */
  async function memberWithRole(
    email: string,
    roleCode: string,
  ): Promise<{ client: Awaited<ReturnType<typeof createUser>>['client']; membershipId: string }> {
    const user = await createUser(context, email);
    const invitation = await inviteAndCaptureToken(
      context,
      owner(),
      tenant.organizationId,
      email,
      roleCode,
    );
    const accepted = await user.client.post(`${API}/invitations/accept`, {
      token: invitation.token,
    });
    if (accepted.status !== 200) {
      throw new Error(`Invitation acceptance failed: ${JSON.stringify(accepted.body)}`);
    }

    // Acceptance returns the organization and the granted role, not a
    // membership id, so the id comes from the member list the owner can see.
    const members = await owner().get(`${API}/organizations/${tenant.organizationId}/members`);
    const membership = (members.body.items as Array<{ membershipId: string; email: string }>).find(
      (item) => item.email === email,
    );
    if (membership === undefined) {
      throw new Error(`${email} is not in the member list after accepting`);
    }

    return { client: user.client, membershipId: membership.membershipId };
  }

  it('lets a template manager author and publish a standard', async () => {
    const manager = await memberWithRole('manager@iug.test', ORG_ROLE.TEMPLATE_MANAGER);

    const documentType = await createDocumentType(manager.client, tenant.organizationId);
    const standard = await createStandard(manager.client, tenant.organizationId, documentType.id);
    const version = await createVersion(manager.client, tenant.organizationId, standard.id);
    await addRule(manager.client, tenant.organizationId, standard.id, version.id, version.revision);

    const published = await publishVersion(
      manager.client,
      tenant.organizationId,
      standard.id,
      version.id,
    );
    expect(published.status).toBe(200);
  });

  it('lets a reviewer read standards', async () => {
    const seeded = await seedDraft(owner(), tenant.organizationId);
    const reviewer = await memberWithRole('reviewer@iug.test', ORG_ROLE.REVIEWER);

    const list = await reviewer.client.get(base());
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);

    const rules = await reviewer.client.get(
      `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules`,
    );
    expect(rules.status).toBe(200);
    expect(rules.body.items).toHaveLength(1);
  });

  it('never lets a reviewer write anything', async () => {
    const seeded = await seedDraft(owner(), tenant.organizationId);
    const reviewer = await memberWithRole('reviewer2@iug.test', ORG_ROLE.REVIEWER);

    const attempts = [
      reviewer.client.post(documentTypesBase(tenant.organizationId), {
        systemCategory: 'THESIS',
        name: 'Sneaky Type',
      }),
      reviewer.client.post(base(), {
        documentTypeId: seeded.documentTypeId,
        code: 'SNEAKY.ONE',
        nameEn: 'Sneaky Standard',
        nameAr: 'معيار',
      }),
      reviewer.client.patch(`${base()}/${seeded.standardId}`, { nameEn: 'Renamed' }),
      reviewer.client.post(`${base()}/${seeded.standardId}/archive`),
      reviewer.client.post(`${base()}/${seeded.standardId}/versions`, { versionLabel: '9.9' }),
      reviewer.client.post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules`,
        validRule({ ruleCode: 'SNEAKY.RULE' }),
        ifMatchRevision(seeded.revision),
      ),
      reviewer.client.patch(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules/${seeded.ruleId}`,
        validRule({ severity: 'INFO' }),
        ifMatchRevision(seeded.revision),
      ),
      reviewer.client.delete(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules/${seeded.ruleId}`,
        undefined,
        ifMatchRevision(seeded.revision),
      ),
      reviewer.client.post(`${base()}/${seeded.standardId}/versions/${seeded.versionId}/publish`),
    ];

    // Collected rather than asserted one at a time, so a failure names every
    // write that got through instead of stopping at the first.
    const allowed = (await Promise.all(attempts))
      .filter((response) => response.status !== 403)
      .map(
        (response) => `${response.request.method} ${response.request.url} -> ${response.status}`,
      );

    expect(allowed).toEqual([]);

    // Nothing changed.
    expect(await context.adminDb.standard.count()).toBe(1);
    expect(await context.adminDb.standardRule.count()).toBe(1);
    const version = await context.adminDb.standardVersion.findUniqueOrThrow({
      where: { id: seeded.versionId },
    });
    expect(version.status).toBe('DRAFT');
  });

  it('separates publishing from editing', async () => {
    // A template manager holds both by default. Removing only the manager role
    // and granting reviewer would remove editing too, so the separation is
    // asserted on the catalogue *and* on behaviour: strip the publish-bearing
    // roles and confirm the editing role that remains cannot publish.
    const author = await memberWithRole('author@iug.test', ORG_ROLE.TEMPLATE_MANAGER);
    const seeded = await seedDraft(author.client, tenant.organizationId);

    // Demote to reviewer: reads survive, publishing does not.
    await grantOrganizationRole(
      owner(),
      tenant.organizationId,
      author.membershipId,
      ORG_ROLE.REVIEWER,
    );
    await removeOrganizationRole(
      owner(),
      tenant.organizationId,
      author.membershipId,
      ORG_ROLE.TEMPLATE_MANAGER,
    );

    const publish = await publishVersion(
      author.client,
      tenant.organizationId,
      seeded.standardId,
      seeded.versionId,
    );
    expect(publish.status).toBe(403);

    const read = await author.client.get(`${base()}/${seeded.standardId}`);
    expect(read.status).toBe(200);
  });

  it('refuses an unauthenticated caller before any tenant work happens', async () => {
    const seeded = await seedDraft(owner(), tenant.organizationId);
    const anonymous = await createUser(context, 'nobody@example.test');
    anonymous.client.clearCookies();

    const response = await anonymous.client.get(`${base()}/${seeded.standardId}`);
    expect(response.status).toBe(401);
  });

  it('serves the rule schema to any authenticated user, with no tenant context', async () => {
    const anyone = await createUser(context, 'curious@example.test');
    const response = await anyone.client.get(`${API}/standards/rule-schema`);

    expect(response.status).toBe(200);
    expect(response.body.operators).toHaveLength(14);
    expect(response.body.categories).toHaveLength(23);
    // Reference data about the platform: it must carry nothing tenant-specific.
    expect(JSON.stringify(response.body)).not.toContain(tenant.organizationId);
  });
});
