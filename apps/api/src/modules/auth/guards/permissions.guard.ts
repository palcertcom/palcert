import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, PalCertErrorCode, type Permission } from '@palcert/contracts';
import type { AuthenticatedRequest } from '../authenticated-request';
import { IS_PUBLIC_KEY, REQUIRED_PERMISSIONS_KEY } from '../decorators/auth.decorators';

/**
 * Permission-based authorization.
 *
 * Guards evaluate permissions, never role names, so a new role is a data change
 * rather than a code change and no endpoint ever grows an
 * `if (role === 'PALCERT_ADMIN')` branch (§18).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<Permission[]>(
      REQUIRED_PERMISSIONS_KEY,
      targets,
    );
    if (required === undefined || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;

    if (principal === undefined) {
      throw new AppError(PalCertErrorCode.UNAUTHENTICATED, {
        message: 'Authentication is required.',
      });
    }

    const missing = required.filter((permission) => !principal.permissions.has(permission));
    if (missing.length > 0) {
      throw new AppError(PalCertErrorCode.PERMISSION_DENIED, {
        message: 'You do not have permission to perform this action.',
        // The required permission is safe to disclose — it is a documented part
        // of the API — while the caller's own permissions are not.
        details: { required: missing },
        internalContext: { userId: principal.userId, held: [...principal.permissions] },
      });
    }

    return true;
  }
}
