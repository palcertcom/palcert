import { computeCertificateClaimHash } from '@palcert/contracts';
import { createHash } from 'node:crypto';
import { type AuthClient } from './support/auth-client';
import {
  downloadCertificate,
  readCertificate,
  verify,
  waitForCertificate,
} from './support/certificates-client';
import {
  publishCheckableStandard,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
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
import { validRule } from './support/standards-client';
import {
  completedCheck,
  decide,
  publishStandardFor,
  submitAndPrepare,
} from './support/submissions-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Certifying each kind of thing a person can submit (§137, §138, §145, §146).
 *
 * A DOCX, a PDF and a SmartFix-corrected recheck are three quite different
 * objects inside PalCert, and issuance treats none of them specially: the same
 * evidence is re-verified, the same claim built, the same artifact rendered.
 * The SmartFix case carries an extra promise — the correction was already paid
 * for, and the certificate that follows it costs nothing at all.
 */
describe('Certificates — formats and purposes (e2e)', () => {
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

  beforeEach(async () => {
    await resetState(context);
    author = await createUser(context, 'author@example.com');
    university = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
    standard = await publishStandardFor(context, university);
  });

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

  /** Approve a handed-over revision and wait for the certificate it earns. */
  async function certify(revisionId: string): Promise<string> {
    const approved = await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    expect(approved.status).toBe(200);
    const settled = await waitForCertificate(context, revisionId);
    expect([settled.issuanceStatus, settled.failureCode]).toEqual(['ISSUED', null]);
    return settled.id;
  }

  it('certifies a DOCX, and the PDF it produces verifies', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    const certificateId = await certify(revisionId);

    const view = await readCertificate(author.client, certificateId);
    expect(view.body.documentFormat).toBe('DOCX');

    // The hashes on the certificate are the ones Phase 14 recorded, not new
    // ones computed from whatever is in storage today.
    const revision = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    expect(view.body.documentSha256).toBe(revision.sourceDocumentSha256);
    expect(view.body.reportHash).toBe(revision.sourceReportHash);
    expect(view.body.submissionEvidenceHash).toBe(revision.evidenceHash);

    const download = await downloadCertificate(author.client, certificateId);
    expect(download.status).toBe(200);
    expect(download.body.filename).toBe(`${view.body.certificateNumber}.pdf`);

    const verified = await verify(context, view.body.certificateNumber as string);
    expect(verified.status).toBe(200);
    expect(verified.body.documentFormat).toBe('DOCX');
    expect(verified.body.certificateArtifactSha256).toBe(view.body.certificateArtifactSha256);
  });

  it('certifies a PDF exactly as it certifies a DOCX', async () => {
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
    expect((await waitForCheck(context, created.body.id as string)).status).toBe('COMPLETED');

    const { revisionId } = await submitAndPrepare(
      context,
      author.client,
      created.body.id as string,
    );
    const certificateId = await certify(revisionId);

    const view = await readCertificate(author.client, certificateId);
    expect(view.body.documentFormat).toBe('PDF');
    expect(view.body.standardCode).toBe('IUG.THESIS.PDF');

    const verified = await verify(context, view.body.certificateNumber as string);
    expect(verified.status).toBe(200);
    expect(verified.body.documentFormat).toBe('PDF');
  });

  it('certifies a SmartFix-corrected recheck, and charges nothing to do it', async () => {
    // §87, §88, §195: a certificate has no price. The person paid for the
    // check and for the correction; issuing the certificate that follows moves
    // no money at all, and a ledger entry here would be a charge nobody agreed
    // to.
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
    const { revisionId } = await submitAndPrepare(context, author.client, recheckId);

    const ledgerBefore = await context.adminDb.creditLedgerEntry.count();
    const holdsBefore = await context.adminDb.creditHold.count();
    const purchasesBefore = await context.adminDb.servicePurchase.count();

    const certificateId = await certify(revisionId);

    expect(await context.adminDb.creditLedgerEntry.count()).toBe(ledgerBefore);
    expect(await context.adminDb.creditHold.count()).toBe(holdsBefore);
    expect(await context.adminDb.servicePurchase.count()).toBe(purchasesBefore);

    // And the certificate says nothing about SmartFix: the claim is about the
    // document that was measured and approved, not about how it got that way
    // (§133).
    const view = await readCertificate(author.client, certificateId);
    const verified = await verify(context, view.body.certificateNumber as string);
    const body = JSON.stringify(verified.body);
    for (const forbidden of ['smartFix', 'SmartFix', 'SMARTFIX', 'correction', 'recheck']) {
      expect([forbidden, body.includes(forbidden)]).toEqual([forbidden, false]);
    }
  }, 120_000);

  it('puts the number in the PDF a holder downloads, and that number verifies', async () => {
    // The capability moved out of the relational row, not out of the holder's
    // hands. The claim artifact and the PDF are still where the number lives,
    // and the number still works.
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    const certificateId = await certify(revisionId);

    const view = await readCertificate(author.client, certificateId);
    const number = view.body.certificateNumber as string;
    expect(number).toMatch(/^PC-[0-9A-HJKMNP-TV-Z]{8}(-[0-9A-HJKMNP-TV-Z]{8}){3}$/);

    // The stored artifact is exactly the one whose digest the certificate
    // published, so the PDF a holder downloads is the PDF that was issued.
    const row = await context.adminDb.complianceCertificate.findUniqueOrThrow({
      where: { id: certificateId },
    });
    const bytes = await context.storage.getObjectBytes({
      zone: 'derived',
      key: row.certificateObjectKey!,
      versionId: row.certificateObjectVersionId,
    });
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.certificateObjectSha256);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // And the number printed on it verifies publicly.
    const verified = await verify(context, number);
    expect(verified.status).toBe(200);
    expect(verified.body.certificateNumber).toBe(number);
    expect(verified.body.certificateArtifactSha256).toBe(row.certificateObjectSha256);

    // The claim is the source of that number, and its own hash still checks.
    const claimBytes = await context.storage.getObjectBytes({
      zone: 'derived',
      key: row.claimObjectKey!,
      versionId: row.claimObjectVersionId,
    });
    const claim = JSON.parse(claimBytes.toString('utf8')) as {
      certificateNumber: string;
      verificationCode: string;
    };
    expect(claim.certificateNumber).toBe(number);
    expect(computeCertificateClaimHash(claim as never)).toBe(row.claimHash);
    // The QR's destination is still the server's, built from the same number.
    expect(view.body.verificationUrl).toContain(number);
  });

  it('builds the verification URL from configuration, not from a request', async () => {
    // §41, §164: the QR's destination is the server's own, so a certificate
    // cannot be made to point somewhere else by whoever triggered it.
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    const certificateId = await certify(revisionId);

    const view = await readCertificate(author.client, certificateId);
    const url = view.body.verificationUrl as string;
    expect(url).toBe(
      `${process.env.APP_PUBLIC_WEB_URL?.replace(/\/+$/, '')}/verify/${view.body.certificateNumber}`,
    );
  });
});
