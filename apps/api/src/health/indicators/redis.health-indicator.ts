import { Injectable } from '@nestjs/common';
import { HealthStatus, type HealthDependency } from '@palcert/contracts';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { withTimeout } from './database.health-indicator';

const PROBE_TIMEOUT_MS = 2_000;

@Injectable()
export class RedisHealthIndicator {
  constructor(private readonly redis: RedisService) {}

  async check(): Promise<HealthDependency> {
    const startedAt = Date.now();
    try {
      const reply = await withTimeout(this.redis.ping(), PROBE_TIMEOUT_MS, 'redis');
      if (reply !== 'PONG') {
        throw new Error(`unexpected ping reply: ${reply}`);
      }
      return { name: 'redis', status: HealthStatus.OK, latencyMs: Date.now() - startedAt };
    } catch {
      return {
        name: 'redis',
        status: HealthStatus.ERROR,
        latencyMs: Date.now() - startedAt,
        message: 'unreachable',
      };
    }
  }
}
