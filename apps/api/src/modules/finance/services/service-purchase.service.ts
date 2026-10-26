import { Injectable } from '@nestjs/common';
import {
  AppError,
  CreditClass,
  CreditHoldPurpose,
  CreditHoldStatus,
  FUNDING_ORDER,
  LedgerReasonCode,
  LedgerReferenceType,
  PalCertErrorCode,
  PurchaseFailureCode,
  ServicePurchaseStatus,
  formatMinorUnits,
  money,
  purchaseHoldIdempotencyKey,
  type ServiceBillingView,
  type ServiceProductCode,
  type ServicePurchaseView,
  type ServiceResourceType,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { CreditHoldService } from './credit-hold.service';
import { CreditLedgerService } from './credit-ledger.service';

/**
 * Buying a deliverable service with PalCert Balance (§5–§12, §32, §37).
 *
 * This is the only place that knows how a purchase is funded, charged and
 * given back. Nothing in the check domain allocates credit itself (§11) — it
 * asks for a reservation, and later says whether the service was delivered.
 *
 * Three properties are worth stating plainly, because each one is a bug that
 * would otherwise be easy to write:
 *
 *   - **Funding is promotional-first, and atomic.** A $5 check against $2 of
 *     promotional credit and $10 of cash reserves $2 and $3, in that order, in
 *     one transaction. If the cash cannot cover the remainder the whole thing
 *     rolls back, so no partial reservation is ever left behind (§10, §11).
 *
 *   - **Accounts are locked in one order, everywhere.** `FUNDING_ORDER` is
 *     both the allocation order and the lock order, so two simultaneous
 *     purchases queue rather than deadlock (§12).
 *
 *   - **Capture happens on delivery and only on delivery.** Every hold is
 *     re-checked as still ACTIVE first: an expired reservation is refused
 *     rather than silently re-taken against whatever balance the customer
 *     happens to have now (§27).
 *
 * There is deliberately no payment-provider import anywhere in this file. A
 * customer with balance can buy a check while the provider is down (§1, §56).
 */

export interface ReserveInput {
  readonly ownerUserId: string;
  /** Preallocated, so the resource can be written in the same transaction (§20). */
  readonly purchaseId: string;
  readonly productCode: ServiceProductCode;
  readonly resourceType: ServiceResourceType;
  readonly resourceId: string;
  readonly quote: {
    readonly id: string;
    readonly priceVersionId: string;
    readonly currency: string;
    readonly amountMinor: bigint;
  };
  readonly reservationTtlSeconds?: number | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface PurchaseRow {
  readonly id: string;
  readonly ownerUserId: string;
  readonly productCode: ServiceProductCode;
  readonly resourceType: ServiceResourceType;
  readonly resourceId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly status: ServicePurchaseStatus;
}

@Injectable()
export class ServicePurchaseService {
  constructor(
    private readonly ledger: CreditLedgerService,
    private readonly holds: CreditHoldService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ServicePurchaseService.name);
  }

  /**
   * Reserve the price of one service, across as many accounts as it takes.
   *
   * Must be called inside the caller's transaction: the row locks it takes are
   * what make "check the balance, then spend it" a single decision, and they
   * last until that transaction commits.
   */
  async reserve(tx: TenantClient, input: ReserveInput): Promise<PurchaseRow> {
    const { ownerUserId, quote } = input;

    // A retried commercial request returns what it reserved the first time,
    // rather than reserving again (§18).
    if (input.idempotencyKey !== undefined) {
      const existing = await tx.servicePurchase.findUnique({
        where: {
          ownerUserId_idempotencyKey: { ownerUserId, idempotencyKey: input.idempotencyKey },
        },
      });
      if (existing !== null) return toPurchaseRow(existing);
    }

    const ttl = input.reservationTtlSeconds ?? this.config.payments.checkReservationTtlSeconds;
    const plan = await this.plan(tx, ownerUserId, quote.currency, quote.amountMinor);

    const purchase = await tx.servicePurchase.create({
      data: {
        id: input.purchaseId,
        ownerUserId,
        productCode: input.productCode,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        priceQuoteId: quote.id,
        priceVersionId: quote.priceVersionId,
        currency: quote.currency,
        amountMinor: quote.amountMinor,
        status: ServicePurchaseStatus.RESERVED,
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: this.clock.now(),
        reservedAt: this.clock.now(),
      },
    });

    for (const slice of plan) {
      const hold = await this.holds.create(tx, {
        ownerUserId,
        currency: quote.currency,
        creditClass: slice.creditClass,
        amountMinor: slice.amountMinor,
        purpose: CreditHoldPurpose.SERVICE,
        referenceType: LedgerReferenceType.SERVICE_PURCHASE,
        referenceId: purchase.id,
        idempotencyKey: purchaseHoldIdempotencyKey(purchase.id, slice.creditClass),
        expiresInSeconds: ttl,
      });

      await tx.servicePurchaseAllocation.create({
        data: {
          ownerUserId,
          purchaseId: purchase.id,
          holdId: hold.id,
          creditClass: slice.creditClass,
          currency: quote.currency,
          amountMinor: slice.amountMinor,
        },
      });
    }

    return toPurchaseRow(purchase);
  }

  /**
   * Decide which accounts pay, and lock them while deciding.
   *
   * Walks `FUNDING_ORDER` — promotional, then cash — taking as much as each
   * account has available until the price is covered. Locking happens in the
   * same order for every purchase, which is the deadlock defence (§12).
   *
   * A shortfall throws rather than reserving what it can: a half-funded
   * purchase is not a purchase, and the caller's transaction rolling back is
   * exactly the right outcome (§11, §108).
   */
  private async plan(
    tx: TenantClient,
    ownerUserId: string,
    currency: string,
    amountMinor: bigint,
  ): Promise<{ creditClass: CreditClass; amountMinor: bigint }[]> {
    const slices: { creditClass: CreditClass; amountMinor: bigint }[] = [];
    let remaining = amountMinor;
    let availableTotal = 0n;

    for (const creditClass of FUNDING_ORDER) {
      const account = await this.ledger.accountFor(tx, { ownerUserId, currency, creditClass });
      // The lock, taken here rather than inside the hold, because the split
      // has to be decided against balances that cannot move underneath it.
      await tx.$queryRaw`SELECT "id" FROM "customer_credit_accounts" WHERE "id" = ${account.id}::uuid FOR UPDATE`;

      const position = await this.ledger.position(tx, { id: account.id, currency, creditClass });
      // A negative position — a chargeback took the balance below zero —
      // contributes nothing and must never be treated as credit (§91).
      const usable = position.availableMinor > 0n ? position.availableMinor : 0n;
      availableTotal += usable;
      if (remaining === 0n || usable === 0n) continue;

      const take = usable >= remaining ? remaining : usable;
      slices.push({ creditClass, amountMinor: take });
      remaining -= take;
    }

    if (remaining > 0n) {
      throw new AppError(PalCertErrorCode.INSUFFICIENT_BALANCE, {
        message: `Your available balance is ${formatMinorUnits(availableTotal, currency)} ${currency}, which is less than the ${formatMinorUnits(amountMinor, currency)} ${currency} this costs.`,
        details: {
          currency,
          availableMinorUnits: availableTotal.toString(),
          requiredMinorUnits: amountMinor.toString(),
          shortfallMinorUnits: remaining.toString(),
        },
      });
    }

    return slices;
  }

  /** The work has started. Purely informational; nothing has been charged. */
  async markProcessing(tx: TenantClient, purchaseId: string): Promise<void> {
    await tx.servicePurchase.updateMany({
      where: { id: purchaseId, status: ServicePurchaseStatus.RESERVED },
      data: { status: ServicePurchaseStatus.PROCESSING, processingAt: this.clock.now() },
    });
  }

  /**
   * Charge for a delivered service (§32, §35).
   *
   * Must run inside the same transaction that persists the delivery. Every
   * hold is captured or none is: a hold that has expired or been released
   * makes the whole transaction fail, which is what stops a late worker
   * delivering a report the customer was never charged for (§27, §116).
   *
   * Capturing an already-delivered purchase is a no-op, because an
   * at-least-once worker will do exactly that (§82).
   */
  async captureOnDelivery(
    tx: TenantClient,
    purchaseId: string,
  ): Promise<{ charged: boolean; entryIds: readonly string[] }> {
    const purchase = await tx.servicePurchase.findUnique({
      where: { id: purchaseId },
      include: { allocations: { include: { hold: true } } },
    });
    if (purchase === null) {
      throw new AppError(PalCertErrorCode.SERVICE_PURCHASE_NOT_FOUND, {
        message: 'That purchase could not be found.',
      });
    }
    if (
      purchase.status === ServicePurchaseStatus.DELIVERED ||
      purchase.status === ServicePurchaseStatus.REFUNDED
    ) {
      return { charged: false, entryIds: [] };
    }
    if (
      purchase.status !== ServicePurchaseStatus.RESERVED &&
      purchase.status !== ServicePurchaseStatus.PROCESSING
    ) {
      throw new AppError(PalCertErrorCode.SERVICE_RESERVATION_EXPIRED, {
        message: 'The reservation for this service is no longer active.',
        details: { status: purchase.status },
      });
    }

    // §27: every reservation is checked before any of them is charged, so a
    // partial capture is not even attempted.
    const stale = purchase.allocations.filter(
      (allocation) => allocation.hold.status !== CreditHoldStatus.ACTIVE,
    );
    if (stale.length > 0) {
      throw new AppError(PalCertErrorCode.SERVICE_RESERVATION_EXPIRED, {
        message: 'The reservation for this service expired before it could be completed.',
        details: { expiredReservations: stale.length },
      });
    }

    const entryIds: string[] = [];
    for (const allocation of purchase.allocations) {
      const captured = await this.holds.capture(tx, allocation.holdId, {
        reasonCode: LedgerReasonCode.SERVICE_CAPTURED,
      });
      entryIds.push(captured.entryId);
    }

    const now = this.clock.now();
    await tx.servicePurchase.update({
      where: { id: purchaseId },
      data: { status: ServicePurchaseStatus.DELIVERED, deliveredAt: now, failureCode: null },
    });

    return { charged: true, entryIds };
  }

  /**
   * Give the reservation back (§37, §41).
   *
   * Release, not refund. Nothing was ever charged, so there is no ledger entry
   * to reverse and nothing for the customer's transaction history to show —
   * which is precisely why Phase 11 captures on delivery rather than charging
   * up front (§41, §60).
   */
  async release(
    tx: TenantClient,
    purchaseId: string,
    failureCode: PurchaseFailureCode,
  ): Promise<{ released: boolean }> {
    const purchase = await tx.servicePurchase.findUnique({
      where: { id: purchaseId },
      include: { allocations: true },
    });
    if (purchase === null) return { released: false };
    if (purchase.status === ServicePurchaseStatus.RELEASED) return { released: false };

    if (
      purchase.status === ServicePurchaseStatus.DELIVERED ||
      purchase.status === ServicePurchaseStatus.REFUNDED
    ) {
      // The service was delivered and charged. Releasing now would be a refund
      // by another name, and a refund is a deliberate, audited act (§42, §95).
      throw new AppError(PalCertErrorCode.SERVICE_ALREADY_DELIVERED, {
        message: 'That service has already been delivered and charged.',
      });
    }

    for (const allocation of purchase.allocations) {
      await this.holds.release(tx, allocation.holdId);
    }

    const now = this.clock.now();
    await tx.servicePurchase.updateMany({
      where: {
        id: purchaseId,
        status: { in: [ServicePurchaseStatus.RESERVED, ServicePurchaseStatus.PROCESSING] },
      },
      data: { status: ServicePurchaseStatus.RELEASED, releasedAt: now, failureCode },
    });
    return { released: true };
  }

  /**
   * Escalate a purchase whose financial state does not add up (§94).
   *
   * Nothing is fixed here. The row is marked so a person looks, exactly as a
   * mismatched payment is in Phase 10.
   */
  async escalate(tx: TenantClient, purchaseId: string, reason: string): Promise<void> {
    await tx.servicePurchase.updateMany({
      where: { id: purchaseId, status: { not: ServicePurchaseStatus.RECONCILIATION_REQUIRED } },
      data: { status: ServicePurchaseStatus.RECONCILIATION_REQUIRED },
    });
    this.logger.error({ purchaseId, reason }, 'Service purchase requires reconciliation');
  }

  async byResource(
    tx: TenantClient,
    resourceType: ServiceResourceType,
    resourceId: string,
  ): Promise<PurchaseRow | null> {
    const row = await tx.servicePurchase.findUnique({
      where: { resourceType_resourceId: { resourceType, resourceId } },
    });
    return row === null ? null : toPurchaseRow(row);
  }

  /**
   * What the customer is told about the money (§50).
   *
   * `reserved` and `charged` are computed from the allocations' holds rather
   * than stored, so they cannot drift from what the ledger actually did.
   */
  async billingFor(tx: TenantClient, purchaseId: string): Promise<ServiceBillingView | null> {
    const purchase = await tx.servicePurchase.findUnique({
      where: { id: purchaseId },
      include: { allocations: { include: { hold: true } } },
    });
    return purchase === null ? null : toBillingView(purchase);
  }
}

export interface PurchaseWithHolds {
  readonly id: string;
  readonly ownerUserId: string;
  readonly productCode: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly status: string;
  readonly failureCode: string | null;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
  readonly releasedAt: Date | null;
  readonly refundedAt: Date | null;
  readonly allocations: readonly {
    readonly creditClass: string;
    readonly amountMinor: bigint;
    readonly hold: { readonly status: string; readonly amountMinor: bigint };
  }[];
}

/** Project a purchase onto the customer-facing billing block. */
export function toBillingView(purchase: PurchaseWithHolds): ServiceBillingView {
  let reserved = 0n;
  let charged = 0n;
  for (const allocation of purchase.allocations) {
    if (allocation.hold.status === CreditHoldStatus.ACTIVE) reserved += allocation.amountMinor;
    if (allocation.hold.status === CreditHoldStatus.CAPTURED) charged += allocation.amountMinor;
  }

  return {
    purchaseId: purchase.id,
    productCode: purchase.productCode as ServiceProductCode,
    status: purchase.status as ServicePurchaseStatus,
    amount: money(purchase.currency, purchase.amountMinor),
    reserved: money(purchase.currency, reserved),
    charged: money(purchase.currency, charged),
    failureCode: (purchase.failureCode as PurchaseFailureCode | null) ?? null,
    createdAt: purchase.createdAt.toISOString(),
    deliveredAt: purchase.deliveredAt?.toISOString() ?? null,
    releasedAt: purchase.releasedAt?.toISOString() ?? null,
    refundedAt: purchase.refundedAt?.toISOString() ?? null,
  };
}

/** The same purchase, with what it bought, for a customer's own history. */
export function toPurchaseView(purchase: PurchaseWithHolds): ServicePurchaseView {
  return {
    ...toBillingView(purchase),
    resourceType: purchase.resourceType as ServiceResourceType,
    resourceId: purchase.resourceId,
    currency: purchase.currency,
  };
}

function toPurchaseRow(row: {
  id: string;
  ownerUserId: string;
  productCode: string;
  resourceType: string;
  resourceId: string;
  currency: string;
  amountMinor: bigint;
  status: string;
}): PurchaseRow {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    productCode: row.productCode as ServiceProductCode,
    resourceType: row.resourceType as ServiceResourceType,
    resourceId: row.resourceId,
    currency: row.currency,
    amountMinor: row.amountMinor,
    status: row.status as ServicePurchaseStatus,
  };
}
