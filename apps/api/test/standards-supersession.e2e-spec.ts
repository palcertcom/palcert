import { API, type AuthClient } from './support/auth-client';
import { readCertificate, verify, waitForCertificate } from './support/certificates-client';
import { publishCheckableStandard } from './support/checks-client';
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
  ifMatchRevision,
  publishVersion,
  seedDraft,
  standardsBase,
  validRule,
} from './support/standards-client';
import { completedCheck, decide, submitAndPrepare } from './support/submissions-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Publishing a successor supersedes the version in force.
 *
 * The lifecycle this pins down:
 *
 *     DRAFT ──publish──> PUBLISHED ──publish a successor──> SUPERSEDED
 *                            └──archive──> ARCHIVED
 *
 * and the promise that goes with it: a superseded version is history, not a
 * deletion. Everything that captured it — checks, reports, certificates, the
 * audit trail — keeps pointing at exactly that version.
 */
describe('Standard version supersession (e2e)', () => {
  let context: TestContext;
  let tenant: TenantFixture;

  beforeAll(async () => {
    context = await createTestContext();
    // One listening server for the whole suite. Left to itself supertest
    // opens and closes an ephemeral listener per request, and with several
    // requests in flight one can close it under another; the races below are
    // meant to exercise the database, not that.
    await new Promise<void>((resolve) => {
      context.app.getHttpServer().listen(0, '127.0.0.1', () => resolve());
    });
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

  /** A further draft of an existing standard, with one valid rule. */
  async function draftOf(
    standardId: string,
    label: string,
    rule: Record<string, unknown> = validRule(),
  ): Promise<string> {
    const version = await createVersion(owner(), tenant.organizationId, standardId, label);
    await addRule(owner(), tenant.organizationId, standardId, version.id, version.revision, rule);
    return version.id;
  }

  /** 1.0 in force and 1.2 ready: the scenario the lifecycle exists for. */
  async function inForceAndDraft(): Promise<{
    standardId: string;
    v10: string;
    v12: string;
  }> {
    const seeded = await seedDraft(owner(), tenant.organizationId);
    const published = await publishVersion(
      owner(),
      tenant.organizationId,
      seeded.standardId,
      seeded.versionId,
    );
    expect(published.status).toBe(200);
    const v12 = await draftOf(seeded.standardId, '1.2', validRule({ ruleCode: 'MARGIN.TOP.MIN' }));
    return { standardId: seeded.standardId, v10: seeded.versionId, v12 };
  }

  async function statusesOf(standardId: string): Promise<Record<string, string>> {
    const rows = await context.adminDb.standardVersion.findMany({ where: { standardId } });
    return Object.fromEntries(rows.map((row) => [row.versionLabel, row.status]));
  }

  async function publishedCount(standardId: string): Promise<number> {
    return context.adminDb.standardVersion.count({ where: { standardId, status: 'PUBLISHED' } });
  }

  // -------------------------------------------------------------------------
  describe('publishing', () => {
    it('publishes the first version of a standard with nothing to supersede', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);

      const response = await publishVersion(
        owner(),
        tenant.organizationId,
        seeded.standardId,
        seeded.versionId,
        { replacesVersionId: null },
      );

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('PUBLISHED');
      expect(response.body.supersededAt).toBeNull();
      expect(response.body.supersededByVersionId).toBeNull();
      expect(
        await context.adminDb.auditEvent.count({
          where: { action: 'STANDARD_VERSION_SUPERSEDED' },
        }),
      ).toBe(0);
    });

    it('replaces the version in force in one step: 1.0 SUPERSEDED, 1.2 PUBLISHED', async () => {
      const { standardId, v10, v12 } = await inForceAndDraft();

      const response = await publishVersion(owner(), tenant.organizationId, standardId, v12, {
        replacesVersionId: v10,
      });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('PUBLISHED');
      expect(response.body.versionLabel).toBe('1.2');
      expect(await statusesOf(standardId)).toEqual({ '1.0': 'SUPERSEDED', '1.2': 'PUBLISHED' });
      expect(await publishedCount(standardId)).toBe(1);

      const old = await owner().get(`${base()}/${standardId}/versions/${v10}`);
      expect(old.status).toBe(200);
      expect(old.body.status).toBe('SUPERSEDED');
      expect(old.body.supersededByVersionId).toBe(v12);
      expect(old.body.supersededByVersionLabel).toBe('1.2');
      expect(old.body.supersededAt).toBe(response.body.publishedAt);
      // Superseding is not archiving.
      expect(old.body.archivedAt).toBeNull();

      const summary = await owner().get(`${base()}/${standardId}`);
      expect(summary.body.publishedVersionId).toBe(v12);
      expect(summary.body.publishedVersionLabel).toBe('1.2');
    });

    it('replaces without a precondition too, for API clients that send none', async () => {
      const { standardId, v12 } = await inForceAndDraft();

      const response = await publishVersion(owner(), tenant.organizationId, standardId, v12);

      expect(response.status).toBe(200);
      expect(await statusesOf(standardId)).toEqual({ '1.0': 'SUPERSEDED', '1.2': 'PUBLISHED' });
    });

    it('no longer answers "archive it first"', async () => {
      const { standardId, v12 } = await inForceAndDraft();
      const response = await publishVersion(owner(), tenant.organizationId, standardId, v12);
      expect(JSON.stringify(response.body)).not.toMatch(/archive it first/i);
    });

    it('stays idempotent: publishing the new version again changes nothing', async () => {
      const { standardId, v10, v12 } = await inForceAndDraft();
      const first = await publishVersion(owner(), tenant.organizationId, standardId, v12, {
        replacesVersionId: v10,
      });
      // A retry after a dropped response still carries the precondition it was
      // sent with; it must not be refused for describing the past.
      const second = await publishVersion(owner(), tenant.organizationId, standardId, v12, {
        replacesVersionId: v10,
      });

      expect(second.status).toBe(200);
      expect(second.body.contentHash).toBe(first.body.contentHash);
      expect(second.body.revision).toBe(first.body.revision);
      expect(
        await context.adminDb.auditEvent.count({
          where: { action: 'STANDARD_VERSION_SUPERSEDED' },
        }),
      ).toBe(1);
      expect(
        await context.adminDb.standardVersionSnapshot.count({ where: { standardVersionId: v12 } }),
      ).toBe(1);
    });

    it('refuses a replacement the caller did not confirm, and changes nothing', async () => {
      const { standardId, v10, v12 } = await inForceAndDraft();
      const v11 = await draftOf(standardId, '1.1');
      await publishVersion(owner(), tenant.organizationId, standardId, v11, {
        replacesVersionId: v10,
      });

      // The page still showed 1.0 in force when the author confirmed.
      const stale = await publishVersion(owner(), tenant.organizationId, standardId, v12, {
        replacesVersionId: v10,
      });

      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('CONFLICT');
      expect(stale.body.error.message).toContain('1.1');
      expect(await statusesOf(standardId)).toEqual({
        '1.0': 'SUPERSEDED',
        '1.1': 'PUBLISHED',
        '1.2': 'DRAFT',
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('the superseded version', () => {
    it('keeps its hash, snapshot, publication record and rules byte for byte', async () => {
      const { standardId, v10, v12 } = await inForceAndDraft();
      const [versionBefore, snapshotBefore, rulesBefore] = await Promise.all([
        context.adminDb.standardVersion.findUniqueOrThrow({ where: { id: v10 } }),
        context.adminDb.standardVersionSnapshot.findUniqueOrThrow({
          where: { standardVersionId: v10 },
        }),
        context.adminDb.standardRule.findMany({
          where: { standardVersionId: v10 },
          orderBy: { id: 'asc' },
        }),
      ]);

      await publishVersion(owner(), tenant.organizationId, standardId, v12);

      const [versionAfter, snapshotAfter, rulesAfter] = await Promise.all([
        context.adminDb.standardVersion.findUniqueOrThrow({ where: { id: v10 } }),
        context.adminDb.standardVersionSnapshot.findUniqueOrThrow({
          where: { standardVersionId: v10 },
        }),
        context.adminDb.standardRule.findMany({
          where: { standardVersionId: v10 },
          orderBy: { id: 'asc' },
        }),
      ]);

      expect(versionAfter.contentHash).toBe(versionBefore.contentHash);
      expect(versionAfter.canonicalizationVersion).toBe(versionBefore.canonicalizationVersion);
      expect(versionAfter.publishedAt).toEqual(versionBefore.publishedAt);
      expect(versionAfter.publishedByUserId).toBe(versionBefore.publishedByUserId);
      expect(versionAfter.versionLabel).toBe('1.0');
      expect(snapshotAfter).toEqual(snapshotBefore);
      expect(rulesAfter).toEqual(rulesBefore);

      // And the snapshot still proves itself.
      const snapshot = await owner().get(`${base()}/${standardId}/versions/${v10}/snapshot`);
      expect(snapshot.status).toBe(200);
      expect(snapshot.body.contentHash).toBe(versionBefore.contentHash);
      expect(snapshot.body.hashVerified).toBe(true);

      // Rules stay readable for the history view.
      const rules = await owner().get(`${base()}/${standardId}/versions/${v10}/rules`);
      expect(rules.status).toBe(200);
      expect(rules.body.items).toHaveLength(rulesBefore.length);
    });

    it('cannot be edited, have rules changed, be archived or be published again', async () => {
      const { standardId, v10, v12 } = await inForceAndDraft();
      await publishVersion(owner(), tenant.organizationId, standardId, v12);
      const current = await context.adminDb.standardVersion.findUniqueOrThrow({
        where: { id: v10 },
      });
      const rule = await context.adminDb.standardRule.findFirstOrThrow({
        where: { standardVersionId: v10 },
      });
      const precondition = ifMatchRevision(current.revision);

      const attempts = await Promise.all([
        owner().patch(
          `${base()}/${standardId}/versions/${v10}`,
          { versionLabel: '1.0b' },
          precondition,
        ),
        owner().post(
          `${base()}/${standardId}/versions/${v10}/rules`,
          validRule({ ruleCode: 'SNUCK.IN' }),
          precondition,
        ),
        owner().patch(
          `${base()}/${standardId}/versions/${v10}/rules/${rule.id}`,
          validRule({ severity: 'CRITICAL' }),
          precondition,
        ),
        owner().delete(
          `${base()}/${standardId}/versions/${v10}/rules/${rule.id}`,
          undefined,
          precondition,
        ),
        owner().post(`${base()}/${standardId}/versions/${v10}/archive`),
        publishVersion(owner(), tenant.organizationId, standardId, v10),
      ]);

      for (const attempt of attempts) {
        expect(attempt.status).toBe(409);
        expect(attempt.body.error.code).toBe('STANDARD_VERSION_SUPERSEDED');
      }
      const republish = attempts[5]!;
      expect(republish.body.error.message).toMatch(/superseded by version 1\.2/);
      expect(republish.body.error.message).toMatch(/clone/i);

      const after = await context.adminDb.standardVersion.findUniqueOrThrow({
        where: { id: v10 },
      });
      expect(after).toEqual(current);
    });

    it('is frozen by the database too, not only by the service', async () => {
      const { standardId, v10, v12 } = await inForceAndDraft();
      await publishVersion(owner(), tenant.organizationId, standardId, v12);

      for (const statement of [
        `UPDATE standard_versions SET status = 'PUBLISHED', superseded_at = NULL, superseded_by_version_id = NULL WHERE id = '${v10}'`,
        `UPDATE standard_versions SET status = 'ARCHIVED', superseded_at = NULL, superseded_by_version_id = NULL WHERE id = '${v10}'`,
        `UPDATE standard_versions SET version_label = 'rewritten' WHERE id = '${v10}'`,
        `UPDATE standard_versions SET superseded_by_version_id = NULL WHERE id = '${v10}'`,
      ]) {
        await expect(context.adminDb.$executeRawUnsafe(statement)).rejects.toThrow(/superseded/i);
      }
      await expect(
        context.adminDb.$executeRawUnsafe(`DELETE FROM standard_versions WHERE id = '${v10}'`),
      ).rejects.toThrow(/cannot be deleted/i);
      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE standard_rules SET title_en = 'tampered' WHERE standard_version_id = '${v10}'`,
        ),
      ).rejects.toThrow(/frozen/i);
    });

    it('can be cloned into a new draft, and that draft published as the way back', async () => {
      const { standardId, v10, v12 } = await inForceAndDraft();
      await publishVersion(owner(), tenant.organizationId, standardId, v12);

      const clone = await owner().post(`${base()}/${standardId}/versions/${v10}/clone`, {
        versionLabel: '1.3',
      });
      expect(clone.status).toBe(201);
      expect(clone.body.status).toBe('DRAFT');
      expect(clone.body.clonedFromVersionId).toBe(v10);
      expect(clone.body.ruleCount).toBe(1);
      expect(clone.body.supersededAt).toBeNull();

      const republished = await publishVersion(
        owner(),
        tenant.organizationId,
        standardId,
        String(clone.body.id),
        { replacesVersionId: v12 },
      );
      expect(republished.status).toBe(200);

      expect(await statusesOf(standardId)).toEqual({
        '1.0': 'SUPERSEDED',
        '1.2': 'SUPERSEDED',
        '1.3': 'PUBLISHED',
      });
      // Each link of the chain names its own successor; 1.0's is untouched.
      const [old, middle] = await Promise.all([
        context.adminDb.standardVersion.findUniqueOrThrow({ where: { id: v10 } }),
        context.adminDb.standardVersion.findUniqueOrThrow({ where: { id: v12 } }),
      ]);
      expect(old.supersededByVersionId).toBe(v12);
      expect(middle.supersededByVersionId).toBe(clone.body.id);
    });

    it('is listed with its successor in the version history', async () => {
      const { standardId, v12 } = await inForceAndDraft();
      await publishVersion(owner(), tenant.organizationId, standardId, v12);

      const all = await owner().get(`${base()}/${standardId}/versions`);
      const byLabel = Object.fromEntries(
        (all.body.items as Array<Record<string, unknown>>).map((item) => [item.versionLabel, item]),
      );
      expect(byLabel['1.0']).toMatchObject({
        status: 'SUPERSEDED',
        supersededByVersionLabel: '1.2',
      });
      expect(byLabel['1.2']).toMatchObject({ status: 'PUBLISHED', supersededByVersionId: null });

      const filtered = await owner().get(`${base()}/${standardId}/versions?status=SUPERSEDED`);
      expect(filtered.status).toBe(200);
      expect((filtered.body.items as unknown[]).length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('audit', () => {
    it('records the supersession and the publication, and leaves the old record alone', async () => {
      const { standardId, v10, v12 } = await inForceAndDraft();
      const originalPublication = await context.adminDb.auditEvent.findFirstOrThrow({
        where: { action: 'STANDARD_VERSION_PUBLISHED', targetId: v10 },
      });

      const response = await publishVersion(owner(), tenant.organizationId, standardId, v12);

      const superseded = await context.adminDb.auditEvent.findMany({
        where: { action: 'STANDARD_VERSION_SUPERSEDED' },
      });
      expect(superseded).toHaveLength(1);
      expect(superseded[0]).toMatchObject({
        actorType: 'USER',
        actorUserId: tenant.owner.userId,
        targetType: 'StandardVersion',
        targetId: v10,
      });
      expect(superseded[0]!.afterState).toMatchObject({
        standardId,
        status: 'SUPERSEDED',
        previousVersionId: v10,
        previousVersionLabel: '1.0',
        supersededByVersionId: v12,
        supersededByVersionLabel: '1.2',
        supersededAt: response.body.publishedAt,
      });
      expect(superseded[0]!.createdAt).toBeInstanceOf(Date);

      const published = await context.adminDb.auditEvent.findFirstOrThrow({
        where: { action: 'STANDARD_VERSION_PUBLISHED', targetId: v12 },
      });
      expect(published.actorUserId).toBe(tenant.owner.userId);
      expect(published.afterState).toMatchObject({
        versionLabel: '1.2',
        supersededVersionId: v10,
        supersededVersionLabel: '1.0',
      });

      const originalAfter = await context.adminDb.auditEvent.findUniqueOrThrow({
        where: { id: originalPublication.id },
      });
      expect(originalAfter).toEqual(originalPublication);
    });
  });

  // -------------------------------------------------------------------------
  describe('atomicity and concurrency', () => {
    it('rolls the supersession back when the publish fails after it', async () => {
      const { standardId, v10, v12 } = await inForceAndDraft();
      // A snapshot already occupying the draft's slot makes the publish fail
      // *after* the version in force has been superseded in the transaction.
      const existing = await context.adminDb.standardVersionSnapshot.findUniqueOrThrow({
        where: { standardVersionId: v10 },
      });
      await context.adminDb.standardVersionSnapshot.create({
        data: {
          organizationId: tenant.organizationId,
          standardVersionId: v12,
          canonical: existing.canonical as object,
          contentHash: existing.contentHash,
          canonicalizationVersion: existing.canonicalizationVersion,
          ruleSchemaVersion: existing.ruleSchemaVersion,
          ruleCount: existing.ruleCount,
        },
      });

      const response = await publishVersion(owner(), tenant.organizationId, standardId, v12);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await statusesOf(standardId)).toEqual({ '1.0': 'PUBLISHED', '1.2': 'DRAFT' });
      const old = await context.adminDb.standardVersion.findUniqueOrThrow({ where: { id: v10 } });
      expect(old.supersededAt).toBeNull();
      expect(old.supersededByVersionId).toBeNull();
      expect(
        await context.adminDb.auditEvent.count({
          where: { action: { in: ['STANDARD_VERSION_SUPERSEDED'] } },
        }),
      ).toBe(0);
      expect(
        await context.adminDb.auditEvent.count({
          where: { action: 'STANDARD_VERSION_PUBLISHED', targetId: v12 },
        }),
      ).toBe(0);
    });

    it('refuses to commit a supersession whose successor never became PUBLISHED', async () => {
      const { standardId, v10, v12 } = await inForceAndDraft();

      // A hand-run supersession that forgets the publish: the deferred
      // trigger refuses it at commit, so the standard is never left with no
      // version in force.
      await expect(
        context.adminDb.$transaction([
          context.adminDb.$executeRawUnsafe(
            `UPDATE standard_versions
               SET status = 'SUPERSEDED', superseded_at = now(), superseded_by_version_id = '${v12}'
             WHERE id = '${v10}'`,
          ),
        ]),
      ).rejects.toThrow(/successor/i);

      expect(await statusesOf(standardId)).toEqual({ '1.0': 'PUBLISHED', '1.2': 'DRAFT' });
    });

    it('refuses a successor from another standard at the database', async () => {
      const { v10 } = await inForceAndDraft();
      const documentType = await createDocumentType(owner(), tenant.organizationId, {
        name: 'Other document type',
      });
      const standard = await createStandard(owner(), tenant.organizationId, documentType.id, {
        code: 'OTHER.STANDARD',
      });
      const otherDraft = await createVersion(owner(), tenant.organizationId, standard.id);

      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE standard_versions
             SET status = 'SUPERSEDED', superseded_at = now(), superseded_by_version_id = '${otherDraft.id}'
           WHERE id = '${v10}'`,
        ),
      ).rejects.toThrow(/same standard/i);
    });

    it('lets exactly one of two concurrent publishes win, and tells the other', async () => {
      const { standardId, v10 } = await inForceAndDraft();
      const v11 = await draftOf(standardId, '1.1');
      const v13 = await draftOf(standardId, '1.3');

      const results = await Promise.all([
        publishVersion(owner(), tenant.organizationId, standardId, v11, {
          replacesVersionId: v10,
        }),
        publishVersion(owner(), tenant.organizationId, standardId, v13, {
          replacesVersionId: v10,
        }),
      ]);

      const statuses = results.map((result) => result.status).sort();
      expect(statuses).toEqual([200, 409]);
      const loser = results.find((result) => result.status === 409)!;
      expect(loser.body.error.code).toBe('CONFLICT');

      const winner = results.find((result) => result.status === 200)!;
      expect(await publishedCount(standardId)).toBe(1);
      const old = await context.adminDb.standardVersion.findUniqueOrThrow({ where: { id: v10 } });
      expect(old.status).toBe('SUPERSEDED');
      expect(old.supersededByVersionId).toBe(winner.body.id);
      const loserRow = await context.adminDb.standardVersion.findUniqueOrThrow({
        where: { id: winner.body.id === v11 ? v13 : v11 },
      });
      expect(loserRow.status).toBe('DRAFT');
      expect(loserRow.contentHash).toBeNull();
    });

    it('never leaves two versions in force, however publishes interleave', async () => {
      const seeded = await seedDraft(owner(), tenant.organizationId);
      await publishVersion(owner(), tenant.organizationId, seeded.standardId, seeded.versionId);

      for (let round = 0; round < 4; round += 1) {
        const drafts = await Promise.all(
          ['a', 'b', 'c'].map((suffix) => draftOf(seeded.standardId, `r${round}${suffix}`)),
        );
        // No precondition: the unique index and the in-force lock are all
        // that stand between these and two versions in force.
        const results = await Promise.all(
          drafts.map((id) => publishVersion(owner(), tenant.organizationId, seeded.standardId, id)),
        );
        for (const result of results) expect([200, 409]).toContain(result.status);
        expect(results.some((result) => result.status === 200)).toBe(true);
        expect(await publishedCount(seeded.standardId)).toBe(1);
      }

      // Every superseded version names a real, later-published successor.
      const rows = await context.adminDb.standardVersion.findMany({
        where: { standardId: seeded.standardId, status: 'SUPERSEDED' },
        include: { supersededBy: true },
      });
      for (const row of rows) {
        expect(row.supersededBy).not.toBeNull();
        expect(['PUBLISHED', 'SUPERSEDED']).toContain(row.supersededBy!.status);
        expect(row.supersededBy!.publishedAt!.getTime()).toBeGreaterThanOrEqual(
          row.publishedAt!.getTime(),
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('archiving stays separate and terminal', () => {
    it('archives the version in force deliberately, and the successor then supersedes nothing', async () => {
      const { standardId, v10, v12 } = await inForceAndDraft();

      const archived = await owner().post(`${base()}/${standardId}/versions/${v10}/archive`);
      expect(archived.status).toBe(201);
      expect(archived.body.status).toBe('ARCHIVED');

      const response = await publishVersion(owner(), tenant.organizationId, standardId, v12, {
        replacesVersionId: null,
      });
      expect(response.status).toBe(200);

      const old = await context.adminDb.standardVersion.findUniqueOrThrow({ where: { id: v10 } });
      expect(old.status).toBe('ARCHIVED');
      expect(old.supersededAt).toBeNull();
      expect(
        await context.adminDb.auditEvent.count({
          where: { action: 'STANDARD_VERSION_SUPERSEDED' },
        }),
      ).toBe(0);
    });

    it('refuses to publish or edit an archived version, and the database refuses to supersede it', async () => {
      const { standardId, v10, v12 } = await inForceAndDraft();
      await owner().post(`${base()}/${standardId}/versions/${v10}/archive`);

      const republish = await publishVersion(owner(), tenant.organizationId, standardId, v10);
      expect(republish.status).toBe(409);
      expect(republish.body.error.code).toBe('STANDARD_VERSION_ARCHIVED');

      await expect(
        context.adminDb.$executeRawUnsafe(
          `UPDATE standard_versions
             SET status = 'SUPERSEDED', superseded_at = now(), superseded_by_version_id = '${v12}'
           WHERE id = '${v10}'`,
        ),
      ).rejects.toThrow(/archived/i);
    });

    it('never converts an existing archived version into a superseded one', async () => {
      const { standardId, v10, v12 } = await inForceAndDraft();
      await owner().post(`${base()}/${standardId}/versions/${v10}/archive`);
      await publishVersion(owner(), tenant.organizationId, standardId, v12);
      const v13 = await draftOf(standardId, '1.3');
      await publishVersion(owner(), tenant.organizationId, standardId, v13);

      expect(await statusesOf(standardId)).toEqual({
        '1.0': 'ARCHIVED',
        '1.2': 'SUPERSEDED',
        '1.3': 'PUBLISHED',
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('tenancy and permissions', () => {
    it('does not let another organization publish, supersede or even see the draft', async () => {
      const { standardId, v10, v12 } = await inForceAndDraft();
      const intruder = await createTenant(context, 'Other University', 'owner@other.test');

      const crossTenant = await intruder.owner.client.post(
        `${standardsBase(intruder.organizationId)}/${standardId}/versions/${v12}/publish`,
        { replacesVersionId: v10 },
      );
      const wrongPath = await intruder.owner.client.post(
        `${base()}/${standardId}/versions/${v12}/publish`,
      );

      expect(crossTenant.status).toBe(404);
      expect([403, 404]).toContain(wrongPath.status);
      expect(await statusesOf(standardId)).toEqual({ '1.0': 'PUBLISHED', '1.2': 'DRAFT' });
    });

    it("treats another tenant's version id as a precondition that does not hold", async () => {
      const { standardId, v12 } = await inForceAndDraft();
      const intruder = await createTenant(context, 'Other University', 'owner@other.test');
      const foreign = await seedDraft(intruder.owner.client, intruder.organizationId);
      await publishVersion(
        intruder.owner.client,
        intruder.organizationId,
        foreign.standardId,
        foreign.versionId,
      );

      const response = await publishVersion(owner(), tenant.organizationId, standardId, v12, {
        replacesVersionId: foreign.versionId,
      });

      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).not.toContain(foreign.versionId);
      expect(await statusesOf(standardId)).toEqual({ '1.0': 'PUBLISHED', '1.2': 'DRAFT' });
    });

    it('refuses a member who may read but not publish', async () => {
      const { standardId, v12 } = await inForceAndDraft();
      const email = 'reviewer@iug.test';
      const reviewer = await createUser(context, email);
      const invitation = await inviteAndCaptureToken(
        context,
        owner(),
        tenant.organizationId,
        email,
        ORG_ROLE.REVIEWER,
      );
      const accepted = await reviewer.client.post(`${API}/invitations/accept`, {
        token: invitation.token,
      });
      expect(accepted.status).toBe(200);

      const read = await reviewer.client.get(`${base()}/${standardId}/versions/${v12}`);
      expect(read.status).toBe(200);
      const response = await publishVersion(
        reviewer.client,
        tenant.organizationId,
        standardId,
        v12,
      );

      expect(response.status).toBe(403);
      expect(await statusesOf(standardId)).toEqual({ '1.0': 'PUBLISHED', '1.2': 'DRAFT' });
    });
  });

  // -------------------------------------------------------------------------
  describe('checks and certificates keep their version', () => {
    it('keeps 1.0 on an existing check, report and certificate; a new check uses 1.2', async () => {
      const author = await createUser(context, 'author@example.com');
      const standard = await publishCheckableStandard(
        context,
        tenant.owner.client,
        tenant.organizationId,
      );
      const v10 = standard.standardVersionId;
      const v10Row = await context.adminDb.standardVersion.findUniqueOrThrow({
        where: { id: v10 },
      });

      // Before: a completed check, its report, and a certificate — all on 1.0.
      const oldCheck = await completedCheck(context, author, standard);
      const { revisionId } = await submitAndPrepare(context, author.client, oldCheck.checkId);
      await decide(tenant.owner.client, tenant.organizationId, revisionId, {
        toStatus: 'APPROVED',
      });
      const issued = await waitForCertificate(context, revisionId);
      expect(issued.issuanceStatus).toBe('ISSUED');
      const certificate = await readCertificate(author.client, issued.id);
      const code = certificate.body.verificationCode as string;
      const reportBefore = await author.client.get(`${API}/checks/${oldCheck.checkId}/report`);
      expect(reportBefore.status).toBe(200);

      // Publish 1.2 over it.
      const v12 = await draftOf(standard.standardId, '1.2');
      const published = await publishVersion(
        tenant.owner.client,
        tenant.organizationId,
        standard.standardId,
        v12,
        { replacesVersionId: v10 },
      );
      expect(published.status).toBe(200);

      // The existing check still reports exactly 1.0.
      const oldView = await author.client.get(`${API}/checks/${oldCheck.checkId}`);
      expect(oldView.status).toBe(200);
      expect(oldView.body.standardVersionId).toBe(v10);
      expect(oldView.body.standardVersionLabel).toBe('1.0');
      const reportAfter = await author.client.get(`${API}/checks/${oldCheck.checkId}/report`);
      expect(reportAfter.status).toBe(200);
      expect(reportAfter.body).toEqual(reportBefore.body);
      const artifact = await author.client.get(`${API}/checks/${oldCheck.checkId}/report/artifact`);
      expect(artifact.status).toBe(200);
      const artifactText = JSON.stringify(artifact.body);
      expect(artifactText).toContain(v10Row.contentHash!);

      // A check that captured 1.0 can still load its snapshot to evaluate.
      const snapshot = await context.adminDb.$queryRawUnsafe<Array<{ content_hash: string }>>(
        `SELECT content_hash FROM app_check_standard_snapshot('${v10}'::uuid)`,
      );
      expect(snapshot.map((row) => row.content_hash)).toEqual([v10Row.contentHash]);
      const identity = await context.adminDb.$queryRawUnsafe<Array<{ version_label: string }>>(
        `SELECT version_label FROM app_check_standard_identity('${v10}'::uuid)`,
      );
      expect(identity.map((row) => row.version_label)).toEqual(['1.0']);

      // The certificate still verifies, against 1.0.
      const verified = await verify(context, code);
      expect(verified.status).toBe(200);
      expect(verified.body.verificationStatus).toBe('VALID');
      expect(verified.body.standardVersionLabel).toBe('1.0');
      expect(verified.body.standardContentHash).toBe(v10Row.contentHash);
      const certificateAfter = await readCertificate(author.client, issued.id);
      expect(certificateAfter.status).toBe(200);
      expect(certificateAfter.body.standardVersionLabel).toBe('1.0');

      // The history view can say what still relies on 1.0.
      const usage = await tenant.owner.client.get(
        `${base()}/${standard.standardId}/versions/${v10}/usage`,
      );
      expect(usage.status).toBe(200);
      expect(usage.body).toEqual({
        standardVersionId: v10,
        submissionCount: 1,
        certificateCount: 1,
      });

      // A new check resolves the version in force: 1.2.
      const newCheck = await completedCheck(context, author, standard);
      const newView = await author.client.get(`${API}/checks/${newCheck.checkId}`);
      expect(newView.body.standardVersionId).toBe(v12);
      expect(newView.body.standardVersionLabel).toBe('1.2');
    });
  });
});
