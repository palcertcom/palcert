import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, PalCertErrorCode, type Permission } from '@palcert/contracts';
import { ORGANIZATION_PERMISSIONS_KEY } from '../decorators/tenant.decorators';
import type { TenantRequest } from '../tenant-context';

/**
 * Authorizes a route against the permissions the caller holds *inside the
 * resolved organization*.
 *
 * Deliberately a separate guard from the global `PermissionsGuard`: the two
 * evaluate different permission sets, and merging them would make it possible
 * for a platform permission to satisfy an organization requirement, or the
 * reverse.
 */
@Injectable()
export class OrganizationPermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(ORGANIZATION_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required === undefined || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<TenantRequest>();
    const tenant = request.tenant;

    if (tenant === undefined) {
      // Programming error: organization permissions declared on a route that
      // never resolves a tenant. Fail closed rather than allowing the request.
      throw new AppError(PalCertErrorCode.ORGANIZATION_ACCESS_DENIED, {
        message: 'Organization context is required.',
        internalContext: { reason: 'RequireOrganizationPermissions without OrganizationScoped' },
      });
    }

    const missing = required.filter((permission) => !tenant.permissions.has(permission));

    if (missing.length > 0) {
      throw new AppError(PalCertErrorCode.ORGANIZATION_ACCESS_DENIED, {
        message: 'You do not have permission to do this in this organization.',
        details: { required: missing },
        internalContext: {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          held: [...tenant.permissions],
        },
      });
    }

    return true;
  }
}
