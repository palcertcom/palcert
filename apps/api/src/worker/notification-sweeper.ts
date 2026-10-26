import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { NotificationDeliveryStatus, ProcessingJobType } from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../config/api-config.service';
import { ClockPort } from '../modules/auth/ports/clock.port';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { ProcessingJobService } from '../infrastructure/queue/processing-job.service';
import { OutboxDispatcher } from '../infrastructure/queue/outbox-dispatcher';

/** How many overdue deliveries one pass revives. Bounded, like every sweep. */
const SWEEP_LIMIT = 50;

/**
 * Picking up deliveries the job ladder gave up on (§57).
 *
 * The two ladders do different jobs and neither replaces the other. The
 * queue's is short and fast, for the ordinary case where a relay hiccups and
 * the next attempt seconds later succeeds. The email ladder is long — the last
 * rung is twelve hours — because a provider outage measured in hours should
 * not turn into a permanently failed notification, and holding a queue job in
 * RETRY_PENDING for half a day would occupy the queue with waiting.
 *
 * So an exhausted job leaves the delivery FAILED_RETRYABLE with a time on it,
 * and this sweep re-enqueues it when that time arrives. `enqueueInTransaction`
 * resurrects the DEAD job rather than creating a second one, so the delivery
 * keeps one job for its whole life and the idempotency key stays meaningful.
 */
@Injectable()
export class NotificationSweeper implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly clock: ClockPort,
    private readonly config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationSweeper.name);
  }

  onModuleInit(): void {
    // Reuses the upload sweep cadence: both are "notice what nobody told us
    // about", and a second knob would be a second thing to get wrong.
    this.timer = setInterval(() => void this.sweep(), this.config.upload.sweepIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /** One pass. Exposed so tests can drive it without waiting for a timer. */
  async sweep(): Promise<number> {
    const due = await this.prisma.notificationDelivery.findMany({
      where: {
        status: NotificationDeliveryStatus.FAILED_RETRYABLE,
        nextAttemptAt: { not: null, lte: this.clock.now() },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: SWEEP_LIMIT,
      select: { id: true },
    });

    let revived = 0;
    for (const delivery of due) {
      try {
        const job = await this.prisma.$transaction((tx) =>
          this.jobs.enqueueInTransaction(tx, {
            type: ProcessingJobType.NOTIFICATION_EMAIL_SEND,
            resourceType: 'NOTIFICATION_DELIVERY',
            resourceId: delivery.id,
          }),
        );
        await this.dispatcher.dispatchNow(job.id);
        revived += 1;
      } catch (error) {
        // One stuck delivery must not stop the sweep for the rest.
        this.logger.warn({ err: error, deliveryId: delivery.id }, 'could not revive a delivery');
      }
    }

    return revived;
  }
}
