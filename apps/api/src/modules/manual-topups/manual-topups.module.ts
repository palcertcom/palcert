import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { AuthModule } from '../auth/auth.module';
import { FinanceCoreModule } from '../finance/finance-core.module';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { AdminManualTopUpsController } from './controllers/admin-manual-topups.controller';
import { AdminPaymentMethodsController } from './controllers/admin-payment-methods.controller';
import { ManualTopUpsController } from './controllers/manual-topups.controller';
import { ManualTopUpFiles } from './manual-topup-files';
import { ManualPaymentMethodService } from './services/manual-payment-method.service';
import { ManualTopUpRequestService } from './services/manual-topup-request.service';
import { ManualTopUpReviewService } from './services/manual-topup-review.service';

/**
 * Manual top-ups: bank and wallet transfers verified by PalCert finance.
 *
 * Its own module rather than more of Phase 10's: the provider top-up path is
 * left exactly as it was, and this one shares only the ledger it credits.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    QueueModule,
    StorageModule,
    AuthModule,
    FinanceCoreModule,
    NotificationsCoreModule,
  ],
  controllers: [ManualTopUpsController, AdminPaymentMethodsController, AdminManualTopUpsController],
  providers: [
    TenantPrismaService,
    ManualTopUpFiles,
    ManualPaymentMethodService,
    ManualTopUpRequestService,
    ManualTopUpReviewService,
  ],
})
export class ManualTopUpsModule {}
