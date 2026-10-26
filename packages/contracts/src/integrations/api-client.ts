/**
 * Organization-owned API clients and machine authentication (Phase 19).
 *
 * The shape of the whole phase is decided by one sentence: **a scope is not a
 * permission**. `API_CLIENT` has held zero permissions since Phase 1, and the
 * obvious implementation — resolve the client's organization, hand it that
 * organization's rights — would undo every boundary the previous eighteen
 * phases built, silently, on the day somebody adds a route.
 *
 * So a client holds *scopes*; a scope names a closed set of *operations*; and
 * an operation is a route that opted in by name. A route that names no
 * operation is unreachable to a machine no matter what scopes a client holds,
 * which makes the default for anything new "inaccessible" rather than
 * "inherited".
 */

/**
 * What a machine may ask PalCert to do.
 *
 * Deliberately coarse and deliberately few. Each is a job an integration
 * genuinely has — watch our submissions, read the evidence we were sent, run a
 * check against our own standard — rather than a mirror of an internal
 * permission. Fewer, broader scopes that a customer can reason about beat a
 * long list nobody reads before ticking every box.
 */
export const ApiClientScope = {
  /** Read the organization's own profile and its published standards. */
  ORGANIZATION_READ: 'organization:read',
  /**
   * List and read official submissions sent to this organization.
   *
   * Metadata and decision history. Deliberately **not** the attached document
   * or report: handing a machine the contents of somebody's thesis is a
   * different decision from telling it one arrived, and it needs its own
   * design — short-lived URLs, their own audit trail, their own scope. Phase
   * 19 does not make that decision quietly by bundling it in here.
   */
  SUBMISSIONS_READ: 'submissions:read',
  /** Read certificate records this organization's approvals produced. */
  CERTIFICATES_READ: 'certificates:read',
  /** Read the organization's outbound webhook configuration. */
  WEBHOOKS_READ: 'webhooks:read',
} as const;

export type ApiClientScope = (typeof ApiClientScope)[keyof typeof ApiClientScope];

export const ALL_API_CLIENT_SCOPES: readonly ApiClientScope[] = Object.values(ApiClientScope);

/**
 * Every scope is read-only in Phase 19, and that is a decision rather than a
 * gap.
 *
 * A machine that can read is a machine that can leak; a machine that can write
 * is a machine that can act, and an integration acting wrongly at scale is a
 * different class of incident. The write surface arrives when there is a
 * concrete integration asking for it, with its own idempotency and its own
 * tests — not pre-emptively because the scope vocabulary had room.
 *
 * The idempotency machinery is built anyway, because the first mutating route
 * must not be the moment somebody designs retry semantics under pressure.
 */
export const WRITE_API_CLIENT_SCOPES: readonly ApiClientScope[] = [];

export function isApiClientScope(value: string): value is ApiClientScope {
  return (ALL_API_CLIENT_SCOPES as readonly string[]).includes(value);
}

/**
 * The named operations a machine may reach.
 *
 * The allow-list is expressed as operation names rather than paths so a route
 * cannot be opted in by a URL that happens to match a pattern. A controller
 * method declares the operation it implements; the guard checks the client's
 * scopes against the operation's required scope; a method that declares none
 * is unreachable.
 */
export const ApiClientOperation = {
  ORGANIZATION_PROFILE_READ: 'organization.profile.read',
  ORGANIZATION_STANDARD_LIST: 'organization.standard.list',
  ORGANIZATION_STANDARD_READ: 'organization.standard.read',
  SUBMISSION_LIST: 'submission.list',
  SUBMISSION_READ: 'submission.read',
  SUBMISSION_REVISION_HISTORY: 'submission.revision.history',
  CERTIFICATE_READ: 'certificate.read',
  CERTIFICATE_EVENTS_READ: 'certificate.events.read',
  WEBHOOK_ENDPOINT_LIST: 'webhook.endpoint.list',
} as const;

export type ApiClientOperation = (typeof ApiClientOperation)[keyof typeof ApiClientOperation];

export const ALL_API_CLIENT_OPERATIONS: readonly ApiClientOperation[] =
  Object.values(ApiClientOperation);

/**
 * The machine-access allow-list: operation → the one scope that unlocks it.
 *
 * One scope per operation, never a set. An operation reachable through two
 * scopes is an operation whose blast radius nobody can state, and "which of
 * these grants it?" is exactly the question an administrator ticking boxes is
 * trying to answer.
 */
export const API_CLIENT_OPERATION_SCOPE: Readonly<Record<ApiClientOperation, ApiClientScope>> = {
  [ApiClientOperation.ORGANIZATION_PROFILE_READ]: ApiClientScope.ORGANIZATION_READ,
  [ApiClientOperation.ORGANIZATION_STANDARD_LIST]: ApiClientScope.ORGANIZATION_READ,
  [ApiClientOperation.ORGANIZATION_STANDARD_READ]: ApiClientScope.ORGANIZATION_READ,
  [ApiClientOperation.SUBMISSION_LIST]: ApiClientScope.SUBMISSIONS_READ,
  [ApiClientOperation.SUBMISSION_READ]: ApiClientScope.SUBMISSIONS_READ,
  [ApiClientOperation.SUBMISSION_REVISION_HISTORY]: ApiClientScope.SUBMISSIONS_READ,
  [ApiClientOperation.CERTIFICATE_READ]: ApiClientScope.CERTIFICATES_READ,
  [ApiClientOperation.CERTIFICATE_EVENTS_READ]: ApiClientScope.CERTIFICATES_READ,
  [ApiClientOperation.WEBHOOK_ENDPOINT_LIST]: ApiClientScope.WEBHOOKS_READ,
};

export function scopeForOperation(operation: string): ApiClientScope | null {
  return API_CLIENT_OPERATION_SCOPE[operation as ApiClientOperation] ?? null;
}

/** Operational state of a credential holder. */
export const ApiClientStatus = {
  ACTIVE: 'ACTIVE',
  /** Switched off by an administrator, reversibly. */
  DISABLED: 'DISABLED',
  /** Ended for good. Never returns to ACTIVE, and its secrets never verify. */
  REVOKED: 'REVOKED',
} as const;

export type ApiClientStatus = (typeof ApiClientStatus)[keyof typeof ApiClientStatus];

/** State of one secret belonging to a client. */
export const ApiClientSecretStatus = {
  /** The secret a rotation mints, and the one a client should be using. */
  ACTIVE: 'ACTIVE',
  /**
   * The previous secret during a rotation overlap. Still verifies, and stops
   * at `overlapEndsAt` without anybody having to do anything.
   */
  ROTATING_OUT: 'ROTATING_OUT',
  /** Ended: by revocation, by a second rotation, or by the overlap elapsing. */
  RETIRED: 'RETIRED',
} as const;

export type ApiClientSecretStatus =
  (typeof ApiClientSecretStatus)[keyof typeof ApiClientSecretStatus];

/**
 * How long a rotated-out secret keeps verifying, in seconds.
 *
 * The number exists so that rotating does not require a synchronised deploy: a
 * customer rotates, updates their configuration, and the old credential keeps
 * working meanwhile. It is *bounded* because the whole point of rotating is to
 * stop the previous secret working, and an unbounded overlap would leave two
 * permanent credentials where the administrator believed there was one.
 *
 * Twelve hours: long enough for a change to move through a normal release
 * process including a timezone's worth of working day, short enough that a
 * leaked secret is not usable tomorrow.
 */
export const API_CLIENT_ROTATION_OVERLAP_SECONDS = 12 * 60 * 60;

/** The longest overlap a caller may request. Never more than the default. */
export const API_CLIENT_MAX_ROTATION_OVERLAP_SECONDS = API_CLIENT_ROTATION_OVERLAP_SECONDS;

/**
 * Secret length in bytes before encoding.
 *
 * 32 bytes from a CSPRNG. Guessing is not a threat model at this width; the
 * threats are disclosure and reuse, which length does not help with and the
 * lifecycle does.
 */
export const API_CLIENT_SECRET_BYTES = 32;

/** How many live (ACTIVE or ROTATING_OUT) secrets one client may hold. */
export const API_CLIENT_MAX_LIVE_SECRETS = 2;

/** How many non-revoked clients one organization may hold. */
export const API_CLIENT_MAX_PER_ORGANIZATION = 25;

/**
 * The prefix every client id carries, and the prefix every secret carries.
 *
 * Distinct and self-describing, so a secret pasted into the wrong field is
 * recognizable as the wrong kind of thing — by a person reading a config file,
 * by a secret scanner, and by PalCert's own validation. The secret prefix also
 * means a leaked string is identifiable in a log or a repository as a PalCert
 * credential rather than an anonymous blob nobody chases.
 */
export const API_CLIENT_ID_PREFIX = 'pcid_';
export const API_CLIENT_SECRET_PREFIX = 'pcsk_';

/** How a presented credential reached PalCert. Recorded, never the secret. */
export const ApiClientAuthScheme = {
  /** `Authorization: Basic base64(clientId:secret)`. */
  BASIC: 'BASIC',
} as const;

export type ApiClientAuthScheme = (typeof ApiClientAuthScheme)[keyof typeof ApiClientAuthScheme];
