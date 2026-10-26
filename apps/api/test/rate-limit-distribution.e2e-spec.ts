import { ThrottlerStorage } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import IORedis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { RedisThrottlerStorage } from '../src/infrastructure/redis/redis-throttler.storage';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { createTestContext, destroyTestContext, type TestContext } from './support/test-app';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/** A storage instance with its own connection: what a second replica has. */
function replica(connection: IORedis): RedisThrottlerStorage {
  const redis = { client: connection } as unknown as RedisService;
  const logger = { setContext: () => undefined, warn: () => undefined } as unknown as PinoLogger;
  return new RedisThrottlerStorage(redis, logger);
}

/**
 * One rate-limit budget across replicas (Phase 20 Checkpoint 2).
 *
 * Checkpoint 20.1 found the global HTTP throttler using `@nestjs/throttler`'s
 * default in-memory store, which counts per process. On a single instance that
 * is invisible; behind a load balancer with N replicas the real budget becomes
 * N times the configured limit, and a caller spread across instances gets the
 * extra for free.
 *
 * Two things have to hold, and they are tested separately because they can
 * fail independently:
 *
 * 1. the storage genuinely shares a counter between instances — proved here
 *    with two `RedisThrottlerStorage` objects on two separate connections,
 *    which is what two replicas are;
 * 2. the running application actually uses that storage rather than the
 *    in-memory default — proved by resolving the storage the app injected.
 *
 * Booting two whole Nest applications would test the same two facts far more
 * slowly, and the second one is what a regression would actually break.
 */
describe('Rate limiting — one budget across replicas (e2e)', () => {
  describe('the shared store', () => {
    let first: IORedis;
    let second: IORedis;
    const keys: string[] = [];

    beforeAll(() => {
      first = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
      second = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    });

    afterAll(async () => {
      for (const key of keys) {
        await first.del(key, `${key}:blocked`).catch(() => undefined);
      }
      first.disconnect();
      second.disconnect();
    });

    /** A fresh caller identity per test, so tests cannot spend each other's budget. */
    function caller(label: string): string {
      const key = `phase20-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // The same derivation RedisThrottlerStorage uses, so the cleanup at the
      // end of this file removes what the tests created.
      const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
      keys.push(`throttle:http:default:${digest}`);
      return key;
    }

    it('counts one caller across two instances rather than twice', async () => {
      const a = replica(first);
      const b = replica(second);
      const key = caller('shared');

      // Alternate. With a per-process store each instance would report
      // totalHits 1, 2, 3 and neither would ever reach the limit.
      const hits: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const storage = attempt % 2 === 0 ? a : b;
        hits.push((await storage.increment(key, 60_000, 10, 60_000, 'default')).totalHits);
      }

      expect(hits).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('blocks on the instance that did not spend the budget', async () => {
      const a = replica(first);
      const b = replica(second);
      const key = caller('block');
      const limit = 3;

      // The first replica spends the whole budget.
      for (let attempt = 0; attempt < limit; attempt += 1) {
        const record = await a.increment(key, 60_000, limit, 60_000, 'default');
        expect(record.isBlocked).toBe(false);
      }

      // The second replica, which has served nothing, refuses immediately.
      // This is the assertion a per-process store fails.
      const refused = await b.increment(key, 60_000, limit, 60_000, 'default');
      expect(refused.isBlocked).toBe(true);
      expect(refused.totalHits).toBeGreaterThan(limit);
      expect(refused.timeToBlockExpire).toBeGreaterThan(0);
    });

    it('keeps one caller’s spending off another caller', async () => {
      const a = replica(first);
      const spender = caller('spender');
      const bystander = caller('bystander');

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await a.increment(spender, 60_000, 3, 60_000, 'default');
      }
      expect((await a.increment(spender, 60_000, 3, 60_000, 'default')).isBlocked).toBe(true);

      // Shared does not mean global.
      const untouched = await replica(second).increment(bystander, 60_000, 3, 60_000, 'default');
      expect(untouched.isBlocked).toBe(false);
      expect(untouched.totalHits).toBe(1);
    });

    it('allows the request when the store cannot answer', async () => {
      const broken = new IORedis('redis://127.0.0.1:1', {
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
        lazyConnect: true,
        retryStrategy: () => null,
      });
      broken.on('error', () => undefined);

      // A rate limiter is an abuse control, not an authorization control.
      // Refusing every request because the limiter is unavailable would turn a
      // throttle outage into a total outage. Authentication and API-client
      // throttling, which are security controls, stay fail-closed.
      const record = await replica(broken).increment('anything', 60_000, 10, 60_000, 'default');
      expect(record.isBlocked).toBe(false);
      broken.disconnect();
    });
  });

  describe('the application wiring', () => {
    let context: TestContext;

    beforeAll(async () => {
      context = await createTestContext();
    }, 180_000);

    afterAll(async () => {
      await destroyTestContext(context);
    });

    it('injects the Redis-backed store, not the in-memory default', () => {
      // The regression guard. Everything above is true of the class in
      // isolation; this is what makes it true of the running API.
      const storage = context.app.get<ThrottlerStorage>(ThrottlerStorage);
      expect(storage).toBeInstanceOf(RedisThrottlerStorage);
    });
  });
});
