import { Injectable } from '@nestjs/common';
import {
  AppError,
  CreditHoldStatus,
  PalCertErrorCode,
  PurchaseFailureCode,
  ServicePurchaseStatus,
  aiPurchaseIdempotencyKey,
  billableAIOperation,
  type AIOperation,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { ServicePurchaseService, type PurchaseRow } from './service-purchase.service';

/**
 * Billing for customer-initiated AI services (ADR-0149).
 *
 * The one place an AI feature asks for money. It adds no new financial
 * authority — the purchase, its holds and the ledger remain that — only the
 * rules that every AI service shares:
 *
 *   - **The payer is the user who starts the work.** Also when the work is an
 *     organization's: a template manager extracting rules for University A pays
 *     from their own PalCert Balance. No role is free, PALCERT_ADMIN included.
 *     The payer is always the authenticated caller; nothing in the request can
 *     name someone else.
 *   - **The price is the server's.** It comes from a quote the caller obtained
 *     for this very product, unexpired and unspent. The client never states an
 *     amount, a price version or a payer.
 *   - **Reserve, then capture on COMPLETED, release otherwise.** Billing follows
 *     delivery status, never the quality or tone of the answer.
 *   - **One resource, one purchase.** The key is derived from the resource,
 *     and a quote funds at most one purchase, so a retry finds the reservation
 *     it already made instead of making another.
 *   - **No provider call on lapsed credit.** Workers call `assertReservationLive`
 *     before every provider call; a reservation that has expired or been
 *     released stops the work before any AI is used.
 */
@Injectable()
export class AIServiceBillingService {
  constructor(
    private readonly purchases: ServicePurchaseService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly events: SecurityEventService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AIServiceBillingService.name);
  }

  /**
   * The purchase a quote has already funded, if any — for an AI resource the
   * caller owns. This is what makes an HTTP retry of the same confirmation
   * return the run it started rather than refuse or start another.
   */
  async purchaseFundedBy(
    tx: TenantClient,
    payerUserId: string,
    operation: AIOperation,
    priceQuoteId: string,
  ): Promise<{ id: string; resourceId: string } | null> {
    const entry = billableAIOperation(operation);
    const row = await tx.servicePurchase.findFirst({
      where: { priceQuoteId, ownerUserId: payerUserId, resourceType: entry.resourceType },
      select: { id: true, resourceId: true },
    });
    return row;
  }

  /**
   * Reserve the quoted price for one AI resource.
   *
   * Must run inside the transaction that creates the resource, so the run and
   * its purchase exist together or not at all. Consent and every other
   * eligibility check happen before this is called: no money is reserved for a
   * request that was already going to be refused.
   */
  async reserve(
    tx: TenantClient,
    input: {
      readonly payerUserId: string;
      readonly operation: AIOperation;
      readonly resourceId: string;
      readonly purchaseId: string;
      readonly priceQuoteId: string;
    },
  ): Promise<PurchaseRow> {
    const entry = billableAIOperation(input.operation);
    const quote = await tx.priceQuote.findFirst({
      where: { id: input.priceQuoteId, ownerUserId: input.payerUserId },
      include: { purchase: { select: { id: true } } },
    });
    // Another user's quote reads as not found: the database scopes the query to
    // the caller, and the answer does not reveal that the id exists.
    if (quote === null) {
      throw new AppError(PalCertErrorCode.QUOTE_NOT_FOUND, {
        message: 'That price quote could not be found.',
      });
    }
    if (quote.productCode !== entry.productCode) {
      throw new AppError(PalCertErrorCode.QUOTE_PRODUCT_MISMATCH, {
        message: 'That price quote is for a different service.',
      });
    }
    if (quote.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw new AppError(PalCertErrorCode.QUOTE_EXPIRED, {
        message: 'That price quote has expired. Please ask for a new one.',
      });
    }
    if (quote.purchase !== null) {
      throw new AppError(PalCertErrorCode.QUOTE_ALREADY_USED, {
        message: 'That price quote has already been used. Please ask for a new one.',
      });
    }

    return this.purchases.reserve(tx, {
      ownerUserId: input.payerUserId,
      purchaseId: input.purchaseId,
      productCode: entry.productCode,
      resourceType: entry.resourceType,
      resourceId: input.resourceId,
      quote: {
        id: quote.id,
        priceVersionId: quote.priceVersionId,
        currency: quote.currency,
        // The quote's own amount, honoured even if the price changed since.
        amountMinor: quote.amountMinor,
      },
      reservationTtlSeconds: this.config.payments.aiReservationTtlSeconds,
      idempotencyKey: aiPurchaseIdempotencyKey(input.operation, input.resourceId),
    });
  }

  /**
   * Refuse to call the provider on credit that is no longer reserved.
   *
   * Every hold must still be ACTIVE and not past its expiry. If one is not,
   * the caller fails the run and releases whatever is left; nothing is sent
   * to the AI provider and nothing is charged.
   */
  async assertReservationLive(tx: TenantClient, purchaseId: string): Promise<void> {
    const purchase = await tx.servicePurchase.findUnique({
      where: { id: purchaseId },
      include: { allocations: { include: { hold: true } } },
    });
    const now = this.clock.now().getTime();
    const live =
      purchase !== null &&
      (purchase.status === ServicePurchaseStatus.RESERVED ||
        purchase.status === ServicePurchaseStatus.PROCESSING) &&
      purchase.allocations.length > 0 &&
      purchase.allocations.every(
        (allocation) =>
          allocation.hold.status === CreditHoldStatus.ACTIVE &&
          (allocation.hold.expiresAt === null || allocation.hold.expiresAt.getTime() > now),
      );
    if (!live) {
      throw new AppError(PalCertErrorCode.SERVICE_RESERVATION_EXPIRED, {
        message: 'The reservation for this AI service is no longer active.',
        details: { purchaseId },
      });
    }
  }

  /** The provider work has started. Nothing is charged. */
  async markProcessing(tx: TenantClient, purchaseId: string): Promise<void> {
    await this.purchases.markProcessing(tx, purchaseId);
  }

  /**
   * Charge for a COMPLETED AI service, exactly once.
   *
   * Runs in the transaction that records the completion. A second delivery of
   * the same job finds the purchase DELIVERED and charges nothing; a
   * reservation that lapsed throws, and the completion rolls back with it.
   */
  async capture(tx: TenantClient, purchaseId: string): Promise<{ charged: boolean }> {
    const result = await this.purchases.captureOnDelivery(tx, purchaseId);
    return { charged: result.charged };
  }

  /** Give the reservation back: FAILED, CANCELLED, or never started. Idempotent. */
  async release(
    tx: TenantClient,
    purchaseId: string,
    failureCode: PurchaseFailureCode,
  ): Promise<{ released: boolean }> {
    return this.purchases.release(tx, purchaseId, failureCode);
  }

  /**
   * One audit row per lifecycle step. History, not authority: the purchase,
   * its holds and the ledger say what happened to the money.
   */
  async audit(input: {
    readonly action:
      'AI_SERVICE_RESERVED' | 'AI_SERVICE_CAPTURED' | 'AI_SERVICE_RELEASED' | 'AI_SERVICE_QUOTED';
    readonly operation: AIOperation;
    readonly purchaseId: string;
    readonly resourceId: string;
    readonly payerUserId: string;
    readonly actorUserId: string | null;
    readonly organizationId?: string | null;
    readonly amountMinor?: bigint;
    readonly currency?: string;
    readonly failureCode?: string;
    readonly requestId?: string | null;
    readonly ipAddress?: string | null;
  }): Promise<void> {
    const entry = billableAIOperation(input.operation);
    await this.events.audit({
      action: input.action,
      actorUserId: input.actorUserId,
      targetType: 'ServicePurchase',
      targetId: input.purchaseId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      afterState: {
        productCode: entry.productCode,
        resourceType: entry.resourceType,
        resourceId: input.resourceId,
        payerUserId: input.payerUserId,
        organizationId: input.organizationId ?? null,
        ...(input.amountMinor === undefined ? {} : { amountMinor: input.amountMinor.toString() }),
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
      },
    });
  }
}
