import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AIOperation,
  AppError,
  PalCertErrorCode,
  PurchaseFailureCode,
  SMARTFIX_PLAN_TTL_MINUTES,
} from '@palcert/contracts';
import type { SmartFixPlanningReservation } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { AIServiceBillingService } from '../../finance/services/ai-service-billing.service';

/** One reserved SMARTFIX purchase, from AI planning through approved delivery. */
@Injectable()
export class SmartFixPlanningBillingService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly billing: AIServiceBillingService,
    private readonly clock: ClockPort,
    private readonly config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SmartFixPlanningBillingService.name);
  }

  onModuleInit(): void {
    this.timer = setInterval(
      () =>
        void this.sweep().catch((err: unknown) => {
          this.logger.error({ err }, 'Could not release expired AI planning reservations');
        }),
      this.config.upload.sweepIntervalMs,
    );
    this.timer.unref?.();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async reserve(
    userId: string,
    checkId: string,
    priceQuoteId: string,
  ): Promise<{
    reservation: SmartFixPlanningReservation;
    reused: boolean;
  }> {
    const result = await this.tenant.withUser(userId, async (tx) => {
      // Quotes are immutable: the application deliberately has no UPDATE grant.
      // Serialize this owner's retries even before a reservation row exists;
      // release the lock with the transaction. Billing still validates quote
      // ownership, expiry and single use under the existing RLS/unique guards.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`smartfix-planning:${userId}:${priceQuoteId}`}, 0))::text`;
      const prior = await tx.smartFixPlanningReservation.findFirst({
        where: { ownerUserId: userId, servicePurchase: { priceQuoteId } },
      });
      if (prior) {
        if (prior.checkId !== checkId)
          throw this.unavailable('This quote belongs to another correction.');
        if (prior.planId !== null) return { reservation: prior, reused: true };
        throw this.unavailable(
          prior.status === 'PLANNING'
            ? 'This AI plan is still running. Retry the same request to recover its result.'
            : 'This AI plan ended. Request a new price quote to try again.',
          { reservationId: prior.id },
        );
      }
      const now = this.clock.now();
      const id = randomUUID();
      const purchaseId = randomUUID();
      await this.billing.reserve(tx, {
        payerUserId: userId,
        operation: AIOperation.SMARTFIX_FORMATTING,
        resourceId: id,
        purchaseId,
        priceQuoteId,
      });
      const reservation = await tx.smartFixPlanningReservation.create({
        data: {
          id,
          ownerUserId: userId,
          checkId,
          servicePurchaseId: purchaseId,
          status: 'PLANNING',
          createdAt: now,
          expiresAt: new Date(now.getTime() + this.approvalWindowSeconds() * 1000),
        },
      });
      return { reservation, reused: false };
    });
    if (!result.reused)
      await this.billing.audit({
        action: 'AI_SERVICE_RESERVED',
        operation: AIOperation.SMARTFIX_FORMATTING,
        purchaseId: result.reservation.servicePurchaseId,
        resourceId: result.reservation.id,
        payerUserId: userId,
        actorUserId: userId,
      });
    return result;
  }

  /**
   * How long the plan may be approved for.
   *
   * The credit hold was placed at planning time and expires
   * `aiReservationTtlSeconds` later; it is not renewed at approval. A plan
   * approved at the last moment of its window still has to run, recheck and
   * capture against that same hold, so the window keeps at least half of the
   * hold's lifetime for that. With the default 2-hour hold this is the full
   * 60-minute plan lifetime; a shorter configured hold shortens the window
   * instead of letting a verified correction miss its own capture.
   */
  private approvalWindowSeconds(): number {
    return Math.min(
      SMARTFIX_PLAN_TTL_MINUTES * 60,
      Math.floor(this.config.payments.aiReservationTtlSeconds / 2),
    );
  }

  private async locked(
    tx: TenantClient,
    userId: string,
    id: string,
  ): Promise<SmartFixPlanningReservation> {
    await tx.$queryRaw`SELECT id FROM smartfix_planning_reservations WHERE id = ${id}::uuid AND owner_user_id = ${userId}::uuid FOR UPDATE`;
    const row = await tx.smartFixPlanningReservation.findFirst({
      where: { id, ownerUserId: userId },
    });
    if (!row)
      throw new AppError(PalCertErrorCode.NOT_FOUND, {
        message: 'That AI planning reservation was not found.',
      });
    return row;
  }

  async assertReservationLive(userId: string, id: string): Promise<void> {
    await this.tenant.withUser(userId, async (tx) => {
      const row = await this.locked(tx, userId, id);
      if (row.status !== 'PLANNING' || row.expiresAt <= this.clock.now()) {
        throw this.unavailable('This AI planning reservation is no longer active.');
      }
      await this.billing.assertReservationLive(tx, row.servicePurchaseId);
      await this.billing.markProcessing(tx, row.servicePurchaseId);
    });
  }

  async finish(tx: TenantClient, userId: string, id: string, usable: boolean): Promise<void> {
    const row = await this.locked(tx, userId, id);
    if (row.status !== 'PLANNING' || row.expiresAt <= this.clock.now()) {
      throw this.unavailable('This AI planning reservation is no longer active.');
    }
    await this.billing.assertReservationLive(tx, row.servicePurchaseId);
    if (!usable)
      await this.billing.release(tx, row.servicePurchaseId, PurchaseFailureCode.SERVICE_FAILED);
    await tx.smartFixPlanningReservation.update({
      where: { id },
      data: {
        planId: id,
        status: usable ? 'READY' : 'FAILED',
      },
    });
  }

  /** Called under the same lock/transaction as request creation and enqueue. */
  async forApproval(
    tx: TenantClient,
    userId: string,
    planId: string,
    quoteId: string,
  ): Promise<SmartFixPlanningReservation> {
    const row = await this.locked(tx, userId, planId);
    const purchase = await tx.servicePurchase.findFirst({
      where: {
        id: row.servicePurchaseId,
        ownerUserId: userId,
        priceQuoteId: quoteId,
        productCode: 'SMARTFIX',
        resourceType: 'SMARTFIX',
        resourceId: row.id,
      },
    });
    if (
      !purchase ||
      row.status !== 'READY' ||
      row.planId !== planId ||
      row.expiresAt <= this.clock.now()
    ) {
      throw this.unavailable('This correction no longer has an active planning reservation.');
    }
    await this.billing.assertReservationLive(tx, row.servicePurchaseId);
    return row;
  }

  async release(userId: string, id: string, cancelled = false, expired = false): Promise<void> {
    const released = await this.tenant.withUser(userId, async (tx) => {
      const row = await this.locked(tx, userId, id);
      if (row.status === 'FAILED' || row.status === 'CANCELLED') return;
      if (row.status === 'CONSUMED') {
        if (!cancelled) return;
        throw this.unavailable('This plan was approved. Cancel the correction request instead.');
      }
      // Recheck after locking: a selected PLANNING row may now be READY.
      const now = this.clock.now();
      if (
        expired &&
        row.expiresAt > now &&
        !(row.status === 'PLANNING' && row.createdAt.getTime() <= now.getTime() - 120_000)
      )
        return;
      await this.billing.release(
        tx,
        row.servicePurchaseId,
        expired
          ? PurchaseFailureCode.RESERVATION_EXPIRED
          : cancelled
            ? PurchaseFailureCode.CANCELLED_BY_CUSTOMER
            : PurchaseFailureCode.SERVICE_FAILED,
      );
      await tx.smartFixPlanningReservation.update({
        where: { id },
        data: { status: cancelled ? 'CANCELLED' : 'FAILED' },
      });
      return row;
    });
    if (released)
      await this.auditRelease(
        userId,
        id,
        released.servicePurchaseId,
        expired
          ? PurchaseFailureCode.RESERVATION_EXPIRED
          : cancelled
            ? PurchaseFailureCode.CANCELLED_BY_CUSTOMER
            : PurchaseFailureCode.SERVICE_FAILED,
        cancelled ? userId : null,
      );
  }

  /**
   * The release audit for a plan `finish` judged unusable. `finish` releases
   * inside the plan's transaction, so its caller records this after commit,
   * giving every reserved AI service a matching release row like the other
   * release paths.
   */
  async recordPlanningRelease(
    userId: string,
    reservation: Pick<SmartFixPlanningReservation, 'id' | 'servicePurchaseId'>,
  ): Promise<void> {
    await this.auditRelease(
      userId,
      reservation.id,
      reservation.servicePurchaseId,
      PurchaseFailureCode.SERVICE_FAILED,
      null,
    );
  }

  private async auditRelease(
    userId: string,
    id: string,
    purchaseId: string,
    failureCode: PurchaseFailureCode,
    actorUserId: string | null,
  ): Promise<void> {
    await this.billing.audit({
      action: 'AI_SERVICE_RELEASED',
      operation: AIOperation.SMARTFIX_FORMATTING,
      purchaseId,
      resourceId: id,
      payerUserId: userId,
      actorUserId,
      failureCode,
    });
  }

  async sweep(): Promise<number> {
    const now = this.clock.now();
    const due = await this.tenant.withPlatformAdmin(
      {
        actorUserId: '00000000-0000-0000-0000-000000000000',
        reason: 'release abandoned or expired AI formatting reservations',
      },
      (tx) =>
        tx.smartFixPlanningReservation.findMany({
          where: {
            status: { in: ['PLANNING', 'READY'] },
            OR: [
              { expiresAt: { lte: now } },
              // The planner has a hard 90-second deadline. Recover a crashed API too.
              { status: 'PLANNING', createdAt: { lte: new Date(now.getTime() - 120_000) } },
            ],
          },
          select: { id: true, ownerUserId: true },
          take: 100,
        }),
    );
    for (const row of due) await this.release(row.ownerUserId, row.id, false, true);
    return due.length;
  }

  private unavailable(message: string, details?: Record<string, string>): AppError {
    return new AppError(PalCertErrorCode.SMARTFIX_NOT_AVAILABLE, {
      message,
      ...(details ? { details } : {}),
    });
  }
}
