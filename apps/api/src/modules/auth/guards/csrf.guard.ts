import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AppError,
  CSRF_HEADER_NAME,
  PalCertErrorCode,
  SESSION_COOKIE_NAME,
} from '@palcert/contracts';
import { ApiConfigService } from '../../../config/api-config.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { hashSecretToken, secureCompare } from '../../../common/crypto/secret-token';
import type { AuthenticatedRequest } from '../authenticated-request';
import { MACHINE_ONLY_KEY } from '../../api-clients/decorators/api-client.decorators';
import { PROVIDER_SIGNED_KEY } from '../decorators/auth.decorators';

/** Methods that cannot change state, so they need no CSRF defence. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-site request forgery protection (ADR-0014).
 *
 * Two independent layers, because neither is sufficient alone:
 *
 *  1. **Origin/Referer allow-list** — applied to every unsafe request, whether
 *     or not a session exists. This is what stops *login* CSRF, where an
 *     attacker submits their own credentials to plant a known session in the
 *     victim's browser; a token check cannot help there because no session
 *     exists yet.
 *
 *  2. **Session-bound synchronizer token** — the CSRF cookie's value must be
 *     echoed in the `x-csrf-token` header and must match the digest stored on
 *     the session row. A cross-site attacker can cause the cookie to be *sent*
 *     but cannot *read* it to construct the header.
 *
 * SameSite=Lax is set as well, but is treated as defence in depth rather than
 * the control: it is a browser-version-dependent default, does nothing for
 * non-browser clients, and `Lax` still permits top-level cross-site GETs.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly config: ApiConfigService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      return true;
    }

    // A payment provider has no cookie, no Origin and no CSRF token. It proves
    // itself with an HMAC over the request body instead, which the route
    // verifies before doing anything at all (Phase 10 §47).
    if (
      this.reflector.getAllAndOverride<boolean>(PROVIDER_SIGNED_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    // An API client has no cookie, no browser and no ambient authority: it
    // presents a credential on every request, so there is nothing a third-party
    // site could cause it to send on somebody's behalf. CSRF is not relaxed
    // here, it does not apply — the attack it prevents needs a browser that
    // attaches credentials automatically, and there is none (Phase 19).
    if (
      this.reflector.getAllAndOverride<boolean>(MACHINE_ONLY_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    this.assertTrustedOrigin(request);
    await this.assertValidToken(request);
    return true;
  }

  /**
   * Reject an unsafe request whose Origin (or Referer, for older clients) is
   * not on the configured allow-list.
   *
   * A request with neither header is allowed through to the token check: that
   * is a same-origin server-to-server caller, which the token check still
   * covers, and rejecting it outright would break legitimate API clients.
   */
  private assertTrustedOrigin(request: AuthenticatedRequest): void {
    const origin = request.get('origin');
    const referer = request.get('referer');
    const candidate = origin ?? referer;

    if (candidate === undefined || candidate === 'null') {
      if (origin === 'null') {
        // An opaque origin means a sandboxed iframe or a data: document.
        throw this.rejected('OPAQUE_ORIGIN');
      }
      return;
    }

    let candidateOrigin: string;
    try {
      candidateOrigin = new URL(candidate).origin;
    } catch {
      throw this.rejected('MALFORMED_ORIGIN');
    }

    const allowed = this.config.corsOrigins.some((entry) => {
      try {
        return new URL(entry).origin === candidateOrigin;
      } catch {
        return false;
      }
    });

    if (!allowed) {
      throw this.rejected('UNTRUSTED_ORIGIN');
    }
  }

  /**
   * Verify the synchronizer token against the one bound to the session.
   *
   * Only applies when the request actually carries a session cookie: an
   * unauthenticated state-changing request (registration, password reset) has
   * no session to bind to and is covered by the origin check above plus
   * throttling.
   */
  private async assertValidToken(request: AuthenticatedRequest): Promise<void> {
    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    const sessionToken = cookies?.[SESSION_COOKIE_NAME];
    if (typeof sessionToken !== 'string' || sessionToken.length === 0) {
      return;
    }

    const headerValue = request.get(CSRF_HEADER_NAME);
    if (typeof headerValue !== 'string' || headerValue.length === 0) {
      throw this.rejected('MISSING_TOKEN');
    }

    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashSecretToken(sessionToken) },
      select: { csrfTokenHash: true },
    });

    // An unknown session cookie is not a CSRF failure — SessionGuard reports it
    // as unauthenticated, which is the more accurate answer.
    if (session === null) return;

    if (!secureCompare(hashSecretToken(headerValue), session.csrfTokenHash)) {
      throw this.rejected('TOKEN_MISMATCH');
    }
  }

  private rejected(reason: string): AppError {
    return new AppError(PalCertErrorCode.CSRF_INVALID, {
      message: 'This request could not be verified. Please refresh the page and try again.',
      internalContext: { reason },
    });
  }
}
