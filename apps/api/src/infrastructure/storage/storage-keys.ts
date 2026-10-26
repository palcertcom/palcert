import { randomBytes } from 'node:crypto';

/**
 * Server-generated object keys (§41).
 *
 * Opaque identifiers only: no email, no name, no title, no original filename.
 * The hierarchy exists for operators reading a bucket listing and for
 * lifecycle rules; it grants nothing — authorization is decided by the
 * database, never by a prefix.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(name: string, value: string): void {
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID`);
}

/**
 * The staging key for one upload session.
 *
 * Unique per session, with a random suffix: two authorizations for the same
 * version (a re-issued one after a lapsed URL) never share a key, so an old
 * URL cannot write over what a newer one uploaded (ADR-0034).
 */
export function quarantineObjectKey(params: {
  ownerUserId: string;
  documentId: string;
  versionId: string;
}): string {
  assertUuid('ownerUserId', params.ownerUserId);
  assertUuid('documentId', params.documentId);
  assertUuid('versionId', params.versionId);
  const nonce = randomBytes(12).toString('hex');
  return `staging/users/${params.ownerUserId}/documents/${params.documentId}/versions/${params.versionId}/upload-${nonce}`;
}

/** The immutable clean key. One per version; never rewritten. */
export function cleanObjectKey(params: {
  ownerUserId: string;
  documentId: string;
  versionId: string;
}): string {
  assertUuid('ownerUserId', params.ownerUserId);
  assertUuid('documentId', params.documentId);
  assertUuid('versionId', params.versionId);
  return `users/${params.ownerUserId}/documents/${params.documentId}/versions/${params.versionId}/source`;
}

/**
 * The staging key for one organization guideline or template (Phase 9, §10).
 *
 * Server-generated and organization-scoped, and carrying nothing a person
 * wrote: no organization name, no email, no original filename, no standard
 * title. The hierarchy is for operators reading a bucket listing; it grants
 * nothing, because authorization is decided by the database.
 */
export function quarantineSourceObjectKey(params: {
  organizationId: string;
  standardVersionId: string;
  sourceId: string;
}): string {
  assertUuid('organizationId', params.organizationId);
  assertUuid('standardVersionId', params.standardVersionId);
  assertUuid('sourceId', params.sourceId);
  const nonce = randomBytes(12).toString('hex');
  return `staging/organizations/${params.organizationId}/standards/${params.standardVersionId}/sources/${params.sourceId}/upload-${nonce}`;
}

/** The immutable clean key for one source. One per source; never rewritten (§8). */
export function cleanSourceObjectKey(params: {
  organizationId: string;
  standardVersionId: string;
  sourceId: string;
}): string {
  assertUuid('organizationId', params.organizationId);
  assertUuid('standardVersionId', params.standardVersionId);
  assertUuid('sourceId', params.sourceId);
  return `organizations/${params.organizationId}/standards/${params.standardVersionId}/sources/${params.sourceId}/source`;
}

/** True when a key could only have been produced by the functions above. */
export function isPalCertObjectKey(key: string): boolean {
  return (
    /^staging\/users\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}\/upload-[0-9a-f]{24}$/i.test(
      key,
    ) ||
    /^staging\/users\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}\/generated-[0-9a-f]{24}$/i.test(
      key,
    ) ||
    /^users\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}\/source$/i.test(
      key,
    ) ||
    /^staging\/organizations\/[0-9a-f-]{36}\/standards\/[0-9a-f-]{36}\/sources\/[0-9a-f-]{36}\/upload-[0-9a-f]{24}$/i.test(
      key,
    ) ||
    /^organizations\/[0-9a-f-]{36}\/standards\/[0-9a-f-]{36}\/sources\/[0-9a-f-]{36}\/source$/i.test(
      key,
    ) ||
    // Phase 14 — one official submission's immutable evidence.
    /^organizations\/[0-9a-f-]{36}\/submissions\/[0-9a-f-]{36}\/revisions\/[0-9a-f-]{36}\/(document|report)$/i.test(
      key,
    ) ||
    // Phase 15 — one certificate's claim and its rendered artifact.
    /^organizations\/[0-9a-f-]{36}\/certificates\/[0-9a-f-]{36}\/(claim|certificate\.pdf)$/i.test(
      key,
    ) ||
    // Certificate attestation — one submitted certificate, staged and clean.
    /^staging\/users\/[0-9a-f-]{36}\/attestations\/[0-9a-f-]{36}\/artifacts\/[0-9a-f-]{36}\/upload-[0-9a-f]{24}$/i.test(
      key,
    ) ||
    /^users\/[0-9a-f-]{36}\/attestations\/[0-9a-f-]{36}\/artifacts\/[0-9a-f-]{36}\/source$/i.test(
      key,
    ) ||
    // Manual top-ups — a receipt, private to its owner, staged and clean.
    /^staging\/users\/[0-9a-f-]{36}\/manual-topups\/[0-9a-f-]{36}\/receipts\/[0-9a-f-]{36}\/upload-[0-9a-f]{24}$/i.test(
      key,
    ) ||
    /^users\/[0-9a-f-]{36}\/manual-topups\/[0-9a-f-]{36}\/receipts\/[0-9a-f-]{36}\/source$/i.test(
      key,
    ) ||
    // Manual payment method logos — PalCert's own, staged and clean.
    /^staging\/platform\/payment-methods\/[0-9a-f-]{36}\/logos\/[0-9a-f-]{36}\/upload-[0-9a-f]{24}$/i.test(
      key,
    ) ||
    /^platform\/payment-methods\/[0-9a-f-]{36}\/logos\/[0-9a-f-]{36}\/source$/i.test(key)
  );
}

/**
 * The artifact key for one analysis (Phase 6).
 *
 * Keyed by the analysis id, not by the document version: a second analyzer
 * version reading the same bytes is a second analysis and gets its own object,
 * so neither can overwrite the other's artifact (ADR-0041, ADR-0042).
 */
export function analysisArtifactKey(params: {
  ownerUserId: string;
  documentVersionId: string;
  analysisId: string;
}): string {
  assertUuid('ownerUserId', params.ownerUserId);
  assertUuid('documentVersionId', params.documentVersionId);
  assertUuid('analysisId', params.analysisId);
  return `users/${params.ownerUserId}/versions/${params.documentVersionId}/analyses/${params.analysisId}/artifact.json`;
}

/**
 * The artifact key for one check report (Phase 7).
 *
 * Keyed by the run, not by the check: a retry produces a new run and a new
 * object, so a completed run's report can never be overwritten by a later one
 * (§62, §64). Reports live in the derived bucket alongside analyses — private,
 * no public CORS, no public URL, never a raw key in an API response (§53).
 */
export function checkReportArtifactKey(params: {
  ownerUserId: string;
  checkId: string;
  checkRunId: string;
}): string {
  assertUuid('ownerUserId', params.ownerUserId);
  assertUuid('checkId', params.checkId);
  assertUuid('checkRunId', params.checkRunId);
  return `users/${params.ownerUserId}/checks/${params.checkId}/runs/${params.checkRunId}/report.json`;
}

/**
 * The artifact key for one SmartFix plan (Phase 12).
 *
 * Keyed by the plan, not by the check: a user may plan a correction, decline
 * it, and plan again after editing their document, and neither plan may
 * overwrite the other's record of what was proposed.
 */
export function smartFixPlanArtifactKey(params: {
  ownerUserId: string;
  checkId: string;
  planId: string;
}): string {
  assertUuid('ownerUserId', params.ownerUserId);
  assertUuid('checkId', params.checkId);
  assertUuid('planId', params.planId);
  return `users/${params.ownerUserId}/checks/${params.checkId}/smartfix/plans/${params.planId}/plan.json`;
}

/**
 * The artifact key for one change manifest (Phase 12).
 *
 * Keyed by the request. One correction produces one manifest, and it is the
 * evidence that the correction changed formatting and nothing else — so it is
 * written once, to a key nothing else can claim.
 */
export function smartFixManifestArtifactKey(params: {
  ownerUserId: string;
  requestId: string;
}): string {
  assertUuid('ownerUserId', params.ownerUserId);
  assertUuid('requestId', params.requestId);
  return `users/${params.ownerUserId}/smartfix/requests/${params.requestId}/manifest.json`;
}

/**
 * The quarantine key for bytes PalCert generated itself (Phase 12 §88).
 *
 * A corrected document goes through the *same* secure ingestion as a browser
 * upload — format detection, malware scan, the lot — because "PalCert made it"
 * is not a security property. The key is server-generated like every other,
 * and says plainly that nobody uploaded this.
 */
export function generatedQuarantineObjectKey(params: {
  ownerUserId: string;
  documentId: string;
  versionId: string;
}): string {
  assertUuid('ownerUserId', params.ownerUserId);
  assertUuid('documentId', params.documentId);
  assertUuid('versionId', params.versionId);
  const nonce = randomBytes(12).toString('hex');
  return `staging/users/${params.ownerUserId}/documents/${params.documentId}/versions/${params.versionId}/generated-${nonce}`;
}

/**
 * Where one official submission's evidence lives (Phase 14, §78).
 *
 * Organization-scoped, because the organization is who reads it — but built
 * from ids alone. No submitter name, no email, no document title, no original
 * filename: a bucket listing must not become a directory of who submitted
 * what to whom.
 *
 * The snapshot sits in the `derived` zone with every other artifact PalCert
 * produced about a document, and no browser ever reaches it directly: the only
 * route is a short-lived signed URL issued after the submission's own
 * authorization checks (§79, §101).
 */
export function submissionDocumentSnapshotKey(params: {
  organizationId: string;
  submissionId: string;
  revisionId: string;
}): string {
  assertUuid('organizationId', params.organizationId);
  assertUuid('submissionId', params.submissionId);
  assertUuid('revisionId', params.revisionId);
  return `organizations/${params.organizationId}/submissions/${params.submissionId}/revisions/${params.revisionId}/document`;
}

export function submissionReportSnapshotKey(params: {
  organizationId: string;
  submissionId: string;
  revisionId: string;
}): string {
  assertUuid('organizationId', params.organizationId);
  assertUuid('submissionId', params.submissionId);
  assertUuid('revisionId', params.revisionId);
  return `organizations/${params.organizationId}/submissions/${params.submissionId}/revisions/${params.revisionId}/report`;
}

/**
 * The staging key for one certificate submitted for attestation.
 *
 * Under the owner, because the owner is who uploaded it and whose private
 * file it remains; the institution reads it only through a signed URL issued
 * after its own authorization. Ids only — no name, no title, no filename.
 */
export function quarantineAttestationObjectKey(params: {
  ownerUserId: string;
  requestId: string;
  artifactId: string;
}): string {
  assertUuid('ownerUserId', params.ownerUserId);
  assertUuid('requestId', params.requestId);
  assertUuid('artifactId', params.artifactId);
  const nonce = randomBytes(12).toString('hex');
  return `staging/users/${params.ownerUserId}/attestations/${params.requestId}/artifacts/${params.artifactId}/upload-${nonce}`;
}

/** The immutable clean key. One per artifact; never rewritten. */
export function cleanAttestationObjectKey(params: {
  ownerUserId: string;
  requestId: string;
  artifactId: string;
}): string {
  assertUuid('ownerUserId', params.ownerUserId);
  assertUuid('requestId', params.requestId);
  assertUuid('artifactId', params.artifactId);
  return `users/${params.ownerUserId}/attestations/${params.requestId}/artifacts/${params.artifactId}/source`;
}

/**
 * The staging key for one manual top-up receipt.
 *
 * Under the owner, whose private file it is; finance reads it only through a
 * signed URL issued after its own authorization. Ids only — never a filename,
 * an amount or a reference.
 */
export function quarantineManualTopUpReceiptKey(params: {
  ownerUserId: string;
  requestId: string;
  receiptId: string;
}): string {
  assertUuid('ownerUserId', params.ownerUserId);
  assertUuid('requestId', params.requestId);
  assertUuid('receiptId', params.receiptId);
  const nonce = randomBytes(12).toString('hex');
  return `staging/users/${params.ownerUserId}/manual-topups/${params.requestId}/receipts/${params.receiptId}/upload-${nonce}`;
}

/** The immutable clean key for one receipt. Never rewritten. */
export function cleanManualTopUpReceiptKey(params: {
  ownerUserId: string;
  requestId: string;
  receiptId: string;
}): string {
  assertUuid('ownerUserId', params.ownerUserId);
  assertUuid('requestId', params.requestId);
  assertUuid('receiptId', params.receiptId);
  return `users/${params.ownerUserId}/manual-topups/${params.requestId}/receipts/${params.receiptId}/source`;
}

/** The staging key for one payment method logo. PalCert's, so under no user. */
export function quarantinePaymentMethodLogoKey(params: {
  paymentMethodId: string;
  logoId: string;
}): string {
  assertUuid('paymentMethodId', params.paymentMethodId);
  assertUuid('logoId', params.logoId);
  const nonce = randomBytes(12).toString('hex');
  return `staging/platform/payment-methods/${params.paymentMethodId}/logos/${params.logoId}/upload-${nonce}`;
}

/** The immutable clean key for one logo. */
export function cleanPaymentMethodLogoKey(params: {
  paymentMethodId: string;
  logoId: string;
}): string {
  assertUuid('paymentMethodId', params.paymentMethodId);
  assertUuid('logoId', params.logoId);
  return `platform/payment-methods/${params.paymentMethodId}/logos/${params.logoId}/source`;
}

/**
 * A fresh quarantine key for one payout proof (ADR-0150). Proofs are
 * PalCert finance's records of a transfer, filed under the request, never
 * under a person or an organization prefix that a broader grant might cover.
 */
export function quarantineWithdrawalProofKey(params: {
  requestId: string;
  proofId: string;
}): string {
  assertUuid('requestId', params.requestId);
  assertUuid('proofId', params.proofId);
  const nonce = randomBytes(12).toString('hex');
  return `staging/platform/withdrawals/${params.requestId}/proofs/${params.proofId}/upload-${nonce}`;
}

/** The immutable clean key for one payout proof. */
export function cleanWithdrawalProofKey(params: { requestId: string; proofId: string }): string {
  assertUuid('requestId', params.requestId);
  assertUuid('proofId', params.proofId);
  return `platform/withdrawals/${params.requestId}/proofs/${params.proofId}/source`;
}
