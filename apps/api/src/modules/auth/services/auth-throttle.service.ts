import { Injectable } from '@nestjs/common';
import { AppError, PalCertErrorCode } from '@palcert/contracts';
import { createHash } from 'node:crypto';
import { ApiConfigService } from '../../../config/api-config.service';
import { RedisService } from '../../../infrastructure/redis/redis.service';

export const ThrottleScope = {
  LOGIN_ACCOUNT: 'login:account',
  LOGIN_IP: 'login:ip',
  MFA: 'mfa',
  PASSWORD_RESET: 'pwreset',
  VERIFICATION_RESEND: 'verify-resend',
  /**
   * Phase 15 §20 — public certificate verification.
   *
   * Its own scope because it is the one unauthenticated lookup in PalCert that
   * takes a secret as a path parameter. The code is 160 bits, so guessing is
   * not a realistic attack, but a dedicated limit means a script cannot sit
   * there trying anyway, and it keeps that traffic from consuming an
   * authentication budget it has nothing to do with.
   */
  PUBLIC_CERTIFICATE_VERIFY: 'certificate-verify',
  /** Public attestation verification, by link or by file digest. Per client. */
  PUBLIC_ATTESTATION_VERIFY: 'attestation-verify',
  /** Certificate uploads for attestation, per user. */
  ATTESTATION_UPLOAD: 'attestation-upload',
  /** Attestation submissions and new requests, per user. */
  ATTESTATION_SUBMIT: 'attestation-submit',
  /** Receipt and payment-method logo uploads for manual top-ups, per user. */
  MANUAL_TOPUP_UPLOAD: 'manual-topup-upload',
  /** Manual top-up drafts and submissions, per user. */
  MANUAL_TOPUP_SUBMIT: 'manual-topup-submit',
  /** Configuration test emails, per administrator. */
  EMAIL_TEST_ADMIN: 'email-test:admin',
  /** Configuration test emails, platform-wide: no relay, however many admins. */
  EMAIL_TEST_GLOBAL: 'email-test:global',
} as const;

/** Uploads one person may start per window: plenty for real use, not for spam. */
export const ATTESTATION_UPLOAD_LIMIT = 30;
/** Requests one person may create or submit per window. */
export const ATTESTATION_SUBMIT_LIMIT = 20;
/** Receipt uploads one person may start per window. */
export const MANUAL_TOPUP_UPLOAD_LIMIT = 30;
/** Manual top-up drafts and submissions one person may make per window. */
export const MANUAL_TOPUP_SUBMIT_LIMIT = 20;
/** Test emails one administrator may send per window. */
export const EMAIL_TEST_ADMIN_LIMIT = 5;
/** Test emails the whole platform may send per window. */
export const EMAIL_TEST_GLOBAL_LIMIT = 20;

/**
 * Attempts per window for public verification.
 *
 * Generous enough that a person checking several certificates from an office
 * is never inconvenienced, and far too low to enumerate anything.
 */
export const PUBLIC_CERTIFICATE_VERIFY_LIMIT = 60;

export type ThrottleScope = (typeof ThrottleScope)[keyof typeof ThrottleScope];

/**
 * Authentication throttling (Phase 1 §12).
 *
 * Counters live in Redis with a sliding TTL window. Two independent dimensions
 * are tracked:
 *
 *  - **per account** — stops password spraying against one user,
 *  - **per IP** — stops credential stuffing from one source.
 *
 * Deliberately NOT implemented as a persistent account lockout: an attacker who
 * knows an email address could then lock any user out at will, turning a
 * brute-force defence into a denial-of-service weapon. The counter expires on
 * its own, so a legitimate user regains access by waiting out the window rather
 * than by contacting support.
 *
 * Identifiers are hashed before being used as keys so Redis never holds a
 * plaintext list of registered email addresses.
 */
@Injectable()
export class AuthThrottleService {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ApiConfigService,
  ) {}

  /**
   * Register an attempt and fail if the limit is now exceeded.
   * Returns the current count so callers can log near-limit activity.
   */
  async consume(scope: ThrottleScope, identifier: string): Promise<number> {
    const limit = this.limitFor(scope);
    const windowSeconds = this.config.throttlePolicy.windowMinutes * 60;
    const key = this.keyFor(scope, identifier);

    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, windowSeconds);
    }

    if (count > limit) {
      const ttl = await this.redis.client.ttl(key);
      throw new AppError(PalCertErrorCode.RATE_LIMITED, {
        message: 'Too many attempts. Please try again later.',
        details: { retryAfterSeconds: ttl > 0 ? ttl : windowSeconds },
      });
    }

    return count;
  }

  /** Clear a counter after a legitimate success, so one bad day is not punished. */
  async reset(scope: ThrottleScope, identifier: string): Promise<void> {
    await this.redis.client.del(this.keyFor(scope, identifier));
  }

  async currentCount(scope: ThrottleScope, identifier: string): Promise<number> {
    const value = await this.redis.client.get(this.keyFor(scope, identifier));
    return value === null ? 0 : Number.parseInt(value, 10);
  }

  private limitFor(scope: ThrottleScope): number {
    const policy = this.config.throttlePolicy;
    switch (scope) {
      case ThrottleScope.LOGIN_ACCOUNT:
        return policy.loginPerAccount;
      case ThrottleScope.LOGIN_IP:
        return policy.loginPerIp;
      case ThrottleScope.MFA:
        return policy.mfaAttempts;
      case ThrottleScope.PASSWORD_RESET:
      case ThrottleScope.VERIFICATION_RESEND:
        return policy.passwordResetRequests;
      case ThrottleScope.PUBLIC_CERTIFICATE_VERIFY:
      case ThrottleScope.PUBLIC_ATTESTATION_VERIFY:
        return PUBLIC_CERTIFICATE_VERIFY_LIMIT;
      case ThrottleScope.ATTESTATION_UPLOAD:
        return ATTESTATION_UPLOAD_LIMIT;
      case ThrottleScope.ATTESTATION_SUBMIT:
        return ATTESTATION_SUBMIT_LIMIT;
      case ThrottleScope.MANUAL_TOPUP_UPLOAD:
        return MANUAL_TOPUP_UPLOAD_LIMIT;
      case ThrottleScope.MANUAL_TOPUP_SUBMIT:
        return MANUAL_TOPUP_SUBMIT_LIMIT;
      case ThrottleScope.EMAIL_TEST_ADMIN:
        return EMAIL_TEST_ADMIN_LIMIT;
      case ThrottleScope.EMAIL_TEST_GLOBAL:
        return EMAIL_TEST_GLOBAL_LIMIT;
    }
  }

  private keyFor(scope: ThrottleScope, identifier: string): string {
    const digest = createHash('sha256').update(identifier).digest('hex').slice(0, 32);
    return `palcert:throttle:${scope}:${digest}`;
  }
}
