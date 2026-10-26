import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  PurchaseFailureCode,
  SmartFixRequestStatus,
  canTransitionSmartFixRequest,
  type SmartFixFailureCode,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { ServicePurchaseService } from '../../finance/services/service-purchase.service';

export interface SettleInput {
  readonly status: typeof SmartFixRequestStatus.FAILED | typeof SmartFixRequestStatus.CANCELLED;
  readonly code: SmartFixFailureCode;
  readonly detail: string;
  readonly allowedFrom: readonly SmartFixRequestStatus[];
  readonly notCancellableMessage?: string;
}

/**
 * Money and correction settle together (Phase 12 §80, §120).
 *
 * The failure path is free. Not "usually free", not "free once support looks
 * at it" — free, because the reservation is released in the same transaction
 * that records the failure, and the database refuses at COMMIT to let a FAILED
 * request coexist with a charged reservation.
 *
 * Every method here is idempotent: an at-least-once worker will run them
 * twice, and releasing twice would give the customer back money they never
 * spent.
 */
@Injectable()
export class SmartFixSettlementService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly purchases: ServicePurchaseService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SmartFixSettlementService.name);
  }

  /**
   * Take the request's row lock and read it.
   *
   * Everything that settles money calls this first, so "what is this
   * correction now?" is answered by a row nobody else can change until the
   * transaction ends.
   */
  private async lock(
    tx: TenantClient,
    requestId: string,
  ): Promise<{
    id: string;
    status: SmartFixRequestStatus;
    servicePurchaseId: string;
    correctedDocumentVersionId: string | null;
  } | null> {
    await tx.$queryRaw`SELECT "id" FROM "smartfix_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
    const row = await tx.smartFixRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        servicePurchaseId: true,
        correctedDocumentVersionId: true,
      },
    });
    return row === null
      ? null
      : {
          id: row.id,
          status: row.status as SmartFixRequestStatus,
          servicePurchaseId: row.servicePurchaseId,
          correctedDocumentVersionId: row.correctedDocumentVersionId,
        };
  }

  /** The work has begun. Nothing is charged; the purchase stops saying "reserved". */
  async markProcessing(userId: string, requestId: string): Promise<boolean> {
    return this.tenant.withUser(userId, async (tx) => {
      const row = await this.lock(tx, requestId);
      if (row === null) return false;
      if (row.status === SmartFixRequestStatus.PROCESSING) return true;
      if (!canTransitionSmartFixRequest(row.status, SmartFixRequestStatus.PROCESSING)) return false;

      await this.purchases.markProcessing(tx, row.servicePurchaseId);
      await tx.smartFixRequest.update({
        where: { id: requestId },
        data: { status: SmartFixRequestStatus.PROCESSING, processingAt: this.clock.now() },
      });
      return true;
    });
  }

  /** Move to the next stage of the work. Touches no money. */
  async advance(
    userId: string,
    requestId: string,
    to: SmartFixRequestStatus,
    extra: Record<string, unknown> = {},
  ): Promise<boolean> {
    return this.tenant.withUser(userId, async (tx) => {
      const row = await this.lock(tx, requestId);
      if (row === null) return false;
      if (row.status === to) return true;
      if (!canTransitionSmartFixRequest(row.status, to)) return false;

      const now = this.clock.now();
      const stamp: Record<string, unknown> =
        to === SmartFixRequestStatus.RECHECKING
          ? { recheckingAt: now }
          : to === SmartFixRequestStatus.VALIDATING
            ? { validatingAt: now }
            : {};
      await tx.smartFixRequest.update({
        where: { id: requestId },
        data: { status: to, ...stamp, ...extra },
      });
      return true;
    });
  }

  /**
   * End a correction without delivering it, and give the reservation back.
   *
   * One transaction: release, record, hide. The corrected version — if one was
   * ever produced — stays invisible, because the user did not buy a document
   * that failed its own recheck.
   */
  async settle(
    userId: string,
    requestId: string,
    input: SettleInput,
  ): Promise<{ settled: boolean }> {
    const outcome = await this.tenant.withUser(userId, async (tx) => {
      const row = await this.lock(tx, requestId);
      if (row === null) {
        throw new AppError(PalCertErrorCode.NOT_FOUND, {
          message: 'That correction could not be found.',
        });
      }
      if (row.status === input.status) return { settled: false };
      if (!input.allowedFrom.includes(row.status)) {
        if (input.notCancellableMessage !== undefined) {
          throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
            message: input.notCancellableMessage,
            details: { status: row.status },
          });
        }
        // Already terminal, or past the point of no return. An at-least-once
        // worker landing here twice is normal and must change nothing.
        return { settled: false };
      }

      await this.purchases.release(
        tx,
        row.servicePurchaseId,
        input.status === SmartFixRequestStatus.CANCELLED
          ? PurchaseFailureCode.CANCELLED_BY_CUSTOMER
          : PurchaseFailureCode.SERVICE_FAILED,
      );

      const now = this.clock.now();
      await tx.smartFixRequest.update({
        where: { id: requestId },
        data: {
          status: input.status,
          failureCode: input.code,
          failureDetail: input.detail.slice(0, 500),
          ...(input.status === SmartFixRequestStatus.CANCELLED
            ? { cancelledAt: now }
            : { failedAt: now }),
        },
      });
      return { settled: true };
    });

    if (outcome.settled) {
      this.logger.info(
        { requestId, failureCode: input.code },
        'SmartFix correction settled without delivery; reservation released',
      );
    }
    return outcome;
  }

  /**
   * Charge for a delivered correction, inside the transaction that delivers it.
   *
   * Deliberately takes the caller's `tx`: the corrected version becoming
   * visible, the request becoming DELIVERED and the reservation becoming a
   * charge are **one** commit. There is no ordering of two commits that is
   * safe, so there is only one (§79).
   */
  async captureOnDelivery(tx: TenantClient, requestId: string): Promise<{ charged: boolean }> {
    const row = await tx.smartFixRequest.findUnique({
      where: { id: requestId },
      select: { servicePurchaseId: true },
    });
    if (row === null) return { charged: false };
    const captured = await this.purchases.captureOnDelivery(tx, row.servicePurchaseId);
    return { charged: captured.charged };
  }

  /**
   * Refuse to deliver a correction that is no longer deliverable.
   *
   * Called at the top of the delivery transaction, after the row lock: a
   * correction cancelled while the worker was validating must not become
   * DELIVERED afterwards.
   */
  async assertDeliverable(tx: TenantClient, requestId: string): Promise<void> {
    const row = await this.lock(tx, requestId);
    if (row === null) {
      throw new AppError(PalCertErrorCode.NOT_FOUND, {
        message: 'That correction could not be found.',
      });
    }
    if (row.status !== SmartFixRequestStatus.VALIDATING) {
      throw new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
        message: 'This correction is no longer being delivered.',
        details: { status: row.status },
        internalContext: { reason: 'delivery raced a terminal state and lost' },
      });
    }
  }
}
