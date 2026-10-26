import supertest from 'supertest';
import { API, type AuthClient } from './support/auth-client';
import {
  publishCheckableStandard,
  setCheckAvailability,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx } from './support/fixtures';
import { createTenant, createUser } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Isolation around checks (§57, §65–§71, §126).
 *
 * Two properties, and both matter more than any feature in this phase.
 *
 * **A check is private to its owner.** Another student cannot see it, read its
 * findings, fetch its report, or learn that it exists.
 *
 * **Publishing a standard buys an institution nothing.** A university whose
 * standard a student checks against gains no sight of the document, the check,
 * the findings, the report or the score. This is the whole basis on which a
 * student can be asked to trust the platform with unpublished research.
 */
describe('Document checks - isolation (e2e)', () => {
  let context: TestContext;
  let student: { email: string; userId: string; client: AuthClient };
  let stranger: { email: string; userId: string; client: AuthClient };
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let standard: PublishedStandard;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    student = await createUser(context, 'student@example.com');
    stranger = await createUser(context, 'stranger@example.com');
    tenant = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
    standard = await publishCheckableStandard(context, tenant.owner.client, tenant.organizationId);
  });

  async function completedCheck(): Promise<{ checkId: string; versionId: string }> {
    const document = await createDocument(student.client, 'Thesis');
    const { versionId } = await uploadAndProcess(student.client, document.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);
    return { checkId: created.body.id, versionId };
  }

  describe('a check is private to its owner', () => {
    it('hides another user’s check behind a 404, never a 403', async () => {
      // The difference would confirm the id exists, which is itself a leak.
      const { checkId } = await completedCheck();

      for (const path of [
        `/checks/${checkId}`,
        `/checks/${checkId}/results`,
        `/checks/${checkId}/report`,
        `/checks/${checkId}/report/artifact`,
      ]) {
        const response = await stranger.client.get(`${API}${path}`);
        expect([response.status, path]).toEqual([404, path]);
      }
    });

    it('excludes another user’s checks from the list', async () => {
      await completedCheck();
      const list = await stranger.client.get(`${API}/checks`);
      expect(list.status).toBe(200);
      expect(list.body.items).toEqual([]);
    });

    it('refuses to retry another user’s check', async () => {
      const { checkId } = await completedCheck();
      const response = await stranger.client.post(`${API}/checks/${checkId}/retry`);
      expect(response.status).toBe(404);
    });

    it('refuses to check another user’s document version', async () => {
      // The version id is real; it simply is not this caller's, and row-level
      // security means their session cannot see it at all.
      const document = await createDocument(student.client, 'Thesis');
      const { versionId } = await uploadAndProcess(student.client, document.id, {
        name: 'thesis.docx',
        bytes: minimalDocx(),
      });

      const response = await startCheck(context, stranger, {
        documentVersionId: versionId,
        standardId: standard.standardId,
      });
      expect(response.status).toBe(404);
    });

    it('keeps every stored row scoped to its owner', async () => {
      const { checkId } = await completedCheck();
      const run = await context.adminDb.checkRun.findFirstOrThrow({ where: { checkId } });
      const results = await context.adminDb.checkRuleResult.findMany({
        where: { checkRunId: run.id },
      });
      const report = await context.adminDb.checkReport.findFirstOrThrow({ where: { checkId } });

      // Every table carries the owner explicitly, which is what the row-level
      // security policies are written against (ADR-0018).
      expect(run.ownerUserId).toBe(student.userId);
      expect(report.ownerUserId).toBe(student.userId);
      for (const result of results) expect(result.ownerUserId).toBe(student.userId);
    });
  });

  describe('the publishing organization sees nothing', () => {
    it('gives the standard’s owner no access to a check against it', async () => {
      const { checkId } = await completedCheck();

      // The registrar owns the standard and the organization. They still have
      // no route to this student's check (§57).
      for (const path of [
        `/checks/${checkId}`,
        `/checks/${checkId}/results`,
        `/checks/${checkId}/report`,
        `/checks/${checkId}/report/artifact`,
      ]) {
        const response = await tenant.owner.client.get(`${API}${path}`);
        expect([response.status, path]).toEqual([404, path]);
      }

      const list = await tenant.owner.client.get(`${API}/checks`);
      expect(list.body.items).toEqual([]);
    });

    it('gives the organization no route to the student’s document', async () => {
      const { versionId } = await completedCheck();
      const response = await tenant.owner.client.get(`${API}/documents`);
      expect(response.body.items).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain(versionId);
    });

    it('does not tell the organization that its standard was checked against', async () => {
      await completedCheck();

      // No counter, no timestamp, no event: nothing in the organization's own
      // view of its standard changes because someone checked against it.
      const standardView = await tenant.owner.client.get(
        `${API}/organizations/${tenant.organizationId}/standards/${standard.standardId}`,
      );
      expect(standardView.status).toBe(200);
      const body = JSON.stringify(standardView.body);
      expect(body).not.toMatch(/checkCount|lastCheckedAt|usage/i);
    });
  });

  describe('the catalogue exposes only what was deliberately published', () => {
    it('does not list a standard the organization kept private', async () => {
      // The default is PRIVATE and stays PRIVATE: exposure is a deliberate
      // act, never a side effect (§16).
      const privateStandard = await publishCheckableStandard(
        context,
        tenant.owner.client,
        tenant.organizationId,
        { standardCode: 'IUG.PRIVATE', documentTypeName: 'Internal Report', public: false },
      );

      const standards = await student.client.get(
        `${API}/catalogue/document-types/${privateStandard.documentTypeId}/standards`,
      );
      expect(standards.body).toEqual([]);

      const direct = await student.client.get(
        `${API}/catalogue/standards/${privateStandard.standardId}`,
      );
      expect(direct.status).toBe(404);
      expect(direct.body.error.code).toBe('CHECK_STANDARD_NOT_AVAILABLE');
    });

    it('refuses to check against a private standard even with its id', async () => {
      const privateStandard = await publishCheckableStandard(
        context,
        tenant.owner.client,
        tenant.organizationId,
        { standardCode: 'IUG.PRIVATE.2', documentTypeName: 'Internal Memo', public: false },
      );
      const document = await createDocument(student.client, 'Thesis');
      const { versionId } = await uploadAndProcess(student.client, document.id, {
        name: 'thesis.docx',
        bytes: minimalDocx(),
      });

      // Listing and creation ask the same database function the same
      // question, so they cannot disagree about what is checkable (§21).
      const response = await startCheck(context, student, {
        documentVersionId: versionId,
        standardId: privateStandard.standardId,
      });
      expect(response.status).toBe(404);
    });

    it('does not list an unverified organization’s standards', async () => {
      const other = await createTenant(context, 'Unverified College', 'other@example.com');
      const otherStandard = await publishCheckableStandard(
        context,
        other.owner.client,
        other.organizationId,
      );
      await context.adminDb.organization.update({
        where: { id: other.organizationId },
        data: { verificationStatus: 'UNVERIFIED' },
      });

      const organizations = await student.client.get(`${API}/catalogue/organizations`);
      expect(organizations.body.map((item: { id: string }) => item.id)).not.toContain(
        other.organizationId,
      );
      const direct = await student.client.get(
        `${API}/catalogue/standards/${otherStandard.standardId}`,
      );
      expect(direct.status).toBe(404);
    });

    it('never exposes a standard’s rules through the catalogue', async () => {
      // "Which standards can I check against" and "what exactly does this
      // standard require" are different questions (§22).
      const organizations = await student.client.get(`${API}/catalogue/organizations`);
      const documentTypes = await student.client.get(
        `${API}/catalogue/organizations/${tenant.organizationId}/document-types`,
      );
      const standards = await student.client.get(
        `${API}/catalogue/document-types/${standard.documentTypeId}/standards`,
      );

      for (const response of [organizations, documentTypes, standards]) {
        const body = JSON.stringify(response.body);
        expect(body).not.toMatch(/"operator"|"expected"|"scope"|"rules"/);
      }
      // The rule *count* is safe and useful; the rules themselves are not.
      expect(standards.body[0].ruleCount).toBeGreaterThan(0);
    });

    it('stops new checks when a standard is withdrawn from the catalogue', async () => {
      const withdrawal = await setCheckAvailability(
        tenant.owner.client,
        tenant.organizationId,
        standard.standardId,
        'PRIVATE',
      );
      expect(withdrawal.status).toBe(200);

      const document = await createDocument(student.client, 'Thesis');
      const { versionId } = await uploadAndProcess(student.client, document.id, {
        name: 'thesis.docx',
        bytes: minimalDocx(),
      });
      const response = await startCheck(context, student, {
        documentVersionId: versionId,
        standardId: standard.standardId,
      });
      expect(response.status).toBe(404);
    });

    it('refuses to publish a standard to the catalogue without the permission', async () => {
      const outsider = await createUser(context, 'outsider@example.com');
      const response = await setCheckAvailability(
        outsider.client,
        tenant.organizationId,
        standard.standardId,
        'PUBLIC_CHECKABLE',
      );
      expect([403, 404]).toContain(response.status);
    });

    it('records who exposed a standard and when', async () => {
      // Making an institution's standard world-visible is a deliberate act
      // with a named actor (§99).
      const events = await context.adminDb.auditEvent.findMany({
        where: { action: 'STANDARD_CHECK_AVAILABILITY_CHANGED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.actorUserId).toBe(tenant.owner.userId);
      expect(events[0]!.targetId).toBe(standard.standardId);
    });
  });

  describe('the report artifact is never publicly reachable', () => {
    it('serves it only through the authenticated API', async () => {
      const { checkId } = await completedCheck();
      const report = await context.adminDb.checkReport.findFirstOrThrow({ where: { checkId } });

      // The key is an internal detail and never leaves the API (§53).
      const metadata = await student.client.get(`${API}/checks/${checkId}/report`);
      expect(JSON.stringify(metadata.body)).not.toContain(report.artifactObjectKey);

      const anonymous = await supertest(context.app.getHttpServer()).get(
        `${API}/checks/${checkId}/report/artifact`,
      );
      expect(anonymous.status).toBe(401);
    });
  });
});
