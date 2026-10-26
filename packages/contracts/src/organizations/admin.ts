import type { OrganizationProfile } from './organization.js';

/**
 * What PalCert staff see about one organization (admin console).
 *
 * The profile with its real member count, the suspension on record, and the
 * verification history a reviewer needs to decide a pending request.
 * `internalNotes` is staff-only by definition — it "never leaves PalCert" —
 * and is present only for callers holding `admin:organization:verify`.
 */
export interface AdminOrganizationDetailView {
  readonly organization: OrganizationProfile;
  readonly suspendedAt: string | null;
  readonly suspensionReason: string | null;
  readonly verificationRequests: readonly AdminVerificationRequestView[];
}

export interface AdminVerificationRequestView {
  readonly id: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly submissionNote: string | null;
  readonly reviewedAt: string | null;
  readonly decisionReason: string | null;
  readonly internalNotes?: string | null;
}

/**
 * Platform-wide counts for the staff dashboard.
 *
 * Every figure is a count the database answers at request time; nothing is
 * estimated, cached or projected.
 */
export interface AdminOverviewView {
  readonly generatedAt: string;
  readonly organizations: {
    readonly total: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly byVerificationStatus: Readonly<Record<string, number>>;
    readonly pendingVerificationRequests: number;
  };
  readonly users: {
    readonly total: number;
    readonly byStatus: Readonly<Record<string, number>>;
  };
}
