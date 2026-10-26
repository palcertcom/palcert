import { Global, Module } from '@nestjs/common';
import { DatabaseMetricsCollector } from './database-metrics.collector';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Telemetry for one process (Phase 20 Checkpoint 3).
 *
 * Global for the same reason `PrismaModule` and `ConfigModule` are: any
 * service that records an operational outcome needs the registry, and
 * threading an import through thirty domain modules to count a webhook
 * failure would make instrumentation expensive enough that people stop
 * doing it.
 *
 * Imported by both the API and the worker. Each process exposes its own
 * endpoint and its own process-level metrics; the database-backed gauges are
 * identical on both because they read the same ledger, which is the point —
 * a scraper that loses one replica still sees the true queue depth.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, DatabaseMetricsCollector, HttpMetricsMiddleware],
  exports: [MetricsService],
})
export class MetricsModule {}
