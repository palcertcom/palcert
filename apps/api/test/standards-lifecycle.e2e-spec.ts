import { RULE_SCHEMA_VERSION } from '@palcert/contracts';
import { createTenant, type TenantFixture } from './support/organization-client';
import {
  addRule,
  createDocumentType,
  createStandard,
  createVersion,
  etagOf,
  ifMatchRevision,
  publishVersion,
  seedDraft,
  standardsBase,
  documentTypesBase,
  validRule,
} from './support/standards-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Document types, standards, versions and rules: the authoring lifecycle.
 *
 * Isolation and permissions have suites of their own; this one is about the
 * state machine, the validation and the publication contract.
 */
describe('Standards authoring (e2e)', () => {
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

  // -------------------------------------------------------------------------
  describe('document types', () => {
    it('creates a document type with a system category and an organization name', async () => {
      const response = await owner().post(documentTypesBase(tenant.organizationId), {
        systemCategory: 'THESIS',
        name: "Master's Thesis",
        nameAr: 'رسالة ماجستير',
      });

      expect(response.status).toBe(201);
      expect(response.body.systemCategory).toBe('THESIS');
      expect(response.body.name).toBe("Master's Thesis");
      expect(response.body.nameAr).toBe('رسالة ماجستير');
      expect(response.body.status).toBe('ACTIVE');
      expect(response.body.standardCount).toBe(0);
    });

    it('refuses a duplicate name regardless of case', async () => {
      await createDocumentType(owner(), tenant.organizationId, { name: "Master's Thesis" });

      const response = await owner().post(documentTypesBase(tenant.organizationId), {
        systemCategory: 'THESIS',
        name: "MASTER'S THESIS",
      });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('DOCUMENT_TYPE_NAME_TAKEN');
    });

    it('lets two organizations use the same document type name', async () => {
      const other = await createTenant(context, 'Birzeit University', 'owner@birzeit.test');

      await createDocumentType(owner(), tenant.organizationId, { name: "Master's Thesis" });
      const response = await other.owner.client.post(documentTypesBase(other.organizationId), {
        systemCategory: 'THESIS',
        name: "Master's Thesis",
      });

      // Uniqueness is per tenant. A global namespace would leak the existence
      // of other organizations' vocabulary.
      expect(response.status).toBe(201);
    });

    it('refuses to archive a document type that active standards still use', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      await createStandard(owner(), tenant.organizationId, documentType.id);

      const response = await owner().post(
        `${documentTypesBase(tenant.organizationId)}/${documentType.id}/archive`,
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('DOCUMENT_TYPE_IN_USE');
      expect(response.body.error.details.activeStandards).toBe(1);
    });

    it('archives and restores a document type nothing uses', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);

      const archived = await owner().post(
        `${documentTypesBase(tenant.organizationId)}/${documentType.id}/archive`,
      );
      expect(archived.status).toBe(201);
      expect(archived.body.status).toBe('ARCHIVED');

      const restored = await owner().post(
        `${documentTypesBase(tenant.organizationId)}/${documentType.id}/restore`,
      );
      expect(restored.body.status).toBe('ACTIVE');
    });

    it('refuses a new standard on an archived document type', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      await owner().post(`${documentTypesBase(tenant.organizationId)}/${documentType.id}/archive`);

      const response = await owner().post(base(), {
        documentTypeId: documentType.id,
        code: 'X.Y',
        nameEn: 'Some Standard',
        nameAr: 'معيار ما',
      });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('DOCUMENT_TYPE_ARCHIVED');
    });

    it('returns 404 for a document type that does not exist', async () => {
      const response = await owner().get(
        `${documentTypesBase(tenant.organizationId)}/00000000-0000-4000-8000-000000000000`,
      );
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('DOCUMENT_TYPE_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  describe('standards', () => {
    it('creates a standard against a document type', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const response = await owner().post(base(), {
        documentTypeId: documentType.id,
        code: 'IUG.THESIS.FORMAT',
        nameEn: 'IUG Thesis Formatting',
        nameAr: 'تنسيق رسائل الجامعة الإسلامية',
      });

      expect(response.status).toBe(201);
      expect(response.body.code).toBe('IUG.THESIS.FORMAT');
      expect(response.body.status).toBe('ACTIVE');
      expect(response.body.versionCount).toBe(0);
      expect(response.body.publishedVersionId).toBeNull();
    });

    it('uppercases and validates the code shape', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const response = await owner().post(base(), {
        documentTypeId: documentType.id,
        code: 'has spaces',
        // Valid everywhere else, so the only thing that can fail is the code.
        nameEn: 'Some Standard',
        nameAr: 'معيار ما',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a duplicate code within the organization', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      await createStandard(owner(), tenant.organizationId, documentType.id, { code: 'A.B' });

      const response = await owner().post(base(), {
        documentTypeId: documentType.id,
        code: 'A.B',
        nameEn: 'Other Standard',
        nameAr: 'معيار آخر',
      });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('STANDARD_CODE_TAKEN');
    });

    it('refuses a document type belonging to another organization', async () => {
      const other = await createTenant(context, 'Birzeit', 'owner2@birzeit.test');
      const foreignType = await createDocumentType(other.owner.client, other.organizationId);

      const response = await owner().post(base(), {
        documentTypeId: foreignType.id,
        code: 'X.Y',
        nameEn: 'Some Standard',
        nameAr: 'معيار ما',
      });

      // Indistinguishable from "does not exist", so the response cannot be used
      // to discover that another tenant holds that id.
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('DOCUMENT_TYPE_NOT_FOUND');
    });

    it('does not let the code be changed after creation', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id);

      const response = await owner().patch(`${base()}/${standard.id}`, { code: 'NEW.CODE' });

      // `forbidNonWhitelisted` refuses the unknown property outright, which is
      // the behaviour we want: silently ignoring it would leave the caller
      // believing the rename happened.
      expect(response.status).toBe(400);
    });

    it('archives a standard and refuses to edit it while archived', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id);

      await owner().post(`${base()}/${standard.id}/archive`);
      const response = await owner().patch(`${base()}/${standard.id}`, { nameEn: 'renamed' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('STANDARD_ARCHIVED');
    });

    it('reports the published version in the standard summary', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      await publishVersion(owner(), tenant.organizationId, seeded.standardId, seeded.versionId);

      const response = await owner().get(`${base()}/${seeded.standardId}`);
      expect(response.body.publishedVersionId).toBe(seeded.versionId);
      expect(response.body.publishedVersionLabel).toBe('1.0');
    });
  });

  // -------------------------------------------------------------------------
  describe('versions', () => {
    it('creates a draft and returns its revision as an ETag', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id);

      const response = await owner().post(`${base()}/${standard.id}/versions`, {
        versionLabel: '1.0',
      });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('DRAFT');
      expect(response.body.contentHash).toBeNull();
      expect(etagOf(response)).toBe(`"${String(response.body.revision)}"`);
    });

    it('refuses a duplicate version label within one standard', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id);
      await createVersion(owner(), tenant.organizationId, standard.id, '1.0');

      const response = await owner().post(`${base()}/${standard.id}/versions`, {
        versionLabel: '1.0',
      });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('STANDARD_VERSION_LABEL_TAKEN');
    });

    it('allows the same label on two different standards', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const first = await createStandard(owner(), tenant.organizationId, documentType.id, {
        code: 'A.ONE',
      });
      const second = await createStandard(owner(), tenant.organizationId, documentType.id, {
        code: 'A.TWO',
      });

      await createVersion(owner(), tenant.organizationId, first.id, '1.0');
      const response = await owner().post(`${base()}/${second.id}/versions`, {
        versionLabel: '1.0',
      });

      // The label is unique per standard, not globally: it is a label, not an
      // identity.
      expect(response.status).toBe(201);
    });

    it('refuses an effective window that runs backwards', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id);

      const response = await owner().post(`${base()}/${standard.id}/versions`, {
        versionLabel: '1.0',
        effectiveFrom: '2027-01-01T00:00:00.000Z',
        effectiveUntil: '2026-01-01T00:00:00.000Z',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('archives an abandoned draft that was never published', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id);
      const version = await createVersion(owner(), tenant.organizationId, standard.id);

      const response = await owner().post(
        `${base()}/${standard.id}/versions/${version.id}/archive`,
      );

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('ARCHIVED');
      // Never published, so it never had a hash — and archiving must not invent
      // one to satisfy a constraint.
      expect(response.body.contentHash).toBeNull();
    });

    it('refuses to publish an archived version', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      await owner().post(`${base()}/${seeded.standardId}/versions/${seeded.versionId}/archive`);

      const response = await publishVersion(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('STANDARD_VERSION_ARCHIVED');
    });

    it('returns 404 for a version that belongs to a different standard', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const first = await createStandard(owner(), tenant.organizationId, documentType.id, {
        code: 'A.ONE',
      });
      const second = await createStandard(owner(), tenant.organizationId, documentType.id, {
        code: 'A.TWO',
      });
      const version = await createVersion(owner(), tenant.organizationId, first.id);

      const response = await owner().get(`${base()}/${second.id}/versions/${version.id}`);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('STANDARD_VERSION_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  describe('rules', () => {
    it('adds a rule to a draft and bumps the version revision', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id);
      const version = await createVersion(owner(), tenant.organizationId, standard.id);

      const response = await owner().post(
        `${base()}/${standard.id}/versions/${version.id}/rules`,
        validRule(),
        ifMatchRevision(version.revision),
      );

      expect(response.status).toBe(201);
      expect(response.body.ruleCode).toBe('MARGIN.TOP.MIN');
      expect(response.body.ruleSchemaVersion).toBe(RULE_SCHEMA_VERSION);
      // The rule's parent moved, so the caller's old revision is now stale.
      expect(etagOf(response)).toBe(`"${String(version.revision + 1)}"`);
    });

    it('appends new rules to the end of the report order', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      const second = await addRule(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
        seeded.revision,
        validRule({ ruleCode: 'ABSTRACT.WORDS.MAX' }),
      );

      expect(second.body.displayOrder).toBe(1);
    });

    it('refuses a duplicate rule code within one version', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);

      const response = await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules`,
        validRule(),
        ifMatchRevision(seeded.revision),
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('RULE_CODE_TAKEN');
    });

    it('rejects an operator and value type that do not go together', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id);
      const version = await createVersion(owner(), tenant.organizationId, standard.id);

      const response = await owner().post(
        `${base()}/${standard.id}/versions/${version.id}/rules`,
        validRule({
          operator: 'GREATER_THAN',
          expected: { type: 'STRING', text: 'wide' },
          unit: null,
          tolerance: null,
        }),
        ifMatchRevision(version.revision),
      );

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('RULE_SCHEMA_INVALID');
      const issues = response.body.error.details.issues as Array<{ path: string; code: string }>;
      expect(issues.some((issue) => issue.code === 'OPERATOR_INCOMPATIBLE')).toBe(true);
    });

    it('names the offending field in every issue, so the builder can mark it', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id);
      const version = await createVersion(owner(), tenant.organizationId, standard.id);

      const response = await owner().post(
        `${base()}/${standard.id}/versions/${version.id}/rules`,
        validRule({
          operator: 'BETWEEN',
          expected: { type: 'NUMBER_RANGE', min: 30, max: 10 },
        }),
        ifMatchRevision(version.revision),
      );

      const issues = response.body.error.details.issues as Array<{ path: string }>;
      expect(issues.map((issue) => issue.path)).toContain('expected.min');
    });

    it('lets an AI-assisted rule block certification under the current schema', async () => {
      // Rule schema v2 (Phase 4): a journal may make an ethics declaration a
      // blocking requirement even though a model or a person must judge it.
      // The rule resolves to INDETERMINATE + requiresReview at evaluation, so
      // certification waits on a reviewer rather than on the model. The v1
      // refusal is still enforced for v1 drafts — see
      // standards-rule-schema.e2e-spec.ts.
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id);
      const version = await createVersion(owner(), tenant.organizationId, standard.id);

      const response = await owner().post(
        `${base()}/${standard.id}/versions/${version.id}/rules`,
        validRule({ evaluationMode: 'AI_ASSISTED', blocking: true }),
        ifMatchRevision(version.revision),
      );

      expect(response.status).toBe(201);
      expect(response.body.blocking).toBe(true);
      expect(response.body.evaluationMode).toBe('AI_ASSISTED');
    });

    it('refuses markup in rule text', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id);
      const version = await createVersion(owner(), tenant.organizationId, standard.id);

      const response = await owner().post(
        `${base()}/${standard.id}/versions/${version.id}/rules`,
        validRule({ titleEn: '<script>alert(1)</script>' }),
        ifMatchRevision(version.revision),
      );

      expect(response.status).toBe(422);
      const issues = response.body.error.details.issues as Array<{ code: string }>;
      expect(issues.some((issue) => issue.code === 'MARKUP_NOT_ALLOWED')).toBe(true);
    });

    it('validates a partial update against the merged rule, not the patch alone', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);

      // The stored rule is numeric with a unit. Swapping only the expected
      // value to a string leaves a combination that is invalid as a whole, even
      // though every field in the patch is individually fine.
      const response = await owner().patch(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules/${seeded.ruleId}`,
        validRule({ expected: { type: 'STRING', text: 'wide' } }),
        ifMatchRevision(seeded.revision),
      );

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('RULE_SCHEMA_INVALID');
    });

    it('reorders rules and refuses a partial list', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      const second = await addRule(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
        seeded.revision,
        validRule({ ruleCode: 'ABSTRACT.WORDS.MAX' }),
      );

      const partial = await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules/reorder`,
        { ruleIds: [second.id] },
        ifMatchRevision(second.revision),
      );
      expect(partial.status).toBe(400);

      const complete = await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules/reorder`,
        { ruleIds: [second.id, seeded.ruleId] },
        ifMatchRevision(second.revision),
      );
      expect(complete.status).toBe(204);

      const rules = await owner().get(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules`,
      );
      expect(rules.body.items.map((item: { ruleCode: string }) => item.ruleCode)).toEqual([
        'ABSTRACT.WORDS.MAX',
        'MARGIN.TOP.MIN',
      ]);
    });

    it('deletes a rule from a draft', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);

      const response = await owner().delete(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules/${seeded.ruleId}`,
        undefined,
        ifMatchRevision(seeded.revision),
      );
      expect(response.status).toBe(204);

      const rules = await owner().get(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules`,
      );
      expect(rules.body.items).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('optimistic concurrency', () => {
    it('refuses a draft mutation with no If-Match at all', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);

      const response = await owner().patch(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}`,
        { versionLabel: '1.1' },
      );

      // Not treated as "go ahead": that would make the protection opt-in and
      // silently give last-write-wins to every client that forgot the header.
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a stale If-Match and reports the current revision', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);

      const response = await owner().patch(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}`,
        { versionLabel: '1.1' },
        ifMatchRevision(seeded.revision - 1),
      );

      expect(response.status).toBe(412);
      expect(response.body.error.code).toBe('STANDARD_VERSION_CONFLICT');
      expect(response.body.error.details.currentRevision).toBe(seeded.revision);
    });

    it('rejects a malformed If-Match rather than ignoring it', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);

      const response = await owner().patch(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}`,
        { versionLabel: '1.1' },
        { headers: { 'If-Match': '*' } },
      );

      expect(response.status).toBe(400);
    });

    it('treats a rule edit as a conflict with a concurrent version edit', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);

      // Two authors read the same revision. The first edits the version...
      const first = await owner().patch(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}`,
        { versionLabel: '1.1' },
        ifMatchRevision(seeded.revision),
      );
      expect(first.status).toBe(200);

      // ...and the second, holding the same stale revision, edits a rule.
      const second = await owner().patch(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules/${seeded.ruleId}`,
        validRule({ severity: 'CRITICAL' }),
        ifMatchRevision(seeded.revision),
      );

      // The version is the aggregate: editing different parts of the same draft
      // is still a conflict, because publication takes the whole set.
      expect(second.status).toBe(412);
    });
  });
});
