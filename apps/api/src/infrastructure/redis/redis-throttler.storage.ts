import { Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { RedisService } from './redis.service';

/**
 * Shared storage for the global HTTP rate limiter (Phase 20 Checkpoint 2).
 *
 * `@nestjs/throttler` defaults to an in-memory store, which counts per
 * process. That is invisible on one instance and wrong on every deployment
 * with more than one: behind a load balancer with N replicas the real budget
 * becomes N times the configured limit, and a caller spread across instances
 * gets the extra for free. Horizontal scaling is exactly what Phase 20 is
 * preparing for, so the limit has to be shared before the replicas exist.
 *
 * The mechanism is the one PalCert already uses twice — `AuthThrottleService`
 * for login attempts and `ApiClientThrottleService` for machine credentials:
 * `INCR` a key, `EXPIRE` it on first write, compare against the limit. Those
 * two are unchanged by this class and keep their own keyspaces; this adds the
 * same pattern for the generic HTTP throttle that had none.
 *
 * **Keys are hashed.** The throttler's key is derived from the caller's IP
 * address, and an IP address is personal data: a Redis dump should not be a
 * list of who used PalCert and when. The hash keeps the counter working and
 * makes the key meaningless on its own.
 *
 * **A Redis outage must not take the API down.** If the store cannot answer,
 * the request is allowed and the failure is logged. That is a deliberate
 * choice between two bad options: refusing every request because a rate
 * limiter is unavailable turns a throttle outage into a total outage, and the
 * limiter is an abuse control rather than an authorization control — nothing
 * downstream of it depends on it for correctness. Authentication throttling
 * and API-client throttling, which *are* security controls, keep their own
 * fail-closed behaviour.
 */
/**
 * What `increment` must return.
 *
 * Declared here rather than imported: `@nestjs/throttler` v6 ships
 * `ThrottlerStorageRecord` in a file its `index.d.ts` does not re-export, so
 * the only way to import it is a deep path into `dist/`, which is a private
 * path that a patch release may move. The shape is checked structurally
 * against `ThrottlerStorage` either way, so a mismatch is still a compile
 * error rather than a runtime surprise.
 */
interface ThrottlerRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RedisThrottlerStorage.name);
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerRecord> {
    // The throttler works in milliseconds; Redis TTLs here are whole seconds.
    const windowSeconds = Math.max(1, Math.ceil(ttl / 1000));
    const blockSeconds = Math.max(1, Math.ceil(blockDuration / 1000));
    const counterKey = this.keyFor(throttlerName, key);
    const blockKey = `${counterKey}:blocked`;

    try {
      const blockedFor = await this.redis.client.ttl(blockKey);
      if (blockedFor > 0) {
        return {
          totalHits: limit + 1,
          timeToExpire: blockedFor,
          isBlocked: true,
          timeToBlockExpire: blockedFor,
        };
      }

      const totalHits = await this.redis.client.incr(counterKey);
      if (totalHits === 1) {
        await this.redis.client.expire(counterKey, windowSeconds);
      }

      const remaining = await this.redis.client.ttl(counterKey);
      const timeToExpire = remaining > 0 ? remaining : windowSeconds;

      if (totalHits > limit) {
        // Set the block only when crossing the line, so a caller who keeps
        // hammering does not extend their own penalty indefinitely — the
        // block is a fixed period, not a rolling one.
        if (totalHits === limit + 1) {
          await this.redis.client.set(blockKey, '1', 'EX', blockSeconds);
        }
        const blockTtl = await this.redis.client.ttl(blockKey);
        return {
          totalHits,
          timeToExpire,
          isBlocked: true,
          timeToBlockExpire: blockTtl > 0 ? blockTtl : blockSeconds,
        };
      }

      return { totalHits, timeToExpire, isBlocked: false, timeToBlockExpire: 0 };
    } catch (error) {
      this.logger.warn({ err: error }, 'Rate-limit store unavailable; allowing the request');
      return { totalHits: 1, timeToExpire: windowSeconds, isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  /**
   * One keyspace, and the caller's identity hashed inside it.
   *
   * Prefixed so a Redis `SCAN` during an incident can tell HTTP throttle
   * counters apart from the auth and API-client ones, which live under their
   * own prefixes and are not touched by this class.
   */
  private keyFor(throttlerName: string, key: string): string {
    const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
    return `throttle:http:${throttlerName}:${digest}`;
  }
}
