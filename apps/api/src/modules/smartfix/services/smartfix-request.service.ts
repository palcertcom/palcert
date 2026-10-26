import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  ServiceProductCode,
  ServicePurchaseStatus,
  ServiceResourceType,
  SmartFixFailureCode,
  SmartFixRequestStatus,
  smartFixHoldsBalance,
} from '@palcert/contracts';
import type { SmartFixRequest } from '@palcert/database';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { RequestContext } from '../../documents/services/document.service';
import { ServicePurchaseService } from '../../finance/services/service-purchase.service';
import { SmartFixPlanService } from './smartfix-plan.service';
import { SmartFixSettlementService } from './smartfix-settlement.service';

export interface StartSmartFixInput {
  readonly planId: string;
  readonly priceQuoteId: string;
  readonly idempotencyKey?: string;
}

/**
 * Buying a correction (Phase 12 §73, §74, §79).
 *
 * The commercial start is one transaction: reserve the balance, write the
 * request, enqueue the work. All three or none, so an insufficient balance
 * leaves no half-started correction and a crashed API process leaves a durable
 * intent rather than a reservation nobody will ever act on.
 *
 * It reuses the Phase 10 SMARTFIX product and the Phase 11 purchase domain
 * unchanged. A second billing framework would mean two answers to "was I
 * charged for that?", and the customer only ever has one question.
 */
@Injectable()
export class SmartFixRequestService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly plans: SmartFixPlanService,
    private readonly purchases: ServicePurchaseService,
    private readonly settlement: SmartFixSettlementService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SmartFixRequestService.name);
  }

  async start(
    userId: string,
    input: StartSmartFixInput,
    request: RequestContext,
  ): Promise<SmartFixRequest> {
    // A browser retry must not buy a second correction. Two deliberate
    // corrections of the same plan are not something anybody wants either, but
    // that is refused below for a different reason.
    if (input.idempotencyKey !== undefined) {
      const existing = await this.tenant.withUser(userId, (tx) =>
        tx.smartFixRequest.findFirst({
          where: { ownerUserId: userId, idempotencyKey: input.idempotencyKey },
        }),
      );
      if (existing !== null) {
        if (existing.planId !== input.planId) {
          throw new AppError(PalCertErrorCode.IDEMPOTENCY_KEY_REUSED, {
            message: 'That request key was already used for a different correction.',
          });
        }
        return existing;
      }
    }

    const plan = await this.plans.byId(userId, input.planId);
    if (plan.refusalCode !== null) {
      throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
        message: 'This document cannot be corrected.',
        details: { refusalCode: plan.refusalCode },
      });
    }
    if (plan.actionCount === 0) {
      // Nothing to do. Charging for a correction that changes nothing would be
      // charging for nothing.
      throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
        message: 'There is nothing for SmartFix to correct in this document.',
      });
    }
    if (plan.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
        message: 'This correction plan has expired. Please ask for a new one.',
        details: { planId: plan.id },
      });
    }

    const requestId = randomUUID();
    const purchaseId = randomUUID();

    const created = await this.tenant.withUser(userId, async (tx) => {
      // One correction at a time per plan. A second in flight would race the
      // first for the same corrected version and the same recheck.
      const live = await tx.smartFixRequest.findFirst({
        where: {
          ownerUserId: userId,
          planId: plan.id,
          status: {
            in: [
              SmartFixRequestStatus.RESERVED,
              SmartFixRequestStatus.PROCESSING,
              SmartFixRequestStatus.RECHECKING,
              SmartFixRequestStatus.VALIDATING,
              SmartFixRequestStatus.DELIVERED,
            ],
          },
        },
      });
      if (live !== null) {
        throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
          message: 'This correction has already been started.',
          details: { smartFixRequestId: live.id, status: live.status },
        });
      }

      // The document must still be the one the plan was computed from. This is
      // the cheap half of the guard; the engine re-checks the bytes themselves
      // before it writes anything (§58).
      const version = await tx.documentVersion.findFirst({
        where: { id: plan.documentVersionId, ownerUserId: userId },
        select: { sha256: true, status: true },
      });
      if (
        version === null ||
        version.status !== 'READY' ||
        version.sha256 !== plan.documentSha256
      ) {
        throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
          message: 'This document has changed since the plan was made. Please plan again.',
        });
      }

      const quote = await this.loadSpendableQuote(tx, userId, input.priceQuoteId);

      // Reserving is where a shortfall is discovered, and it throws — which
      // rolls back everything, so an insufficient balance leaves no request,
      // no purchase, no hold and no job behind.
      await this.purchases.reserve(tx, {
        ownerUserId: userId,
        purchaseId,
        productCode: ServiceProductCode.SMARTFIX,
        resourceType: ServiceResourceType.SMARTFIX,
        resourceId: requestId,
        quote: {
          id: quote.id,
          priceVersionId: quote.priceVersionId,
          currency: quote.currency,
          amountMinor: quote.amountMinor,
        },
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      });

      const row = await tx.smartFixRequest.create({
        data: {
          id: requestId,
          ownerUserId: userId,
          planId: plan.id,
          planHash: plan.planHash,
          checkId: plan.checkId,
          documentId: plan.documentId,
          sourceDocumentVersionId: plan.documentVersionId,
          standardVersionId: plan.standardVersionId,
          servicePurchaseId: purchaseId,
          status: SmartFixRequestStatus.RESERVED,
          idempotencyKey: input.idempotencyKey ?? null,
        },
      });

      // The durable kickoff, written inside the same commit as the money.
      await this.jobs.enqueueInTransaction(tx, {
        type: 'SMARTFIX_EXECUTE',
        resourceType: 'SMARTFIX_REQUEST',
        resourceId: requestId,
        ownerUserId: userId,
      });

      return row;
    });

    await this.events.audit({
      action: 'SMARTFIX_REQUESTED',
      actorUserId: userId,
      targetType: 'SmartFixRequest',
      targetId: created.id,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: { planId: plan.id, checkId: plan.checkId, purchaseId },
    });

    const job = await this.jobs.findByResource('SMARTFIX_EXECUTE', created.id);
    if (job !== null) await this.dispatcher.dispatchNow(job.id);

    return created;
  }

  /**
   * Stop a correction the user no longer wants (§80).
   *
   * Releases the reservation and charges nothing. Refused once the recheck has
   * run: at that point the only remaining questions are whether the result
   * justifies delivery and whether to charge, and a cancellation there would
   * leave a verified, undelivered, unpaid correction that nobody could explain.
   */
  async cancel(
    userId: string,
    requestId: string,
    request: RequestContext,
  ): Promise<SmartFixRequest> {
    await this.settlement.settle(userId, requestId, {
      status: SmartFixRequestStatus.CANCELLED,
      code: SmartFixFailureCode.CANCELLED_BY_CUSTOMER,
      detail: 'the customer cancelled the correction',
      allowedFrom: [
        SmartFixRequestStatus.RESERVED,
        SmartFixRequestStatus.PROCESSING,
        SmartFixRequestStatus.RECHECKING,
      ],
      notCancellableMessage: 'This correction can no longer be cancelled.',
    });

    await this.events.audit({
      action: 'SMARTFIX_CANCELLED',
      actorUserId: userId,
      targetType: 'SmartFixRequest',
      targetId: requestId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: { failureCode: SmartFixFailureCode.CANCELLED_BY_CUSTOMER },
    });

    return this.byId(userId, requestId);
  }

  async byId(userId: string, requestId: string): Promise<SmartFixRequest> {
    const row = await this.tenant.withUser(userId, (tx) =>
      tx.smartFixRequest.findFirst({ where: { id: requestId, ownerUserId: userId } }),
    );
    if (row === null) {
      throw new AppError(PalCertErrorCode.NOT_FOUND, {
        message: 'That correction could not be found.',
      });
    }
    return row;
  }

  async listForCheck(userId: string, checkId: string): Promise<readonly SmartFixRequest[]> {
    return this.tenant.withUser(userId, (tx) =>
      tx.smartFixRequest.findMany({
        where: { ownerUserId: userId, checkId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    );
  }

  /** True while the request is still holding the customer's balance. */
  static holdsBalance(status: string): boolean {
    return smartFixHoldsBalance(status as SmartFixRequestStatus);
  }

  /**
   * Load the quote that will pay for this correction, or refuse.
   *
   * The same five conditions Phase 11 applies to a check, against the SMARTFIX
   * product: the quote is the caller's, it is for this service, it has not
   * expired, its currency is one PalCert transacts in, and it has not already
   * funded something.
   */
  private async loadSpendableQuote(
    tx: TenantClient,
    userId: string,
    priceQuoteId: string,
  ): Promise<{ id: string; priceVersionId: string; currency: string; amountMinor: bigint }> {
    const quote = await tx.priceQuote.findFirst({
      where: { id: priceQuoteId, ownerUserId: userId },
      include: { purchase: { select: { id: true } } },
    });
    if (quote === null) {
      throw new AppError(PalCertErrorCode.QUOTE_NOT_FOUND, {
        message: 'That price quote could not be found.',
      });
    }
    if (quote.productCode !== ServiceProductCode.SMARTFIX) {
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
    return {
      id: quote.id,
      priceVersionId: quote.priceVersionId,
      currency: quote.currency,
      amountMinor: quote.amountMinor,
    };
  }

  /** Whether a purchase is still reserved, for the settlement paths. */
  static stillReserved(status: ServicePurchaseStatus): boolean {
    return status === ServicePurchaseStatus.RESERVED || status === ServicePurchaseStatus.PROCESSING;
  }
}
