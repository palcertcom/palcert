import { Injectable } from '@nestjs/common';
import {
  AIProviderPort,
  HealthStatus,
  PaymentProviderPort,
  type HealthDependency,
  type HealthResponse,
} from '@palcert/contracts';
import { ApiConfigService } from '../config/api-config.service';
import { DatabaseHealthIndicator } from './indicators/database.health-indicator';
import { RedisHealthIndicator } from './indicators/redis.health-indicator';
import { StorageHealthIndicator } from './indicators/storage.health-indicator';

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly config: ApiConfigService,
    private readonly database: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly storage: StorageHealthIndicator,
    private readonly provider: AIProviderPort,
    private readonly payments: PaymentProviderPort,
  ) {}

  /** Liveness: the process is running. Never touches dependencies. */
  live(): HealthResponse {
    return this.buildResponse([]);
  }

  /**
   * Readiness: every dependency required to serve traffic is reachable.
   *
   * The AI provider is deliberately **not** among them (§57). PalCert's
   * deterministic product — upload, analysis, checks, reports — does not
   * depend on it, and taking the platform out of rotation because a
   * third-party model API was slow would be an outage PalCert inflicted on
   * itself.
   */
  async ready(): Promise<HealthResponse> {
    const dependencies = await Promise.all([
      this.database.check(),
      this.redis.check(),
      this.storage.check(),
    ]);
    return this.buildResponse(dependencies);
  }

  /** The separate AI diagnostic. Never fails the request itself (§57, §105). */
  async aiAvailability(): Promise<{ enabled: boolean; available: boolean }> {
    if (!this.config.ai.enabled) return { enabled: false, available: false };
    const probe = await this.provider.checkAvailability();
    return { enabled: true, available: probe.ok };
  }

  /**
   * Payment provider availability (Phase 10 §110, §111).
   *
   * Deliberately separate from `/health/ready`, which never probes a payment
   * company. A provider outage must not make PalCert unready: balances stay
   * visible, existing credit stays spendable, and only adding new credit is
   * unavailable. Reporting it here lets the UI say exactly that instead of
   * offering a button that cannot work.
   */
  async paymentsAvailability(): Promise<{
    enabled: boolean;
    available: boolean;
    provider: string;
  }> {
    if (!this.config.payments.enabled) {
      return { enabled: false, available: false, provider: this.config.payments.provider };
    }
    const capabilities = this.payments.getCapabilities();
    const probe = await this.payments.checkAvailability();
    return { enabled: true, available: probe.ok, provider: capabilities.provider };
  }

  private buildResponse(dependencies: readonly HealthDependency[]): HealthResponse {
    return {
      status: aggregateStatus(dependencies),
      service: this.config.appName,
      version: this.config.appVersion,
      release: this.config.release,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checkedAt: new Date().toISOString(),
      dependencies,
    };
  }
}

export function aggregateStatus(dependencies: readonly HealthDependency[]): HealthStatus {
  if (dependencies.some((dependency) => dependency.status === HealthStatus.ERROR)) {
    return HealthStatus.ERROR;
  }
  if (dependencies.some((dependency) => dependency.status === HealthStatus.DEGRADED)) {
    return HealthStatus.DEGRADED;
  }
  return HealthStatus.OK;
}
