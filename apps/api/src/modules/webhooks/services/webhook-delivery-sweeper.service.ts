import { Injectable } from '@nestjs/common';
import { ProcessingJobType } from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';

import { ClockPort } from '../../auth/ports/clock.port';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';

const SWEEP_LIMIT = 50;

/**
 * The webhook business retry ladder, made to happen.
 *
 * A delivery whose receiver was not ready is `FAILED_RETRYABLE` with a time on
 * it, and its job has *succeeded* — the attempt was made and the answer was
 * recorded, which is exactly what that job was for. Nothing is waiting in the
 * queue, which is the point: the last rung of the ladder is twenty-four hours,
 * and holding a queue slot open for a day would be a queue that is mostly
 * waiting.
 *
 * When the time arrives this re-arms that same job through the business-retry
 * doorway. One job per delivery for its whole life, so the idempotency key
 * keeps meaning what it says, and a receiver's 503 never turns into a burst of
 * immediate retries through the queue's own short ladder.
 */
@Injectable()
export class WebhookDeliverySweeper {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhookDeliverySweeper.name);
  }

  async sweep(): Promise<number> {
    const due = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT * FROM app_webhook_deliveries_due($1::timestamptz, $2::integer)`,
      this.clock.now(),
      SWEEP_LIMIT,
    );

    let revived = 0;
    for (const delivery of due) {
      try {
        const job = await this.prisma.$transaction((tx) =>
          this.jobs.rearmForBusinessRetry(tx, {
            type: ProcessingJobType.WEBHOOK_DELIVER,
            resourceType: 'WEBHOOK_DELIVERY',
            resourceId: delivery.id,
          }),
        );
        await this.dispatcher.dispatchNow(job.id);
        revived += 1;
      } catch (error) {
        this.logger.warn(
          { err: error, deliveryId: delivery.id },
          'could not re-arm a webhook delivery',
        );
      }
    }

    return revived;
  }
}
