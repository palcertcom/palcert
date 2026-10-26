import { Module } from '@nestjs/common';
import { PaymentProviderModule } from '../../infrastructure/payments/payment-provider.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort, SystemClock } from '../auth/ports/clock.port';
import { SecurityEventService } from '../auth/services/security-event.service';
import { BalanceService } from './services/balance.service';
import { CreditHoldService } from './services/credit-hold.service';
import { CreditLedgerService } from './services/credit-ledger.service';
import { FinanceAdminService } from './services/finance-admin.service';
import { PaymentEventService } from './services/payment-event.service';
import { PaymentRefundService } from './services/payment-refund.service';
import { PricingService } from './services/pricing.service';
import { AIServiceBillingService } from './services/ai-service-billing.service';
import { ServicePurchaseService } from './services/service-purchase.service';
import { TopUpService } from './services/top-up.service';

/**
 * Phase 10 services, without the HTTP surface.
 *
 * Split like Phase 8 and Phase 9: the worker settles payments and expires
 * holds, and importing a module full of controllers to reach those services
 * would mount routes in a process that has no callers.
 *
 * This is also the module Phase 11 will import to reach `createQuote`,
 * `createHold`, `captureHold`, `releaseHold` and `refundServiceCharge` — none
 * of which requires it to know that Stripe exists (§145).
 */
@Module({
  imports: [PaymentProviderModule, QueueModule],
  providers: [
    TenantPrismaService,
    SecurityEventService,
    { provide: ClockPort, useClass: SystemClock },
    CreditLedgerService,
    CreditHoldService,
    BalanceService,
    PricingService,
    TopUpService,
    PaymentRefundService,
    PaymentEventService,
    FinanceAdminService,
    ServicePurchaseService,
    AIServiceBillingService,
  ],
  exports: [
    CreditLedgerService,
    CreditHoldService,
    BalanceService,
    PricingService,
    TopUpService,
    PaymentRefundService,
    PaymentEventService,
    FinanceAdminService,
    ServicePurchaseService,
    AIServiceBillingService,
    PaymentProviderModule,
  ],
})
export class FinanceCoreModule {}
