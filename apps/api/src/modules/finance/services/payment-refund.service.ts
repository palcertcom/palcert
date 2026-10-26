import { Injectable } from '@nestjs/common';
import {
  AppError,
  CreditClass,
  CreditHoldPurpose,
  LedgerEntryType,
  LedgerReasonCode,
  LedgerReferenceType,
  PalCertErrorCode,
  PaymentDisputeStatus,
  PaymentProviderError,
  PaymentProviderPort,
  PaymentRefundReason,
  PaymentRefundStatus,
  TopUpStatus,
  formatMinorUnits,
  money,
  providerIdempotencyKey,
  type PaymentRefundView,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { CreditHoldService } from './credit-hold.service';
import { CreditLedgerService } from './credit-ledger.service';
import { SYSTEM_ACTOR } from './top-up.service';

/**
 * External refunds and disputes (§65, §68–§75, §83–§86).
 *
 * An **external refund** sends real money back through the payment provider.
 * It is a completely different act from a service refund, which moves credit
 * inside PalCert and never touches a card (§65), and conflating the two would
 * let a customer be paid twice for one failed check.
 *
 * Two properties make it safe. The credit is **reserved before the provider is
 * called** (§71), so a customer cannot request a refund and then spend the
 * same money while it settles. And promotional credit is structurally
 * unreachable: the reservation is taken against a CASH account, and a database
 * CHECK refuses a `PAYMENT_REFUND_DEBIT` against any other class (§70).
 */
@Injectable()
export class PaymentRefundService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly provider: PaymentProviderPort,
    private readonly holds: CreditHoldService,
    private readonly ledger: CreditLedgerService,
    private readonly clock: ClockPort,
    private readonly events: SecurityEventService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PaymentRefundService.name);
  }

  /**
   * Send money back to a card.
   *
   * Finance-initiated only (§69): there is no self-service customer refund
   * endpoint, because "give me my money back" is a conversation with a policy
   * behind it, not a button.
   */
  async createRefund(input: {
    readonly topUpId: string;
    readonly amountMinor: bigint;
    readonly reason: PaymentRefundReason;
    readonly requestedByUserId: string;
    readonly idempotencyKey?: string | undefined;
  }): Promise<PaymentRefundView> {
    const topUp = await this.tenant.withPlatformAdmin(
      { actorUserId: input.requestedByUserId, reason: 'finance refund of a customer top-up' },
      (tx) => tx.balanceTopUp.findUnique({ where: { id: input.topUpId } }),
    );
    if (topUp === null) {
      throw new AppError(PalCertErrorCode.TOPUP_NOT_FOUND, {
        message: 'That top-up could not be found.',
      });
    }
    if (topUp.status !== TopUpStatus.SUCCEEDED || topUp.providerPaymentId === null) {
      throw new AppError(PalCertErrorCode.REFUND_NOT_ELIGIBLE, {
        message: 'That top-up was never paid, so there is nothing to refund.',
      });
    }
    if (input.amountMinor <= 0n) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'A refund must be greater than zero.',
      });
    }

    const ownerUserId = topUp.ownerUserId;

    // Everything up to the provider call happens in one transaction under the
    // *customer's* scope, so the reservation is subject to the same RLS and
    // the same account lock as any other spend.
    const prepared = await this.tenant.withUser(ownerUserId, async (tx) => {
      if (input.idempotencyKey !== undefined) {
        const existing = await tx.paymentRefund.findFirst({
          where: { ownerUserId, idempotencyKey: input.idempotencyKey },
        });
        if (existing !== null) return { refund: existing, alreadyExisted: true as const };
      }

      // Never more than what is left of the original payment (§70, §74).
      const priorRefunds = await tx.paymentRefund.aggregate({
        where: {
          topUpId: topUp.id,
          status: {
            in: [
              PaymentRefundStatus.REQUESTED,
              PaymentRefundStatus.PENDING,
              PaymentRefundStatus.SUCCEEDED,
            ],
          },
        },
        _sum: { amountMinor: true },
      });
      const alreadyRefunded = priorRefunds._sum.amountMinor ?? 0n;
      const remaining = topUp.amountMinor - alreadyRefunded;
      if (input.amountMinor > remaining) {
        throw new AppError(PalCertErrorCode.REFUND_EXCEEDS_REMAINING, {
          message: `Only ${formatMinorUnits(remaining, topUp.currency)} ${topUp.currency} of that payment is still refundable.`,
          details: {
            remainingMinorUnits: remaining.toString(),
            requestedMinorUnits: input.amountMinor.toString(),
          },
        });
      }

      const refund = await tx.paymentRefund.create({
        data: {
          ownerUserId,
          topUpId: topUp.id,
          currency: topUp.currency,
          amountMinor: input.amountMinor,
          provider: topUp.provider,
          status: PaymentRefundStatus.REQUESTED,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey ?? null,
          requestedByUserId: input.requestedByUserId,
        },
      });

      // Reserve the cash now (§71). This is also what enforces "eligible CASH
      // credit still available": if the customer has already spent it, the
      // hold fails with INSUFFICIENT_BALANCE and no refund is sent.
      const hold = await this.holds.create(tx, {
        ownerUserId,
        currency: topUp.currency,
        creditClass: CreditClass.CASH,
        amountMinor: input.amountMinor,
        purpose: CreditHoldPurpose.EXTERNAL_REFUND,
        referenceType: LedgerReferenceType.PAYMENT_REFUND,
        referenceId: refund.id,
        idempotencyKey: `refund:${refund.id}:reserve`,
        // Long enough to outlive a provider settling asynchronously.
        expiresInSeconds: 24 * 60 * 60,
      });

      const withHold = await tx.paymentRefund.update({
        where: { id: refund.id },
        data: { holdId: hold.id },
      });
      return { refund: withHold, alreadyExisted: false as const };
    });

    if (prepared.alreadyExisted) return toRefundView(prepared.refund);

    await this.events.audit({
      action: 'PAYMENT_REFUND_REQUESTED',
      actorUserId: input.requestedByUserId,
      targetType: 'PaymentRefund',
      targetId: prepared.refund.id,
      afterState: {
        currency: topUp.currency,
        amountMinor: input.amountMinor.toString(),
        reason: input.reason,
      },
    });

    return this.sendToProvider(prepared.refund.id, topUp.providerPaymentId);
  }

  /** Ask the provider to move the money, then record whatever it says. */
  private async sendToProvider(
    refundId: string,
    providerPaymentId: string,
  ): Promise<PaymentRefundView> {
    const refund = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'send a refund to the payment provider' },
      (tx) => tx.paymentRefund.findUniqueOrThrow({ where: { id: refundId } }),
    );

    try {
      const state = await this.provider.refundPayment({
        refundId: refund.id,
        providerPaymentId,
        currency: refund.currency,
        amountMinor: refund.amountMinor,
        reason: (refund.reason ?? PaymentRefundReason.REQUESTED_BY_CUSTOMER) as PaymentRefundReason,
        idempotencyKey: providerIdempotencyKey('refund', refund.id, 'create'),
      });

      if (state.succeeded) return this.settleSucceeded(refund.id, state.providerRefundId);
      if (state.failed)
        return this.settleFailed(refund.id, state.failureCode ?? 'PROVIDER_DECLINED');

      // Still settling: the provider will tell us through a webhook, and
      // reconciliation will ask if it does not.
      const pending = await this.tenant.withPlatformAdmin(
        { actorUserId: SYSTEM_ACTOR, reason: 'record a pending provider refund' },
        (tx) =>
          tx.paymentRefund.update({
            where: { id: refund.id },
            data: { status: PaymentRefundStatus.PENDING, providerRefundId: state.providerRefundId },
          }),
      );
      return toRefundView(pending);
    } catch (error) {
      const kind = error instanceof PaymentProviderError ? error.kind : 'UNKNOWN';
      // A provider that might still act is left PENDING for reconciliation; a
      // definite refusal releases the reservation now (§73).
      if (error instanceof PaymentProviderError && error.retryable) {
        this.logger.warn(
          { refundId, providerFailureKind: kind },
          'Refund deferred; provider unavailable',
        );
        const pending = await this.tenant.withPlatformAdmin(
          { actorUserId: SYSTEM_ACTOR, reason: 'defer a refund after a provider outage' },
          (tx) =>
            tx.paymentRefund.update({
              where: { id: refund.id },
              data: { status: PaymentRefundStatus.PENDING },
            }),
        );
        return toRefundView(pending);
      }
      return this.settleFailed(refund.id, String(kind));
    }
  }

  /**
   * A verified provider refund (§72).
   *
   * Capturing the hold *is* the debit: the reservation becomes a
   * `PAYMENT_REFUND_DEBIT`, atomically, and the capture is idempotent, so a
   * webhook and a direct response racing produce one debit.
   */
  async settleSucceeded(
    refundId: string,
    providerRefundId: string | null,
  ): Promise<PaymentRefundView> {
    const refund = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'settle a verified provider refund' },
      (tx) => tx.paymentRefund.findUniqueOrThrow({ where: { id: refundId } }),
    );
    if (refund.status === PaymentRefundStatus.SUCCEEDED) return toRefundView(refund);
    if (refund.holdId === null) {
      throw new AppError(PalCertErrorCode.RECONCILIATION_REQUIRED, {
        message: 'That refund has no reservation behind it.',
      });
    }

    const settled = await this.tenant.withUser(refund.ownerUserId, async (tx) => {
      const captured = await this.holds.capture(tx, refund.holdId!, {
        reasonCode: LedgerReasonCode.EXTERNAL_REFUND,
      });
      const updated = await tx.paymentRefund.updateMany({
        where: { id: refund.id, status: { not: PaymentRefundStatus.SUCCEEDED } },
        data: {
          status: PaymentRefundStatus.SUCCEEDED,
          succeededAt: this.clock.now(),
          debitEntryId: captured.entryId,
          ...(providerRefundId === null || refund.providerRefundId !== null
            ? {}
            : { providerRefundId }),
        },
      });
      return {
        changed: updated.count > 0,
        row: await tx.paymentRefund.findUniqueOrThrow({ where: { id: refund.id } }),
      };
    });

    if (settled.changed) {
      await this.events.audit({
        action: 'PAYMENT_REFUND_SUCCEEDED',
        actorUserId: null,
        targetType: 'PaymentRefund',
        targetId: refund.id,
        afterState: { currency: refund.currency, amountMinor: refund.amountMinor.toString() },
      });
    }
    return toRefundView(settled.row);
  }

  /**
   * A refund the provider refused permanently (§73).
   *
   * The reservation is released so the money becomes spendable again, and the
   * customer is **not** debited: nothing left PalCert, so nothing should leave
   * their balance.
   */
  async settleFailed(refundId: string, failureCode: string): Promise<PaymentRefundView> {
    const refund = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'record a failed provider refund' },
      (tx) => tx.paymentRefund.findUniqueOrThrow({ where: { id: refundId } }),
    );
    if (refund.status === PaymentRefundStatus.SUCCEEDED) return toRefundView(refund);

    const settled = await this.tenant.withUser(refund.ownerUserId, async (tx) => {
      if (refund.holdId !== null) await this.holds.release(tx, refund.holdId);
      await tx.paymentRefund.updateMany({
        where: { id: refund.id, status: { not: PaymentRefundStatus.SUCCEEDED } },
        data: {
          status: PaymentRefundStatus.FAILED,
          failedAt: this.clock.now(),
          failureCode: failureCode.slice(0, 64),
        },
      });
      return tx.paymentRefund.findUniqueOrThrow({ where: { id: refund.id } });
    });

    await this.events.audit({
      action: 'PAYMENT_REFUND_FAILED',
      actorUserId: null,
      targetType: 'PaymentRefund',
      targetId: refund.id,
      afterState: { failureCode },
    });
    return toRefundView(settled);
  }

  async listForOwner(ownerUserId: string): Promise<readonly PaymentRefundView[]> {
    return this.tenant.withUser(ownerUserId, async (tx) => {
      const rows = await tx.paymentRefund.findMany({
        where: { ownerUserId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      return rows.map(toRefundView);
    });
  }

  async get(refundId: string, actorUserId: string): Promise<PaymentRefundView> {
    const refund = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'finance read of a customer refund' },
      (tx) => tx.paymentRefund.findUnique({ where: { id: refundId } }),
    );
    if (refund === null) {
      throw new AppError(PalCertErrorCode.PAYMENT_REFUND_NOT_FOUND, {
        message: 'That refund could not be found.',
      });
    }
    return toRefundView(refund);
  }

  // -------------------------------------------------------------------------
  // Disputes and chargebacks (§83–§86)
  // -------------------------------------------------------------------------

  /**
   * A provider pulled a settled payment back.
   *
   * The debit is written even when it takes the balance below zero. Inventing
   * credit to keep the number non-negative would be recording a fiction, and
   * the deficit is real: PalCert has lost money it already let the customer
   * spend (§84, §85).
   */
  async recordDispute(input: {
    readonly providerDisputeId: string;
    readonly provider: string;
    readonly providerPaymentId: string;
    readonly amountMinor: bigint;
    readonly currency: string;
  }): Promise<{ recorded: boolean }> {
    const topUp = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'record a provider dispute' },
      (tx) =>
        tx.balanceTopUp.findFirst({
          where: { provider: input.provider, providerPaymentId: input.providerPaymentId },
        }),
    );
    if (topUp === null) {
      this.logger.warn(
        { provider: input.provider },
        'Dispute for a payment PalCert does not recognize; recorded for reconciliation',
      );
      return { recorded: false };
    }

    const existing = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'check for an existing dispute' },
      (tx) =>
        tx.paymentDispute.findFirst({
          where: { provider: input.provider, providerDisputeId: input.providerDisputeId },
        }),
    );
    if (existing !== null) return { recorded: false };

    await this.tenant.withUser(topUp.ownerUserId, async (tx) => {
      const account = await this.ledger.accountFor(tx, {
        ownerUserId: topUp.ownerUserId,
        currency: input.currency,
        creditClass: CreditClass.CASH,
      });
      const entry = await this.ledger.append(tx, {
        ownerUserId: topUp.ownerUserId,
        accountId: account.id,
        currency: input.currency,
        creditClass: CreditClass.CASH,
        entryType: LedgerEntryType.CHARGEBACK_DEBIT,
        amountMinorSigned: -input.amountMinor,
        referenceType: LedgerReferenceType.PAYMENT_DISPUTE,
        referenceId: topUp.id,
        idempotencyKey: `dispute:${input.provider}:${input.providerDisputeId}:debit`,
        reasonCode: LedgerReasonCode.PROVIDER_DISPUTE,
      });
      await tx.paymentDispute.create({
        data: {
          ownerUserId: topUp.ownerUserId,
          topUpId: topUp.id,
          currency: input.currency,
          amountMinor: input.amountMinor,
          provider: input.provider,
          providerDisputeId: input.providerDisputeId,
          status: PaymentDisputeStatus.OPEN,
          debitEntryId: entry.id,
        },
      });
    });

    await this.events.audit({
      action: 'PAYMENT_DISPUTE_RECEIVED',
      actorUserId: null,
      targetType: 'BalanceTopUp',
      targetId: topUp.id,
      afterState: { currency: input.currency, amountMinor: input.amountMinor.toString() },
    });
    return { recorded: true };
  }

  /** A dispute resolved in PalCert's favour: the exact debit is given back (§86). */
  async resolveDispute(input: {
    readonly provider: string;
    readonly providerDisputeId: string;
    readonly won: boolean;
  }): Promise<{ reversed: boolean }> {
    const dispute = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'resolve a provider dispute' },
      (tx) =>
        tx.paymentDispute.findFirst({
          where: { provider: input.provider, providerDisputeId: input.providerDisputeId },
        }),
    );
    if (dispute === null || dispute.status !== PaymentDisputeStatus.OPEN) {
      return { reversed: false };
    }

    if (!input.won) {
      await this.tenant.withPlatformAdmin(
        { actorUserId: SYSTEM_ACTOR, reason: 'record a lost dispute' },
        (tx) =>
          tx.paymentDispute.updateMany({
            where: { id: dispute.id, status: PaymentDisputeStatus.OPEN },
            data: { status: PaymentDisputeStatus.LOST, resolvedAt: this.clock.now() },
          }),
      );
      return { reversed: false };
    }

    await this.tenant.withUser(dispute.ownerUserId, async (tx) => {
      const account = await this.ledger.accountFor(tx, {
        ownerUserId: dispute.ownerUserId,
        currency: dispute.currency,
        creditClass: CreditClass.CASH,
      });
      const entry = await this.ledger.append(tx, {
        ownerUserId: dispute.ownerUserId,
        accountId: account.id,
        currency: dispute.currency,
        creditClass: CreditClass.CASH,
        entryType: LedgerEntryType.CHARGEBACK_REVERSAL,
        // Exactly the disputed amount, no more and no less.
        amountMinorSigned: dispute.amountMinor,
        referenceType: LedgerReferenceType.PAYMENT_DISPUTE,
        referenceId: dispute.topUpId,
        idempotencyKey: `dispute:${input.provider}:${input.providerDisputeId}:reversal`,
        reasonCode: LedgerReasonCode.PROVIDER_DISPUTE_WON,
      });
      await tx.paymentDispute.updateMany({
        where: { id: dispute.id, status: PaymentDisputeStatus.OPEN },
        data: {
          status: PaymentDisputeStatus.WON,
          resolvedAt: this.clock.now(),
          reversalEntryId: entry.id,
        },
      });
    });
    return { reversed: true };
  }
}

export function toRefundView(row: {
  id: string;
  topUpId: string;
  status: PaymentRefundStatus;
  currency: string;
  amountMinor: bigint;
  reason: string | null;
  failureCode: string | null;
  createdAt: Date;
  succeededAt: Date | null;
  failedAt: Date | null;
}): PaymentRefundView {
  return {
    id: row.id,
    topUpId: row.topUpId,
    status: row.status,
    amount: money(row.currency, row.amountMinor),
    reason: row.reason as PaymentRefundReason | null,
    failureCode: row.failureCode,
    createdAt: row.createdAt.toISOString(),
    succeededAt: row.succeededAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
  };
}
