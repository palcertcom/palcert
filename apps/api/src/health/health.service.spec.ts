import { Test, type TestingModule } from '@nestjs/testing';
import { AIProviderPort, HealthStatus, PaymentProviderPort } from '@palcert/contracts';
import { ApiConfigService } from '../config/api-config.service';
import { HealthService, aggregateStatus } from './health.service';
import { DatabaseHealthIndicator } from './indicators/database.health-indicator';
import { RedisHealthIndicator } from './indicators/redis.health-indicator';
import { StorageHealthIndicator } from './indicators/storage.health-indicator';

const configStub = {
  appName: 'palcert-api',
  appVersion: '0.1.0',
} as unknown as ApiConfigService;

describe('aggregateStatus', () => {
  it('is ok when there are no dependencies', () => {
    expect(aggregateStatus([])).toBe(HealthStatus.OK);
  });

  it('is ok when all dependencies are ok', () => {
    expect(
      aggregateStatus([
        { name: 'database', status: HealthStatus.OK },
        { name: 'redis', status: HealthStatus.OK },
      ]),
    ).toBe(HealthStatus.OK);
  });

  it('is degraded when a dependency is degraded', () => {
    expect(
      aggregateStatus([
        { name: 'database', status: HealthStatus.OK },
        { name: 'redis', status: HealthStatus.DEGRADED },
      ]),
    ).toBe(HealthStatus.DEGRADED);
  });

  it('is error when any dependency errors, even alongside a degraded one', () => {
    expect(
      aggregateStatus([
        { name: 'database', status: HealthStatus.ERROR },
        { name: 'redis', status: HealthStatus.DEGRADED },
      ]),
    ).toBe(HealthStatus.ERROR);
  });
});

describe('HealthService', () => {
  let service: HealthService;
  const aiProvider = { checkAvailability: jest.fn<Promise<{ ok: boolean }>, []>() };
  const paymentProvider = {
    checkAvailability: jest.fn<Promise<{ ok: boolean }>, []>(),
    getCapabilities: jest.fn(() => ({ provider: 'fake' })),
  };
  let database: { check: jest.Mock };
  let redis: { check: jest.Mock };
  let storage: { check: jest.Mock };

  beforeEach(async () => {
    database = { check: jest.fn() };
    redis = { check: jest.fn() };
    storage = {
      check: jest.fn().mockResolvedValue({ name: 'object-storage', status: HealthStatus.OK }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: ApiConfigService, useValue: configStub },
        { provide: DatabaseHealthIndicator, useValue: database },
        { provide: RedisHealthIndicator, useValue: redis },
        { provide: StorageHealthIndicator, useValue: storage },
        // Present so the service constructs, and asserted on below: an AI
        // provider must never be probed by readiness (§57).
        { provide: AIProviderPort, useValue: aiProvider },
        // Same reason, same rule: a payment company being down is not PalCert
        // being down, and readiness must never probe one (Phase 10 §110).
        { provide: PaymentProviderPort, useValue: paymentProvider },
      ],
    }).compile();

    aiProvider.checkAvailability.mockResolvedValue({ ok: true });
    paymentProvider.checkAvailability.mockResolvedValue({ ok: true });
    service = moduleRef.get(HealthService);
  });

  it('reports liveness without touching any dependency', () => {
    const result = service.live();

    expect(result.status).toBe(HealthStatus.OK);
    expect(result.service).toBe('palcert-api');
    expect(result.version).toBe('0.1.0');
    expect(result.dependencies).toEqual([]);
    expect(database.check).not.toHaveBeenCalled();
    expect(redis.check).not.toHaveBeenCalled();
  });

  it('reports ready when every dependency is healthy', async () => {
    database.check.mockResolvedValue({ name: 'database', status: HealthStatus.OK, latencyMs: 1 });
    redis.check.mockResolvedValue({ name: 'redis', status: HealthStatus.OK, latencyMs: 1 });

    const result = await service.ready();

    expect(result.status).toBe(HealthStatus.OK);
    expect(result.dependencies).toHaveLength(3);
    expect(Date.parse(result.checkedAt)).not.toBeNaN();
  });

  it('reports error when the database is unreachable', async () => {
    database.check.mockResolvedValue({
      name: 'database',
      status: HealthStatus.ERROR,
      message: 'unreachable',
    });
    redis.check.mockResolvedValue({ name: 'redis', status: HealthStatus.OK });

    const result = await service.ready();

    expect(result.status).toBe(HealthStatus.ERROR);
  });

  it('never lets the payment provider affect readiness', async () => {
    // §110, §111: if Stripe is down, PalCert is not. Existing balances stay
    // visible and existing credit stays spendable; only adding new credit
    // becomes unavailable, and that is reported on its own endpoint.
    database.check.mockResolvedValue({ name: 'database', status: HealthStatus.OK });
    redis.check.mockResolvedValue({ name: 'redis', status: HealthStatus.OK });
    paymentProvider.checkAvailability.mockResolvedValue({ ok: false });

    const result = await service.ready();

    expect(result.status).toBe(HealthStatus.OK);
    expect(paymentProvider.checkAvailability).not.toHaveBeenCalled();
    expect(result.dependencies.map((dependency) => dependency.name)).not.toContain('payments');
  });

  it('never lets the AI provider affect readiness', async () => {
    // The single most consequential line in the Phase 8 health design: a
    // third-party model API being unavailable must not take PalCert's
    // deterministic product out of a load balancer (§57).
    aiProvider.checkAvailability.mockResolvedValue({ ok: false });
    database.check.mockResolvedValue({ name: 'database', status: HealthStatus.OK });
    redis.check.mockResolvedValue({ name: 'redis', status: HealthStatus.OK });

    const result = await service.ready();

    expect(aiProvider.checkAvailability).not.toHaveBeenCalled();
    expect(result.status).toBe(HealthStatus.OK);
    expect(JSON.stringify(result)).not.toMatch(/ai|anthropic|provider/i);
  });

  it('probes dependencies concurrently, not serially', async () => {
    const order: string[] = [];
    database.check.mockImplementation(async () => {
      order.push('db:start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('db:end');
      return { name: 'database', status: HealthStatus.OK };
    });
    redis.check.mockImplementation(async () => {
      order.push('redis:start');
      return { name: 'redis', status: HealthStatus.OK };
    });

    await service.ready();

    expect(order.indexOf('redis:start')).toBeLessThan(order.indexOf('db:end'));
  });
});
