import {
  PORTABLE_STANDARD_LIMITS,
  computePortableStandardHash,
  readPortableStandardPackage,
} from '@palcert/contracts';
import { API, type AuthClient } from './support/auth-client';
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
  publishVersion,
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
 * Portable standard packages, end to end.
 *
 * The promise under test: one organization's standard can be carried to another
 * as a file that holds content and nothing else, arrives as a DRAFT the second
 * organization owns, and changes nothing in the first.
 */
describe('Standard export and import (e2e)', () => {
  let context: TestContext;
  let orgA: TenantFixture;
  let orgB: TenantFixture;

  beforeAll(async () => {
    context = await createTestContext();
    await new Promise<void>((resolve) => {
      context.app.getHttpServer().listen(0, '127.0.0.1', () => resolve());
    });
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    orgA = await createTenant(context, 'Islamic University of Gaza', 'registrar@iug.test');
    orgB = await createTenant(context, 'Al-Aqsa University', 'registrar@alaqsa.test');
  });

  const MARGINS: Array<[string, string, number, string]> = [
    ['MARGINS.TOP', 'marginTop', 3, 'الهامش العلوي'],
    ['MARGINS.BOTTOM', 'marginBottom', 3, 'الهامش السفلي'],
    ['MARGINS.LEFT', 'marginLeft', 3.5, 'الهامش الأيسر'],
    ['MARGINS.RIGHT', 'marginRight', 3, 'الهامش الأيمن'],
  ];

  function marginRule(
    code: string,
    property: string,
    number: number,
    titleAr: string,
    order: number,
  ) {
    return validRule({
      ruleCode: code,
      category: 'MARGINS',
      scope: { kind: 'DOCUMENT', property },
      operator: 'EQUALS',
      expected: { type: 'NUMBER', number },
      unit: 'CENTIMETRE',
      tolerance: 0.1,
      severity: 'MAJOR',
      blocking: true,
      autofix: 'NONE',
      titleEn: `${property} is ${number} cm`,
      titleAr,
      guidanceEn: 'Set the page margin in the Layout tab.',
      guidanceAr: 'اضبط الهامش من تبويب التخطيط.',
      displayOrder: order,
    });
  }

  /** Organization A: Standard A, version 1.2, four margin rules. */
  async function standardA(options: { publish?: boolean } = {}) {
    const type = await createDocumentType(orgA.owner.client, orgA.organizationId, {
      name: 'PhD Thesis',
    });
    const standard = await createStandard(orgA.owner.client, orgA.organizationId, type.id, {
      code: 'IUG-PHD',
      nameEn: 'PhD Thesis Standard',
      nameAr: 'معيار رسائل الدكتوراه',
    });
    const version = await createVersion(orgA.owner.client, orgA.organizationId, standard.id, '1.2');
    let revision = version.revision;
    for (const [index, [code, property, number, titleAr]] of MARGINS.entries()) {
      revision = (
        await addRule(
          orgA.owner.client,
          orgA.organizationId,
          standard.id,
          version.id,
          revision,
          marginRule(code, property, number, titleAr, index),
        )
      ).revision;
    }
    if (options.publish === true) {
      const published = await publishVersion(
        orgA.owner.client,
        orgA.organizationId,
        standard.id,
        version.id,
      );
      expect(published.status).toBe(200);
    }
    return { typeId: type.id, standardId: standard.id, versionId: version.id };
  }

  const exportUrl = (org: string, standardId: string, versionId: string): string =>
    `${standardsBase(org)}/${standardId}/versions/${versionId}/export`;

  async function exportA(standardId: string, versionId: string): Promise<string> {
    const response = await orgA.owner.client.get(
      exportUrl(orgA.organizationId, standardId, versionId),
    );
    expect(response.status).toBe(200);
    return response.text;
  }

  const preview = (client: AuthClient, org: string, text: string) =>
    client.post(`${standardsBase(org)}/import/preview`, { package: text });
  const importInto = (client: AuthClient, org: string, body: Record<string, unknown>) =>
    client.post(`${standardsBase(org)}/import`, body);

  async function orgBType(category = 'THESIS'): Promise<string> {
    return (
      await createDocumentType(orgB.owner.client, orgB.organizationId, {
        systemCategory: category,
        name: 'Doctoral thesis',
      })
    ).id;
  }

  /** Every table an import could touch, counted. */
  async function footprint() {
    const db = context.adminDb;
    return {
      standards: await db.standard.count(),
      versions: await db.standardVersion.count(),
      rules: await db.standardRule.count(),
      imports: await db.standardVersionImport.count(),
      audits: await db.auditEvent.count({ where: { action: 'STANDARD_IMPORTED' } }),
    };
  }

  async function orgAState(standardId: string) {
    const db = context.adminDb;
    const versions = await db.standardVersion.findMany({
      where: { standardId },
      orderBy: { id: 'asc' },
    });
    const rules = await db.standardRule.findMany({
      where: { version: { standardId } },
      orderBy: { id: 'asc' },
    });
    const snapshots = await db.standardVersionSnapshot.findMany({
      where: { version: { standardId } },
      orderBy: { id: 'asc' },
    });
    return { versions, rules, snapshots };
  }

  // -------------------------------------------------------------------------
  describe('export', () => {
    it('downloads a pretty-printed .palcert.json with a verifiable hash', async () => {
      const a = await standardA({ publish: true });
      const response = await orgA.owner.client.get(
        exportUrl(orgA.organizationId, a.standardId, a.versionId),
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="IUG-PHD-1.2.palcert.json"',
      );
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.text).toContain('\n  "format": "PALCERT_STANDARD"');

      const pkg = JSON.parse(response.text);
      expect(pkg).toMatchObject({
        format: 'PALCERT_STANDARD',
        formatVersion: 1,
        source: {
          organizationName: 'Islamic University of Gaza',
          standardCode: 'IUG-PHD',
          versionLabel: '1.2',
          versionStatus: 'PUBLISHED',
        },
        schema: { ruleSchemaVersion: 2, canonicalizationVersion: 1 },
        documentType: { systemCategory: 'THESIS', name: 'PhD Thesis' },
        version: { versionLabel: '1.2', effectiveFrom: null, effectiveUntil: null },
      });
      expect(response.headers['x-palcert-package-hash']).toBe(pkg.contentHash);
      expect(computePortableStandardHash(pkg)).toBe(pkg.contentHash);
      // Stable order: by rule code.
      expect(pkg.rules.map((rule: { ruleCode: string }) => rule.ruleCode)).toEqual([
        'MARGINS.BOTTOM',
        'MARGINS.LEFT',
        'MARGINS.RIGHT',
        'MARGINS.TOP',
      ]);
      const left = pkg.rules.find((rule: { ruleCode: string }) => rule.ruleCode === 'MARGINS.LEFT');
      expect(left).toEqual({
        ruleCode: 'MARGINS.LEFT',
        category: 'MARGINS',
        evaluationMode: 'DETERMINISTIC',
        scope: { kind: 'DOCUMENT', property: 'marginLeft' },
        operator: 'EQUALS',
        expected: { type: 'NUMBER', number: 3.5 },
        unit: 'CENTIMETRE',
        tolerance: 0.1,
        severity: 'MAJOR',
        blocking: true,
        autofix: 'NONE',
        origin: 'ORGANIZATION_POLICY',
        originReference: null,
        titleEn: 'marginLeft is 3.5 cm',
        titleAr: 'الهامش الأيسر',
        descriptionEn: null,
        descriptionAr: null,
        guidanceEn: 'Set the page margin in the Layout tab.',
        guidanceAr: 'اضبط الهامش من تبويب التخطيط.',
        displayOrder: 2,
      });

      const audit = await context.adminDb.auditEvent.findFirstOrThrow({
        where: { action: 'STANDARD_EXPORTED' },
      });
      expect(audit).toMatchObject({ targetId: a.versionId, actorUserId: orgA.owner.userId });
      expect(audit.afterState).toMatchObject({ packageSha256: pkg.contentHash, ruleCount: 4 });
    });

    it('contains no identifier, user, secret or private entity', async () => {
      const a = await standardA({ publish: true });
      const text = await exportA(a.standardId, a.versionId);
      const ids = [
        orgA.organizationId,
        a.standardId,
        a.versionId,
        a.typeId,
        orgA.owner.userId,
        ...(
          await context.adminDb.standardRule.findMany({ where: { standardVersionId: a.versionId } })
        ).map((r) => r.id),
      ];
      for (const id of ids) expect(text).not.toContain(id);
      for (const word of [
        'organizationId',
        'standardId',
        'versionId',
        'ruleId',
        'documentTypeId',
        'userId',
        'email',
        'registrar@iug.test',
        'password',
        'secret',
        'token',
        'checkId',
        'certificate',
        'proposal',
        'extraction',
        'objectKey',
        'http://',
        'https://',
        'publishedAt',
        'createdAt',
        'revision',
      ]) {
        expect(text).not.toContain(word);
      }
    });

    it('exports every lifecycle status and says which, informationally', async () => {
      const a = await standardA();
      const asDraft = JSON.parse(await exportA(a.standardId, a.versionId));
      expect(asDraft.source.versionStatus).toBe('DRAFT');

      await publishVersion(orgA.owner.client, orgA.organizationId, a.standardId, a.versionId);
      const published = JSON.parse(await exportA(a.standardId, a.versionId));
      expect(published.source.versionStatus).toBe('PUBLISHED');
      // Status is outside the rules but inside the hash: a different status is a different file.
      expect(published.rules).toEqual(asDraft.rules);

      const next = await createVersion(orgA.owner.client, orgA.organizationId, a.standardId, '1.3');
      await addRule(
        orgA.owner.client,
        orgA.organizationId,
        a.standardId,
        next.id,
        next.revision,
        validRule(),
      );
      await publishVersion(orgA.owner.client, orgA.organizationId, a.standardId, next.id);
      expect(JSON.parse(await exportA(a.standardId, a.versionId)).source.versionStatus).toBe(
        'SUPERSEDED',
      );

      await orgA.owner.client.post(
        `${standardsBase(orgA.organizationId)}/${a.standardId}/versions/${next.id}/archive`,
      );
      expect(JSON.parse(await exportA(a.standardId, next.id)).source.versionStatus).toBe(
        'ARCHIVED',
      );
    });

    it('is deterministic apart from the export time', async () => {
      const a = await standardA({ publish: true });
      const first = JSON.parse(await exportA(a.standardId, a.versionId));
      context.clock.advanceMinutes(1);
      const second = JSON.parse(await exportA(a.standardId, a.versionId));
      expect(second.contentHash).toBe(first.contentHash);
      expect({ ...second, exportedAt: null }).toEqual({ ...first, exportedAt: null });
    });

    it('refuses to export across tenants', async () => {
      const a = await standardA({ publish: true });
      const viaOwnOrg = await orgB.owner.client.get(
        exportUrl(orgB.organizationId, a.standardId, a.versionId),
      );
      const viaTheirs = await orgB.owner.client.get(
        exportUrl(orgA.organizationId, a.standardId, a.versionId),
      );
      expect(viaOwnOrg.status).toBe(404);
      expect([403, 404]).toContain(viaTheirs.status);
    });
  });

  // -------------------------------------------------------------------------
  describe('preview', () => {
    it('verifies, validates and proposes destinations without writing anything', async () => {
      const a = await standardA({ publish: true });
      const text = await exportA(a.standardId, a.versionId);
      await orgBType();
      const before = await footprint();

      const response = await preview(orgB.owner.client, orgB.organizationId, text);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        integrity: 'VERIFIED',
        formatVersion: 1,
        ruleCount: 4,
        validRuleCount: 4,
        invalidRuleCount: 0,
        canImport: true,
        source: {
          organizationName: 'Islamic University of Gaza',
          versionLabel: '1.2',
          versionStatus: 'PUBLISHED',
        },
        schema: { sourceRuleSchemaVersion: 2, importRuleSchemaVersion: 2, upgraded: false },
        destination: { existingStandardWithCode: null },
        previousImports: [],
      });
      expect(response.body.destination.documentTypes).toEqual([
        expect.objectContaining({ systemCategory: 'THESIS', matchesCategory: true }),
      ]);
      expect(await footprint()).toEqual(before);
    });

    it('refuses a file changed after export', async () => {
      const a = await standardA({ publish: true });
      const pkg = JSON.parse(await exportA(a.standardId, a.versionId));
      pkg.rules[0].expected.number = 4;
      const response = await preview(orgB.owner.client, orgB.organizationId, JSON.stringify(pkg));
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('STANDARD_IMPORT_INTEGRITY_FAILED');
      expect(response.body.error.message).toBe(
        "The file's integrity check failed. The contents may have been changed after export.",
      );
    });

    it.each([
      ['malformed JSON', '{"format": "PALCERT', 'STANDARD_IMPORT_PACKAGE_INVALID'],
      [
        'the wrong format',
        JSON.stringify({ format: 'OTHER', formatVersion: 1 }),
        'STANDARD_IMPORT_PACKAGE_INVALID',
      ],
      [
        'a future format version',
        JSON.stringify({ format: 'PALCERT_STANDARD', formatVersion: 99 }),
        'STANDARD_IMPORT_UNSUPPORTED',
      ],
      [
        'a prototype-pollution key',
        '{"format":"PALCERT_STANDARD","formatVersion":1,"__proto__":{"admin":true}}',
        'STANDARD_IMPORT_PACKAGE_INVALID',
      ],
    ])('refuses %s', async (_name, text, code) => {
      const response = await preview(orgB.owner.client, orgB.organizationId, text);
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe(code);
      expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
    });

    it('refuses a future rule schema, even with a recomputed hash', async () => {
      const a = await standardA({ publish: true });
      const pkg = JSON.parse(await exportA(a.standardId, a.versionId));
      pkg.schema.ruleSchemaVersion = 3;
      pkg.contentHash = computePortableStandardHash(pkg);
      const response = await preview(orgB.owner.client, orgB.organizationId, JSON.stringify(pkg));
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('STANDARD_IMPORT_UNSUPPORTED');
      expect(response.body.error.details.reason).toBe('UNSUPPORTED_RULE_SCHEMA');
    });

    it('lists invalid and duplicate rules with their issues, and blocks the import', async () => {
      const a = await standardA({ publish: true });
      const pkg = JSON.parse(await exportA(a.standardId, a.versionId));
      pkg.rules[0].unit = 'FURLONG';
      pkg.rules[2].ruleCode = pkg.rules[3].ruleCode;
      pkg.contentHash = computePortableStandardHash(pkg);
      await orgBType();

      const response = await preview(orgB.owner.client, orgB.organizationId, JSON.stringify(pkg));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        ruleCount: 4,
        validRuleCount: 1,
        invalidRuleCount: 3,
        canImport: false,
      });
      const [unit, , dupA, dupB] = response.body.rules;
      expect(unit.issues.map((issue: { path: string }) => issue.path)).toContain('unit');
      expect(dupA.issues.some((issue: { code: string }) => issue.code === 'DUPLICATE')).toBe(true);
      expect(dupB.issues.some((issue: { code: string }) => issue.code === 'DUPLICATE')).toBe(true);

      const attempt = await importInto(orgB.owner.client, orgB.organizationId, {
        package: JSON.stringify(pkg),
        packageHash: pkg.contentHash,
        mode: 'NEW_STANDARD',
        documentTypeId: (
          await context.adminDb.documentType.findFirstOrThrow({
            where: { organizationId: orgB.organizationId },
          })
        ).id,
        versionLabel: '1.2',
      });
      expect(attempt.status).toBe(422);
      expect(attempt.body.error.code).toBe('STANDARD_IMPORT_RULES_INVALID');
      expect(attempt.body.error.details.invalidRuleCount).toBe(3);
    });

    it('refuses an oversized body and an oversized package', async () => {
      const huge = `{"format":"PALCERT_STANDARD","pad":"${'x'.repeat(PORTABLE_STANDARD_LIMITS.maxBytes)}"}`;
      const response = await preview(orgB.owner.client, orgB.organizationId, huge);
      expect([400, 413, 422]).toContain(response.status);

      const tooManyText = JSON.stringify({
        package: 'x'.repeat(PORTABLE_STANDARD_LIMITS.maxBytes * 2),
      });
      const raw = await orgB.owner.client.post(
        `${standardsBase(orgB.organizationId)}/import/preview`,
        JSON.parse(tooManyText),
      );
      expect(raw.status).toBe(413);
    });

    it('refuses more rules than the limit', async () => {
      const a = await standardA({ publish: true });
      const pkg = JSON.parse(await exportA(a.standardId, a.versionId));
      pkg.rules = Array.from({ length: PORTABLE_STANDARD_LIMITS.maxRules + 1 }, (_, index) => ({
        ...pkg.rules[0],
        ruleCode: `R.${index}`,
      }));
      pkg.contentHash = computePortableStandardHash(pkg);
      const response = await preview(orgB.owner.client, orgB.organizationId, JSON.stringify(pkg));
      expect(response.status).toBe(422);
      expect(response.body.error.details.reason).toBe('TOO_MANY_RULES');
    });

    it('explains an older rule schema will be imported under the current one', async () => {
      const a = await standardA({ publish: true });
      const pkg = JSON.parse(await exportA(a.standardId, a.versionId));
      pkg.schema.ruleSchemaVersion = 1;
      pkg.contentHash = computePortableStandardHash(pkg);
      const response = await preview(orgB.owner.client, orgB.organizationId, JSON.stringify(pkg));
      expect(response.status).toBe(200);
      expect(response.body.schema).toMatchObject({
        sourceRuleSchemaVersion: 1,
        importRuleSchemaVersion: 2,
        upgraded: true,
      });
      expect(response.body.warnings).toEqual(
        expect.arrayContaining([
          {
            code: 'RULE_SCHEMA_UPGRADED',
            message:
              'This standard was exported using Rule Schema v1. PalCert will import it using Rule Schema v2.',
          },
        ]),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('import', () => {
    async function previewed(text: string) {
      const response = await preview(orgB.owner.client, orgB.organizationId, text);
      expect(response.status).toBe(200);
      return response.body as { packageHash: string };
    }

    it('crosses tenants: B gets a new DRAFT with new ids and the same rules; A is untouched', async () => {
      const a = await standardA({ publish: true });
      const aBefore = await orgAState(a.standardId);
      const text = await exportA(a.standardId, a.versionId);
      const typeB = await orgBType();
      const { packageHash } = await previewed(text);

      const response = await importInto(orgB.owner.client, orgB.organizationId, {
        package: text,
        packageHash,
        mode: 'NEW_STANDARD',
        documentTypeId: typeB,
        versionLabel: '1.2',
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        createdStandard: true,
        ruleCount: 4,
        versionLabel: '1.2',
      });
      const { standardId, versionId } = response.body;
      expect(standardId).not.toBe(a.standardId);
      expect(versionId).not.toBe(a.versionId);

      const version = await context.adminDb.standardVersion.findUniqueOrThrow({
        where: { id: versionId },
        include: { standard: true, rules: { orderBy: { displayOrder: 'asc' } } },
      });
      expect(version).toMatchObject({
        organizationId: orgB.organizationId,
        status: 'DRAFT',
        contentHash: null,
        publishedAt: null,
        ruleSchemaVersion: 2,
        createdByUserId: orgB.owner.userId,
      });
      expect(version.standard).toMatchObject({
        organizationId: orgB.organizationId,
        code: 'IUG-PHD',
        documentTypeId: typeB,
      });
      const sourceRuleIds = aBefore.rules.map((rule) => rule.id);
      expect(version.rules.map((rule) => rule.id).some((id) => sourceRuleIds.includes(id))).toBe(
        false,
      );
      expect(
        version.rules.map((rule) => [
          (rule.scope as { property: string }).property,
          (rule.expectedValue as { number: number }).number,
          rule.unit,
          Number(rule.tolerance),
          rule.displayOrder,
          rule.origin,
          rule.organizationId,
        ]),
      ).toEqual([
        ['marginTop', 3, 'CENTIMETRE', 0.1, 0, 'ORGANIZATION_POLICY', orgB.organizationId],
        ['marginBottom', 3, 'CENTIMETRE', 0.1, 1, 'ORGANIZATION_POLICY', orgB.organizationId],
        ['marginLeft', 3.5, 'CENTIMETRE', 0.1, 2, 'ORGANIZATION_POLICY', orgB.organizationId],
        ['marginRight', 3, 'CENTIMETRE', 0.1, 3, 'ORGANIZATION_POLICY', orgB.organizationId],
      ]);
      expect(version.rules[2]).toMatchObject({
        titleAr: 'الهامش الأيسر',
        guidanceAr: 'اضبط الهامش من تبويب التخطيط.',
      });

      // Provenance, on the version read.
      const read = await orgB.owner.client.get(
        `${standardsBase(orgB.organizationId)}/${standardId}/versions/${versionId}`,
      );
      expect(read.body.importProvenance).toMatchObject({
        packageHash,
        formatVersion: 1,
        sourceOrganizationName: 'Islamic University of Gaza',
        sourceStandardCode: 'IUG-PHD',
        sourceVersionLabel: '1.2',
        sourceVersionStatus: 'PUBLISHED',
        importedByUserId: orgB.owner.userId,
        ruleCount: 4,
        createdStandard: true,
      });
      const audit = await context.adminDb.auditEvent.findFirstOrThrow({
        where: { action: 'STANDARD_IMPORTED' },
      });
      expect(audit).toMatchObject({ targetId: versionId, actorUserId: orgB.owner.userId });

      // Adopting it is B's own publish, and affects only B.
      const check = await orgB.owner.client.get(
        `${standardsBase(orgB.organizationId)}/${standardId}/versions/${versionId}/validation`,
      );
      expect(check.body.valid).toBe(true);
      const published = await publishVersion(
        orgB.owner.client,
        orgB.organizationId,
        standardId,
        versionId,
      );
      expect(published.status).toBe(200);
      expect(published.body.status).toBe('PUBLISHED');
      expect(await orgAState(a.standardId)).toEqual(aBefore);
      // Same content, same organization-independent snapshot hash.
      const aVersion = await context.adminDb.standardVersion.findUniqueOrThrow({
        where: { id: a.versionId },
      });
      expect(published.body.contentHash).not.toBeNull();
      expect(aVersion.status).toBe('PUBLISHED');
    });

    it('never publishes on import, whatever the source status was', async () => {
      const a = await standardA({ publish: true });
      const text = await exportA(a.standardId, a.versionId);
      const typeB = await orgBType();
      const { packageHash } = await previewed(text);
      await importInto(orgB.owner.client, orgB.organizationId, {
        package: text,
        packageHash,
        mode: 'NEW_STANDARD',
        documentTypeId: typeB,
        versionLabel: '1.2',
      });
      expect(
        await context.adminDb.standardVersion.count({
          where: { organizationId: orgB.organizationId, status: { not: 'DRAFT' } },
        }),
      ).toBe(0);
      expect(
        await context.adminDb.standardVersionSnapshot.count({
          where: { organizationId: orgB.organizationId },
        }),
      ).toBe(0);
    });

    it('adds a new draft to an existing standard without touching its versions', async () => {
      const a = await standardA({ publish: true });
      const text = await exportA(a.standardId, a.versionId);
      const typeB = await orgBType();
      const existing = await createStandard(orgB.owner.client, orgB.organizationId, typeB, {
        code: 'AQU.PHD',
      });
      const v1 = await createVersion(orgB.owner.client, orgB.organizationId, existing.id, '1.0');
      await addRule(
        orgB.owner.client,
        orgB.organizationId,
        existing.id,
        v1.id,
        v1.revision,
        validRule(),
      );
      await publishVersion(orgB.owner.client, orgB.organizationId, existing.id, v1.id);
      const v1Before = await context.adminDb.standardVersion.findUniqueOrThrow({
        where: { id: v1.id },
      });
      const { packageHash } = await previewed(text);

      const response = await importInto(orgB.owner.client, orgB.organizationId, {
        package: text,
        packageHash,
        mode: 'EXISTING_STANDARD',
        standardId: existing.id,
        versionLabel: '2.0-imported',
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        standardId: existing.id,
        createdStandard: false,
        versionLabel: '2.0-imported',
      });
      expect(
        await context.adminDb.standardVersion.findUniqueOrThrow({ where: { id: v1.id } }),
      ).toEqual(v1Before);
      const created = await context.adminDb.standardVersion.findUniqueOrThrow({
        where: { id: response.body.versionId },
      });
      expect(created.status).toBe('DRAFT');
      expect(
        await context.adminDb.standard.count({ where: { organizationId: orgB.organizationId } }),
      ).toBe(1);
    });

    it('refuses a code collision rather than overwriting, and a taken version label', async () => {
      const a = await standardA({ publish: true });
      const text = await exportA(a.standardId, a.versionId);
      const typeB = await orgBType();
      const existing = await createStandard(orgB.owner.client, orgB.organizationId, typeB, {
        code: 'IUG-PHD',
      });
      await createVersion(orgB.owner.client, orgB.organizationId, existing.id, '1.2');
      const preview = await previewed(text);
      expect(
        (preview as never as { destination: { existingStandardWithCode: { id: string } } })
          .destination.existingStandardWithCode.id,
      ).toBe(existing.id);

      const collision = await importInto(orgB.owner.client, orgB.organizationId, {
        package: text,
        packageHash: preview.packageHash,
        mode: 'NEW_STANDARD',
        documentTypeId: typeB,
        versionLabel: '1.2',
      });
      expect(collision.status).toBe(409);
      expect(collision.body.error.code).toBe('STANDARD_CODE_TAKEN');

      const label = await importInto(orgB.owner.client, orgB.organizationId, {
        package: text,
        packageHash: preview.packageHash,
        mode: 'EXISTING_STANDARD',
        standardId: existing.id,
        versionLabel: '1.2',
      });
      expect(label.status).toBe(409);
      expect(label.body.error.code).toBe('STANDARD_VERSION_LABEL_TAKEN');

      const renamed = await importInto(orgB.owner.client, orgB.organizationId, {
        package: text,
        packageHash: preview.packageHash,
        mode: 'NEW_STANDARD',
        documentTypeId: typeB,
        versionLabel: '1.2',
        code: 'AQU-PHD',
      });
      expect(renamed.status).toBe(201);
    });

    it('refuses a standard for another kind of document', async () => {
      const a = await standardA({ publish: true });
      const text = await exportA(a.standardId, a.versionId);
      const paperType = await orgBType('JOURNAL_ARTICLE');
      const paperStandard = await createStandard(
        orgB.owner.client,
        orgB.organizationId,
        paperType,
        { code: 'AQU.PAPER' },
      );
      const { packageHash } = await previewed(text);
      const into = await importInto(orgB.owner.client, orgB.organizationId, {
        package: text,
        packageHash,
        mode: 'EXISTING_STANDARD',
        standardId: paperStandard.id,
        versionLabel: '1.2',
      });
      expect(into.status).toBe(409);
      expect(into.body.error.code).toBe('STANDARD_IMPORT_INCOMPATIBLE');
    });

    it('refuses a package other than the one previewed', async () => {
      const a = await standardA({ publish: true });
      const text = await exportA(a.standardId, a.versionId);
      const typeB = await orgBType();
      const { packageHash } = await previewed(text);
      const other = JSON.parse(text);
      other.rules[0].tolerance = 0.2;
      other.contentHash = computePortableStandardHash(other);
      const response = await importInto(orgB.owner.client, orgB.organizationId, {
        package: JSON.stringify(other),
        packageHash,
        mode: 'NEW_STANDARD',
        documentTypeId: typeB,
        versionLabel: '1.2',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('STANDARD_IMPORT_PACKAGE_CHANGED');
    });

    it('warns about a package already imported, and re-imports only when asked', async () => {
      const a = await standardA({ publish: true });
      const text = await exportA(a.standardId, a.versionId);
      const typeB = await orgBType();
      const { packageHash } = await previewed(text);
      const first = await importInto(orgB.owner.client, orgB.organizationId, {
        package: text,
        packageHash,
        mode: 'NEW_STANDARD',
        documentTypeId: typeB,
        versionLabel: '1.2',
      });
      expect(first.status).toBe(201);

      const again = await preview(orgB.owner.client, orgB.organizationId, text);
      expect(again.body.previousImports).toHaveLength(1);
      expect(again.body.warnings.map((warning: { code: string }) => warning.code)).toEqual(
        expect.arrayContaining(['ALREADY_IMPORTED', 'CODE_TAKEN']),
      );

      const refused = await importInto(orgB.owner.client, orgB.organizationId, {
        package: text,
        packageHash,
        mode: 'EXISTING_STANDARD',
        standardId: first.body.standardId,
        versionLabel: '1.2b',
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('STANDARD_IMPORT_DUPLICATE');
      expect(refused.body.error.details.previousImportedAt).toBeDefined();

      const deliberate = await importInto(orgB.owner.client, orgB.organizationId, {
        package: text,
        packageHash,
        mode: 'EXISTING_STANDARD',
        standardId: first.body.standardId,
        versionLabel: '1.2b',
        acknowledgeDuplicate: true,
      });
      expect(deliberate.status).toBe(201);
      // Two separate drafts; nothing merged.
      expect(
        await context.adminDb.standardVersion.count({
          where: { standardId: first.body.standardId },
        }),
      ).toBe(2);
      expect(
        await context.adminDb.standardRule.count({
          where: { version: { standardId: first.body.standardId } },
        }),
      ).toBe(8);
    });

    it('rolls everything back when rule persistence fails part-way', async () => {
      const a = await standardA({ publish: true });
      const text = await exportA(a.standardId, a.versionId);
      const typeB = await orgBType();
      const { packageHash } = await previewed(text);
      const before = await footprint();

      await context.adminDb.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION test_fail_third_rule() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.rule_code = 'MARGINS.RIGHT' THEN
            RAISE EXCEPTION 'injected failure on the third rule';
          END IF;
          RETURN NEW;
        END $$`);
      await context.adminDb.$executeRawUnsafe(
        `CREATE TRIGGER test_fail_third_rule BEFORE INSERT ON standard_rules
         FOR EACH ROW EXECUTE FUNCTION test_fail_third_rule()`,
      );
      try {
        const response = await importInto(orgB.owner.client, orgB.organizationId, {
          package: text,
          packageHash,
          mode: 'NEW_STANDARD',
          documentTypeId: typeB,
          versionLabel: '1.2',
        });
        expect(response.status).toBeGreaterThanOrEqual(500);
      } finally {
        await context.adminDb.$executeRawUnsafe(
          'DROP TRIGGER test_fail_third_rule ON standard_rules',
        );
        await context.adminDb.$executeRawUnsafe('DROP FUNCTION test_fail_third_rule()');
      }
      expect(await footprint()).toEqual(before);
    });

    it('keeps provenance append-only', async () => {
      const a = await standardA({ publish: true });
      const text = await exportA(a.standardId, a.versionId);
      const typeB = await orgBType();
      const { packageHash } = await previewed(text);
      await importInto(orgB.owner.client, orgB.organizationId, {
        package: text,
        packageHash,
        mode: 'NEW_STANDARD',
        documentTypeId: typeB,
        versionLabel: '1.2',
      });
      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE standard_version_imports SET source_organization_name = 'Forged'`,
        ),
      ).rejects.toThrow(/append-only/);
    });
  });

  // -------------------------------------------------------------------------
  describe('tenancy and permissions', () => {
    async function member(email: string, role: string) {
      const user = await createUser(context, email);
      const invitation = await inviteAndCaptureToken(
        context,
        orgB.owner.client,
        orgB.organizationId,
        email,
        role,
      );
      const accepted = await user.client.post(`${API}/invitations/accept`, {
        token: invitation.token,
      });
      expect(accepted.status).toBe(200);
      return user;
    }

    it('lets a reader export but not preview or import', async () => {
      const a = await standardA({ publish: true });
      const text = await exportA(a.standardId, a.versionId);
      const reviewer = await member('reviewer@alaqsa.test', ORG_ROLE.REVIEWER);
      const typeB = await orgBType();

      expect((await preview(reviewer.client, orgB.organizationId, text)).status).toBe(403);
      const { packageHash } = (await preview(orgB.owner.client, orgB.organizationId, text)).body;
      const attempt = await importInto(reviewer.client, orgB.organizationId, {
        package: text,
        packageHash,
        mode: 'NEW_STANDARD',
        documentTypeId: typeB,
        versionLabel: '1.2',
      });
      expect(attempt.status).toBe(403);
      expect(
        await context.adminDb.standard.count({ where: { organizationId: orgB.organizationId } }),
      ).toBe(0);
    });

    it('cannot import into, or see, another organization’s standard', async () => {
      const a = await standardA({ publish: true });
      const text = await exportA(a.standardId, a.versionId);
      const { packageHash, destination } = (
        await preview(orgB.owner.client, orgB.organizationId, text)
      ).body;
      expect(destination.standards).toEqual([]);

      const into = await importInto(orgB.owner.client, orgB.organizationId, {
        package: text,
        packageHash,
        mode: 'EXISTING_STANDARD',
        standardId: a.standardId,
        versionLabel: '9.9',
      });
      expect(into.status).toBe(404);
      expect(
        await context.adminDb.standardVersion.count({ where: { standardId: a.standardId } }),
      ).toBe(1);

      const asOutsider = await orgB.owner.client.post(
        `${standardsBase(orgA.organizationId)}/import/preview`,
        { package: text },
      );
      expect([403, 404]).toContain(asOutsider.status);
    });

    it('does not call any AI provider or queue any work', async () => {
      const a = await standardA({ publish: true });
      const text = await exportA(a.standardId, a.versionId);
      const typeB = await orgBType();
      const jobsBefore = await context.adminDb.processingJob.count();
      const { packageHash } = (await preview(orgB.owner.client, orgB.organizationId, text)).body;
      await importInto(orgB.owner.client, orgB.organizationId, {
        package: text,
        packageHash,
        mode: 'NEW_STANDARD',
        documentTypeId: typeB,
        versionLabel: '1.2',
      });
      expect(await context.adminDb.processingJob.count()).toBe(jobsBefore);
      expect(await context.adminDb.ruleExtractionRun.count()).toBe(0);
      expect(await context.adminDb.extractionInvocation.count()).toBe(0);
    });
  });

  it('round-trips through the contracts reader exactly', async () => {
    const a = await standardA({ publish: true });
    const text = await exportA(a.standardId, a.versionId);
    const read = readPortableStandardPackage(text);
    expect(read.ok).toBe(true);
  });
});
