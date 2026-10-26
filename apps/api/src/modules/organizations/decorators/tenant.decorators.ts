import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@palcert/contracts';
import type { TenantContext, TenantRequest } from '../tenant-context';

/**
 * Marks a route as organization-scoped.
 *
 * `OrganizationContextGuard` then resolves and verifies the organization from
 * the `:organizationId` route parameter before the handler runs. Without this
 * decorator no tenant context exists and `@Tenant()` throws, so a route cannot
 * accidentally read tenant data with an unverified organization id.
 */
export const ORGANIZATION_SCOPED_KEY = 'palcert:organization-scoped';
export const OrganizationScoped = () => SetMetadata(ORGANIZATION_SCOPED_KEY, true);

/** Organization permissions the caller must hold *within* the resolved tenant. */
export const ORGANIZATION_PERMISSIONS_KEY = 'palcert:organization-permissions';
export const RequireOrganizationPermissions = (...permissions: Permission[]) =>
  SetMetadata(ORGANIZATION_PERMISSIONS_KEY, permissions);

/**
 * Allows a PalCert administrator to reach this route for any organization,
 * without a membership.
 *
 * Opt-in per route and never the default: an ordinary tenant route must not
 * gain cross-tenant reach merely because the caller happens to be staff (§22).
 * Routes carrying this always audit the access.
 */
export const ALLOW_PLATFORM_ADMIN_KEY = 'palcert:allow-platform-admin';
export const AllowPlatformAdmin = () => SetMetadata(ALLOW_PLATFORM_ADMIN_KEY, true);

/** Injects the verified tenant context. */
export const Tenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext => {
    const request = ctx.switchToHttp().getRequest<TenantRequest>();
    if (request.tenant === undefined) {
      // Programming error: the route was not marked @OrganizationScoped().
      throw new Error('Tenant used on a route without an organization context');
    }
    return request.tenant;
  },
);
