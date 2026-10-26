/**
 * Organization type.
 *
 * PalCert's tenant is an `Organization`, never a `University` (ADR-0004).
 * Adding a type here must never require touching the tenancy model — the type
 * is descriptive metadata, not a structural distinction.
 */
export const OrganizationType = {
  UNIVERSITY: 'UNIVERSITY',
  SCIENTIFIC_JOURNAL: 'SCIENTIFIC_JOURNAL',
  PUBLISHER: 'PUBLISHER',
  RESEARCH_INSTITUTION: 'RESEARCH_INSTITUTION',
  GOVERNMENT: 'GOVERNMENT',
  COMPANY: 'COMPANY',
  OTHER: 'OTHER',
} as const;

export type OrganizationType = (typeof OrganizationType)[keyof typeof OrganizationType];

export const ORGANIZATION_TYPES: readonly OrganizationType[] = Object.values(OrganizationType);

/**
 * Operational status — deliberately separate from verification status.
 *
 * Merging them would create ambiguous states ("is a REJECTED organization
 * suspended?") and would make suspension and identity checks impossible to
 * reason about independently.
 *
 *   ACTIVE ──suspend──► SUSPENDED ──reactivate──► ACTIVE
 *      │                    │
 *      └──────close─────────┴───────────────────► CLOSED (terminal)
 */
export const OrganizationStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
} as const;

export type OrganizationStatus = (typeof OrganizationStatus)[keyof typeof OrganizationStatus];

const ALLOWED_STATUS_TRANSITIONS: Record<OrganizationStatus, readonly OrganizationStatus[]> = {
  ACTIVE: [OrganizationStatus.SUSPENDED, OrganizationStatus.CLOSED],
  SUSPENDED: [OrganizationStatus.ACTIVE, OrganizationStatus.CLOSED],
  CLOSED: [],
};

export function canTransitionOrganizationStatus(
  from: OrganizationStatus,
  to: OrganizationStatus,
): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

/** Only an ACTIVE organization may be operated on through tenant-scoped routes. */
export function organizationPermitsAccess(status: OrganizationStatus): boolean {
  return status === OrganizationStatus.ACTIVE;
}

/**
 * Identity verification status.
 *
 *   UNVERIFIED ──request──► PENDING ──approve──► VERIFIED
 *        ▲                     │
 *        │                  reject
 *        │                     ▼
 *        └────resubmit──── REJECTED
 *
 * A rejection never deletes the organization: it remains operational and may
 * resubmit. Verification attests that PalCert checked the organization's
 * identity — it says nothing about academic quality (see §27).
 */
export const OrganizationVerificationStatus = {
  UNVERIFIED: 'UNVERIFIED',
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
} as const;

export type OrganizationVerificationStatus =
  (typeof OrganizationVerificationStatus)[keyof typeof OrganizationVerificationStatus];

const ALLOWED_VERIFICATION_TRANSITIONS: Record<
  OrganizationVerificationStatus,
  readonly OrganizationVerificationStatus[]
> = {
  UNVERIFIED: [OrganizationVerificationStatus.PENDING],
  PENDING: [OrganizationVerificationStatus.VERIFIED, OrganizationVerificationStatus.REJECTED],
  // Resubmission is permitted; a rejection is not a dead end.
  REJECTED: [OrganizationVerificationStatus.PENDING],
  // Re-verification would need an explicit revocation flow, which Phase 2 does
  // not provide. VERIFIED is terminal for now.
  VERIFIED: [],
};

export function canTransitionVerificationStatus(
  from: OrganizationVerificationStatus,
  to: OrganizationVerificationStatus,
): boolean {
  return ALLOWED_VERIFICATION_TRANSITIONS[from].includes(to);
}

/**
 * Field visibility classification (§49).
 *
 * Every organization field is classified so it is impossible to add one without
 * deciding who may see it. Phase 2 exposes no public directory at all, so
 * `PUBLIC` currently means "safe to expose if a directory is added later".
 */
export const FieldVisibility = {
  PUBLIC: 'PUBLIC',
  MEMBER_ONLY: 'MEMBER_ONLY',
  PALCERT_INTERNAL: 'PALCERT_INTERNAL',
} as const;

export type FieldVisibility = (typeof FieldVisibility)[keyof typeof FieldVisibility];

export const ORGANIZATION_FIELD_VISIBILITY = {
  id: FieldVisibility.PUBLIC,
  slug: FieldVisibility.PUBLIC,
  displayName: FieldVisibility.PUBLIC,
  type: FieldVisibility.PUBLIC,
  countryCode: FieldVisibility.PUBLIC,
  website: FieldVisibility.PUBLIC,
  verificationStatus: FieldVisibility.PUBLIC,

  legalName: FieldVisibility.MEMBER_ONLY,
  defaultLocale: FieldVisibility.MEMBER_ONLY,
  timezone: FieldVisibility.MEMBER_ONLY,
  status: FieldVisibility.MEMBER_ONLY,
  createdAt: FieldVisibility.MEMBER_ONLY,
  memberCount: FieldVisibility.MEMBER_ONLY,

  createdByUserId: FieldVisibility.PALCERT_INTERNAL,
  suspensionReason: FieldVisibility.PALCERT_INTERNAL,
  verificationInternalNotes: FieldVisibility.PALCERT_INTERNAL,
} as const satisfies Record<string, FieldVisibility>;

export interface OrganizationSummary {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly type: OrganizationType;
  readonly status: OrganizationStatus;
  readonly verificationStatus: OrganizationVerificationStatus;
  readonly countryCode: string;
}

export interface OrganizationProfile extends OrganizationSummary {
  readonly legalName: string;
  readonly website: string | null;
  readonly defaultLocale: string;
  readonly timezone: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly memberCount: number;
}

/** An organization the current user belongs to, with their standing in it. */
export interface OrganizationMembershipSummary {
  readonly organization: OrganizationSummary;
  readonly membershipId: string;
  readonly membershipStatus: string;
  readonly roles: readonly string[];
  readonly joinedAt: string;
}
