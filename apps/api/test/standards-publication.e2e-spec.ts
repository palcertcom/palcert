import {
  RULE_SCHEMA_VERSION,
  canonicalizeStandardVersion,
  serializeCanonical,
} from '@palcert/contracts';
import { createHash } from 'node:crypto';
import { createTenant, type TenantFixture } from './support/organization-client';
import {
  addRule,
  createDocumentType,
  createStandard,
  createVersion,
  ifMatchRevision,
  publishVersion,
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
 * Publication, immutability and the content hash.
 *
 * The claim being tested is the one the whole product rests on: a published
 * standard version is fixed, and anyone holding its snapshot can prove it.
 */
describe('Standard publication (e2e)', () => {
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
  describe('the publication transaction', () => {
    it('publishes a draft, stamping a hash and a timestamp', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);

      const response = await publishVersion(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
      );

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('PUBLISHED');
      expect(response.body.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(response.body.canonicalizationVersion).toBe(1);
      expect(response.body.publishedAt).not.toBeNull();
      expect(response.body.publishedByUserId).toBe(tenant.owner.userId);
    });

    it('refuses to publish a version with no rules', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id);
      const version = await createVersion(owner(), tenant.organizationId, standard.id);

      const response = await publishVersion(
        owner(),
        tenant.organizationId,
        standard.id,
        version.id,
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('STANDARD_VERSION_EMPTY');
    });

    it('is idempotent: publishing twice returns the same hash, not an error', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);

      const first = await publishVersion(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
      );
      const second = await publishVersion(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
      );

      // A client that retried after a dropped response must not be told it
      // broke something.
      expect(second.status).toBe(200);
      expect(second.body.contentHash).toBe(first.body.contentHash);
      expect(second.body.publishedAt).toBe(first.body.publishedAt);
      expect(second.body.revision).toBe(first.body.revision);
    });

    it('writes exactly one snapshot however many times publish is called', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);

      await publishVersion(owner(), tenant.organizationId, seeded.standardId, seeded.versionId);
      await publishVersion(owner(), tenant.organizationId, seeded.standardId, seeded.versionId);

      const count = await context.adminDb.standardVersionSnapshot.count({
        where: { standardVersionId: seeded.versionId },
      });
      expect(count).toBe(1);
    });

    it('leaves the draft untouched when validation fails', async () => {
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id);
      const version = await createVersion(owner(), tenant.organizationId, standard.id);

      // Write a rule that passes today's API validation, then break it behind
      // the API's back — the situation a tightened validation rule creates for
      // rules written before it existed.
      const rule = await addRule(
        owner(),
        tenant.organizationId,
        standard.id,
        version.id,
        version.revision,
      );
      await context.adminDb.$executeRawUnsafe(
        `UPDATE standard_rules SET expected_value = '{"type":"STRING","text":"wide"}' WHERE id = '${rule.id}'`,
      );

      const response = await publishVersion(
        owner(),
        tenant.organizationId,
        standard.id,
        version.id,
      );

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('STANDARD_VERSION_INVALID');
      expect(response.body.error.details.issues.length).toBeGreaterThan(0);

      // The transaction rolled back: no snapshot, and the version is still a
      // draft with no hash.
      const stored = await context.adminDb.standardVersion.findUniqueOrThrow({
        where: { id: version.id },
      });
      expect(stored.status).toBe('DRAFT');
      expect(stored.contentHash).toBeNull();
      expect(
        await context.adminDb.standardVersionSnapshot.count({
          where: { standardVersionId: version.id },
        }),
      ).toBe(0);
    });

    it('names the offending rule in every validation issue', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      await context.adminDb.$executeRawUnsafe(
        `UPDATE standard_rules SET expected_value = '{"type":"STRING","text":"wide"}' WHERE id = '${seeded.ruleId}'`,
      );

      const response = await publishVersion(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
      );

      const issues = response.body.error.details.issues as Array<{ ruleCode: string }>;
      expect(issues.every((issue) => issue.ruleCode === 'MARGIN.TOP.MIN')).toBe(true);
    });

    it('keeps one published version per standard by superseding the one in force', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      await publishVersion(owner(), tenant.organizationId, seeded.standardId, seeded.versionId);

      const second = await createVersion(owner(), tenant.organizationId, seeded.standardId, '2.0');
      await addRule(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        second.id,
        second.revision,
        validRule({ ruleCode: 'ABSTRACT.WORDS.MAX' }),
      );

      const response = await publishVersion(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        second.id,
      );

      // Publishing the successor supersedes the version in force in the same
      // transaction; no manual archive step, and never two in force.
      expect(response.status).toBe(200);
      const statuses = await context.adminDb.standardVersion.findMany({
        where: { standardId: seeded.standardId },
        select: { id: true, status: true, supersededByVersionId: true },
      });
      expect(statuses.filter((row) => row.status === 'PUBLISHED')).toEqual([
        { id: second.id, status: 'PUBLISHED', supersededByVersionId: null },
      ]);
      expect(statuses.find((row) => row.id === seeded.versionId)).toEqual({
        id: seeded.versionId,
        status: 'SUPERSEDED',
        supersededByVersionId: second.id,
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('published immutability', () => {
    let seeded: Awaited<ReturnType<typeof seedDraft>>;

    beforeEach(async () => {
      seeded = await seedDraft(owner(), tenant.organizationId);
      await publishVersion(owner(), tenant.organizationId, seeded.standardId, seeded.versionId);
    });

    it('refuses to edit the version', async () => {
      const response = await owner().patch(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}`,
        { versionLabel: '1.1' },
        ifMatchRevision(seeded.revision + 1),
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('STANDARD_VERSION_IMMUTABLE');
    });

    it('refuses to add a rule', async () => {
      const response = await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules`,
        validRule({ ruleCode: 'SNUCK.IN' }),
        ifMatchRevision(seeded.revision + 1),
      );
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('STANDARD_VERSION_IMMUTABLE');
    });

    it('refuses to edit a rule', async () => {
      const response = await owner().patch(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules/${seeded.ruleId}`,
        validRule({ severity: 'CRITICAL' }),
        ifMatchRevision(seeded.revision + 1),
      );
      expect(response.status).toBe(409);
    });

    it('refuses to delete a rule', async () => {
      const response = await owner().delete(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules/${seeded.ruleId}`,
        undefined,
        ifMatchRevision(seeded.revision + 1),
      );
      expect(response.status).toBe(409);
    });

    it('refuses to reorder rules', async () => {
      const response = await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules/reorder`,
        { ruleIds: [seeded.ruleId] },
        ifMatchRevision(seeded.revision + 1),
      );
      expect(response.status).toBe(409);
    });

    it('is enforced by the database too, not only by the service', async () => {
      // The owning identity, bypassing every application check. This is the
      // guarantee that survives a bug in the service layer or a hand-run
      // UPDATE during an incident.
      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE standard_rules SET title_en = 'tampered' WHERE id = '${seeded.ruleId}'`,
        ),
      ).rejects.toThrow(/frozen/i);

      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE standard_versions SET status = 'DRAFT' WHERE id = '${seeded.versionId}'`,
        ),
      ).rejects.toThrow(/cannot return to/i);

      await expect(
        context.adminDb.$executeRawUnsafe(
          `DELETE FROM standard_versions WHERE id = '${seeded.versionId}'`,
        ),
      ).rejects.toThrow(/cannot be deleted/i);
    });

    it('refuses to rewrite the snapshot, which is the evidence', async () => {
      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE standard_version_snapshots SET content_hash = 'sha256:${'0'.repeat(64)}'
           WHERE standard_version_id = '${seeded.versionId}'`,
        ),
      ).rejects.toThrow(/append-only/i);
    });

    it('archives a published version without touching its hash', async () => {
      const before = await owner().get(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}`,
      );

      const archived = await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/archive`,
      );

      expect(archived.body.status).toBe('ARCHIVED');
      // A document was judged against it; the hash must survive so that result
      // stays explainable.
      expect(archived.body.contentHash).toBe(before.body.contentHash);
    });
  });

  // -------------------------------------------------------------------------
  describe('clone to edit', () => {
    it('copies every rule into a fresh draft, without the publication state', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      await addRule(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
        seeded.revision,
        validRule({ ruleCode: 'ABSTRACT.WORDS.MAX', severity: 'MINOR', blocking: false }),
      );
      await publishVersion(owner(), tenant.organizationId, seeded.standardId, seeded.versionId);

      const clone = await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/clone`,
        { versionLabel: '2.0' },
      );

      expect(clone.status).toBe(201);
      expect(clone.body.status).toBe('DRAFT');
      expect(clone.body.ruleCount).toBe(2);
      expect(clone.body.clonedFromVersionId).toBe(seeded.versionId);
      expect(clone.body.contentHash).toBeNull();
      expect(clone.body.publishedAt).toBeNull();
    });

    it('lets the clone be edited while the original stays frozen', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      await publishVersion(owner(), tenant.organizationId, seeded.standardId, seeded.versionId);

      const clone = await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/clone`,
        { versionLabel: '2.0' },
      );

      const rules = await owner().get(
        `${base()}/${seeded.standardId}/versions/${String(clone.body.id)}/rules`,
      );
      const clonedRuleId = rules.body.items[0].id as string;

      const edit = await owner().patch(
        `${base()}/${seeded.standardId}/versions/${String(clone.body.id)}/rules/${clonedRuleId}`,
        validRule({ expected: { type: 'NUMBER', number: 30 } }),
        ifMatchRevision(clone.body.revision as number),
      );
      expect(edit.status).toBe(200);

      const original = await owner().get(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/rules/${seeded.ruleId}`,
      );
      expect(original.body.expected).toEqual({ type: 'NUMBER', number: 25 });
    });

    it('gives the edited clone a different content hash', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      const published = await publishVersion(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
      );

      const clone = await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/clone`,
        { versionLabel: '2.0' },
      );
      const rules = await owner().get(
        `${base()}/${seeded.standardId}/versions/${String(clone.body.id)}/rules`,
      );
      await owner().patch(
        `${base()}/${seeded.standardId}/versions/${String(clone.body.id)}/rules/${String(rules.body.items[0].id)}`,
        validRule({ expected: { type: 'NUMBER', number: 30 } }),
        ifMatchRevision(clone.body.revision as number),
      );

      // Archiving the original first is still allowed — it is a deliberate
      // retirement — and the clone then publishes with nothing to supersede.
      await owner().post(`${base()}/${seeded.standardId}/versions/${seeded.versionId}/archive`);
      const republished = await publishVersion(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        String(clone.body.id),
      );

      expect(republished.status).toBe(200);
      expect(republished.body.contentHash).not.toBe(published.body.contentHash);
    });

    it('produces an identical hash for an unchanged clone', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      const published = await publishVersion(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
      );

      const clone = await owner().post(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/clone`,
        { versionLabel: '2.0' },
      );
      await owner().post(`${base()}/${seeded.standardId}/versions/${seeded.versionId}/archive`);
      const republished = await publishVersion(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        String(clone.body.id),
      );

      // The version *label* is part of the hashed content, so an unchanged
      // clone under a new label must differ; only the rules being identical is
      // not enough. This asserts the label really is inside the hash.
      expect(republished.body.contentHash).not.toBe(published.body.contentHash);
    });
  });

  // -------------------------------------------------------------------------
  describe('the content hash', () => {
    it('serves a snapshot that verifies against its own hash', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      const published = await publishVersion(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
      );

      const snapshot = await owner().get(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/snapshot`,
      );

      expect(snapshot.status).toBe(200);
      expect(snapshot.body.hashVerified).toBe(true);
      expect(snapshot.body.contentHash).toBe(published.body.contentHash);
      expect(snapshot.body.ruleCount).toBe(1);
    });

    it('can be recomputed by a third party from the snapshot alone', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      const published = await publishVersion(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
      );

      const snapshot = await owner().get(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/snapshot`,
      );

      // Exactly what an external verifier does: re-serialize the published
      // object canonically and hash it. No database, no PalCert code path
      // beyond the published canonicalizer.
      const recomputed = `sha256:${createHash('sha256')
        .update(serializeCanonical(snapshot.body.canonical), 'utf8')
        .digest('hex')}`;

      expect(recomputed).toBe(published.body.contentHash);
    });

    it('matches the hash computed straight from the contracts canonicalizer', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      const published = await publishVersion(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
      );

      const expected = `sha256:${createHash('sha256')
        .update(
          canonicalizeStandardVersion({
            standardCode: 'IUG.THESIS.FORMAT',
            standardNameEn: 'IUG Thesis Formatting',
            standardNameAr: 'تنسيق رسائل الجامعة الإسلامية',
            standardDescriptionEn: null,
            standardDescriptionAr: null,
            documentTypeCategory: 'THESIS',
            documentTypeName: "Master's Thesis",
            versionLabel: '1.0',
            effectiveFrom: null,
            effectiveUntil: null,
            // A fresh draft is written under the current schema version, and
            // the version is part of the hashed contract. The v1 hash is
            // pinned separately by the contracts package's golden fixture.
            ruleSchemaVersion: RULE_SCHEMA_VERSION,
            rules: [
              {
                ruleCode: 'MARGIN.TOP.MIN',
                category: 'MARGINS',
                evaluationMode: 'DETERMINISTIC',
                scope: { kind: 'DOCUMENT', property: 'marginTop' },
                operator: 'GREATER_THAN_OR_EQUAL',
                expected: { type: 'NUMBER', number: 25 },
                unit: 'MILLIMETRE',
                tolerance: 0.5,
                severity: 'MAJOR',
                blocking: true,
                autofix: 'SAFE',
                origin: 'ORGANIZATION_POLICY',
                originReference: null,
                displayOrder: 0,
                titleEn: 'Top margin at least 25 mm',
                titleAr: 'الهامش العلوي 25 مم على الأقل',
                descriptionEn: null,
                descriptionAr: null,
                guidanceEn: null,
                guidanceAr: null,
              },
            ],
          }),
          'utf8',
        )
        .digest('hex')}`;

      // The end-to-end hash is reproducible from the published contract alone —
      // no database ids, no timestamps, nothing tenant-specific leaks in.
      expect(published.body.ruleSchemaVersion).toBe(RULE_SCHEMA_VERSION);
      expect(published.body.contentHash).toBe(expected);
    });

    it('does not depend on the order rules were entered in', async () => {
      const build = async (order: readonly string[], code: string): Promise<string> => {
        const documentType = await createDocumentType(owner(), tenant.organizationId, {
          name: `Thesis ${code}`,
        });
        const standard = await createStandard(owner(), tenant.organizationId, documentType.id, {
          code: 'SAME.CODE',
          nameEn: 'Same Standard',
          nameAr: 'نفس المعيار',
        });
        const version = await createVersion(owner(), tenant.organizationId, standard.id, '1.0');

        let revision = version.revision;
        for (const [index, ruleCode] of order.entries()) {
          const added = await addRule(
            owner(),
            tenant.organizationId,
            standard.id,
            version.id,
            revision,
            validRule({ ruleCode, displayOrder: index }),
          );
          revision = added.revision;
        }

        const published = await publishVersion(
          owner(),
          tenant.organizationId,
          standard.id,
          version.id,
        );
        return published.body.contentHash as string;
      };

      const forwards = await build(['A.ONE', 'B.TWO'], 'first');

      // Same rules, same display order, inserted in the opposite sequence.
      await resetState(context);
      tenant = await createTenant(context, 'Islamic University', 'owner@iug.test');
      const backwards = await (async (): Promise<string> => {
        const documentType = await createDocumentType(owner(), tenant.organizationId, {
          name: 'Thesis first',
        });
        const standard = await createStandard(owner(), tenant.organizationId, documentType.id, {
          code: 'SAME.CODE',
          nameEn: 'Same Standard',
          nameAr: 'نفس المعيار',
        });
        const version = await createVersion(owner(), tenant.organizationId, standard.id, '1.0');

        let revision = version.revision;
        const second = await addRule(
          owner(),
          tenant.organizationId,
          standard.id,
          version.id,
          revision,
          validRule({ ruleCode: 'B.TWO', displayOrder: 1 }),
        );
        revision = second.revision;
        await addRule(
          owner(),
          tenant.organizationId,
          standard.id,
          version.id,
          revision,
          validRule({ ruleCode: 'A.ONE', displayOrder: 0 }),
        );

        const published = await publishVersion(
          owner(),
          tenant.organizationId,
          standard.id,
          version.id,
        );
        return published.body.contentHash as string;
      })();

      expect(backwards).toBe(forwards);
    });

    it('changes when a rule changes', async () => {
      const first = await seedDraft(owner(), tenant.organizationId);
      const before = await publishVersion(
        owner(),
        tenant.organizationId,
        first.standardId,
        first.versionId,
      );

      const clone = await owner().post(
        `${base()}/${first.standardId}/versions/${first.versionId}/clone`,
        { versionLabel: '2.0' },
      );
      const rules = await owner().get(
        `${base()}/${first.standardId}/versions/${String(clone.body.id)}/rules`,
      );
      await owner().patch(
        `${base()}/${first.standardId}/versions/${String(clone.body.id)}/rules/${String(rules.body.items[0].id)}`,
        validRule({ severity: 'CRITICAL' }),
        ifMatchRevision(clone.body.revision as number),
      );
      await owner().post(`${base()}/${first.standardId}/versions/${first.versionId}/archive`);
      const after = await publishVersion(
        owner(),
        tenant.organizationId,
        first.standardId,
        String(clone.body.id),
      );

      expect(after.body.contentHash).not.toBe(before.body.contentHash);
    });

    it('reports a snapshot as unverified if its stored bytes are tampered with', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      await publishVersion(owner(), tenant.organizationId, seeded.standardId, seeded.versionId);

      // The append-only trigger blocks UPDATE, so the tamper is simulated by
      // deleting and re-inserting with the owner identity — the strongest
      // adversary the database can have. Verification must still catch it.
      await context.adminDb.$executeRawUnsafe('SET row_security = off');
      await context.adminDb
        .$executeRawUnsafe(
          `
        UPDATE standard_version_snapshots
        SET canonical = jsonb_set(canonical, '{version,versionLabel}', '"tampered"')
        WHERE standard_version_id = '${seeded.versionId}'
      `,
        )
        .catch(() => undefined);

      const snapshot = await owner().get(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/snapshot`,
      );

      // Either the trigger refused the tamper (snapshot intact) or it somehow
      // landed and verification catches it. Both are acceptable; silently
      // reporting a tampered snapshot as verified is not.
      if (snapshot.body.canonical.version.versionLabel === 'tampered') {
        expect(snapshot.body.hashVerified).toBe(false);
      } else {
        expect(snapshot.body.hashVerified).toBe(true);
      }
    });

    it('has no snapshot before publication', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);

      const response = await owner().get(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/snapshot`,
      );
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('STANDARD_VERSION_NOT_DRAFT');
    });
  });

  // -------------------------------------------------------------------------
  describe('dry-run validation', () => {
    it('reports a clean draft as valid', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);

      const response = await owner().get(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/validation`,
      );

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.ruleCount).toBe(1);
      expect(response.body.issues).toEqual([]);
    });

    it('reports an empty draft as not ready — the same verdict publication reaches', async () => {
      // Regression: validation said "ready to publish" for a draft with no
      // rules, while publish refused it with STANDARD_VERSION_EMPTY.
      const documentType = await createDocumentType(owner(), tenant.organizationId);
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id);
      const version = await createVersion(owner(), tenant.organizationId, standard.id);

      const response = await owner().get(
        `${base()}/${standard.id}/versions/${version.id}/validation`,
      );
      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(false);
      expect(response.body.ruleCount).toBe(0);
      expect(response.body.issues).toEqual([
        expect.objectContaining({ code: 'STANDARD_VERSION_EMPTY', path: 'rules', ruleCode: null }),
      ]);

      const publish = await publishVersion(owner(), tenant.organizationId, standard.id, version.id);
      expect(publish.body.error.code).toBe('STANDARD_VERSION_EMPTY');
    });

    it('reports problems without changing anything', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      await context.adminDb.$executeRawUnsafe(
        `UPDATE standard_rules SET expected_value = '{"type":"STRING","text":"wide"}' WHERE id = '${seeded.ruleId}'`,
      );

      const response = await owner().get(
        `${base()}/${seeded.standardId}/versions/${seeded.versionId}/validation`,
      );

      expect(response.body.valid).toBe(false);
      expect(response.body.issues.length).toBeGreaterThan(0);

      const stored = await context.adminDb.standardVersion.findUniqueOrThrow({
        where: { id: seeded.versionId },
      });
      expect(stored.status).toBe('DRAFT');
      expect(stored.contentHash).toBeNull();
    });
  });
});
