import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { buildLoggerParams } from '../common/logging/logger.config';
import { ApiConfigService } from '../config/api-config.service';
import { ConfigModule } from '../config/config.module';
import { MetricsModule } from '../infrastructure/metrics/metrics.module';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { DatabaseHealthIndicator } from '../health/indicators/database.health-indicator';
import { DocumentEngineModule } from '../infrastructure/document-engine/document-engine.module';
import { QueueModule } from '../infrastructure/queue/queue.module';
import { ScannerModule } from '../infrastructure/scanner/scanner.module';
import { StorageModule } from '../infrastructure/storage/storage.module';
import { TenantPrismaService } from '../infrastructure/tenant/tenant-prisma.service';
import { ClockPort, SystemClock } from '../modules/auth/ports/clock.port';
import { SecurityEventService } from '../modules/auth/services/security-event.service';
import { AnalysisModule } from '../modules/analysis/analysis.module';
import { ChecksCoreModule } from '../modules/checks/checks-core.module';
import { AICoreModule } from '../modules/ai/ai-core.module';
import { ExtractionCoreModule } from '../modules/extraction/extraction-core.module';
import { FinanceCoreModule } from '../modules/finance/finance-core.module';
import { SmartFixCoreModule } from '../modules/smartfix/smartfix-core.module';
import { CertificatesCoreModule } from '../modules/certificates/certificates-core.module';
import { SubmissionsCoreModule } from '../modules/submissions/submissions-core.module';
import { NotificationsCoreModule } from '../modules/notifications/notifications-core.module';
import { WebhooksCoreModule } from '../modules/webhooks/webhooks-core.module';
import { AttestationsCoreModule } from '../modules/attestations/attestations-core.module';
import { AttestationArtifactJobHandler } from './attestation-artifact-job.handler';
import { ManualTopUpFileJobHandler } from './manual-topup-file-job.handler';
import { AttestationPaymentJobHandler } from './attestation-payment-job.handler';
import { AttestationSweeper } from './attestation-sweeper';
import { AnalysisJobHandler } from './analysis-job.handler';
import { AIReviewJobHandler } from './ai-review-job.handler';
import { CheckEvaluationJobHandler } from './check-evaluation-job.handler';
import { CheckPrepareJobHandler } from './check-prepare-job.handler';
import { IngestJobHandler } from './ingest-job.handler';
import { FinanceSweeper } from './finance-sweeper';
import { PaymentJobHandler } from './payment-job.handler';
import { PurgeJobHandler } from './purge-job.handler';
import { RuleExtractionJobHandler } from './rule-extraction-job.handler';
import { SmartFixJobHandler } from './smartfix-job.handler';
import { CertificateIssueJobHandler } from './certificate-issue-job.handler';
import { SubmissionPrepareJobHandler } from './submission-prepare-job.handler';
import { NotificationJobHandler } from './notification-job.handler';
import { NotificationSweeper } from './notification-sweeper';
import { WebhookJobHandler } from './webhook-job.handler';
import { WebhookSweeper } from './webhook-sweeper';
import { SourceIngestJobHandler } from './source-ingest-job.handler';
import { WorkerHealthController } from './worker-health.controller';
import { WorkerService } from './worker.service';

/**
 * The worker process (ADR-0001): the same infrastructure modules as the API,
 * none of its HTTP surface beyond two probes, and no session or guard —
 * there is no caller to authenticate. Authorization comes from the job row.
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService) => buildLoggerParams(config),
    }),
    PrismaModule,
    MetricsModule,
    StorageModule,
    ScannerModule,
    QueueModule,
    DocumentEngineModule,
    AnalysisModule,
    ChecksCoreModule,
    AICoreModule,
    ExtractionCoreModule,
    FinanceCoreModule,
    SmartFixCoreModule,
    SubmissionsCoreModule,
    CertificatesCoreModule,
    NotificationsCoreModule,
    WebhooksCoreModule,
    AttestationsCoreModule,
  ],
  controllers: [WorkerHealthController],
  providers: [
    TenantPrismaService,
    SecurityEventService,
    // The worker's readiness probe needs it; the API gets the same indicator
    // from HealthModule, which the worker deliberately does not import.
    DatabaseHealthIndicator,
    { provide: ClockPort, useClass: SystemClock },
    IngestJobHandler,
    PurgeJobHandler,
    AnalysisJobHandler,
    CheckPrepareJobHandler,
    CheckEvaluationJobHandler,
    AIReviewJobHandler,
    SourceIngestJobHandler,
    RuleExtractionJobHandler,
    PaymentJobHandler,
    SmartFixJobHandler,
    SubmissionPrepareJobHandler,
    NotificationJobHandler,
    NotificationSweeper,
    WebhookJobHandler,
    WebhookSweeper,
    CertificateIssueJobHandler,
    FinanceSweeper,
    AttestationArtifactJobHandler,
    ManualTopUpFileJobHandler,
    AttestationPaymentJobHandler,
    AttestationSweeper,
    WorkerService,
  ],
  exports: [
    WorkerService,
    IngestJobHandler,
    PurgeJobHandler,
    AnalysisJobHandler,
    CheckPrepareJobHandler,
    CheckEvaluationJobHandler,
    AIReviewJobHandler,
    SourceIngestJobHandler,
    RuleExtractionJobHandler,
    SmartFixJobHandler,
    SubmissionPrepareJobHandler,
    CertificateIssueJobHandler,
    NotificationJobHandler,
    NotificationSweeper,
    WebhookJobHandler,
    WebhookSweeper,
    AttestationArtifactJobHandler,
    ManualTopUpFileJobHandler,
    AttestationPaymentJobHandler,
    AttestationSweeper,
  ],
})
export class WorkerModule {}
