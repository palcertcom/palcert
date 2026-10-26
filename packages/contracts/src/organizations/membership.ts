/**
 * Membership status.
 *
 *   ACTIVE ──suspend──► SUSPENDED ──reactivate──► ACTIVE
 *      │                    │
 *      └──────remove────────┴───────────────────► REMOVED (terminal)
 *
 * Membership status is strictly organization-local. Suspending a membership in
 * Organization A must never affect the user's PalCert account or their standing
 * in Organization B (§39).
 */
export const MembershipStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  REMOVED: 'REMOVED',
} as const;

export type MembershipStatus = (typeof MembershipStatus)[keyof typeof MembershipStatus];

const ALLOWED_MEMBERSHIP_TRANSITIONS: Record<MembershipStatus, readonly MembershipStatus[]> = {
  ACTIVE: [MembershipStatus.SUSPENDED, MembershipStatus.REMOVED],
  SUSPENDED: [MembershipStatus.ACTIVE, MembershipStatus.REMOVED],
  // A removed member re-joins through a fresh invitation, which produces a new
  // membership record and therefore a clean provenance trail.
  REMOVED: [],
};

export function canTransitionMembershipStatus(
  from: MembershipStatus,
  to: MembershipStatus,
): boolean {
  return ALLOWED_MEMBERSHIP_TRANSITIONS[from].includes(to);
}

/** Only an ACTIVE membership grants any access to the organization. */
export function membershipPermitsAccess(status: MembershipStatus): boolean {
  return status === MembershipStatus.ACTIVE;
}

export interface OrganizationMember {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: MembershipStatus;
  readonly roles: readonly string[];
  readonly joinedAt: string;
  readonly suspendedAt: string | null;
}

/**
 * Invitation lifecycle.
 *
 *   PENDING ──accept──► ACCEPTED   (terminal)
 *      │
 *      ├───revoke────► REVOKED     (terminal)
 *      └───lapse─────► EXPIRED     (terminal)
 *
 * `status` is authoritative. The timestamps (`acceptedAt`, `revokedAt`) are
 * provenance only — deriving state from nullable timestamps produces ambiguous
 * combinations, so they are never consulted to decide whether an invitation is
 * usable. EXPIRED is materialized on first inspection after `expiresAt`, so a
 * lapsed invitation reads consistently rather than depending on when it is
 * looked at.
 */
export const InvitationStatus = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
} as const;

export type InvitationStatus = (typeof InvitationStatus)[keyof typeof InvitationStatus];

export interface OrganizationInvitationSummary {
  readonly id: string;
  readonly email: string;
  readonly roleCode: string;
  readonly status: InvitationStatus;
  readonly invitedByUserId: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/**
 * What a recipient is told about an invitation before accepting.
 *
 * Deliberately minimal: enough to decide whether to accept, and nothing that
 * would let someone who guessed a token learn about the organization's people
 * or internal state (§32).
 */
export interface InvitationPreview {
  readonly organizationDisplayName: string;
  readonly roleCode: string;
  readonly expiresAt: string;
  /** True when the invited address already has a PalCert account. */
  readonly requiresRegistration: boolean;
}
