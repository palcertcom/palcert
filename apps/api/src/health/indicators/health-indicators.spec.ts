import { HealthStatus } from '@palcert/contracts';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { DatabaseHealthIndicator, withTimeout } from './database.health-indicator';
import { RedisHealthIndicator } from './redis.health-indicator';

describe('withTimeout', () => {
  it('resolves when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 100, 'test')).resolves.toBe('ok');
  });

  it('rejects when the promise exceeds the budget', async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 10, 'test')).rejects.toThrow('test probe timed out');
  });
});

describe('DatabaseHealthIndicator', () => {
  it('returns ok with a latency measurement on a successful query', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const indicator = new DatabaseHealthIndicator(prisma as unknown as PrismaService);

    const result = await indicator.check();

    expect(result.status).toBe(HealthStatus.OK);
    expect(result.name).toBe('database');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns error without leaking connection details', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockRejectedValue(new Error('connect ECONNREFUSED postgres://user:pw@10.0.0.5:5432')),
    };
    const indicator = new DatabaseHealthIndicator(prisma as unknown as PrismaService);

    const result = await indicator.check();

    expect(result.status).toBe(HealthStatus.ERROR);
    expect(result.message).toBe('unreachable');
    expect(JSON.stringify(result)).not.toContain('10.0.0.5');
    expect(JSON.stringify(result)).not.toContain('pw');
  });
});

describe('RedisHealthIndicator', () => {
  it('returns ok when Redis replies PONG', async () => {
    const redis = { ping: jest.fn().mockResolvedValue('PONG') };
    const indicator = new RedisHealthIndicator(redis as unknown as RedisService);

    await expect(indicator.check()).resolves.toMatchObject({
      name: 'redis',
      status: HealthStatus.OK,
    });
  });

  it('returns error on an unexpected reply', async () => {
    const redis = { ping: jest.fn().mockResolvedValue('NOPE') };
    const indicator = new RedisHealthIndicator(redis as unknown as RedisService);

    await expect(indicator.check()).resolves.toMatchObject({ status: HealthStatus.ERROR });
  });

  it('returns error when Redis rejects', async () => {
    const redis = { ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const indicator = new RedisHealthIndicator(redis as unknown as RedisService);

    const result = await indicator.check();
    expect(result.status).toBe(HealthStatus.ERROR);
    expect(result.message).toBe('unreachable');
  });
});
