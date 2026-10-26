import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { AuthModule } from '../auth/auth.module';
import { FinanceCoreModule } from '../finance/finance-core.module';
import { ManualTopUpFiles } from '../manual-topups/manual-topup-files';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { AdminPlatformFundsController } from './controllers/admin-platform-funds.controller';
import { AdminWithdrawalSettingsController } from './controllers/admin-withdrawal-settings.controller';
import { AdminWithdrawalsController } from './controllers/admin-withdrawals.controller';
import { OrganizationPayoutsController } from './controllers/organization-payouts.controller';
import { WithdrawalsController } from './controllers/withdrawals.controller';
import { PayoutDestinationKeyring } from './payout-destination-keyring';
import { PayoutDestinationService } from './services/payout-destination.service';
import { WithdrawalFundsService } from './services/withdrawal-funds.service';
import { WithdrawalPolicyService } from './services/withdrawal-policy.service';
import { WithdrawalReconciliationService } from './services/withdrawal-reconciliation.service';
import { WithdrawalRequestService } from './services/withdrawal-request.service';
import { WithdrawalReviewService } from './services/withdrawal-review.service';

/**
 * Withdrawals and payouts (ADR-0150): one review workflow for a user's
 * eligible money, an organization's settled net share and PalCert's realized
 * revenue. Shares the ledger and hold path with finance, and the notification
 * pipeline with everything else; adds no second wallet and no payout API.
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
  controllers: [
    WithdrawalsController,
    OrganizationPayoutsController,
    AdminWithdrawalsController,
    AdminPlatformFundsController,
    AdminWithdrawalSettingsController,
  ],
  providers: [
    TenantPrismaService,
    ManualTopUpFiles,
    PayoutDestinationKeyring,
    PayoutDestinationService,
    WithdrawalPolicyService,
    WithdrawalFundsService,
    WithdrawalRequestService,
    WithdrawalReviewService,
    WithdrawalReconciliationService,
  ],
})
export class WithdrawalsModule {}
