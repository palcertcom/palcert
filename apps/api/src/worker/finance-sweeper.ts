import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../config/api-config.service';
import { TenantPrismaService } from '../infrastructure/tenant/tenant-prisma.service';
import { CreditHoldService } from '../modules/finance/services/credit-hold.service';
import { PaymentEventService } from '../modules/finance/services/payment-event.service';
import { PaidCheckSettlementService } from '../modules/checks/services/paid-check-settlement.service';

/**
 * Periodic financial housekeeping (§22, §60).
 *
 * Three jobs nobody triggers:
 *
 *   - **Expiring holds.** A reservation whose service never completed must
 *     stop reserving, or a customer's money would be locked up by an
 *     abandoned request forever.
 *   - **Reconciling payments.** A webhook that never arrived is not an error
 *     anyone sees; it is simply a balance that never went up. Asking the
 *     provider directly is the only way to notice.
 *   - **Settling expired reservations.** Phase 11: once a paid check's
 *     reservation has expired, the check must converge to failed and its
 *     purchase to released — otherwise a slow worker could finish later and
 *     hand over a report nobody paid for (§26, §28, §116).
 *
 * All three are idempotent, so running them twice — or running two workers — is
 * harmless. That is what makes it safe to sweep on a timer rather than
 * coordinating a single leader.
 */
@Injectable()
export class FinanceSweeper implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly holds: CreditHoldService,
    private readonly events: PaymentEventService,
    private readonly settlement: PaidCheckSettlementService,
    private readonly config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FinanceSweeper.name);
  }

  onModuleInit(): void {
    if (!this.config.payments.enabled) return;
    // Reuses the upload sweep cadence: both are "notice what nobody told us
    // about", and a second knob would be a second thing to get wrong.
    this.timer = setInterval(() => void this.sweep(), this.config.upload.sweepIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /** One pass. Exposed so tests can drive it without waiting for a timer. */
  async sweep(): Promise<{ expiredHolds: number; reconciled: number; settledPurchases: number }> {
    let expiredHolds = 0;
    let reconciled = 0;
    let settledPurchases = 0;

    try {
      // Platform elevation: expiring holds crosses every customer, and the
      // elevation is logged with a reason rather than being implicit (§151).
      expiredHolds = await this.tenant.withPlatformAdmin(
        { actorUserId: SWEEPER_ACTOR, reason: 'expire credit holds past their deadline' },
        (tx) => this.holds.expireDue(tx),
      );
    } catch (error) {
      this.logger.error({ err: error }, 'Could not expire due credit holds');
    }

    try {
      const outcome = await this.events.reconcileOpenTopUps();
      reconciled = outcome.credited;
    } catch (error) {
      // A provider outage postpones reconciliation and nothing else: existing
      // balances stay visible and spendable (§111).
      this.logger.warn({ err: error }, 'Payment reconciliation pass did not complete');
    }

    try {
      // Deliberately after the hold expiry above, so a hold that expired this
      // very pass is settled in the same pass rather than the next one.
      settledPurchases = await this.settlement.settleExpiredReservations();
    } catch (error) {
      this.logger.error({ err: error }, 'Could not settle expired service reservations');
    }

    if (expiredHolds > 0 || reconciled > 0 || settledPurchases > 0) {
      this.logger.info(
        { expiredHolds, reconciled, settledPurchases },
        'Financial housekeeping completed',
      );
    }
    return { expiredHolds, reconciled, settledPurchases };
  }
}

/** The nil UUID, recorded as the actor for work PalCert does on its own. */
const SWEEPER_ACTOR = '00000000-0000-0000-0000-000000000000';
