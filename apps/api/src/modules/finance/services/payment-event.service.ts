import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  PaymentEventKind,
  PaymentObjectKind,
  PaymentProviderError,
  PaymentProviderPort,
  PaymentRefundStatus,
  ProviderEventStatus,
  TopUpStatus,
  isTopUpOpen,
  type VerifiedPaymentEvent,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { PaymentRefundService } from './payment-refund.service';
import { SYSTEM_ACTOR, TopUpService } from './top-up.service';

/**
 * Provider events: receiving them, deduplicating them and acting on them
 * (§47–§54, §60, §61, §112, §123, §124, §125).
 *
 * Three assumptions shape this file, and all three are true of every payment
 * provider rather than peculiar to one:
 *
 *   - **At-least-once.** The same event will arrive again. Ten deliveries must
 *     have one financial effect (§124).
 *   - **Unordered.** A "failed" may arrive after a "succeeded" for the same
 *     payment. Later is not newer (§53, §125).
 *   - **Incomplete.** Some events never arrive at all, which is what
 *     reconciliation exists for (§60).
 *
 * So the webhook endpoint does the least it safely can — verify, record,
 * acknowledge — and the financial work happens afterwards through the existing
 * outbox, against current provider state rather than against the event's claim.
 */
@Injectable()
export class PaymentEventService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
    private readonly provider: PaymentProviderPort,
    private readonly topUps: TopUpService,
    private readonly refunds: PaymentRefundService,
    private readonly jobs: ProcessingJobService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PaymentEventService.name);
  }

  /**
   * Handle one inbound webhook.
   *
   * Verify the signature against the raw bytes, write a durable receipt,
   * enqueue the work, return. Nothing financial happens inside the provider's
   * HTTP request (§54, §122) — a provider that times out waiting for PalCert
   * to do accounting will retry, and retries are exactly what we are trying
   * not to need.
   */
  async ingest(params: {
    readonly rawBody: Buffer;
    readonly signatureHeader: string | undefined;
  }): Promise<{ accepted: boolean; duplicate: boolean }> {
    let event: VerifiedPaymentEvent;
    try {
      event = this.provider.verifyAndParseWebhook(params);
    } catch (error) {
      // A bad signature has no financial effect and never will (§49). The
      // message deliberately echoes nothing back.
      this.logger.warn(
        { providerFailureKind: error instanceof PaymentProviderError ? error.kind : 'UNKNOWN' },
        'Rejected a webhook with an invalid signature',
      );
      throw new AppError(PalCertErrorCode.WEBHOOK_SIGNATURE_INVALID, {
        message: 'The request signature could not be verified.',
      });
    }

    const provider = this.provider.getCapabilities().provider;
    // The digest proves what arrived without keeping what arrived (§81).
    const payloadSha256 = createHash('sha256').update(params.rawBody).digest('hex');

    // `provider + providerEventId` is unique, so a redelivery is caught here
    // before anything else happens (§51).
    const existing = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'record a verified payment-provider event' },
      (tx) =>
        tx.paymentProviderEvent.findUnique({
          where: {
            provider_providerEventId: { provider, providerEventId: event.providerEventId },
          },
          select: { id: true },
        }),
    );
    if (existing !== null) {
      return { accepted: true, duplicate: true };
    }

    try {
      await this.tenant.withPlatformAdmin(
        { actorUserId: SYSTEM_ACTOR, reason: 'record a verified payment-provider event' },
        async (tx) => {
          const receipt = await tx.paymentProviderEvent.create({
            data: {
              provider,
              providerEventId: event.providerEventId,
              providerEventType: event.providerEventType,
              eventKind: event.kind,
              objectKind: event.objectKind,
              providerObjectId: event.providerObjectId,
              relatedPaymentId: event.relatedPaymentId,
              currency: event.currency,
              amountMinor: event.amountMinor,
              payloadSha256,
              processingStatus:
                event.kind === PaymentEventKind.UNSUPPORTED
                  ? ProviderEventStatus.IGNORED
                  : ProviderEventStatus.RECEIVED,
              occurredAt: event.occurredAt,
              ...(event.kind === PaymentEventKind.UNSUPPORTED
                ? { processedAt: this.clock.now() }
                : {}),
            },
          });

          // An event PalCert has no use for is acknowledged and dropped. A
          // provider adding a new event type must never break the endpoint (§123).
          if (event.kind === PaymentEventKind.UNSUPPORTED) return;

          // No owner: a payment event is PalCert's work, not a customer's.
          await this.jobs.enqueueInTransaction(tx, {
            type: 'PAYMENT_EVENT',
            resourceType: 'PAYMENT_PROVIDER_EVENT',
            resourceId: receipt.id,
          });
        },
      );
    } catch (error) {
      // Two deliveries arriving at once: one wins the unique index, the other
      // lands here, and both are "accepted" as far as the provider is
      // concerned.
      //
      // Narrowed to exactly that: treating *any* failure as a duplicate would
      // acknowledge an event PalCert never recorded, the provider would stop
      // retrying, and a payment would silently never be credited. Anything
      // else is re-thrown so the provider retries and an operator sees it.
      if (isUniqueViolation(error)) return { accepted: true, duplicate: true };
      this.logger.error({ err: error }, 'Could not record a verified provider event');
      throw error;
    }

    return { accepted: true, duplicate: false };
  }

  /**
   * Act on one recorded event.
   *
   * Runs in the worker. Crucially it does **not** trust the event's own claim
   * about the payment: for anything that credits money it asks the provider
   * what is true now. That is what makes out-of-order delivery harmless — a
   * stale "failed" event triggers a fresh lookup that reports "paid", and the
   * credit stands (§53, §125).
   */
  async process(eventId: string): Promise<void> {
    const event = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'act on a recorded payment-provider event' },
      (tx) => tx.paymentProviderEvent.findUnique({ where: { id: eventId } }),
    );
    if (event === null) return;
    if (event.processingStatus === ProviderEventStatus.PROCESSED) return;

    try {
      switch (event.eventKind) {
        case PaymentEventKind.PAYMENT_SUCCEEDED:
        case PaymentEventKind.PAYMENT_FAILED:
        case PaymentEventKind.PAYMENT_CANCELLED:
        case PaymentEventKind.PAYMENT_EXPIRED:
          await this.settleTopUpFor(event.providerObjectId);
          break;

        case PaymentEventKind.REFUND_SUCCEEDED:
        case PaymentEventKind.REFUND_FAILED:
          await this.settleRefundFor(event);
          break;

        case PaymentEventKind.PAYMENT_DISPUTED:
          await this.openDisputeFor(event);
          break;

        case PaymentEventKind.DISPUTE_REVERSED:
          await this.refunds.resolveDispute({
            provider: event.provider,
            providerDisputeId: event.providerObjectId ?? '',
            won: true,
          });
          break;

        default:
          break;
      }

      await this.tenant.withPlatformAdmin(
        { actorUserId: SYSTEM_ACTOR, reason: 'mark a payment-provider event processed' },
        (tx) =>
          tx.paymentProviderEvent.update({
            where: { id: event.id },
            data: {
              processingStatus: ProviderEventStatus.PROCESSED,
              processedAt: this.clock.now(),
              attemptCount: { increment: 1 },
            },
          }),
      );
    } catch (error) {
      await this.tenant.withPlatformAdmin(
        { actorUserId: SYSTEM_ACTOR, reason: 'record a failed payment-event processing attempt' },
        (tx) =>
          tx.paymentProviderEvent.update({
            where: { id: event.id },
            data: {
              processingStatus: ProviderEventStatus.FAILED,
              failureCode: error instanceof AppError ? error.code.slice(0, 64) : 'UNKNOWN',
              attemptCount: { increment: 1 },
            },
          }),
      );
      throw error;
    }
  }

  /**
   * Reconciliation (§60, §61).
   *
   * Catches the missed webhook, the delayed webhook and the webhook that
   * arrived while PalCert was down. It asks the provider about every top-up
   * that has been open longer than the configured threshold, and settles it
   * from the answer — through the same exactly-once path a webhook uses, so
   * the two racing is not a problem to solve but a case that already works.
   */
  async reconcileOpenTopUps(limit = 50): Promise<{ checked: number; credited: number }> {
    const threshold = new Date(
      this.clock.now().getTime() - this.config.payments.reconcileAfterSeconds * 1_000,
    );

    const open = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'reconcile open payments against provider state' },
      (tx) =>
        tx.balanceTopUp.findMany({
          where: {
            status: { in: [TopUpStatus.CREATED, TopUpStatus.PENDING] },
            createdAt: { lte: threshold },
            providerSessionId: { not: null },
          },
          orderBy: { createdAt: 'asc' },
          take: limit,
        }),
    );

    let credited = 0;
    for (const topUp of open) {
      if (!isTopUpOpen(topUp.status)) continue;
      try {
        const state = await this.provider.retrievePayment({
          providerSessionId: topUp.providerSessionId,
          providerPaymentId: topUp.providerPaymentId,
        });
        const outcome = await this.topUps.settleFromProviderState(topUp.id, state);
        if (outcome.credited) credited += 1;
      } catch (error) {
        // A provider outage postpones reconciliation; it never fails a
        // customer's balance (§111).
        this.logger.warn(
          {
            topUpId: topUp.id,
            providerFailureKind: error instanceof PaymentProviderError ? error.kind : 'UNKNOWN',
          },
          'Could not reconcile a payment; will retry',
        );
      }
    }

    return { checked: open.length, credited };
  }

  // -------------------------------------------------------------------------

  /**
   * Settle the top-up a provider object belongs to.
   *
   * The provider is asked directly rather than believed: this is the single
   * place where §53's "retrieve current provider state when necessary" and
   * §113's "favour safety" are applied. PalCert's documented policy is that a
   * signed webhook is a *prompt to check*, never evidence in itself.
   */
  private async settleTopUpFor(providerObjectId: string | null): Promise<void> {
    if (providerObjectId === null) return;
    const provider = this.provider.getCapabilities().provider;

    const topUp = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'settle a top-up named by a provider event' },
      (tx) =>
        tx.balanceTopUp.findFirst({
          where: {
            provider,
            OR: [{ providerSessionId: providerObjectId }, { providerPaymentId: providerObjectId }],
          },
        }),
    );
    if (topUp === null) {
      // An event about a payment PalCert never made. Recorded, not acted on:
      // metadata is not authority (§150).
      this.logger.warn({ provider }, 'Provider event named a payment PalCert does not recognize');
      return;
    }

    const state = await this.provider.retrievePayment({
      providerSessionId: topUp.providerSessionId,
      providerPaymentId: topUp.providerPaymentId,
    });
    await this.topUps.settleFromProviderState(topUp.id, state);
  }

  private async settleRefundFor(event: {
    provider: string;
    providerObjectId: string | null;
    eventKind: string;
  }): Promise<void> {
    if (event.providerObjectId === null) return;

    const refund = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'settle a refund named by a provider event' },
      (tx) =>
        tx.paymentRefund.findFirst({
          where: { provider: event.provider, providerRefundId: event.providerObjectId },
        }),
    );
    if (refund === null || refund.status === PaymentRefundStatus.SUCCEEDED) return;

    if (event.eventKind === PaymentEventKind.REFUND_SUCCEEDED) {
      await this.refunds.settleSucceeded(refund.id, event.providerObjectId);
    } else {
      await this.refunds.settleFailed(refund.id, 'PROVIDER_DECLINED');
    }
  }

  /**
   * Open a chargeback against the payment a dispute names.
   *
   * The adapter resolved the dispute → payment link, so this does not have to
   * guess. Without that link PalCert refuses to debit anyone: charging the
   * wrong customer for someone else's dispute would be worse than leaving it
   * for a person to resolve (§104, §150).
   */
  private async openDisputeFor(event: {
    provider: string;
    providerObjectId: string | null;
    relatedPaymentId: string | null;
    currency: string | null;
    amountMinor: bigint | null;
  }): Promise<void> {
    if (
      event.providerObjectId === null ||
      event.relatedPaymentId === null ||
      event.currency === null ||
      event.amountMinor === null
    ) {
      this.logger.error(
        { provider: event.provider },
        'Dispute event lacked the payment or amount needed to record a chargeback',
      );
      return;
    }

    await this.refunds.recordDispute({
      providerDisputeId: event.providerObjectId,
      provider: event.provider,
      providerPaymentId: event.relatedPaymentId,
      amountMinor: event.amountMinor,
      currency: event.currency,
    });
  }
}

/**
 * A unique-constraint violation, and nothing else.
 *
 * Prisma reports it as P2002. Matching on the code rather than on a message
 * keeps this from quietly widening when a message changes.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export { PaymentObjectKind };
