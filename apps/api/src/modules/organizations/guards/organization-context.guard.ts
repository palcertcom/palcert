import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, PalCertErrorCode } from '@palcert/contracts';
import { requestIdOf } from '../../auth/authenticated-request';
import { ALLOW_PLATFORM_ADMIN_KEY, ORGANIZATION_SCOPED_KEY } from '../decorators/tenant.decorators';
import { TenantResolverService } from '../services/tenant-resolver.service';
import type { TenantRequest } from '../tenant-context';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turns an `:organizationId` route parameter into a verified tenant context.
 *
 * Runs after `SessionGuard` (identity) and before `OrganizationPermissionsGuard`
 * (tenant authorization). Routes not marked `@OrganizationScoped()` are
 * untouched, so no route can accidentally acquire a tenant context it did not
 * ask for — and, conversely, `@Tenant()` on an unmarked route fails loudly
 * rather than silently reading someone else's data.
 */
@Injectable()
export class OrganizationContextGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: TenantResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(ORGANIZATION_SCOPED_KEY, targets) !== true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<TenantRequest>();
    const principal = request.principal;

    if (principal === undefined) {
      throw new AppError(PalCertErrorCode.UNAUTHENTICATED, {
        message: 'Authentication is required.',
      });
    }

    const params = request.params as Record<string, string | undefined>;
    const organizationId = params.organizationId;

    // A malformed id is reported as "not found", identically to a well-formed
    // id belonging to someone else, so the shape of the response never hints at
    // whether an organization exists.
    if (typeof organizationId !== 'string' || !UUID_PATTERN.test(organizationId)) {
      throw new AppError(PalCertErrorCode.ORGANIZATION_NOT_FOUND, {
        message: 'Organization not found.',
      });
    }

    request.tenant = await this.resolver.resolve({
      principal,
      organizationId,
      allowPlatformAdmin:
        this.reflector.getAllAndOverride<boolean>(ALLOW_PLATFORM_ADMIN_KEY, targets) === true,
      requestId: requestIdOf(request),
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
      method: request.method,
      path: request.path,
    });

    return true;
  }
}
