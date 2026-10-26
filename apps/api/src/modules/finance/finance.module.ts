import { Module } from '@nestjs/common';
import { FinanceCoreModule } from './finance-core.module';
import { BalanceController } from './controllers/balance.controller';
import { FinanceAdminController } from './controllers/finance-admin.controller';
import { PaymentWebhookController } from './controllers/payment-webhook.controller';

/** Phase 10's HTTP surface: a customer's balance, pricing, finance, webhooks. */
@Module({
  imports: [FinanceCoreModule],
  controllers: [BalanceController, FinanceAdminController, PaymentWebhookController],
})
export class FinanceModule {}
