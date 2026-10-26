/** Decision on an organization verification request. */
export const VerificationRequestStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;

export type VerificationRequestStatus =
  (typeof VerificationRequestStatus)[keyof typeof VerificationRequestStatus];

/**
 * What PalCert verification does and does not mean (§27).
 *
 * Exposed as a constant so the UI and the API describe it identically, and so
 * the claim cannot drift into implying something PalCert does not check.
 */
export const VERIFICATION_SEMANTICS: string =
  'PalCert verification confirms that the organization’s identity and account ' +
  'have passed PalCert’s verification process. It is not an assessment of ' +
  'academic quality, research validity or editorial standards.';

/** Verification state as shown to organization members. */
export interface OrganizationVerificationView {
  readonly status: string;
  readonly requestedAt: string | null;
  readonly reviewedAt: string | null;
  /**
   * Safe, applicant-facing explanation of a rejection. Internal reviewer notes
   * are never included here.
   */
  readonly decisionReason: string | null;
  readonly canRequest: boolean;
}
