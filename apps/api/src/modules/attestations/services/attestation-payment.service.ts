import { Injectable } from '@nestjs/common';
import {
  AttestationActorSide,
  AttestationPaymentStatus,
  AttestationRequestEventType,
  AttestationRequestStatus,
  CreditClass,
  CreditHoldPurpose,
  LedgerReasonCode,
  LedgerReferenceType,
  money,
  type MoneyView,
} from '@palcert/contracts';
import type { AttestationRequest } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { CreditHoldService } from '../../finance/services/credit-hold.service';
import { CreditLedgerService } from '../../finance/services/credit-ledger.service';
import { SYSTEM_ACTOR } from '../attestation-support';

/**
 * The money an attestation moves, and nothing else (§19–§21, §41–§43).
 *
 * Built on the Phase 10 primitives rather than beside them. The fee is
 * reserved with a `CreditHold` under the same row lock that serializes every
 * other spend of the account, captured with the same idempotent capture, and
 * released with the same idempotent release. There is no second wallet and no
 * balance column: the ledger remains the only definition of a balance.
 *
 * What is new is only where a captured fee *goes*. The customer's side is the
 * existing ledger debit; the other side is an `attestation_settlements` header
 * and exactly two revenue entries — the institution's share and PalCert's
 * commission — which the database refuses to commit unless they sum to the
 * captured amount and match the price the user submitted under.
 *
 * Policy, stated once:
 *   - fees are paid from the CASH balance only. Promotional credit is PalCert's
 *     own marketing money, and passing it on to an institution as revenue would
 *     make PalCert owe real money for a coupon;
 *   - rejection and pre-review cancellation release the hold in full;
 *   - approval captures and settles;
 *   - revocation refunds nothing automatically.
 */
@Injectable()
export class AttestationPaymentService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly holds: CreditHoldService,
    private readonly ledger: CreditLedgerService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AttestationPaymentService.name);
  }

  /**
   * What the owner may spend on an attestation right now, in one currency.
   *
   * CASH only, for the reason above. A negative position (after a chargeback)
   * is shown as it is.
   */
  async availableCash(tx: TenantClient, ownerUserId: string, currency: string): Promise<MoneyView> {
    const positions = await this.ledger.positions(tx, ownerUserId);
    const cash = positions.find(
      (position) => position.currency === currency && position.creditClass === CreditClass.CASH,
    );
    return money(currency, cash?.availableMinor ?? 0n);
  }

  /**
   * Reserve a submitted request's fee inside the owner's submit transaction.
   *
   * The hold's own row lock is what makes two concurrent submissions against
   * one balance queue rather than both succeed. The idempotency key is the
   * request, so a retried submit finds the hold it already made.
   */
  async reserve(
    tx: TenantClient,
    request: Pick<AttestationRequest, 'id' | 'ownerUserId'>,
    fee: { readonly currency: string; readonly grossMinor: bigint },
  ): Promise<{ holdId: string } | null> {
    if (fee.grossMinor === 0n) return null;
    const hold = await this.holds.create(tx, {
      ownerUserId: request.ownerUserId,
      currency: fee.currency,
      creditClass: CreditClass.CASH,
      amountMinor: fee.grossMinor,
      purpose: CreditHoldPurpose.SERVICE,
      referenceType: LedgerReferenceType.ATTESTATION_REQUEST,
      referenceId: request.id,
      idempotencyKey: `attestation:${request.id}:reserve`,
      // An institution's review takes as long as it takes. The hold ends when
      // the request is decided, never on a timer that could strand an approval
      // with nothing to capture.
      expiresInSeconds: null,
    });
    return { holdId: hold.id };
  }

  /** Release inside the owner's own cancellation transaction. Idempotent. */
  async releaseForOwner(tx: TenantClient, holdId: string): Promise<void> {
    await this.holds.release(tx, holdId);
  }

  /**
   * Move the money a decision implies. Run by the ATTESTATION_PAYMENT job.
   *
   * PalCert's own work: it touches the owner's ledger and the institution's
   * revenue, which belong to different parties, so it runs under the audited
   * platform elevation rather than borrowing either party's identity.
   *
   * Idempotent end to end. A settled or released request is a no-op; the
   * capture is keyed on the hold; the settlement is unique per request. A
   * retry after a crash therefore completes the work rather than repeating it.
   */
  async settle(requestId: string): Promise<'SETTLED' | 'RELEASED' | 'NOTHING_TO_DO'> {
    return this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'settle or release an attestation fee' },
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "attestation_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
        const request = await tx.attestationRequest.findUnique({ where: { id: requestId } });
        if (request === null) return 'NOTHING_TO_DO' as const;
        if (
          request.paymentStatus !== AttestationPaymentStatus.RESERVED ||
          request.holdId === null
        ) {
          return 'NOTHING_TO_DO' as const;
        }

        const now = this.clock.now();
        if (request.status === AttestationRequestStatus.APPROVED) {
          return this.captureAndSplit(tx, request, request.holdId, now);
        }
        if (
          request.status === AttestationRequestStatus.REJECTED ||
          request.status === AttestationRequestStatus.CANCELLED
        ) {
          return this.release(tx, request, request.holdId, now);
        }
        // Undecided: nothing to move yet. The job was enqueued by a decision,
        // so this is only reachable by a replay from an operator.
        return 'NOTHING_TO_DO' as const;
      },
    );
  }

  private async captureAndSplit(
    tx: TenantClient,
    request: AttestationRequest,
    holdId: string,
    now: Date,
  ): Promise<'SETTLED'> {
    const captured = await this.holds.capture(tx, holdId, {
      reasonCode: LedgerReasonCode.ATTESTATION_FEE,
    });
    const currency = request.currency!;
    const settlement = await tx.attestationSettlement.create({
      data: {
        requestId: request.id,
        ownerUserId: request.ownerUserId,
        organizationId: request.organizationId,
        currency,
        grossMinor: request.grossFeeMinor!,
        platformCommissionBps: request.platformCommissionBps!,
        platformFeeMinor: request.platformFeeMinor!,
        institutionNetMinor: request.institutionNetMinor!,
        holdId,
        captureEntryId: captured.entryId,
        settledAt: now,
      },
    });
    await tx.attestationRevenueEntry.createMany({
      data: [
        {
          settlementId: settlement.id,
          requestId: request.id,
          ownerUserId: request.ownerUserId,
          organizationId: request.organizationId,
          account: 'INSTITUTION',
          currency,
          amountMinor: request.institutionNetMinor!,
        },
        {
          settlementId: settlement.id,
          requestId: request.id,
          ownerUserId: request.ownerUserId,
          organizationId: request.organizationId,
          account: 'PLATFORM_COMMISSION',
          currency,
          amountMinor: request.platformFeeMinor!,
        },
      ],
    });
    await tx.attestationRequest.update({
      where: { id: request.id },
      data: {
        paymentStatus: AttestationPaymentStatus.SETTLED,
        captureEntryId: captured.entryId,
        paymentSettledAt: now,
      },
    });
    await tx.attestationRequestEvent.create({
      data: {
        requestId: request.id,
        ownerUserId: request.ownerUserId,
        organizationId: request.organizationId,
        eventType: AttestationRequestEventType.PAYMENT_SETTLED,
        actorSide: AttestationActorSide.SYSTEM,
        actorUserId: null,
        createdAt: now,
      },
    });
    await this.events.auditWithin(tx, {
      action: 'ATTESTATION_PAYMENT_SETTLED',
      actor: { type: 'SYSTEM' },
      targetType: 'AttestationRequest',
      targetId: request.id,
      afterState: {
        organizationId: request.organizationId,
        currency,
        grossMinorUnits: request.grossFeeMinor!.toString(),
        platformFeeMinorUnits: request.platformFeeMinor!.toString(),
        institutionNetMinorUnits: request.institutionNetMinor!.toString(),
        platformCommissionBps: request.platformCommissionBps,
        ledgerEntryId: captured.entryId,
      },
    });
    this.logger.info({ requestId: request.id }, 'Attestation fee settled');
    return 'SETTLED';
  }

  private async release(
    tx: TenantClient,
    request: AttestationRequest,
    holdId: string,
    now: Date,
  ): Promise<'RELEASED'> {
    await this.holds.release(tx, holdId);
    await tx.attestationRequest.update({
      where: { id: request.id },
      data: { paymentStatus: AttestationPaymentStatus.RELEASED, paymentReleasedAt: now },
    });
    await tx.attestationRequestEvent.create({
      data: {
        requestId: request.id,
        ownerUserId: request.ownerUserId,
        organizationId: request.organizationId,
        eventType: AttestationRequestEventType.PAYMENT_RELEASED,
        actorSide: AttestationActorSide.SYSTEM,
        actorUserId: null,
        createdAt: now,
      },
    });
    await this.events.auditWithin(tx, {
      action: 'ATTESTATION_PAYMENT_RELEASED',
      actor: { type: 'SYSTEM' },
      targetType: 'AttestationRequest',
      targetId: request.id,
      afterState: {
        organizationId: request.organizationId,
        currency: request.currency,
        releasedMinorUnits: request.grossFeeMinor?.toString() ?? '0',
        reason: request.status,
      },
    });
    this.logger.info({ requestId: request.id }, 'Attestation fee released');
    return 'RELEASED';
  }
}
