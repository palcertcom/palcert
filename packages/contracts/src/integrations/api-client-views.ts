import type { ApiClientScope, ApiClientSecretStatus, ApiClientStatus } from './api-client.js';

/**
 * What an administrator sees about a credential holder.
 *
 * There is no secret on this object and no field that could carry one. That is
 * structural rather than a matter of care at the call site: a view type with
 * nowhere to put a secret cannot leak one through a controller somebody writes
 * later.
 */
export interface ApiClientView {
  readonly apiClientId: string;
  readonly organizationId: string;
  /** The public identifier, safe to display and to log. */
  readonly clientId: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly status: ApiClientStatus;
  readonly scopes: readonly ApiClientScope[];
  readonly createdAt: string;
  readonly createdByUserId: string;
  /** When the client stops authenticating, or null when it does not expire. */
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly disabledAt: string | null;
  /**
   * Last successful authentication, to the minute.
   *
   * Truncated deliberately. "Has this credential been used?" and "is anything
   * still calling with it?" are the questions an administrator has, and both
   * are answered at minute resolution. Second-level timestamps across a set of
   * clients start to describe a customer's internal schedule, which is not
   * PalCert's to publish back.
   */
  readonly lastUsedAt: string | null;
  /** How many secrets currently verify: 1 normally, 2 during an overlap. */
  readonly liveSecretCount: number;
  /** When the rotation overlap ends, when one is in progress. */
  readonly rotationOverlapEndsAt: string | null;
}

/**
 * The one and only time a secret is returned.
 *
 * Its own type so that returning it is a deliberate act at the call site,
 * visible in the signature, rather than an extra field that could be included
 * in an ordinary read by accident.
 */
export interface ApiClientSecretRevealView {
  readonly client: ApiClientView;
  /** Shown once. PalCert keeps only a one-way verifier and cannot show it again. */
  readonly clientSecret: string;
  /** When the previous secret stops verifying, on a rotation. */
  readonly previousSecretRetiresAt: string | null;
}

/** One secret's lifecycle, without the secret. */
export interface ApiClientSecretView {
  readonly secretId: string;
  readonly status: ApiClientSecretStatus;
  readonly createdAt: string;
  readonly overlapEndsAt: string | null;
  readonly retiredAt: string | null;
  readonly lastUsedAt: string | null;
}

/** The scope catalogue, for a management screen that must not hard-code it. */
export interface ApiClientScopeDescriptor {
  readonly scope: ApiClientScope;
  /** Operations this scope unlocks, so a screen can show what it means. */
  readonly operations: readonly string[];
  readonly write: boolean;
}
