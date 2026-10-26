import { Module } from '@nestjs/common';
import { FinanceCoreModule } from '../finance/finance-core.module';
import { ConfigModule } from '../../config/config.module';
import { AIProviderModule } from '../../infrastructure/ai/ai-provider.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort, SystemClock } from '../auth/ports/clock.port';
import { SecurityEventService } from '../auth/services/security-event.service';
import { AIConsentService } from './services/ai-consent.service';
import { AIContextBuilder } from './services/ai-context-builder.service';
import { AIOutputValidator } from './services/ai-output-validator.service';
import { AIReviewReadService } from './services/ai-review-read.service';
import { AIReviewService } from './services/ai-review.service';

/**
 * AI services without any HTTP surface.
 *
 * Split from `AIModule` for the same reason the checks module is: the worker
 * needs the services and must not serve the routes.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    QueueModule,
    StorageModule,
    AIProviderModule,
    FinanceCoreModule,
  ],
  providers: [
    TenantPrismaService,
    SecurityEventService,
    { provide: ClockPort, useClass: SystemClock },
    AIConsentService,
    AIContextBuilder,
    AIOutputValidator,
    AIReviewService,
    AIReviewReadService,
  ],
  exports: [
    AIProviderModule,
    AIConsentService,
    AIContextBuilder,
    AIOutputValidator,
    AIReviewService,
    AIReviewReadService,
  ],
})
export class AICoreModule {}
