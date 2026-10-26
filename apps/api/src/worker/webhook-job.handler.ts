import { Injectable } from '@nestjs/common';
import { WebhookDeliveryStatus, WebhookErrorCode } from '@palcert/contracts';
import type { ProcessingJob } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';

import { ClockPort } from '../modules/auth/ports/clock.port';
import { WebhookDeliveryService } from '../modules/webhooks/services/webhook-delivery.service';
import { WebhookFanoutService } from '../modules/webhooks/services/webhook-fanout.service';
import { WebhookGatewayService } from '../modules/webhooks/services/webhook-gateway.service';
import { WebhookMetricsService } from '../modules/webhooks/services/webhook-metrics.service';
import { WebhookVerificationService } from '../modules/webhooks/services/webhook-verification.service';

/**
 * The three webhook job types, and what a "failed job" means for each.
 *
 * The distinction this handler exists to hold: a receiver's answer is never a
 * job failure. A 503 means the attempt ran, the answer was recorded, and the
 * delivery is owed another try on the webhook ladder — so the job succeeds and
 * the sweeper re-arms it later. Only PalCert failing to *carry out* the
 * attempt throws, because that is what the queue's short ladder is for.
 */
@Injectable()
export class WebhookJobHandler {
  constructor(
    private readonly fanout: WebhookFanoutService,
    private readonly delivery: WebhookDeliveryService,
    private readonly verification: WebhookVerificationService,
    private readonly gateway: WebhookGatewayService,
    private readonly metrics: WebhookMetricsService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhookJobHandler.name);
  }

  async fanOut(job: ProcessingJob): Promise<void> {
    const result = await this.fanout.fanOut(job.resourceId);
    this.metrics.fanoutCompleted({
      eventType: result.eventType ?? 'unknown',
      deliveries: result.deliveries,
    });
    this.logger.info(
      { domainEventId: job.resourceId, eventId: result.eventId, deliveries: result.deliveries },
      'webhook fan-out finished',
    );
  }

  async deliver(job: ProcessingJob): Promise<void> {
    const outcome = await this.delivery.attempt(job.resourceId);
    this.metrics.attemptFinished({
      eventType: outcome.eventType ?? 'unknown',
      status: outcome.kind,
      errorCode: 'errorCode' in outcome ? outcome.errorCode : null,
    });
    // Logged at the level the outcome deserves and with no identifying detail
    // beyond the delivery: no URL, no host, no body, no signature.
    this.logger.info(
      { deliveryId: job.resourceId, outcome: outcome.kind },
      'webhook delivery attempt finished',
    );
  }

  async verify(job: ProcessingJob): Promise<void> {
    const outcome = await this.verification.verify(job.resourceId);
    this.metrics.verificationSettled({
      status: outcome.kind,
      errorCode: 'errorCode' in outcome ? outcome.errorCode : null,
    });
    this.logger.info(
      { operationId: job.resourceId, outcome: outcome.kind },
      'webhook verification finished',
    );
  }

  /**
   * The queue gave up on a delivery job.
   *
   * Nothing here is a receiver's fault, so the delivery is not permanently
   * failed on its behalf: an interrupted attempt is closed as
   * `WORKER_INTERRUPTED` and the delivery is left retryable with a time on it,
   * which the sweeper will honour. The alternative — marking it permanently
   * failed — would let a PalCert outage silently cancel an organization's
   * webhook.
   */
  async failExhaustedDelivery(job: ProcessingJob): Promise<void> {
    const delivery = await this.gateway.readDelivery(job.resourceId);
    if (delivery === null) return;

    await this.closeOpenAttempt(job.resourceId);

    if (
      delivery.status === WebhookDeliveryStatus.SENDING ||
      delivery.status === WebhookDeliveryStatus.PENDING
    ) {
      await this.gateway.transitionDelivery({
        deliveryId: job.resourceId,
        status: WebhookDeliveryStatus.FAILED_RETRYABLE,
        errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
        // Soon, because this was PalCert's interruption rather than a receiver
        // asking for time. The injected clock, like every other schedule in the
        // phase: the begin doorway compares the worker's clock against this
        // time, and two different clocks would make that comparison a lottery.
        nextAttemptAt: new Date(this.clock.now().getTime() + 60_000),
      });
    }
  }

  /**
   * The queue gave up on a verification job.
   *
   * Leaving the operation alone here was wrong, and quietly so: the job is
   * DEAD, so nothing will ever run it again, and an operation with no job is an
   * intent that says "in progress" for as long as the row exists. The open
   * attempt underneath it says PalCert is still waiting for a receiver nobody
   * is talking to. Both are settled here.
   *
   * The configuration itself stays PENDING. Nothing proved it, and a later ask
   * is an explicit act: a new idempotency key, a new operation, a new job.
   */
  async failExhaustedVerification(job: ProcessingJob): Promise<void> {
    const operation = await this.gateway.readVerificationOperation(job.resourceId);
    if (operation === null || operation.settled_at !== null) return;

    // The proof may already exist. A worker that died between recording a
    // successful handshake and activating the configuration left everything
    // needed to finish, and finishing costs no network at all.
    if (operation.succeeded_attempt_id !== null) {
      await this.verification.resume(job.resourceId);
      this.logger.info(
        { operationId: job.resourceId },
        'webhook verification job exhausted, but its proof was already on disk',
      );
      return;
    }

    const attempts = await this.gateway.verificationAttempts(job.resourceId);
    const open = attempts.find((attempt) => attempt.outcome === null);
    if (open !== undefined) {
      await this.gateway.closeVerificationAttempt({
        attemptId: open.id,
        outcome: 'FAILED_RETRYABLE',
        errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
      });
    }

    await this.gateway.settleOperation(job.resourceId, WebhookErrorCode.WORKER_INTERRUPTED);
    this.logger.warn(
      { operationId: job.resourceId, closedAttempt: open?.id ?? null },
      'webhook verification job exhausted; the configuration stays pending',
    );
  }

  /**
   * Close whatever attempt a dead worker left open.
   *
   * Without this an attempt row stays open for ever and the delivery's history
   * says PalCert is still trying — the exact failure Phase 16 shipped a fix for
   * on the email side.
   */
  private async closeOpenAttempt(deliveryId: string): Promise<void> {
    const attempts = await this.gateway.openAttempts(deliveryId);
    const open = attempts.find((attempt) => attempt.outcome === null);
    if (open === undefined) return;

    await this.gateway.closeAttempt({
      attemptId: open.id,
      outcome: 'FAILED_RETRYABLE',
      errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
    });
  }
}
