import type {
  CertificateEventSource,
  CertificateEventType,
  CertificateIssuanceStatus,
  CertificateRevocationReason,
  CertificateVerificationStatus,
} from './certificate.js';
import type { ComplianceDetermination } from '../checks/check.js';
import type { DocumentFormat } from '../documents/document.js';

/**
 * What the API returns about a certificate.
 *
 * Three audiences, three shapes, and the separation is deliberate: the public
 * view is not the private view with fields removed at the last moment, because
 * that is the pattern where a field added later leaks by default.
 */

/**
 * What anyone holding a verification code may see (§12).
 *
 * This type is the privacy boundary. Adding a field here is adding it to the
 * public internet, so the list stays short, and a leak-guard test asserts the
 * serialized response contains nothing resembling identity, ids, prose,
 * storage or money (§128).
 *
 * Note what is absent: no user id, no name, no email, no submission or
 * revision id, no check or report id, no document title, no filename, no
 * comment, no decision actor, no AI or SmartFix data, no finance, no storage
 * key or object version.
 */
export interface PublicCertificateVerificationView {
  readonly certificateNumber: string;
  readonly verificationStatus: CertificateVerificationStatus;

  readonly organizationName: string;
  readonly documentTypeName: string;
  readonly documentFormat: DocumentFormat;

  readonly standardName: string;
  readonly standardCode: string;
  readonly standardVersionLabel: string;

  /** Always COMPLIANT: nothing else is certifiable. */
  readonly technicalResult: ComplianceDetermination;
  /** Always APPROVED, and always the organization's own decision. */
  readonly institutionDecision: 'APPROVED';

  readonly issuedAt: string;
  readonly validUntil: string | null;

  /** Present only when withdrawn, so a stale QR tells the truth (§68). */
  readonly revokedAt: string | null;
  /** The category only. The private note stays private (§67). */
  readonly revocationReason: CertificateRevocationReason | null;

  /** Digests a verifier can check against artifacts they already hold. */
  readonly documentSha256: string;
  readonly reportHash: string;
  readonly standardContentHash: string;
  readonly submissionEvidenceHash: string;
  readonly certificateClaimHash: string;
  readonly certificateArtifactSha256: string;
}

/** One lifecycle entry, as either party may read it (§121). */
export interface CertificateEventView {
  readonly id: string;
  readonly eventType: CertificateEventType;
  readonly eventSource: CertificateEventSource;
  readonly reasonCode: CertificateRevocationReason | null;
  readonly createdAt: string;
}

/**
 * The certificate as its subject or the approving organization sees it.
 *
 * Carries the internal ids both parties legitimately need to navigate their
 * own records, and the verification code, because the holder must be able to
 * share it. None of this is public.
 */
export interface CertificateView {
  readonly id: string;
  /**
   * Read from the immutable claim artifact, so it is null until issuance has
   * produced one. It is deliberately not a column: a relational number would
   * be the verification code with separators, and one SELECT would hand over
   * every certificate's capability at once.
   */
  readonly certificateNumber: string | null;
  readonly issuanceStatus: CertificateIssuanceStatus;

  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly documentTypeName: string;
  readonly documentFormat: DocumentFormat;

  readonly standardCode: string;
  readonly standardName: string;
  readonly standardVersionLabel: string;

  readonly technicalResult: ComplianceDetermination;
  readonly institutionDecision: 'APPROVED';

  readonly issuedAt: string | null;
  readonly validUntil: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: CertificateRevocationReason | null;

  readonly documentSha256: string;
  readonly reportHash: string;
  readonly standardContentHash: string;
  readonly submissionEvidenceHash: string;
  readonly certificateClaimHash: string | null;
  readonly certificateArtifactSha256: string | null;

  /**
   * The holder's own verification code, and the link built from it.
   *
   * Private to the two parties. Possessing it identifies a certificate; it is
   * never a credential for anything else (§16).
   */
  readonly verificationCode: string | null;
  readonly verificationUrl: string | null;
}

/**
 * Why a submission has no certificate (§117).
 *
 * Stable keys the UI localizes, never prose from the server — and never a
 * sentence that blames the institution for a decision it did not make.
 */
export const CertificateIneligibilityReason = {
  /** The institution has not decided yet, or asked for a revision. */
  AWAITING_INSTITUTION_DECISION: 'AWAITING_INSTITUTION_DECISION',
  /** The institution decided, and it was not an approval. */
  NOT_APPROVED: 'NOT_APPROVED',
  /** PalCert's technical result is not COMPLIANT. */
  NOT_COMPLIANT: 'NOT_COMPLIANT',
  /** A newer revision supersedes this one. */
  SUPERSEDED_REVISION: 'SUPERSEDED_REVISION',
  /** The handoff itself never completed. */
  NOT_HANDED_OVER: 'NOT_HANDED_OVER',
} as const;

export type CertificateIneligibilityReason =
  (typeof CertificateIneligibilityReason)[keyof typeof CertificateIneligibilityReason];

export const CERTIFICATE_INELIGIBILITY_REASONS: readonly CertificateIneligibilityReason[] =
  Object.values(CertificateIneligibilityReason);

/** What a submission page shows where a certificate would be (§116). */
export interface SubmissionCertificateStatusView {
  readonly eligible: boolean;
  readonly reason: CertificateIneligibilityReason | null;
  readonly certificate: CertificateView | null;
}

/**
 * The organization's register of the certificates its approvals produced.
 *
 * Status groups a person can act on rather than the four issuance states:
 * a retryable failure is reconciled back to PENDING, so to the institution it
 * is simply still being prepared.
 */
export const ORGANIZATION_CERTIFICATE_FILTERS = [
  'ISSUED',
  'REVOKED',
  'IN_PREPARATION',
  'FAILED',
] as const;
export type OrganizationCertificateFilter = (typeof ORGANIZATION_CERTIFICATE_FILTERS)[number];

/** Long enough for a certificate number or a standard name; short enough to bound a query. */
export const ORGANIZATION_CERTIFICATE_SEARCH_MAX_LENGTH = 128;

/** Who a certificate was issued to, as the approving organization may see them. */
export interface CertificateHolderView {
  readonly displayName: string | null;
  readonly email: string;
}

/**
 * One row of that register.
 *
 * The same authority as `CertificateView` — the approving organization may
 * already open each certificate and read its number — but narrower: no
 * verification code or link, no hashes, no internal user id. The number is
 * read from each row's own claim, never from a column, so the list costs one
 * storage read per row shown and still offers no bulk capability.
 */
export interface OrganizationCertificateListEntryView {
  readonly id: string;
  /** Null until issuance has produced a claim, or when that claim cannot be read. */
  readonly certificateNumber: string | null;
  readonly issuanceStatus: CertificateIssuanceStatus;

  readonly submissionId: string;
  /** Null when the holder's account can no longer be resolved. */
  readonly holder: CertificateHolderView | null;

  readonly documentTypeName: string;
  readonly documentFormat: DocumentFormat;
  readonly standardCode: string;
  readonly standardName: string;
  readonly standardVersionLabel: string;

  readonly issuedAt: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: CertificateRevocationReason | null;
  readonly createdAt: string;
}
