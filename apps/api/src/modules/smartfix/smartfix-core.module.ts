import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { AIProviderModule } from '../../infrastructure/ai/ai-provider.module';
import { SmartFixAIPlannerService } from './services/smartfix-ai-planner.service';
import { SmartFixPlanningBillingService } from './services/smartfix-planning-billing.service';
import { DocumentEngineModule } from '../../infrastructure/document-engine/document-engine.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { ScannerModule } from '../../infrastructure/scanner/scanner.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort, SystemClock } from '../auth/ports/clock.port';
import { SecurityEventService } from '../auth/services/security-event.service';
import { ChecksCoreModule } from '../checks/checks-core.module';
import { FinanceCoreModule } from '../finance/finance-core.module';
import { SmartFixExecutionService } from './services/smartfix-execution.service';
import { SmartFixFinalizeService } from './services/smartfix-finalize.service';
import { SmartFixPlanService } from './services/smartfix-plan.service';
import { SmartFixReadService } from './services/smartfix-read.service';
import { SmartFixRequestService } from './services/smartfix-request.service';
import { SmartFixSettlementService } from './services/smartfix-settlement.service';

/**
 * SmartFix services without any HTTP surface.
 *
 * Split from `SmartFixModule` for the same reason the checks are: the worker
 * needs the services and must not serve the routes.
 */
@Module({
  imports: [
    ConfigModule,
    AIProviderModule,
    PrismaModule,
    QueueModule,
    StorageModule,
    ScannerModule,
    DocumentEngineModule,
    ChecksCoreModule,
    FinanceCoreModule,
  ],
  providers: [
    TenantPrismaService,
    SecurityEventService,
    { provide: ClockPort, useClass: SystemClock },
    SmartFixPlanService,
    SmartFixAIPlannerService,
    SmartFixPlanningBillingService,
    SmartFixReadService,
    SmartFixSettlementService,
    SmartFixRequestService,
    SmartFixExecutionService,
    SmartFixFinalizeService,
  ],
  exports: [
    SmartFixPlanningBillingService,
    SmartFixPlanService,
    SmartFixReadService,
    SmartFixSettlementService,
    SmartFixRequestService,
    SmartFixExecutionService,
    SmartFixFinalizeService,
  ],
})
export class SmartFixCoreModule {}
