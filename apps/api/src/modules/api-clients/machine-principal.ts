import type { ApiClientScope } from '@palcert/contracts';
import type { Request } from 'express';

/**
 * An authenticated machine (Phase 19).
 *
 * A separate type from `RequestPrincipal`, not a variant of it, and that is the
 * point. If a machine could be represented as a user principal then every
 * `@CurrentUser()` in PalCert would silently accept one, and every audit record
 * would name a person who was not there. The two cannot be assigned to each
 * other, so a route written for a human refuses a machine at compile time
 * rather than at review time.
 *
 * There is no `userId` here and no way to derive one. An API client does not
 * act as the person who created it: that person may have left the organization,
 * lost their permissions, or been removed entirely, and a credential that kept
 * working as them would be an account nobody can see in the member list.
 */
export interface MachinePrincipal {
  readonly kind: 'API_CLIENT';
  /** The row id. Used in audit records and never shown to the caller. */
  readonly apiClientId: string;
  /** The public identifier, safe to log. */
  readonly clientId: string;
  /** Exactly one, always. A client belongs to one organization for ever. */
  readonly organizationId: string;
  readonly displayName: string;
  readonly scopes: ReadonlySet<ApiClientScope>;
  /** Which stored secret verified, so a rotation can be traced end to end. */
  readonly secretId: string;
}

export interface MachineRequest extends Request {
  machine?: MachinePrincipal;
}

/**
 * The actor recorded in an audit event.
 *
 * A discriminated union rather than a nullable user id, so a reader of the
 * audit log can never mistake "a machine did this" for "we do not know who did
 * this". Those are different facts and only one of them is a problem.
 */
export type AuditActor =
  | { readonly type: 'USER'; readonly userId: string }
  | { readonly type: 'API_CLIENT'; readonly apiClientId: string; readonly clientId: string }
  | { readonly type: 'SYSTEM' };

export function machineActor(principal: MachinePrincipal): AuditActor {
  return {
    type: 'API_CLIENT',
    apiClientId: principal.apiClientId,
    clientId: principal.clientId,
  };
}
