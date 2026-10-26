import { ReportsModule } from './modules/reports/reports.module';
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ApiClientsModule } from './modules/api-clients/api-clients.module';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { buildLoggerParams } from './common/logging/logger.config';
import { ApiConfigService } from './config/api-config.service';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { HttpMetricsMiddleware } from './infrastructure/metrics/http-metrics.middleware';
import { MetricsModule } from './infrastructure/metrics/metrics.module';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { RedisThrottlerStorage } from './infrastructure/redis/redis-throttler.storage';
import { RedisModule } from './infrastructure/redis/redis.module';
import { AdminModule } from './modules/admin/admin.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { ChecksModule } from './modules/checks/checks.module';
import { SmartFixModule } from './modules/smartfix/smartfix.module';
import { CertificatesModule } from './modules/certificates/certificates.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SubmissionsModule } from './modules/submissions/submissions.module';
import { AIModule } from './modules/ai/ai.module';
import { ExtractionModule } from './modules/extraction/extraction.module';
import { RevenueSharingModule } from './modules/revenue-sharing/revenue-sharing.module';
import { FinanceModule } from './modules/finance/finance.module';
import { AuthModule } from './modules/auth/auth.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { StandardsModule } from './modules/standards/standards.module';
import { UsersModule } from './modules/users/users.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { AttestationsModule } from './modules/attestations/attestations.module';
import { ManualTopUpsModule } from './modules/manual-topups/manual-topups.module';
import { WithdrawalsModule } from './modules/withdrawals/withdrawals.module';
import { EmailWebhooksModule } from './modules/email/email-webhooks.module';

/**
 * PalCert API root module.
 *
 * Phase 0 wired infrastructure: configuration, logging, error handling, rate
 * limiting, database, cache and health. Phase 1 added identity: RBAC, auth,
 * users and the staff admin surface. Phase 2 adds tenancy: organizations,
 * membership, invitations, verification and row-level tenant isolation. The
 * Phase 3 adds authoring: document types, standards, versions and rules. The
 * remaining domain modules (documents, checks, ai, smartfix, billing,
 * submissions, certificates, notifications) arrive in their own phases (§33).
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService) => buildLoggerParams(config),
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule, RedisModule],
      inject: [ApiConfigService, RedisThrottlerStorage],
      // Counters live in Redis, not in this process. Without a shared store
      // the configured limit is enforced per replica, so N instances behind a
      // load balancer means N times the budget — invisible on one instance and
      // wrong on every real deployment (Phase 20 Checkpoint 2).
      useFactory: (config: ApiConfigService, storage: RedisThrottlerStorage) => ({
        throttlers: [{ ttl: config.rateLimit.ttlSeconds * 1000, limit: config.rateLimit.limit }],
        storage,
      }),
    }),
    PrismaModule,
    RedisModule,
    MetricsModule,
    HealthModule,
    RbacModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    StandardsModule,
    DocumentsModule,
    AnalysisModule,
    ChecksModule,
    SmartFixModule,
    SubmissionsModule,
    CertificatesModule,
    NotificationsModule,
    EmailWebhooksModule,
    WebhooksModule,
    AIModule,
    ExtractionModule,
    FinanceModule,
    RevenueSharingModule,
    ReportsModule,
    AdminModule,
    ApiClientsModule,
    AttestationsModule,
    ManualTopUpsModule,
    WithdrawalsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including ones no controller matched: the middleware
    // labels those `<unmatched>` rather than by path, so a 404 scanner cannot
    // mint a timeseries per probe.
    consumer.apply(HttpMetricsMiddleware).forRoutes('*');
  }
}
