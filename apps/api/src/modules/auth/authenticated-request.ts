import type { AssuranceLevel, UserStatus } from '@palcert/contracts';
import type { Request } from 'express';

/** The authenticated caller, attached to the request by SessionGuard. */
export interface RequestPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly status: UserStatus;
  readonly assuranceLevel: AssuranceLevel;
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<string>;
  /** True when a held role demands MFA (drives the stricter session policy). */
  readonly privileged: boolean;
  readonly recentlyAuthenticated: boolean;
  readonly preferredLocale: string;
}

export interface AuthenticatedRequest extends Request {
  principal?: RequestPrincipal;
  /** Present on a PENDING_MFA session; the request is not yet authenticated. */
  pendingMfaPrincipal?: Pick<RequestPrincipal, 'userId' | 'sessionId' | 'email' | 'privileged'>;
}

/**
 * The correlation id pino-http attaches to the request. Typed as unknown here
 * because pino's own `ReqId` is a union; callers narrow it to a string.
 */
export function requestIdOf(request: Request): string | null {
  const id = (request as Request & { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
