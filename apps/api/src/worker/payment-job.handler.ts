import { Injectable } from '@nestjs/common';
import type { ProcessingJob } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { PaymentEventService } from '../modules/finance/services/payment-event.service';

/**
 * Payment work in the worker (§54, §60).
 *
 * Both handlers are deliberately thin. The interesting behaviour — exactly-once
 * credit, convergence between a webhook and a reconciliation sweep, refusing to
 * guess when provider state disagrees — lives in `PaymentEventService`, where
 * it can be tested without a queue.
 *
 * What the worker adds is durability: the job ledger means an event survives a
 * restart, and a failure is retried under the same at-least-once rules as every
 * other job (ADR-0037) — which is safe precisely because the financial effects
 * are idempotent.
 */
@Injectable()
export class PaymentJobHandler {
  constructor(
    private readonly events: PaymentEventService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PaymentJobHandler.name);
  }

  /** Act on one verified provider event. */
  async handleEvent(job: ProcessingJob): Promise<void> {
    await this.events.process(job.resourceId);
  }

  /**
   * Ask the provider about payments PalCert heard nothing about.
   *
   * Covers the missed webhook, the delayed webhook, and the webhook that
   * arrived while PalCert was down (§60, §112). It credits through the same
   * path a webhook uses, so the two racing produces one credit rather than two.
   */
  async handleReconciliation(): Promise<void> {
    const outcome = await this.events.reconcileOpenTopUps();
    if (outcome.credited > 0) {
      this.logger.info(
        { checked: outcome.checked, credited: outcome.credited },
        'Reconciliation credited payments PalCert had not heard about',
      );
    }
  }
}
