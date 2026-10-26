/** Name of the opaque session cookie. Never appears in a URL. */
export const SESSION_COOKIE_NAME = 'palcert_session' as const;

/**
 * Name of the CSRF cookie. Unlike the session cookie this one is deliberately
 * readable by JavaScript: the browser client must echo its value in the
 * `x-csrf-token` header (synchronizer-token pattern, see ADR-0014).
 */
export const CSRF_COOKIE_NAME = 'palcert_csrf' as const;
export const CSRF_HEADER_NAME = 'x-csrf-token' as const;

/**
 * Session lifecycle state.
 *
 * `PENDING_MFA` is a deliberately constrained pre-authentication state: the
 * password has been verified but the session may only reach the MFA challenge
 * endpoints. It is never a fully authenticated session.
 */
export const SessionState = {
  PENDING_MFA: 'PENDING_MFA',
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
} as const;

export type SessionState = (typeof SessionState)[keyof typeof SessionState];

/** Authenticator assurance level, following NIST SP 800-63B terminology. */
export const AssuranceLevel = {
  /** Single factor (password). */
  AAL1: 'AAL1',
  /** Two factors (password + TOTP or recovery code). */
  AAL2: 'AAL2',
} as const;

export type AssuranceLevel = (typeof AssuranceLevel)[keyof typeof AssuranceLevel];

export const SessionRevocationReason = {
  /** Reached its idle or absolute expiry and was retired on discovery. */
  EXPIRED: 'EXPIRED',
  USER_LOGOUT: 'USER_LOGOUT',
  USER_LOGOUT_ALL: 'USER_LOGOUT_ALL',
  USER_REVOKED: 'USER_REVOKED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  ADMIN_REVOKED: 'ADMIN_REVOKED',
  SESSION_ROTATED: 'SESSION_ROTATED',
  MFA_CHANGED: 'MFA_CHANGED',
} as const;

export type SessionRevocationReason =
  (typeof SessionRevocationReason)[keyof typeof SessionRevocationReason];

/** Session as exposed to its owner through `GET /auth/sessions`. */
export interface SessionSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly absoluteExpiresAt: string;
  readonly idleExpiresAt: string;
  readonly assuranceLevel: AssuranceLevel;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /** True for the session making the request. */
  readonly current: boolean;
}
