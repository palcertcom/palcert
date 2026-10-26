import { API } from './support/auth-client';
import {
  grantOrganizationAIConsent,
  runExtraction,
  uploadSource,
} from './support/extraction-client';
import {
  equationDocx,
  equationObject,
  mathTypeEquationDocx,
  packagedExecutableObject,
} from './support/ole-fixtures';
import { createTenant } from './support/organization-client';
import { realPhdEquationDocx } from './support/real-phd-template';
import { createDocumentType, createStandard, createVersion } from './support/standards-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * A thesis template with scientific equations reaches extraction (STANDARD_SOURCE_INGEST).
 *
 * The real case: an institution uploaded its PhD template as "Template (Word)",
 * "Primary", and the worker refused it with FILE_EMBEDDED_OBJECT_UNSUPPORTED
 * because of one MathType equation. The same worker must now accept that, and
 * must go on refusing everything else it refused before.
 */
describe('Legacy equations in a standard source (e2e)', () => {
  let context: TestContext;
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let organizationId: string;
  let versionId: string;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    tenant = await createTenant(context, 'Thesis University', 'registrar@example.com');
    organizationId = tenant.organizationId;
    const documentType = await createDocumentType(tenant.owner.client, organizationId);
    const standard = await createStandard(tenant.owner.client, organizationId, documentType.id);
    versionId = (await createVersion(tenant.owner.client, organizationId, standard.id)).id;
  });

  const sourcesBase = () =>
    `${API}/organizations/${organizationId}/standard-versions/${versionId}/sources`;

  it('accepts the thesis template with a MathType equation, says so, and reads it', async () => {
    await grantOrganizationAIConsent(tenant.owner.client, organizationId);
    const source = await uploadSource(context, tenant.owner.client, organizationId, versionId, {
      sourceKind: 'TEMPLATE_DOCX',
      authority: 'PRIMARY',
      filename: 'PhD_Template_00.docx',
      bytes: mathTypeEquationDocx(),
    });

    const row = await context.adminDb.standardSourceAsset.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(row.status).toBe('READY');
    expect(row.rejectionCode).toBeNull();
    expect(row.legacyEquationCount).toBe(1);
    // Promoted unchanged: the equation was not stripped to get it through.
    expect(row.sha256).toBe(source.sha256);

    const view = await tenant.owner.client.get(`${sourcesBase()}/${source.id}`);
    expect(view.status).toBe(200);
    expect(view.body.legacyEquationCount).toBe(1);

    // And the workflow goes on: reading the sources starts and settles.
    const { status } = await runExtraction(context, tenant.owner.client, organizationId, versionId);
    expect(status).toBe('COMPLETED');
  });

  it('accepts the real PhD template’s equation and reads the source', async () => {
    await grantOrganizationAIConsent(tenant.owner.client, organizationId);
    const source = await uploadSource(context, tenant.owner.client, organizationId, versionId, {
      sourceKind: 'TEMPLATE_DOCX',
      authority: 'PRIMARY',
      filename: 'PhD_Template_00.docx',
      bytes: realPhdEquationDocx(),
    });
    const row = await context.adminDb.standardSourceAsset.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(row.status).toBe('READY');
    expect(row.legacyEquationCount).toBe(1);
    const { status } = await runExtraction(context, tenant.owner.client, organizationId, versionId);
    expect(status).toBe('COMPLETED');
  });

  // The whole 628 KB template exceeds this harness's 256 KB DOCX limit; it is
  // exercised unmodified in embedded-objects.spec.ts (PALCERT_REAL_TEMPLATE)
  // and uploaded on staging, where production limits apply.

  it('accepts a guideline mixing OMML and several legacy equations', async () => {
    const source = await uploadSource(context, tenant.owner.client, organizationId, versionId, {
      sourceKind: 'GUIDELINE_DOCX',
      filename: 'formatting-guide.docx',
      bytes: equationDocx({
        omml: true,
        objects: [
          { progId: 'Equation.DSMT4', bytes: equationObject('Equation.DSMT4'), number: '3.1' },
          { progId: 'Equation.3', bytes: equationObject('Equation.3'), number: '3.2' },
        ],
      }),
    });
    const row = await context.adminDb.standardSourceAsset.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(row.status).toBe('READY');
    expect(row.legacyEquationCount).toBe(2);
  });

  it('tells the AI an equation is there, rather than dropping it', async () => {
    await grantOrganizationAIConsent(tenant.owner.client, organizationId);
    context.documentEngine.extraParagraphs = [
      {
        locator: { nodeId: 'main/body/p:4', path: ['main', 'body', 'p:4'], story: 'MAIN_DOCUMENT' },
        story: 'MAIN_DOCUMENT',
        text: '',
      },
    ];
    context.documentEngine.equations = [
      {
        locator: { nodeId: 'main/body/p:4/r:2/math', path: ['main', 'body', 'p:4', 'r:2', 'math'] },
        display: false,
        sourceFormat: 'legacy-ole',
        legacyClass: 'Equation.DSMT4',
        previewAvailable: true,
        semanticsAvailable: false,
        order: 1,
        paragraphNodeId: 'main/body/p:4',
        number: '3.1',
      },
    ];
    await uploadSource(context, tenant.owner.client, organizationId, versionId, {
      sourceKind: 'GUIDELINE_DOCX',
      filename: 'formatting-guide.docx',
      bytes: mathTypeEquationDocx(),
    });
    await runExtraction(context, tenant.owner.client, organizationId, versionId);

    const blocks = context.aiProvider.discoveryCalls.flatMap((call) =>
      call.documents.flatMap((document) => ('blocks' in document ? document.blocks : [])),
    );
    expect(blocks).toContain(
      '[Equation (3.1): legacy Equation.DSMT4 object, processed in safe mode; mathematical content not available]',
    );
  });

  it('still refuses an embedded executable that claims to be an equation', async () => {
    const source = await uploadSource(context, tenant.owner.client, organizationId, versionId, {
      sourceKind: 'TEMPLATE_DOCX',
      filename: 'template.docx',
      bytes: equationDocx({
        objects: [{ progId: 'Equation.DSMT4', bytes: packagedExecutableObject(), number: '3.1' }],
      }),
    });
    const row = await context.adminDb.standardSourceAsset.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(row.status).toBe('REJECTED');
    expect(row.rejectionCode).toBe('FILE_EMBEDDED_OBJECT_UNSUPPORTED');
    expect(row.cleanObjectKey).toBeNull();
    expect(row.legacyEquationCount).toBe(0);

    const view = await tenant.owner.client.get(`${sourcesBase()}/${source.id}`);
    expect(view.body.rejectionCode).toBe('FILE_EMBEDDED_OBJECT_UNSUPPORTED');
  });

  it('still refuses an unknown OLE object', async () => {
    const source = await uploadSource(context, tenant.owner.client, organizationId, versionId, {
      sourceKind: 'GUIDELINE_DOCX',
      filename: 'guide.docx',
      bytes: equationDocx({
        objects: [{ progId: 'Package', bytes: packagedExecutableObject() }],
      }),
    });
    const row = await context.adminDb.standardSourceAsset.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(row.status).toBe('REJECTED');
    expect(row.rejectionCode).toBe('FILE_EMBEDDED_OBJECT_UNSUPPORTED');
  });
});
