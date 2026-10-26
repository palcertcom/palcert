import { Injectable } from '@nestjs/common';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '@palcert/contracts';
import type { CookieOptions, Response } from 'express';
import { ApiConfigService } from '../../../config/api-config.service';

/**
 * Session cookie handling (§2, §33).
 *
 * The session cookie is HttpOnly so no script can read it — that is what makes
 * XSS unable to exfiltrate a session. The CSRF cookie is deliberately readable,
 * because the browser client has to copy it into a request header; knowing it
 * grants nothing on its own.
 */
@Injectable()
export class SessionCookieService {
  constructor(private readonly config: ApiConfigService) {}

  setSessionCookies(
    response: Response,
    params: { sessionToken: string; csrfToken: string; expiresAt: Date },
  ): void {
    const base = this.baseOptions();

    response.cookie(SESSION_COOKIE_NAME, params.sessionToken, {
      ...base,
      httpOnly: true,
      expires: params.expiresAt,
    });

    response.cookie(CSRF_COOKIE_NAME, params.csrfToken, {
      ...base,
      // Must be readable by the client so it can echo the value in a header.
      httpOnly: false,
      expires: params.expiresAt,
    });
  }

  clearSessionCookies(response: Response): void {
    const base = this.baseOptions();
    response.clearCookie(SESSION_COOKIE_NAME, { ...base, httpOnly: true });
    response.clearCookie(CSRF_COOKIE_NAME, { ...base, httpOnly: false });
  }

  private baseOptions(): CookieOptions {
    const policy = this.config.cookiePolicy;
    return {
      // Scoped to the whole origin: the API lives under /api but cookies must
      // also be cleared and sent for the documented routes.
      path: '/',
      secure: policy.secure,
      sameSite: policy.sameSite,
      ...(policy.domain !== undefined ? { domain: policy.domain } : {}),
    };
  }
}
