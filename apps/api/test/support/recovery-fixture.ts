import { randomUUID } from 'node:crypto';
import { createApiClient } from './api-client-client';
import { API } from './auth-client';
import { publishCheckableStandard, startCheck, waitForCheck } from './checks-client';
import { readCertificate, waitForCertificate } from './certificates-client';
import { createDocument, uploadAndProcess } from './documents-client';
import { minimalDocx, minimalPdf } from './fixtures';
import { createTenant, createUser } from './organization-client';
import { fundForCheck, purchaseOf } from './paid-check-client';
import { validRule } from './standards-client';
import { decide, submitAndPrepare } from './submissions-client';
import type { TestContext } from './test-app';

/**
 * What the recovery drill needs to know about the installation it captured,
 * so it can ask the *restored* installation the same questions.
 *
 * Everything here is an identifier or a hash PalCert itself computed. No
 * document content and no capability material: the fixture summary is written
 * to the drill's working directory, and a verification code in it would make
 * that file a way to verify a certificate.
 */
export interface RecoveryFixture {
  readonly author: { userId: string; email: string };
  readonly organizationId: string;
  readonly organizationOwnerUserId: string;
  readonly docx: { documentId: string; versionId: string; sha256: string };
  readonly pdf: { documentId: string; versionId: string; sha256: string };
  readonly standardId: string;
  readonly standardVersionId: string;
  readonly pdfStandardId: string;
  readonly pdfCheckId: string;
  readonly freeCheckId: string;
  readonly paidCheckId: string;
  readonly paidPurchaseId: string;
  readonly reportId: string;
  readonly reportHash: string;
  readonly submissionId: string;
  readonly revisionId: string;
  readonly certificateId: string;
  readonly certificateClaimHash: string;
  /**
   * The plaintext code, held only in the drill process's memory so the restored
   * system can be asked to verify a certificate it has never seen the code for.
   * Never written to the fixture summary file.
   */
  readonly certificateVerificationCode: string;
  readonly webhookEndpointId: string;
  readonly apiClientId: string;
  readonly notificationCount: number;
  readonly ledgerEntryCount: number;
  readonly balanceMinor: string;
}

/**
 * Build a deterministic dataset that crosses PalCert's major persistence
 * boundaries, using the application's own workflows.
 *
 * Everything here goes through HTTP or through the worker, never through
 * hand-written INSERTs, for one reason: a restore proof is only worth
 * something if the rows it restores are the rows PalCert actually writes.
 * Fabricated rows can satisfy every foreign key and still miss the trigger,
 * the default, the domain event and the derived object that the real path
 * produces -- and those are exactly what a restore has to bring back.
 */
export async function buildRecoveryFixture(context: TestContext): Promise<RecoveryFixture> {
  const author = await createUser(context, `author-${randomUUID().slice(0, 8)}@example.com`);
  const university = await createTenant(
    context,
    'Islamic University of Gaza',
    `registrar-${randomUUID().slice(0, 8)}@example.com`,
  );

  const standard = await publishCheckableStandard(
    context,
    university.owner.client,
    university.organizationId,
  );

  // A second standard whose rules a PDF can actually answer. The first one is
  // about Word authoring properties, and PalCert refuses a PDF check against
  // it rather than charging for a verdict it cannot reach -- so without this
  // the fixture would contain no PDF analysis at all, and the restore proof
  // would silently cover only one analyzer.
  const pdfStandard = await publishCheckableStandard(
    context,
    university.owner.client,
    university.organizationId,
    {
      standardCode: 'IUG.RECOVERY.PAGES',
      documentTypeName: 'Recovery drill thesis',
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

  // --- documents: a DOCX and a PDF, each through scan, promotion and analysis
  const docxDocumentId = (await createDocument(author.client, 'Thesis (DOCX)')).id;
  const docx = await uploadAndProcess(author.client, docxDocumentId, {
    name: 'thesis.docx',
    bytes: minimalDocx(),
  });
  const pdfDocumentId = (await createDocument(author.client, 'Thesis (PDF)')).id;
  const pdf = await uploadAndProcess(author.client, pdfDocumentId, {
    name: 'thesis.pdf',
    bytes: minimalPdf(),
  });

  const docxRow = await context.adminDb.documentVersion.findUniqueOrThrow({
    where: { id: docx.versionId },
  });
  const pdfRow = await context.adminDb.documentVersion.findUniqueOrThrow({
    where: { id: pdf.versionId },
  });

  // --- a free check, so a report artifact exists in the derived zone
  const freeCheck = await startCheck(context, author, {
    documentVersionId: docx.versionId,
    standardId: standard.standardId,
  });
  if (freeCheck.status !== 201 && freeCheck.status !== 202) {
    throw new Error(
      `free check creation failed (${freeCheck.status}): ${JSON.stringify(freeCheck.body)}`,
    );
  }
  const freeCheckId = freeCheck.body.id as string;
  await waitForCheck(context, freeCheckId);

  // --- a paid check, so the ledger, a purchase and a charge all exist
  //
  // Against the DOCX version, not the PDF one: this standard's rules can only
  // be answered from OOXML, and PalCert refuses the check rather than charging
  // for one it cannot perform. The PDF still contributes its own persisted
  // analysis above, which is the thing a restore has to bring back.
  const { quoteId } = await fundForCheck(context, author.userId);
  const paidCheck = await startCheck(context, author, {
    documentVersionId: docx.versionId,
    standardId: standard.standardId,
    priceQuoteId: quoteId,
  });
  if (paidCheck.status !== 201 && paidCheck.status !== 202) {
    throw new Error(
      `paid check creation failed (${paidCheck.status}): ${JSON.stringify(paidCheck.body)}`,
    );
  }
  const paidCheckId = paidCheck.body.id as string;
  await waitForCheck(context, paidCheckId);
  const purchase = await purchaseOf(context, paidCheckId);

  // --- a PDF check, so the PDF analyzer persists an artifact too
  const pdfCheck = await startCheck(context, author, {
    documentVersionId: pdf.versionId,
    standardId: pdfStandard.standardId,
  });
  if (pdfCheck.status !== 201 && pdfCheck.status !== 202) {
    throw new Error(
      `pdf check creation failed (${pdfCheck.status}): ${JSON.stringify(pdfCheck.body)}`,
    );
  }
  const pdfCheckId = pdfCheck.body.id as string;
  await waitForCheck(context, pdfCheckId);

  const report = await context.adminDb.checkReport.findFirstOrThrow({
    where: { checkId: freeCheckId },
  });

  // --- submission, approval and the certificate that follows from it
  const { submissionId, revisionId } = await submitAndPrepare(context, author.client, freeCheckId);
  await decide(university.owner.client, university.organizationId, revisionId, {
    toStatus: 'UNDER_REVIEW',
  });
  await decide(university.owner.client, university.organizationId, revisionId, {
    toStatus: 'APPROVED',
  });
  const issued = await waitForCertificate(context, revisionId);
  if (issued.issuanceStatus !== 'ISSUED') {
    throw new Error(`certificate did not issue (${issued.issuanceStatus})`);
  }

  // The owner's own read of the certificate is the only place the plaintext
  // verification code is ever disclosed: the row keeps a SHA-256 of it and
  // nothing else. Taken here so the restored installation can later be asked
  // to verify a code it has never itself held.
  const certificateView = await readCertificate(author.client, issued.id);
  if (certificateView.status !== 200) {
    throw new Error(`certificate read failed (${certificateView.status})`);
  }
  const certificateRow = await context.adminDb.complianceCertificate.findFirstOrThrow({
    where: { submissionRevisionId: revisionId },
  });

  // --- webhook endpoint: sealed URL and signing secret under the keyring
  const endpointResponse = await university.owner.client.post(
    `${API}/organizations/${university.organizationId}/webhooks/endpoints`,
    {
      description: 'Registrar integration',
      url: 'https://registrar.example/palcert-hook',
      eventTypes: [],
    },
    { headers: { 'idempotency-key': randomUUID() } },
  );
  if (endpointResponse.status !== 201) {
    throw new Error(
      `webhook endpoint creation failed (${endpointResponse.status}): ` +
        JSON.stringify(endpointResponse.body),
    );
  }
  // The creation response discloses the signing secret once and is never
  // stored; the drill keeps only the endpoint's identifier.
  const webhookEndpoint = await context.adminDb.webhookEndpoint.findFirstOrThrow({
    where: { organizationId: university.organizationId },
  });

  // --- API client: a verifier-based credential, no ciphertext
  const apiClient = await createApiClient(
    context.app,
    university.owner.client,
    university.organizationId,
    ['submissions:read', 'certificates:read'],
  );

  // --- drain the outbox, so downstream work actually happened
  //
  // A submission decision emits a domain event, which fans out to
  // notifications, which fan out to deliveries. Left undrained the fixture
  // would contain the cause and none of the effects -- and a restore proof
  // that only covers rows written on the request path would miss every row
  // the worker writes, which is most of them.
  await drainJobs(context);

  const [notificationCount, ledgerEntryCount, ledgerSum] = await Promise.all([
    context.adminDb.userNotification.count(),
    context.adminDb.creditLedgerEntry.count(),
    // The balance is the sum of an append-only ledger, never a stored total,
    // so the drill re-derives it the same way the application does.
    context.adminDb.creditLedgerEntry.aggregate({
      _sum: { amountMinorSigned: true },
      where: { account: { ownerUserId: author.userId } },
    }),
  ]);

  return {
    author: { userId: author.userId, email: author.email },
    organizationId: university.organizationId,
    organizationOwnerUserId: university.owner.userId,
    docx: { documentId: docxDocumentId, versionId: docx.versionId, sha256: docxRow.sha256 ?? '' },
    pdf: { documentId: pdfDocumentId, versionId: pdf.versionId, sha256: pdfRow.sha256 ?? '' },
    standardId: standard.standardId,
    standardVersionId: standard.standardVersionId,
    pdfStandardId: pdfStandard.standardId,
    pdfCheckId,
    freeCheckId,
    paidCheckId,
    paidPurchaseId: purchase?.id ?? '',
    reportId: report.id,
    reportHash: report.reportHash,
    submissionId,
    revisionId,
    certificateId: certificateRow.id,
    certificateClaimHash: certificateRow.claimHash ?? '',
    certificateVerificationCode: certificateView.body.verificationCode as string,
    webhookEndpointId: webhookEndpoint.id,
    apiClientId: apiClient.apiClientId,
    notificationCount,
    ledgerEntryCount,
    balanceMinor: String(ledgerSum._sum.amountMinorSigned ?? 0n),
  };
}

/**
 * Run every job that is ready, until nothing is.
 *
 * Bounded rather than "until empty": a handler that keeps re-queueing itself
 * would otherwise hang the fixture instead of failing it, and a fixture that
 * hangs teaches nobody anything.
 */
async function drainJobs(context: TestContext, rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const ready = await context.adminDb.processingJob.findMany({
      where: { status: { in: ['PENDING', 'RETRY_PENDING', 'DISPATCHED'] } },
      select: { id: true },
      take: 100,
    });
    if (ready.length === 0) return;
    for (const job of ready) await context.worker.processJobId(job.id);
  }
}

/** The summary safe to write to disk: identifiers and hashes, no capabilities. */
export function redactFixture(fixture: RecoveryFixture): Record<string, unknown> {
  const { certificateVerificationCode: _omitted, ...safe } = fixture;
  return safe;
}
