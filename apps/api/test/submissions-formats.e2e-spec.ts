import { type AuthClient } from './support/auth-client';
import {
  publishCheckableStandard,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { validRule } from './support/standards-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx, minimalPdf } from './support/fixtures';
import { createTenant, createUser, type TenantFixture } from './support/organization-client';
import { grantCredit } from './support/paid-check-client';
import {
  ensureSmartFixPrice,
  planSmartFix,
  quoteForSmartFix,
  smartFixRow,
  startSmartFix,
} from './support/smartfix-client';
import {
  completedCheck,
  decide,
  publishStandardFor,
  reviewQueue,
  submitAndPrepare,
  submitCheck,
} from './support/submissions-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Every kind of check a person can submit, and what a submission records
 * about it.
 *
 * A DOCX, a PDF and a SmartFix recheck are three quite different objects
 * inside PalCert, and the submission machinery treats none of them specially:
 * the same bytes are copied, the same digests verified, the same evidence
 * hash computed. These tests exist to keep it that way.
 */
describe('Official submissions — formats and purposes (e2e)', () => {
  let context: TestContext;
  let author: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let standard: PublishedStandard;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  /** Wait for the live worker to settle a correction, as its own suite does. */
  async function waitForSmartFix(requestId: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = 'RESERVED';
    while (Date.now() < deadline) {
      const row = await context.adminDb.smartFixRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      last = row.status;
      if (row.status === 'DELIVERED') return;
      if (row.status === 'FAILED' || row.status === 'CANCELLED') {
        throw new Error(`smartfix ${requestId} settled as ${row.status} (${row.failureCode})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`smartfix ${requestId} did not settle in ${timeoutMs} ms (last ${last})`);
  }

  beforeEach(async () => {
    await resetState(context);
    author = await createUser(context, 'author@example.com');
    university = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
    standard = await publishStandardFor(context, university);
  });

  it('submits a DOCX, copying the bytes and the report unchanged', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    expect(revision.sourceDocumentFormat).toBe('DOCX');
    expect(revision.documentSnapshotSha256).toBe(revision.sourceDocumentSha256);
    expect(revision.reportSnapshotSha256).not.toBeNull();
    expect(revision.evidenceHash).toHaveLength(64);
  });

  it('submits a PDF exactly as it submits a DOCX', async () => {
    // §31: submission transforms nothing, so a PDF is not converted, not
    // re-rendered and not re-analyzed on its way to an institution.
    // Rules a PDF can answer: page geometry, not Word authoring properties
    // (Phase 13 §55).
    const pdfStandard = await publishCheckableStandard(
      context,
      university.owner.client,
      university.organizationId,
      {
        standardCode: 'IUG.THESIS.PDF',
        documentTypeName: 'PDF thesis',
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
        ],
      },
    );

    const document = await createDocument(author.client, 'Thesis');
    const { versionId } = await uploadAndProcess(author.client, document.id, {
      name: 'thesis.pdf',
      bytes: minimalPdf('A thesis rendered to PDF'),
    });
    const created = await startCheck(context, author, {
      documentVersionId: versionId,
      standardId: pdfStandard.standardId,
    });
    expect([201, 202]).toContain(created.status);
    const settled = await waitForCheck(context, created.body.id as string);
    expect(settled.status).toBe('COMPLETED');

    const { revisionId } = await submitAndPrepare(
      context,
      author.client,
      created.body.id as string,
    );

    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    const version = await context.adminDb.documentVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(revision.sourceDocumentFormat).toBe('PDF');
    expect(revision.documentSnapshotSha256).toBe(version.sha256);

    const queue = await reviewQueue(university.owner.client, university.organizationId);
    expect(queue.body).toHaveLength(1);
  });

  it('submits a SmartFix recheck without buying another check', async () => {
    // §12: the recheck is already a paid, completed check — the person paid
    // for it once, as part of the correction. Requiring a second
    // DOCUMENT_CHECK purchase to submit it would be charging twice for the
    // same analysis.
    const document = await createDocument(author.client, 'Thesis');
    const { versionId } = await uploadAndProcess(author.client, document.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
    const first = await startCheck(context, author, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    await waitForCheck(context, first.body.id as string);

    const planned = await planSmartFix(author.client, first.body.id as string);
    expect(planned.status).toBe(200);

    await ensureSmartFixPrice(context);
    await grantCredit(context, author.userId, 5000n);
    const quote = await quoteForSmartFix(context, author.userId);
    const started = await startSmartFix(author.client, {
      planId: planned.body.id as string,
      priceQuoteId: quote.id,
    });
    expect(started.status).toBe(202);
    await waitForSmartFix(started.body.id as string);

    const row = await smartFixRow(context, started.body.id as string);
    const recheckId = row.recheck!.id;
    expect(row.recheck!.purpose).toBe('SMARTFIX_RECHECK');
    expect(row.recheck!.servicePurchaseId).toBeNull();

    const chargesBefore = await context.adminDb.creditLedgerEntry.count();

    const { revisionId } = await submitAndPrepare(context, author.client, recheckId);

    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    expect(revision.sourceCheckId).toBe(recheckId);

    // §146, §147, §148: no submission fee, no second purchase, no ledger
    // movement of any kind.
    expect(await context.adminDb.creditLedgerEntry.count()).toBe(chargesBefore);

    // §22, §23: the correction itself is not part of the handoff. The
    // institution receives the corrected document and its report, and learns
    // nothing about the plan that produced it.
    const queue = await reviewQueue(university.owner.client, university.organizationId);
    const serialized = JSON.stringify(queue.body);
    expect(serialized).not.toContain(started.body.id as string);
    expect(serialized).not.toContain(planned.body.id as string);
  });

  it('records what happened without recording what was said', async () => {
    // §117, §118: an audit log is read by people who are not party to the
    // submission. It says a decision was made and by whom; it never carries a
    // document title, a filename or the text of a comment.
    const check = await completedCheck(context, author, standard, {
      documentName: 'A Study of Coastal Aquifers in Gaza',
    });
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);

    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'REJECTED',
      reasonCode: 'DOCUMENT_INCOMPLETE',
      comment: 'The literature review chapter is missing entirely.',
    });

    const events = await context.adminDb.auditEvent.findMany({
      where: { targetType: 'SubmissionRevision' },
    });
    expect(events.length).toBeGreaterThan(0);

    const actions = events.map((event) => event.action);
    expect(actions).toContain('OFFICIAL_SUBMISSION_REQUESTED');
    expect(actions).toContain('OFFICIAL_SUBMISSION_READY');
    expect(actions).toContain('SUBMISSION_DECISION_RECORDED');

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('Coastal Aquifers');
    expect(serialized).not.toContain('literature review');
    expect(serialized).not.toContain('thesis.docx');
  });

  it('refuses to submit a check that did not finish', async () => {
    // §13: a submission is evidence, and a check that never produced a report
    // is not evidence of anything. Failed deterministically rather than by
    // cancelling a running check, so the assertion is about the rule and not
    // about who won a race.
    context.documentEngine.mode = 'password-required';

    const document = await createDocument(author.client, 'Thesis');
    const { versionId } = await uploadAndProcess(author.client, document.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
    const created = await startCheck(context, author, {
      documentVersionId: versionId,
      standardId: standard.standardId,
    });
    const checkId = created.body.id as string;
    expect((await waitForCheck(context, checkId)).status).toBe('FAILED');

    const attempt = await submitCheck(author.client, checkId);
    expect(attempt.status).toBe(409);
    expect(attempt.body.error.code).toBe('SUBMISSION_CHECK_NOT_COMPLETED');
    expect(await context.adminDb.submissionRevision.count()).toBe(0);
  });
});
