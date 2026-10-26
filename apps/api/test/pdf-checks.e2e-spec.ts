import { API, type AuthClient } from './support/auth-client';
import {
  publishCheckableStandard,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx, minimalPdf } from './support/fixtures';
import { createTenant, createUser } from './support/organization-client';
import { validRule } from './support/standards-client';
import { purchaseOf, readCheck, serviceCharges } from './support/paid-check-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Paid checks against PDFs, end to end (Phase 13 §63-§66, §83-§87).
 *
 * The analyzer is proved by the Python golden corpus; this suite is about what
 * PalCert does *around* a PDF: which analyzer it reaches for, what it tells a
 * user before they pay, what it refuses to sell, and what happens to their
 * money when a PDF cannot be read at all.
 *
 * The one sentence underneath all of it: **PalCert charges for a report it
 * could actually produce, and says beforehand what that report can contain.**
 */
describe('PDF checks - orchestration (e2e)', () => {
  let context: TestContext;
  let student: { email: string; userId: string; client: AuthClient };
  let tenant: Awaited<ReturnType<typeof createTenant>>;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    student = await createUser(context, 'student@example.com');
    tenant = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
  });

  /** A standard whose rules a PDF can answer: page geometry and typography. */
  async function pdfFriendlyStandard(): Promise<PublishedStandard> {
    return publishCheckableStandard(context, tenant.owner.client, tenant.organizationId, {
      standardCode: 'IUG.THESIS.PAGES',
      rules: [
        validRule({
          ruleCode: 'PAGE.COUNT.MIN',
          category: 'PAGE_SETUP',
          scope: { kind: 'DOCUMENT', property: 'pageCount' },
          unit: 'PAGES',
          expected: { type: 'NUMBER', number: 1 },
          titleEn: 'At least one page',
          titleAr: 'صفحة واحدة على الأقل',
        }),
        validRule({
          ruleCode: 'FONT.SIZE.MIN',
          category: 'TYPOGRAPHY',
          scope: { kind: 'ELEMENT', elementType: 'PARAGRAPH', property: 'fontSize' },
          unit: 'POINT',
          expected: { type: 'NUMBER', number: 12 },
          titleEn: 'Body text at least 12pt',
          titleAr: 'حجم النص 12 نقطة على الأقل',
        }),
      ],
    });
  }

  /** A standard about Word authoring properties, which a PDF does not store. */
  async function docxOnlyStandard(): Promise<PublishedStandard> {
    return publishCheckableStandard(context, tenant.owner.client, tenant.organizationId, {
      standardCode: 'IUG.THESIS.MARGINS',
      documentTypeName: 'Margins thesis',
      // `marginTop` is the authoring instruction a Word document stores. A PDF
      // records where ink landed, which is a different thing (§55).
      rules: [validRule()],
    });
  }

  async function readyPdf(): Promise<string> {
    const document = await createDocument(student.client, 'Thesis');
    const { versionId } = await uploadAndProcess(student.client, document.id, {
      name: 'thesis.pdf',
      bytes: minimalPdf('A thesis rendered to PDF'),
    });
    return versionId;
  }

  async function readyDocx(): Promise<string> {
    const document = await createDocument(student.client, 'Thesis');
    const { versionId } = await uploadAndProcess(student.client, document.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
    return versionId;
  }

  function compatibility(standardId: string, documentVersionId: string) {
    return student.client.get(
      `${API}/catalogue/standards/${standardId}/compatibility?documentVersionId=${documentVersionId}`,
    );
  }

  // -------------------------------------------------------------------------
  // The compatibility preview, before any money moves (§63, §64)
  // -------------------------------------------------------------------------

  it('says what a PDF can answer before the user pays', async () => {
    const standard = await pdfFriendlyStandard();
    const response = await compatibility(standard.standardId, await readyPdf());

    expect(response.status).toBe(200);
    expect(response.body.format).toBe('PDF');
    expect(response.body.level).toBe('FULL');
    expect(response.body.totalRules).toBe(2);
    expect(response.body.supportedRules).toBe(2);
    expect(response.body.unsupportedProperties).toEqual([]);
  });

  it('names the rules a PDF cannot answer, and why', async () => {
    const standard = await publishCheckableStandard(
      context,
      tenant.owner.client,
      tenant.organizationId,
      {
        standardCode: 'IUG.THESIS.MIXED',
        rules: [
          validRule({
            ruleCode: 'PAGE.COUNT.MIN',
            scope: { kind: 'DOCUMENT', property: 'pageCount' },
            unit: 'PAGES',
            expected: { type: 'NUMBER', number: 1 },
          }),
          validRule(),
        ],
      },
    );

    const body = (await compatibility(standard.standardId, await readyPdf())).body;
    expect(body.level).toBe('PARTIAL');
    expect(body.supportedRules).toBe(1);
    expect(body.unsupportedRules).toBe(1);
    expect(body.unsupportedProperties).toEqual(['marginTop']);

    const refused = body.rules.find(
      (rule: { ruleCode: string }) => rule.ruleCode === 'MARGIN.TOP.MIN',
    );
    expect(refused.support).toBe('UNSUPPORTED');
    // A reason a person can read, not a code they have to look up.
    expect(refused.note.length).toBeGreaterThan(10);
  });

  it('gives the same standard a different answer for a DOCX', async () => {
    // The point of the preview: support is a property of the *pair*, and the
    // margin rule a PDF cannot answer is exactly what a DOCX is best at.
    const standard = await docxOnlyStandard();

    const pdf = (await compatibility(standard.standardId, await readyPdf())).body;
    const docx = (await compatibility(standard.standardId, await readyDocx())).body;

    expect(pdf.level).toBe('NONE');
    expect(docx.level).toBe('FULL');
  });

  it('does not open the document to answer the preview', async () => {
    // §63: the preview is free and static. Opening the document is the work
    // the user has not paid for.
    const standard = await pdfFriendlyStandard();
    await compatibility(standard.standardId, await readyPdf());
    expect(context.documentEngine.calls).toHaveLength(0);
  });

  it("refuses the preview for a stranger's document", async () => {
    const standard = await pdfFriendlyStandard();
    const versionId = await readyPdf();
    const stranger = await createUser(context, 'stranger@example.com');

    const response = await stranger.client.get(
      `${API}/catalogue/standards/${standard.standardId}/compatibility?documentVersionId=${versionId}`,
    );
    // The same answer a nonexistent id gets: the preview must not become a way
    // to learn that someone else's document exists (ADR-0017).
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('DOCUMENT_VERSION_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // What PalCert refuses to sell (§66)
  // -------------------------------------------------------------------------

  it('refuses a check whose standard a PDF can answer nothing of, before charging', async () => {
    const standard = await docxOnlyStandard();
    const versionId = await readyPdf();

    const response = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('CHECK_STANDARD_NOT_SUPPORTED_FOR_FORMAT');

    // Refused before the reservation, so nothing was reserved and nothing
    // spent — not a refund afterwards, which would still have moved money.
    expect(await serviceCharges(context, student.userId)).toHaveLength(0);
    const purchases = await context.adminDb.servicePurchase.findMany({
      where: { ownerUserId: student.userId },
    });
    expect(purchases).toHaveLength(0);
    const checks = await context.adminDb.documentCheck.findMany({
      where: { ownerUserId: student.userId },
    });
    expect(checks).toHaveLength(0);
  });

  it('sells a partially supported standard rather than refusing it', async () => {
    // Partial coverage is a useful check: the rules PalCert can answer are
    // answered, and the rest come back INDETERMINATE with a reason. Refusing
    // it would be refusing to do work the user wants done.
    const standard = await publishCheckableStandard(
      context,
      tenant.owner.client,
      tenant.organizationId,
      {
        standardCode: 'IUG.THESIS.PARTIAL',
        rules: [
          validRule({
            ruleCode: 'PAGE.COUNT.MIN',
            scope: { kind: 'DOCUMENT', property: 'pageCount' },
            unit: 'PAGES',
            expected: { type: 'NUMBER', number: 1 },
          }),
          validRule(),
        ],
      },
    );

    const response = await startCheck(context, student, {
      documentVersionId: await readyPdf(),
      standardId: standard.standardId,
    });
    expect(response.status).toBe(202);
  });

  // -------------------------------------------------------------------------
  // The check itself (§83-§87)
  // -------------------------------------------------------------------------

  it('runs a paid PDF check through the PDF analyzer and charges once', async () => {
    const standard = await pdfFriendlyStandard();
    const versionId = await readyPdf();

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    expect(created.status).toBe(202);

    const settled = await waitForCheck(context, created.body.id);
    expect(settled).toEqual({ status: 'COMPLETED', failureCode: null });

    // The PDF analyzer, chosen from the version's detected format (§83).
    expect(context.documentEngine.calls).toHaveLength(1);
    expect(context.documentEngine.calls[0]!.format).toBe('PDF');

    const analysis = await context.adminDb.documentAnalysis.findFirstOrThrow({
      where: { documentVersionId: versionId },
    });
    expect(analysis.analyzerName).toBe('palcert-pdf');
    expect(analysis.status).toBe('SUCCEEDED');

    const purchase = await purchaseOf(context, created.body.id);
    expect(purchase!.status).toBe('DELIVERED');
    expect(await serviceCharges(context, student.userId)).toHaveLength(1);
  });

  it('leaves the DOCX path exactly as it was', async () => {
    // §11: Phase 13 must not destabilize the existing analyzer. A DOCX check
    // still reaches the DOCX analyzer and still records its identity.
    const standard = await docxOnlyStandard();
    const versionId = await readyDocx();

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    const settled = await waitForCheck(context, created.body.id);
    expect(settled).toEqual({ status: 'COMPLETED', failureCode: null });

    expect(context.documentEngine.calls[0]!.format).toBe('DOCX');
    const analysis = await context.adminDb.documentAnalysis.findFirstOrThrow({
      where: { documentVersionId: versionId },
    });
    expect(analysis.analyzerName).toBe('palcert-docx');
  });

  it('tells the report what the PDF was, in counters and nothing else', async () => {
    // §153: the report page needs three things about a PDF that it never needs
    // about a DOCX. §107: it gets them as counters, never as content.
    const standard = await pdfFriendlyStandard();
    const created = await startCheck(context, student, {
      documentVersionId: await readyPdf(),
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);

    const view = (await readCheck(student.client, created.body.id)).body;
    expect(view.documentFormat).toBe('PDF');
    expect(view.pdfDocument).toMatchObject({
      textLayer: expect.stringMatching(/NATIVE_TEXT|IMAGE_ONLY|HYBRID|EMPTY_OR_UNKNOWN/),
      tagged: expect.any(Boolean),
      pageCount: expect.any(Number),
      imageOnlyPages: expect.any(Number),
      nativeTextPages: expect.any(Number),
    });
    // Counters only: no title, no filename, no extracted text.
    expect(Object.keys(view.pdfDocument).sort()).toEqual([
      'imageOnlyPages',
      'nativeTextPages',
      'pageCount',
      'tagged',
      'textLayer',
    ]);
  });

  it('gives a DOCX check no PDF panel to render', async () => {
    const standard = await docxOnlyStandard();
    const created = await startCheck(context, student, {
      documentVersionId: await readyDocx(),
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);

    const view = (await readCheck(student.client, created.body.id)).body;
    expect(view.documentFormat).toBe('DOCX');
    expect(view.pdfDocument).toBeNull();
  });

  // -------------------------------------------------------------------------
  // When a PDF cannot be read (§19, §79)
  // -------------------------------------------------------------------------

  it('settles without charge when the PDF needs a password', async () => {
    // §19, §79: a fatal analysis failure releases the reservation and charges
    // nothing. PalCert does not collect the password and does not try to
    // bypass it, so this is the end of the road for these bytes.
    const standard = await pdfFriendlyStandard();
    const versionId = await readyPdf();
    context.documentEngine.mode = 'password-required';

    const created = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    expect(created.status).toBe(202);

    const settled = await waitForCheck(context, created.body.id);
    expect(settled.status).toBe('FAILED');

    const analysis = await context.adminDb.documentAnalysis.findFirstOrThrow({
      where: { documentVersionId: versionId },
    });
    expect(analysis.status).toBe('FAILED');
    expect(analysis.failureCode).toBe('DOCUMENT_PASSWORD_REQUIRED');

    const purchase = await purchaseOf(context, created.body.id);
    expect(purchase!.status).toBe('RELEASED');
    expect(await serviceCharges(context, student.userId)).toHaveLength(0);
  });

  it('does not retry a password-protected PDF', async () => {
    // The same bytes need the same password on the third attempt, so retrying
    // is waste. One analyzer call, and the job ends rather than looping.
    const standard = await pdfFriendlyStandard();
    context.documentEngine.mode = 'password-required';

    const created = await startCheck(context, student, {
      documentVersionId: await readyPdf(),
      standardId: standard.standardId,
    });
    await waitForCheck(context, created.body.id);

    expect(context.documentEngine.calls).toHaveLength(1);
  });
});
