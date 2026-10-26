/**
 * Explicit account lifecycle. Deliberately a single status rather than a set of
 * overlapping booleans (`isActive` + `isBlocked` + `isDisabled`), which cannot
 * express an unambiguous state.
 *
 * Permitted transitions:
 *
 *   PENDING_VERIFICATION → ACTIVE      (email verified)
 *   PENDING_VERIFICATION → DISABLED    (administrative)
 *   ACTIVE               → SUSPENDED   (reversible, administrative)
 *   ACTIVE               → DISABLED    (terminal)
 *   SUSPENDED            → ACTIVE      (reinstated)
 *   SUSPENDED            → DISABLED    (terminal)
 *
 * DISABLED is terminal. Any transition into SUSPENDED or DISABLED revokes every
 * session the user holds.
 */
export const UserStatus = {
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DISABLED: 'DISABLED',
} as const;

export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

const ALLOWED_TRANSITIONS: Record<UserStatus, readonly UserStatus[]> = {
  PENDING_VERIFICATION: [UserStatus.ACTIVE, UserStatus.DISABLED],
  ACTIVE: [UserStatus.SUSPENDED, UserStatus.DISABLED],
  SUSPENDED: [UserStatus.ACTIVE, UserStatus.DISABLED],
  DISABLED: [],
};

export function canTransitionStatus(from: UserStatus, to: UserStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Statuses in which a user may hold a usable session. */
export function statusPermitsSession(status: UserStatus): boolean {
  return status === UserStatus.ACTIVE;
}

/** The authenticated user as returned by `GET /users/me`. Never includes secrets. */
export interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: UserStatus;
  readonly preferredLocale: string;
  readonly emailVerified: boolean;
  readonly mfaEnrolled: boolean;
  readonly mfaRequired: boolean;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}
