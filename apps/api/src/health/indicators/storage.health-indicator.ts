import { Injectable } from '@nestjs/common';
import { HealthStatus, type HealthDependency } from '@palcert/contracts';
import { ObjectStoragePort } from '../../infrastructure/storage/object-storage.port';
import { withTimeout } from './database.health-indicator';

const PROBE_TIMEOUT_MS = 3_000;

/**
 * Object-storage readiness (§68): both buckets answer and quarantine is
 * versioned. Reports nothing about endpoints, bucket names or credentials —
 * the response is public.
 */
@Injectable()
export class StorageHealthIndicator {
  constructor(private readonly storage: ObjectStoragePort) {}

  async check(): Promise<HealthDependency> {
    const startedAt = Date.now();
    try {
      const readiness = await withTimeout(
        this.storage.checkReadiness(),
        PROBE_TIMEOUT_MS,
        'object-storage',
      );
      return {
        name: 'object-storage',
        status: readiness.ok ? HealthStatus.OK : HealthStatus.ERROR,
        latencyMs: Date.now() - startedAt,
        ...(readiness.message !== undefined ? { message: readiness.message } : {}),
      };
    } catch {
      return {
        name: 'object-storage',
        status: HealthStatus.ERROR,
        latencyMs: Date.now() - startedAt,
        message: 'unreachable',
      };
    }
  }
}
