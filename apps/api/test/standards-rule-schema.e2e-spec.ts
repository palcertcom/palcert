import { RULE_SCHEMA_VERSION } from '@palcert/contracts';
import { createTenant, type TenantFixture } from './support/organization-client';
import { API, type AuthClient } from './support/auth-client';
import {
  addRule,
  createDocumentType,
  createStandard,
  createVersion,
  ifMatchRevision,
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
 * Rule schema versioning.
 *
 * Phase 4 amended one Phase 3 invariant: a rule may now be blocking in any
 * evaluation mode. The amendment is *versioned*, not retroactive, and these
 * tests exist to prove both halves of that — content written under version 1
 * is still judged by version 1's rules, and nothing upgrades without someone
 * asking for it.
 */
describe('Rule schema versioning (e2e)', () => {
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
  const owner = (): AuthClient => tenant.owner.client;

  /** A rule that is blocking but not deterministic — legal in v2, not in v1. */
  const blockingAiRule = (): Record<string, unknown> =>
    validRule({
      ruleCode: 'ETHICS.STATEMENT.PRESENT',
      category: 'RESEARCH_ETHICS',
      evaluationMode: 'AI_ASSISTED',
      scope: { kind: 'SECTION', property: 'text', sectionKey: 'ETHICS' },
      operator: 'EXISTS',
      expected: { type: 'NONE' },
      unit: null,
      tolerance: null,
      blocking: true,
      autofix: 'NONE',
      titleEn: 'An ethics statement is present',
      titleAr: 'يوجد بيان أخلاقيات',
    });

  /**
   * Demote a draft and its rules to schema version 1.
   *
   * There is deliberately no API for writing a v1 version — this release
   * authors v2 — so a legacy draft is manufactured with the schema-owning
   * client. The version is moved first: the database trigger requires a rule's
   * version to match its parent's, so moving the rules first would be refused.
   */
  async function demoteToV1(versionId: string): Promise<void> {
    await context.adminDb.$executeRawUnsafe(
      `UPDATE "standard_versions" SET "rule_schema_version" = 1 WHERE "id" = $1::uuid`,
      versionId,
    );
    await context.adminDb.$executeRawUnsafe(
      `UPDATE "standard_rules" SET "rule_schema_version" = 1 WHERE "standard_version_id" = $1::uuid`,
      versionId,
    );
  }

  async function storedSchemaVersion(versionId: string): Promise<number> {
    const rows = await context.adminDb.$queryRawUnsafe<Array<{ rule_schema_version: number }>>(
      `SELECT "rule_schema_version" FROM "standard_versions" WHERE "id" = $1::uuid`,
      versionId,
    );
    return rows[0]!.rule_schema_version;
  }

  async function ruleSchemaVersions(versionId: string): Promise<number[]> {
    const rows = await context.adminDb.$queryRawUnsafe<Array<{ rule_schema_version: number }>>(
      `SELECT DISTINCT "rule_schema_version" FROM "standard_rules"
       WHERE "standard_version_id" = $1::uuid`,
      versionId,
    );
    return rows.map((row) => row.rule_schema_version).sort();
  }

  async function seedVersion(label = '1.0'): Promise<{
    standardId: string;
    versionId: string;
    revision: number;
  }> {
    const documentType = await createDocumentType(owner(), tenant.organizationId);
    const standard = await createStandard(owner(), tenant.organizationId, documentType.id);
    const version = await createVersion(owner(), tenant.organizationId, standard.id, label);
    return { standardId: standard.id, versionId: version.id, revision: version.revision };
  }

  // -------------------------------------------------------------------------
  describe('the published schema descriptor', () => {
    it('advertises every version it can validate, not only the current one', async () => {
      const response = await owner().get(`${API}/standards/rule-schema`);

      expect(response.status).toBe(200);
      expect(response.body.ruleSchemaVersion).toBe(RULE_SCHEMA_VERSION);
      expect(response.body.supportedRuleSchemaVersions).toEqual([1, 2]);
      expect(response.body.blockingAnyModeFromSchemaVersion).toBe(2);
    });

    it('names the current version as one it supports', async () => {
      // A descriptor that advertised a current version it could not validate
      // would send the builder into a state the API refuses.
      const response = await owner().get(`${API}/standards/rule-schema`);
      expect(response.body.supportedRuleSchemaVersions).toContain(response.body.ruleSchemaVersion);
    });
  });

  // -------------------------------------------------------------------------
  describe('version 2 — the amended blocking rule', () => {
    it('creates new drafts under the current schema version', async () => {
      const seeded = await seedVersion();
      expect(await storedSchemaVersion(seeded.versionId)).toBe(RULE_SCHEMA_VERSION);
    });

    it('accepts a blocking AI-assisted rule', async () => {
      const seeded = await seedVersion();

      const response = await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules`,
        blockingAiRule(),
        ifMatchRevision(seeded.revision),
      );

      expect(response.status).toBe(201);
      expect(response.body.blocking).toBe(true);
      expect(response.body.evaluationMode).toBe('AI_ASSISTED');
    });

    it('accepts a blocking manual rule', async () => {
      // The other half of the amendment: a requirement a person must judge can
      // still be one a document cannot be certified without.
      const seeded = await seedVersion();

      const response = await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules`,
        { ...blockingAiRule(), ruleCode: 'REVIEW.ANONYMITY', evaluationMode: 'MANUAL' },
        ifMatchRevision(seeded.revision),
      );

      expect(response.status).toBe(201);
      expect(response.body.blocking).toBe(true);
      expect(response.body.evaluationMode).toBe('MANUAL');
    });

    it('validates a draft holding a blocking AI-assisted rule as clean', async () => {
      const seeded = await seedVersion();
      await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules`,
        blockingAiRule(),
        ifMatchRevision(seeded.revision),
      );

      const response = await owner().get(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/validation`,
      );

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.issues).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('version 1 — history keeps its own rules', () => {
    it('refuses a blocking AI-assisted rule with a field-level explanation', async () => {
      const seeded = await seedVersion();
      await demoteToV1(seeded.versionId);

      const response = await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules`,
        blockingAiRule(),
        ifMatchRevision(seeded.revision),
      );

      // 422 from the validator, not 500 from the database check constraint:
      // the author is told which field is wrong and why.
      expect(response.status).toBe(422);
      const issues = response.body.error.details.issues as Array<{ path: string; code: string }>;
      expect(issues.some((issue) => issue.path === 'blocking')).toBe(true);
    });

    it('still accepts a blocking deterministic rule', async () => {
      const seeded = await seedVersion();
      await demoteToV1(seeded.versionId);

      const response = await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules`,
        validRule(),
        ifMatchRevision(seeded.revision),
      );

      expect(response.status).toBe(201);
    });

    it('stamps a rule added to a v1 draft as v1, matching its parent', async () => {
      const seeded = await seedVersion();
      await demoteToV1(seeded.versionId);

      await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules`,
        validRule(),
        ifMatchRevision(seeded.revision),
      );

      expect(await ruleSchemaVersions(seeded.versionId)).toEqual([1]);
    });

    it('refuses to make an existing v1 rule blocking and AI-assisted', async () => {
      const seeded = await seedVersion();
      const rule = await addRule(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
        seeded.revision,
      );
      await demoteToV1(seeded.versionId);

      const response = await owner().patch(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules/${rule.id}`,
        // The whole rule, with only the mode changed: under v1 that alone makes
        // an already-blocking rule illegal, which is the invariant history keeps.
        validRule({ evaluationMode: 'AI_ASSISTED' }),
        ifMatchRevision(rule.revision),
      );

      expect(response.status).toBe(422);
    });

    it('validates a v1 draft under v1, leaving valid history valid', async () => {
      const seeded = await seedVersion();
      await addRule(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
        seeded.revision,
      );
      await demoteToV1(seeded.versionId);

      const response = await owner().get(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/validation`,
      );

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('cloning across schema versions', () => {
    async function seedV1Draft(): Promise<{
      standardId: string;
      versionId: string;
      ruleId: string;
    }> {
      const seeded = await seedVersion();
      const rule = await addRule(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
        seeded.revision,
      );
      await demoteToV1(seeded.versionId);
      return { standardId: seeded.standardId, versionId: seeded.versionId, ruleId: rule.id };
    }

    it('carries the source schema version across by default', async () => {
      const source = await seedV1Draft();

      const response = await owner().post(
        `${base()}/${source.standardId}/versions/${source.versionId}/clone`,
        { versionLabel: '1.1' },
      );

      expect(response.status).toBe(201);
      expect(await storedSchemaVersion(response.body.id)).toBe(1);
      expect(await ruleSchemaVersions(response.body.id)).toEqual([1]);
    });

    it('upgrades only when asked, and upgrades the rules with the draft', async () => {
      const source = await seedV1Draft();

      const response = await owner().post(
        `${base()}/${source.standardId}/versions/${source.versionId}/clone`,
        { versionLabel: '2.0', upgradeRuleSchema: true },
      );

      expect(response.status).toBe(201);
      expect(await storedSchemaVersion(response.body.id)).toBe(RULE_SCHEMA_VERSION);
      expect(await ruleSchemaVersions(response.body.id)).toEqual([RULE_SCHEMA_VERSION]);
    });

    it('never touches the source version, on either path', async () => {
      const source = await seedV1Draft();

      await owner().post(`${base()}/${source.standardId}/versions/${source.versionId}/clone`, {
        versionLabel: '2.0',
        upgradeRuleSchema: true,
      });

      expect(await storedSchemaVersion(source.versionId)).toBe(1);
      expect(await ruleSchemaVersions(source.versionId)).toEqual([1]);
    });

    it('lets an upgraded clone accept what the source could not', async () => {
      const source = await seedV1Draft();
      const clone = await owner().post(
        `${base()}/${source.standardId}/versions/${source.versionId}/clone`,
        { versionLabel: '2.0', upgradeRuleSchema: true },
      );

      const response = await owner().post(
        `${base()}/${source.standardId}/versions/${clone.body.id}/rules`,
        blockingAiRule(),
        ifMatchRevision(clone.body.revision),
      );

      expect(response.status).toBe(201);
    });

    it('records both schema versions in the audit trail', async () => {
      const source = await seedV1Draft();

      await owner().post(`${base()}/${source.standardId}/versions/${source.versionId}/clone`, {
        versionLabel: '2.0',
        upgradeRuleSchema: true,
      });

      const events = await context.adminDb.$queryRawUnsafe<
        Array<{ after_state: Record<string, unknown> }>
      >(`SELECT "after_state" FROM "audit_events" WHERE "action" = 'STANDARD_VERSION_CLONED'`);

      expect(events).toHaveLength(1);
      expect(events[0]!.after_state).toMatchObject({
        sourceRuleSchemaVersion: 1,
        ruleSchemaVersion: RULE_SCHEMA_VERSION,
        ruleSchemaUpgraded: true,
      });
    });

    it('records a plain clone as not upgraded', async () => {
      const source = await seedV1Draft();

      await owner().post(`${base()}/${source.standardId}/versions/${source.versionId}/clone`, {
        versionLabel: '1.1',
      });

      const events = await context.adminDb.$queryRawUnsafe<
        Array<{ after_state: Record<string, unknown> }>
      >(`SELECT "after_state" FROM "audit_events" WHERE "action" = 'STANDARD_VERSION_CLONED'`);

      expect(events[0]!.after_state).toMatchObject({ ruleSchemaUpgraded: false });
    });

    it('refuses a non-boolean upgrade flag rather than reading it as truthy', async () => {
      const source = await seedV1Draft();

      const response = await owner().post(
        `${base()}/${source.standardId}/versions/${source.versionId}/clone`,
        { versionLabel: '1.1', upgradeRuleSchema: 'yes' },
      );

      expect(response.status).toBe(400);
    });
  });
});
