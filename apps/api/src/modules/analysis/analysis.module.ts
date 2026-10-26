import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort, SystemClock } from '../auth/ports/clock.port';
import { DocumentAnalysisService } from './services/document-analysis.service';

/**
 * Document analysis (Phase 6).
 *
 * No controller. Analysis is infrastructure for the Phase 7 check workflow,
 * not a user-facing feature of its own, and exposing an "analyze" button now
 * would be a surface with no product behind it (§9, §120).
 */
@Module({
  imports: [ConfigModule, PrismaModule, QueueModule],
  providers: [
    TenantPrismaService,
    { provide: ClockPort, useClass: SystemClock },
    DocumentAnalysisService,
  ],
  exports: [DocumentAnalysisService],
})
export class AnalysisModule {}
