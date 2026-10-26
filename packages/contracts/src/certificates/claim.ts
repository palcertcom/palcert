import { canonicalizeJson, sha256Hex } from '../checks/report.js';
import type { ComplianceDetermination } from '../checks/check.js';
import type { DocumentFormat } from '../documents/document.js';

/**
 * The certificate claim (§29).
 *
 * This is the certificate. The PDF is a presentation of it (§35), and the
 * public verification page is another; both can be regenerated, restyled or
 * translated without touching what PalCert actually asserted. That is why the
 * claim hash and the PDF hash are different things with different meanings and
 * are never conflated (§174).
 *
 * Three rules decide what may appear here.
 *
 * **No person.** A Phase 15 certificate certifies a document and its evidence,
 * not a named human (§10). Phase 14 shares a submitter's display name and
 * email with the receiving organization inside the explicit official-submission
 * boundary; that is a very different thing from printing them on an artifact
 * whose whole purpose is to be handed to strangers. No name, no email, no user
 * id, and no invented student number.
 *
 * **No prose anyone wrote.** No review comment, no revocation note, no
 * document title, no filename.
 *
 * **Labels come from the handoff, not from today.** Every display label here
 * is the one Phase 14 captured when the submission was made. If a university
 * renames itself between approval and rendering — or between issuance and a
 * verifier scanning the QR five years later — the certificate keeps describing
 * the evidence as it was handed over (§30, and correction §5). Reading live
 * catalogue rows at render time would let an unrelated edit quietly change
 * what an old approval appears to have said.
 */

/** Bumped when a field is added, removed or renamed. */
export const CERTIFICATE_CLAIM_SCHEMA_VERSION = 1;

/** Bumped when the same input would serialize differently. */
export const CERTIFICATE_CLAIM_CANONICALIZATION_VERSION = 1;

/**
 * Exactly what a certificate asserts.
 *
 * Every field is an identity, a digest, a captured label or one of the two
 * determinations. Nothing is derived at read time, and nothing can drift.
 */
export interface CertificateClaim {
  readonly claimSchemaVersion: number;
  readonly claimCanonicalizationVersion: number;

  /** The displayed, non-enumerable certificate number. */
  readonly certificateNumber: string;
  /** The canonical verification code the holder presents. */
  readonly verificationCode: string;

  /** The exact immutable revision this certificate is derived from. */
  readonly submissionRevisionId: string;

  readonly organizationId: string;
  /** As captured at submission, never as the organization is named today. */
  readonly organizationName: string;

  readonly documentTypeId: string;
  readonly documentTypeName: string;

  readonly documentFormat: DocumentFormat;
  readonly documentSha256: string;

  readonly reportHash: string;
  readonly evaluationHash: string;

  readonly standardId: string;
  readonly standardVersionId: string;
  readonly standardContentHash: string;
  readonly standardCode: string;
  readonly standardName: string;
  readonly standardVersionLabel: string;

  /** The Phase 14 handoff integrity reference this certificate rests on. */
  readonly submissionEvidenceHash: string;

  /** Always COMPLIANT. Anything else is not certifiable (§4). */
  readonly technicalDetermination: ComplianceDetermination;
  /** Always APPROVED, and always the organization's own word. */
  readonly institutionDecision: 'APPROVED';

  /** The exact organization-sourced decision event that made this eligible. */
  readonly approvalDecisionEventId: string;
  readonly approvedAt: string;

  readonly issuedAt: string;
  /** Null means no automatic expiry, which is the Phase 15 default (§28). */
  readonly validUntil: string | null;
}

/**
 * The claim in canonical form.
 *
 * RFC 8785, reusing the report's own implementation rather than a second one
 * that could drift from it (§31). Extracted so a test can assert the exact
 * bytes, not merely the digest of something unexamined.
 */
export function canonicalCertificateClaim(claim: CertificateClaim): string {
  if (claim.claimCanonicalizationVersion !== CERTIFICATE_CLAIM_CANONICALIZATION_VERSION) {
    throw new Error(
      `cannot hash a claim canonicalized at version ${claim.claimCanonicalizationVersion}`,
    );
  }
  return canonicalizeJson(claim);
}

/**
 * The claim hash (§32).
 *
 * The bytes this hashes are the bytes that get stored, so verification later
 * never depends on re-serializing the claim and hoping the result matches.
 */
export function computeCertificateClaimHash(claim: CertificateClaim): string {
  return sha256Hex(canonicalCertificateClaim(claim));
}
