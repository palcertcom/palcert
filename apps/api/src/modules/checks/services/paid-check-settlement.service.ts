import { Injectable } from '@nestjs/common';
import {
  AppError,
  CheckStatus,
  PalCertErrorCode,
  PurchaseFailureCode,
  ServiceResourceType,
  isCheckSettled,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { ServicePurchaseService } from '../../finance/services/service-purchase.service';
import { SYSTEM_ACTOR } from '../../finance/services/top-up.service';

/**
 * The one place a paid check's money is settled (§79, §80).
 *
 * Three outcomes, one service. A check is delivered and charged, or it fails
 * and the reservation is given back, or the customer cancels it and the
 * reservation is given back. Scattering those across the evaluation worker,
 * the analysis worker and a controller is how a product ends up charging for a
 * cancelled check exactly once, in production, six months later.
 *
 * Every path takes the same locks in the same order (§81):
 *
 *   `document_checks` → `service_purchases` → `credit_holds` → accounts
 *
 * The check row is locked first and its status re-read *inside* the
 * transaction, which is what makes completion, failure and cancellation
 * mutually exclusive. Whichever transaction takes the lock first decides; the
 * others see a terminal state and stop. That is the whole of the race
 * strategy, and it is why there is no state in which a check is CANCELLED and
 * charged, or COMPLETED and released (§45, §85).
 */
@Injectable()
export class PaidCheckSettlementService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly purchases: ServicePurchaseService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PaidCheckSettlementService.name);
  }

  /**
   * Take the check's row lock and return its current state.
   *
   * Everything that settles money calls this first, so "what is this check
   * now?" is answered by a row nobody else can change until the transaction
   * ends.
   */
  private async lockCheck(
    tx: TenantClient,
    checkId: string,
  ): Promise<{ id: string; status: CheckStatus; servicePurchaseId: string | null } | null> {
    await tx.$queryRaw`SELECT "id" FROM "document_checks" WHERE "id" = ${checkId}::uuid FOR UPDATE`;
    const check = await tx.documentCheck.findUnique({
      where: { id: checkId },
      select: { id: true, status: true, servicePurchaseId: true },
    });
    return check === null
      ? null
      : {
          id: check.id,
          status: check.status as CheckStatus,
          servicePurchaseId: check.servicePurchaseId,
        };
  }

  /** The work has begun. Nothing is charged; the purchase just stops saying "reserved". */
  async markProcessing(userId: string, checkId: string): Promise<void> {
    await this.tenant.withUser(userId, async (tx) => {
      const check = await this.lockCheck(tx, checkId);
      if (check === null || check.servicePurchaseId === null) return;
      await this.purchases.markProcessing(tx, check.servicePurchaseId);
    });
  }

  /**
   * Charge for a delivered check, inside the transaction that delivers it (§32).
   *
   * Deliberately takes the caller's `tx`: the results, the violations, the
   * report row, the run, the capture and the completion are **one** commit.
   * There is no ordering of two commits that is safe, so there is only one.
   *
   * The caller must already hold the check's row lock — `assertDeliverable`
   * takes it — so a cancellation cannot slip in between.
   */
  async captureOnDelivery(tx: TenantClient, checkId: string): Promise<{ charged: boolean }> {
    const check = await tx.documentCheck.findUnique({
      where: { id: checkId },
      select: { servicePurchaseId: true },
    });
    // A historical free check has nothing to charge and is completed exactly
    // as it always was (§4, §49).
    if (check === null || check.servicePurchaseId === null) return { charged: false };

    const captured = await this.purchases.captureOnDelivery(tx, check.servicePurchaseId);
    return { charged: captured.charged };
  }

  /**
   * Refuse to deliver a check that is no longer deliverable.
   *
   * Called at the top of the completion transaction, after the row lock. A
   * check that was cancelled or failed while the worker was building its
   * report must not become COMPLETED afterwards (§46, §85).
   */
  async assertDeliverable(tx: TenantClient, checkId: string): Promise<void> {
    const check = await this.lockCheck(tx, checkId);
    if (check === null) {
      throw new AppError(PalCertErrorCode.CHECK_NOT_FOUND, { message: 'No such check.' });
    }
    // Settled, not merely terminal. A FAILED check has already given its
    // reservation back, so delivering it would capture money that was
    // released — and FAILED is deliberately not terminal, because the retry
    // workflow moves it back to WAITING_ANALYSIS. A retried check is
    // EVALUATING by the time it reaches here, so nothing legitimate is lost.
    if (isCheckSettled(check.status)) {
      throw new AppError(PalCertErrorCode.CHECK_NOT_CANCELLABLE, {
        message: 'This check has already finished.',
        details: { status: check.status },
        internalContext: { reason: 'settlement raced a terminal state and lost' },
      });
    }
  }

  /**
   * Fail a check and give its reservation back (§37, §38, §39, §40).
   *
   * Atomic and idempotent: a repeated failure settlement finds a terminal
   * check and does nothing, so an at-least-once worker cannot release twice
   * (§83). Release, never refund — nothing was charged, and calling it a
   * refund would be a lie to the customer (§41, §60).
   */
  async fail(
    userId: string,
    checkId: string,
    failure: { code: string; detail: string },
  ): Promise<{ settled: boolean }> {
    const now = this.clock.now();

    const outcome = await this.tenant.withUser(userId, async (tx) => {
      const check = await this.lockCheck(tx, checkId);
      if (check === null) return { settled: false, released: false };
      // Already settled, by this path or by cancellation. Either way it is
      // not billable and there is nothing left to do (§84).
      //
      // `isCheckSettled`, because FAILED is the state this method produces:
      // asking `isCheckTerminal` here let an at-least-once redelivery fail an
      // already-failed check and release its reservation a second time, which
      // is exactly what this guard exists to prevent.
      if (isCheckSettled(check.status)) return { settled: false, released: false };

      await tx.documentCheck.update({
        where: { id: checkId },
        data: {
          status: CheckStatus.FAILED,
          failureCode: failure.code,
          failureDetail: failure.detail.slice(0, 500),
          failedAt: now,
        },
      });

      if (check.servicePurchaseId === null) return { settled: true, released: false };
      const released = await this.purchases.release(
        tx,
        check.servicePurchaseId,
        PurchaseFailureCode.SERVICE_FAILED,
      );
      return { settled: true, released: released.released };
    });

    if (outcome.settled) {
      await this.events.audit({
        action: 'CHECK_FAILED',
        actorUserId: null,
        targetType: 'DocumentCheck',
        targetId: checkId,
        afterState: { failureCode: failure.code },
      });
    }
    if (outcome.released) {
      await this.events.audit({
        action: 'CHECK_PURCHASE_RELEASED',
        actorUserId: null,
        targetType: 'DocumentCheck',
        targetId: checkId,
        afterState: { reason: PurchaseFailureCode.SERVICE_FAILED },
      });
    }
    return { settled: outcome.settled };
  }

  /**
   * Stop a check the customer no longer wants (§43, §44).
   *
   * Allowed right up until the service is delivered, and never after: a report
   * that exists has been paid for, and "cancelling" it would mean handing over
   * the work for nothing.
   */
  async cancel(
    userId: string,
    checkId: string,
    request: { requestId: string | null; ipAddress: string | null },
  ): Promise<void> {
    const outcome = await this.tenant.withUser(userId, async (tx) => {
      const check = await this.lockCheck(tx, checkId);
      if (check === null) {
        throw new AppError(PalCertErrorCode.CHECK_NOT_FOUND, { message: 'No such check.' });
      }
      if (check.status === CheckStatus.COMPLETED) {
        throw new AppError(PalCertErrorCode.SERVICE_ALREADY_DELIVERED, {
          message: 'This check has already produced a report, so it cannot be cancelled.',
        });
      }
      // Already stopped, by cancellation or by failure. Saying so twice is not
      // an error, and re-releasing would be.
      //
      // The comment was right and the predicate was wrong. `isCheckTerminal`
      // deliberately excludes FAILED so the retry workflow can move a failed
      // check back to WAITING_ANALYSIS — but a failed check has nothing in
      // flight and has already released its reservation, so cancelling one
      // fell through to a second release and answered 500. Settlement asks
      // whether the money is finished with, which is `isCheckSettled`; the
      // Check domain's own retry rules are untouched.
      if (isCheckSettled(check.status)) return { cancelled: false, released: false };

      await tx.documentCheck.update({
        where: { id: checkId },
        data: { status: CheckStatus.CANCELLED, completedAt: null, failedAt: this.clock.now() },
      });

      if (check.servicePurchaseId === null) return { cancelled: true, released: false };
      const released = await this.purchases.release(
        tx,
        check.servicePurchaseId,
        PurchaseFailureCode.CANCELLED_BY_CUSTOMER,
      );
      return { cancelled: true, released: released.released };
    });

    if (!outcome.cancelled) return;

    await this.events.audit({
      action: 'CHECK_CANCELLED',
      actorUserId: userId,
      targetType: 'DocumentCheck',
      targetId: checkId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
    });
    if (outcome.released) {
      await this.events.audit({
        action: 'CHECK_PURCHASE_RELEASED',
        actorUserId: userId,
        targetType: 'DocumentCheck',
        targetId: checkId,
        afterState: { reason: PurchaseFailureCode.CANCELLED_BY_CUSTOMER },
      });
    }
  }

  /**
   * Give back a reservation that timed out while the work was still running
   * (§26, §28, §116).
   *
   * The sweeper expires the holds; this converges the rest of the state so a
   * delayed worker cannot later deliver a report nobody paid for. The check
   * fails, because it genuinely did not finish in time.
   */
  async settleExpiredReservations(limit = 100): Promise<number> {
    const stale = await this.tenant.withPlatformAdmin<
      { id: string; ownerUserId: string; resourceId: string }[]
    >(
      {
        actorUserId: SYSTEM_ACTOR,
        reason: 'settling service reservations that expired mid-processing',
      },
      (tx) =>
        tx.servicePurchase.findMany({
          where: {
            status: { in: ['RESERVED', 'PROCESSING'] },
            resourceType: ServiceResourceType.DOCUMENT_CHECK,
            allocations: { some: { hold: { status: { in: ['EXPIRED', 'RELEASED'] } } } },
          },
          select: { id: true, ownerUserId: true, resourceId: true },
          take: limit,
        }),
    );

    let settled = 0;
    for (const purchase of stale) {
      await this.fail(purchase.ownerUserId, purchase.resourceId, {
        code: 'SERVICE_RESERVATION_EXPIRED',
        detail: 'the reservation expired before the check could be completed',
      });
      settled += 1;
    }
    if (settled > 0) {
      this.logger.warn({ settled }, 'Settled paid checks whose reservation expired');
    }
    return settled;
  }
}
