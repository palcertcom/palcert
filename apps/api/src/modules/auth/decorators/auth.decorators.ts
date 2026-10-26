import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@palcert/contracts';
import type { AuthenticatedRequest, RequestPrincipal } from '../authenticated-request';

/** Marks a route as reachable without a session (login, register, reset...). */
export const IS_PUBLIC_KEY = 'palcert:public';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * A route authenticated by a provider's own signature rather than by a session.
 *
 * Browser CSRF protection is meaningless here and actively harmful: a payment
 * provider has no cookie, no Origin header and no CSRF token, so applying the
 * browser rules would reject every webhook (Phase 10 §47). What replaces them
 * is stronger — an HMAC over the exact request body, verified against a secret
 * only PalCert and the provider hold.
 *
 * Marking a route with this is a deliberate, greppable act. It must never be
 * used on anything a browser calls.
 */
export const PROVIDER_SIGNED_KEY = 'providerSigned';
export const ProviderSigned = () => SetMetadata(PROVIDER_SIGNED_KEY, true);

/**
 * Marks a route as reachable by a PENDING_MFA session.
 *
 * Only the MFA challenge and enrollment endpoints may carry this: everything
 * else must require a fully established session.
 */
export const ALLOWS_PENDING_MFA_KEY = 'palcert:allows-pending-mfa';
export const AllowsPendingMfa = () => SetMetadata(ALLOWS_PENDING_MFA_KEY, true);

/** Permissions the caller must hold. Evaluated by PermissionsGuard. */
export const REQUIRED_PERMISSIONS_KEY = 'palcert:permissions';
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/**
 * Requires the session to have authenticated within the re-authentication
 * window. Used for sensitive operations such as disabling MFA (§24).
 */
export const REQUIRES_RECENT_AUTH_KEY = 'palcert:recent-auth';
export const RequireRecentAuthentication = () => SetMetadata(REQUIRES_RECENT_AUTH_KEY, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestPrincipal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.principal === undefined) {
      // Programming error: the route was not protected by SessionGuard.
      throw new Error('CurrentUser used on a route without authentication');
    }
    return request.principal;
  },
);
