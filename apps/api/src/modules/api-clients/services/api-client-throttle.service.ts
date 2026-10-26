import { Injectable } from '@nestjs/common';
import { AppError, PalCertErrorCode } from '@palcert/contracts';
import { createHash } from 'node:crypto';
import { MetricsService } from '../../../infrastructure/metrics/metrics.service';
import { RedisService } from '../../../infrastructure/redis/redis.service';

/**
 * Per-credential throttling for machine traffic (Phase 19).
 *
 * The existing global limiter counts per IP, which is the wrong dimension for
 * an integration: a customer's whole estate is often one egress address, so an
 * IP limit either throttles a legitimate integration or is set so high it
 * throttles nothing. And a stolen credential used from a different address
 * would get a fresh budget.
 *
 * So the credential is the subject. Two windows, because they answer different
 * questions:
 *
 * * **authentication attempts**, keyed on the presented client id, counted
 *   whether or not the secret was right. This is what caps an online guessing
 *   attack and what stops an attacker using PalCert's Argon2 cost as an
 *   amplifier. Counted before verification, so a wrong secret is as expensive
 *   to the attacker as a right one.
 * * **successful calls**, keyed on the authenticated client. Ordinary capacity
 *   management, generous enough that a real integration never notices.
 *
 * Failures are counted on a *separate* key from successes. Without that split,
 * a busy legitimate integration would raise the ceiling an attacker guessing
 * against the same client id gets to hide under.
 */
@Injectable()
export class ApiClientThrottleService {
  /** Authentication attempts per client id per minute, right or wrong. */
  static readonly AUTH_ATTEMPTS_PER_MINUTE = 60;
  /** Authenticated requests per client per minute. */
  static readonly REQUESTS_PER_MINUTE = 600;
  static readonly WINDOW_SECONDS = 60;

  constructor(
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Count one authentication attempt and refuse when the budget is spent.
   *
   * Keyed on a hash of the presented client id rather than the id itself, so a
   * Redis dump does not enumerate which credentials exist — and so that an
   * arbitrary string from a caller never becomes a key.
   */
  async attempt(presentedClientId: string): Promise<void> {
    await this.consume(
      `api-client:auth:${this.digest(presentedClientId)}`,
      ApiClientThrottleService.AUTH_ATTEMPTS_PER_MINUTE,
      'auth',
    );
  }

  /** Count one authenticated request. */
  async request(apiClientId: string): Promise<void> {
    await this.consume(
      `api-client:req:${this.digest(apiClientId)}`,
      ApiClientThrottleService.REQUESTS_PER_MINUTE,
      'request',
    );
  }

  /**
   * `window` is `auth` or `request` — which budget was spent, never whose.
   * The key is already a hash precisely so no credential is enumerable, and a
   * metric labelled by client id would undo that on a scrape.
   */
  private async consume(key: string, limit: number, window: 'auth' | 'request'): Promise<void> {
    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, ApiClientThrottleService.WINDOW_SECONDS);
    }
    if (count > limit) {
      this.metrics.apiClientThrottled.inc({ window });
      throw new AppError(PalCertErrorCode.API_CLIENT_RATE_LIMITED, {
        message: 'Too many requests for this credential. Please slow down and retry.',
      });
    }
  }

  private digest(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
  }
}
