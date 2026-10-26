import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { ApiConfigService } from '../config/api-config.service';
import { WebhookDeliverySweeper } from '../modules/webhooks/services/webhook-delivery-sweeper.service';
import { WebhookFanoutReconciler } from '../modules/webhooks/services/webhook-fanout-reconciler.service';
import { WebhookRevealSweeper } from '../modules/webhooks/services/webhook-reveal-sweeper.service';

/**
 * The webhook background passes, on one timer.
 *
 * Three jobs that all answer "notice what nobody told us about": a delivery
 * whose retry time has arrived, an eligible event whose producer never wrote a
 * fan-out job, and reveal material whose window has closed. One timer rather
 * than three, because a second cadence knob would be a second thing to get
 * wrong and none of the three is urgent to the second.
 *
 * Only the worker runs these. The API process holds the same services for its
 * own routes but must never sweep, or two processes would race on every pass.
 */
@Injectable()
export class WebhookSweeper implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deliveries: WebhookDeliverySweeper,
    private readonly reconciler: WebhookFanoutReconciler,
    private readonly reveals: WebhookRevealSweeper,
    private readonly config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhookSweeper.name);
  }

  onModuleInit(): void {
    if (!this.config.webhooksEnabled) return;

    // Readiness is not checked here any more, and deliberately not: it is an
    // awaited part of `WebhookKeyringService`'s own initialization, which Nest
    // completes before this module exists. Firing it here and hoping a rejected
    // promise took the process down was a race the worker usually won.
    this.timer = setInterval(() => void this.sweep(), this.config.upload.sweepIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /** One pass of all three. Exposed so tests drive it without a timer. */
  async sweep(): Promise<{ revived: number; reconciled: number; cleared: number }> {
    const revived = await this.deliveries.sweep();
    const reconciled = await this.reconciler.reconcile();
    const cleared = await this.reveals.sweep();
    return { revived, reconciled, cleared };
  }
}
