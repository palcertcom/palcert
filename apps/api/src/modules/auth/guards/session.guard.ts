import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AppError,
  AssuranceLevel,
  PalCertErrorCode,
  SESSION_COOKIE_NAME,
  SessionState,
  UserStatus,
  statusPermitsSession,
} from '@palcert/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { RbacService } from '../../rbac/rbac.service';
import type { AuthenticatedRequest } from '../authenticated-request';
import {
  ALLOWS_PENDING_MFA_KEY,
  IS_PUBLIC_KEY,
  REQUIRES_RECENT_AUTH_KEY,
} from '../decorators/auth.decorators';
import { SessionService } from '../services/session.service';

/**
 * Establishes the caller's identity from the opaque session cookie.
 *
 * Runs on every route by default; `@Public()` opts out. A PENDING_MFA session
 * is rejected everywhere except routes marked `@AllowsPendingMfa()`, so a
 * half-authenticated caller can never reach application functionality.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controller])) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const rawToken = this.extractToken(request);

    if (rawToken === null) {
      throw new AppError(PalCertErrorCode.UNAUTHENTICATED, {
        message: 'Authentication is required.',
      });
    }

    // `resolve` throws SESSION_EXPIRED / SESSION_REVOKED; an unknown token
    // yields null and is reported as plain unauthenticated.
    const session = await this.sessions.resolve(rawToken);
    if (session === null) {
      throw new AppError(PalCertErrorCode.UNAUTHENTICATED, {
        message: 'Authentication is required.',
      });
    }

    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (user === null) {
      throw new AppError(PalCertErrorCode.UNAUTHENTICATED, {
        message: 'Authentication is required.',
      });
    }

    // Status is re-checked on every request, not just at login: suspending an
    // account must take effect immediately for sessions already in flight.
    if (!statusPermitsSession(user.status as UserStatus)) {
      await this.sessions.revokeAllForUser(
        user.id,
        user.status === UserStatus.DISABLED ? 'ACCOUNT_DISABLED' : 'ACCOUNT_SUSPENDED',
      );
      throw new AppError(
        user.status === UserStatus.DISABLED
          ? PalCertErrorCode.ACCOUNT_DISABLED
          : PalCertErrorCode.ACCOUNT_SUSPENDED,
        { message: 'This account is not currently able to sign in.' },
      );
    }

    const authorization = await this.rbac.resolveAuthorization(user.id);
    const privileged = authorization.requiresMfa || user.mfaRequiredOverride;

    if (session.state === SessionState.PENDING_MFA) {
      const allowsPending = this.reflector.getAllAndOverride<boolean>(ALLOWS_PENDING_MFA_KEY, [
        handler,
        controller,
      ]);
      if (allowsPending !== true) {
        throw new AppError(PalCertErrorCode.MFA_REQUIRED, {
          message: 'Multi-factor authentication must be completed first.',
        });
      }
      request.pendingMfaPrincipal = {
        userId: user.id,
        sessionId: session.id,
        email: user.email,
        privileged,
      };
      return true;
    }

    // A privileged user whose session never reached AAL2 must not proceed: this
    // is the backstop if a role is granted while a session is already open.
    if (privileged && session.assuranceLevel !== AssuranceLevel.AAL2) {
      throw new AppError(PalCertErrorCode.MFA_REQUIRED, {
        message: 'Multi-factor authentication is required for this account.',
      });
    }

    request.principal = {
      userId: user.id,
      sessionId: session.id,
      email: user.email,
      status: user.status as UserStatus,
      assuranceLevel: session.assuranceLevel as AssuranceLevel,
      roles: authorization.roles,
      permissions: authorization.permissions,
      privileged,
      recentlyAuthenticated: this.sessions.isRecentlyAuthenticated(session),
      preferredLocale: user.preferredLocale,
    };

    if (
      this.reflector.getAllAndOverride<boolean>(REQUIRES_RECENT_AUTH_KEY, [handler, controller]) &&
      !request.principal.recentlyAuthenticated
    ) {
      throw new AppError(PalCertErrorCode.REAUTHENTICATION_REQUIRED, {
        message: 'Please confirm your password again to continue.',
      });
    }

    await this.sessions.touch(session, privileged);
    return true;
  }

  /**
   * The session identifier is read from the cookie only.
   *
   * It is never accepted from a query parameter or URL path: that would place
   * a live credential in browser history, referrer headers and server logs.
   */
  private extractToken(request: AuthenticatedRequest): string | null {
    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    const value = cookies?.[SESSION_COOKIE_NAME];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}
