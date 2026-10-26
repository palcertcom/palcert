import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { AnalysisModule } from '../analysis/analysis.module';
import { FinanceCoreModule } from '../finance/finance-core.module';
import { ClockPort, SystemClock } from '../auth/ports/clock.port';
import { SecurityEventService } from '../auth/services/security-event.service';
import { CatalogueService } from './services/catalogue.service';
import { FormatCompatibilityService } from './services/format-compatibility.service';
import { CheckReadService } from './services/check-read.service';
import { CheckReportBuilder } from './services/check-report-builder.service';
import { DocumentCheckService } from './services/document-check.service';
import { PaidCheckSettlementService } from './services/paid-check-settlement.service';

/**
 * Check services without any HTTP surface.
 *
 * Split from `ChecksModule` because the worker needs the services and must not
 * serve the routes: importing a module brings its controllers with it, and the
 * worker process exposes two health probes and nothing else (ADR-0001).
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    QueueModule,
    StorageModule,
    AnalysisModule,
    FinanceCoreModule,
  ],
  providers: [
    TenantPrismaService,
    SecurityEventService,
    { provide: ClockPort, useClass: SystemClock },
    CatalogueService,
    FormatCompatibilityService,
    CheckReportBuilder,
    CheckReadService,
    DocumentCheckService,
    PaidCheckSettlementService,
  ],
  exports: [
    CatalogueService,
    FormatCompatibilityService,
    CheckReportBuilder,
    CheckReadService,
    DocumentCheckService,
    PaidCheckSettlementService,
  ],
})
export class ChecksCoreModule {}
