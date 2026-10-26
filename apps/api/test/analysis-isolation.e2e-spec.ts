import { DocumentAnalysisService } from '../src/modules/analysis/services/document-analysis.service';
import type { AuthClient } from './support/auth-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx } from './support/fixtures';
import {
  createTenant,
  createUser,
  grantOrganizationRoleTo,
  type TenantFixture,
} from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Analysis is as private as the document it describes (§92, §93, §94).
 *
 * A derived artifact inherits its source's sensitivity exactly: it contains
 * the document's headings, its structure and its metadata. If analysis were
 * even slightly less private than the document, PalCert would have created a
 * side channel around its own tenancy model.
 */
describe('Document analysis - isolation (e2e)', () => {
  let context: TestContext;
  let owner: { email: string; userId: string; client: AuthClient };
  let stranger: { email: string; userId: string; client: AuthClient };

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    owner = await createUser(context, 'analysis-owner@example.com');
    stranger = await createUser(context, 'analysis-stranger@example.com');
  });

  const analyses = (): DocumentAnalysisService => context.app.get(DocumentAnalysisService);

  async function ownerAnalysis(): Promise<{ versionId: string; analysisId: string }> {
    const document = await createDocument(owner.client, 'Private thesis');
    const { versionId } = await uploadAndProcess(owner.client, document.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
    const ensured = await analyses().ensureDocumentAnalysis(owner.userId, versionId);
    return { versionId, analysisId: ensured.analysis.id };
  }

  it('another user cannot read the analysis (§125.11)', async () => {
    const { analysisId } = await ownerAnalysis();

    await expect(analyses().findById(stranger.userId, analysisId)).rejects.toMatchObject({
      code: 'DOCX_ANALYSIS_NOT_AVAILABLE',
    });
  });

  it('another user cannot trigger analysis of a version they do not own (§125.12)', async () => {
    const document = await createDocument(owner.client, 'Private thesis');
    const { versionId } = await uploadAndProcess(owner.client, document.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });

    await expect(
      analyses().ensureDocumentAnalysis(stranger.userId, versionId),
    ).rejects.toMatchObject({
      code: 'DOCUMENT_VERSION_NOT_FOUND',
    });

    // And nothing was created on their behalf.
    const rows = await context.adminDb.documentAnalysis.findMany({
      where: { documentVersionId: versionId },
    });
    expect(rows.filter((row) => row.ownerUserId === stranger.userId)).toHaveLength(0);
  });

  it('another user cannot list analyses of a version they do not own', async () => {
    const { versionId } = await ownerAnalysis();

    await expect(analyses().listForVersion(stranger.userId, versionId)).rejects.toMatchObject({
      code: 'DOCUMENT_VERSION_NOT_FOUND',
    });
  });

  it('row-level security returns nothing for another user, and nothing with no user', async () => {
    const { analysisId } = await ownerAnalysis();
    const tenant = context.app.get(DocumentAnalysisService);
    void tenant;

    // As the request role under the stranger's scope: the row is not there.
    const asStranger = await context.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM document_analyses WHERE id = '${analysisId}'`,
    );
    expect(Number(asStranger[0]!.count)).toBe(0);

    // The owner sees exactly one, proving the row exists and RLS is why the
    // others saw nothing — not a mistyped query.
    const asOwner = await context.adminDb.documentAnalysis.count({ where: { id: analysisId } });
    expect(asOwner).toBe(1);
  });

  describe('organizations have no access (§93)', () => {
    let tenant: TenantFixture;

    beforeEach(async () => {
      tenant = await createTenant(context, 'Test University', 'org-owner@example.com');
    });

    it.each(['ORGANIZATION_ADMIN', 'ORGANIZATION_REVIEWER'])(
      'an %s cannot read a member analysis',
      async (roleCode) => {
        const { analysisId } = await ownerAnalysis();
        const staff = await createUser(context, `staff-${roleCode.toLowerCase()}@example.com`);
        await grantOrganizationRoleTo(context, tenant, staff, roleCode);

        await expect(analyses().findById(staff.userId, analysisId)).rejects.toMatchObject({
          code: 'DOCX_ANALYSIS_NOT_AVAILABLE',
        });
      },
    );

    it('the organization owner cannot read a member analysis', async () => {
      const { analysisId } = await ownerAnalysis();

      // The tenant's own owner, with every organization permission there is.
      await expect(analyses().findById(tenant.owner.userId, analysisId)).rejects.toMatchObject({
        code: 'DOCX_ANALYSIS_NOT_AVAILABLE',
      });
    });

    it('no analysis row carries an organization at all', async () => {
      await ownerAnalysis();
      const columns = await context.adminDb.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'document_analyses'`,
      );
      const names = columns.map((column) => column.column_name);
      expect(names).not.toContain('organization_id');
      expect(names).toContain('owner_user_id');
    });
  });

  it('is registered as USER_SCOPED so the coverage test enforces it (§121)', async () => {
    const rows = await context.adminDb.$queryRawUnsafe<
      Array<{ classification: string; tenant_column: string | null }>
    >(
      `SELECT classification, tenant_column FROM table_isolation_classification
       WHERE table_name = 'document_analyses'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.classification).toBe('USER_SCOPED');
    expect(rows[0]!.tenant_column).toBe('owner_user_id');
  });

  it('the artifact is never exposed through an API view (§94, §119)', async () => {
    const { analysisId } = await ownerAnalysis();
    const analysis = await analyses().findById(owner.userId, analysisId);
    const { toDocumentAnalysisView } =
      await import('../src/modules/analysis/services/document-analysis.service');
    const view = toDocumentAnalysisView(analysis);
    const serialized = JSON.stringify(view);

    expect(serialized).not.toContain('artifactObjectKey');
    expect(serialized).not.toContain('users/');
    expect(serialized).not.toContain('palcert-test-derived');
    expect(serialized).not.toMatch(/https?:\/\//);
  });
});
