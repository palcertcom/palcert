import { Injectable } from '@nestjs/common';
import { ProcessingJobType } from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';

import { ClockPort } from '../../auth/ports/clock.port';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';

/** One pass is bounded, like every sweep in PalCert. */
const SCAN_LIMIT = 200;

/**
 * How long an eligible event is left alone before the reconciler adopts it.
 *
 * The producer writes the event and its fan-out job in one transaction, so in
 * the ordinary case there is nothing here to find. The grace period keeps the
 * reconciler from racing a producer whose transaction is still open, and one
 * minute is comfortably longer than that and far shorter than anyone waiting
 * for a webhook would notice.
 */
const GRACE_MS = 60_000;

/**
 * The mandatory safety net for a rolling deployment.
 *
 * `prisma migrate deploy` applies every pending migration in one run, so the
 * database reaches the Phase 17 cutover while some processes are still running
 * Phase 16 code. Such a process writes a `webhook_eligible` DomainEvent — it
 * gets the column default — and does not write the `WEBHOOK_FANOUT` job,
 * because its code has never heard of that job type.
 *
 * That gap is real and file ordering does not close it. This does: a bounded
 * scan for eligible events with no live fan-out job, creating exactly the
 * missing job and nothing else. It makes no network request of any kind, and
 * it never looks at a `webhook_eligible = false` row, so no submission
 * approved before the cutover can be announced now.
 *
 * The scan is oldest-first and bounded, with no cursor carried between passes:
 * every pass starts from the beginning of what is still outstanding. Creating
 * a job removes that event from the next pass's window, so the window drains
 * rather than repeating — and one event whose enqueue raises does not stop the
 * pass, because the loop catches per event and keeps going. What this shape
 * does *not* promise is progress past `SCAN_LIMIT` permanently unenqueueable
 * events; that would need a cursor, and it would also need a class of failure
 * that has never been observed, since the only work here is one insert.
 *
 * It is also how an eligible event survives a fan-out job that went DEAD:
 * `enqueueInTransaction` revives a DEAD job rather than creating a second one,
 * so the event keeps one job for its whole life and cannot be lost.
 */
@Injectable()
export class WebhookFanoutReconciler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhookFanoutReconciler.name);
  }

  /**
   * One bounded pass. Returns how many jobs it had to create.
   *
   * Idempotent by construction: the work it does is `enqueueInTransaction`,
   * whose unique idempotency key is `WEBHOOK_FANOUT:{domainEventId}`. Running
   * it a hundred times in a row creates the job once.
   */
  async reconcile(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - GRACE_MS);

    const orphans = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT e."id"
         FROM "domain_events" e
        WHERE e."webhook_eligible"
          AND e."created_at" <= $1::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM "processing_jobs" j
             WHERE j."job_type" = 'WEBHOOK_FANOUT'
               AND j."resource_id" = e."id"
               -- A dead job is not cover. It is the case this net exists for:
               -- the event is still owed its fan-out, and re-enqueueing revives
               -- that same job rather than creating a second one.
               AND j."status" <> 'DEAD'
          )
        ORDER BY e."created_at", e."id"
        LIMIT ${SCAN_LIMIT}`,
      cutoff,
    );

    let created = 0;
    for (const orphan of orphans) {
      try {
        const job = await this.prisma.$transaction((tx) =>
          this.jobs.enqueueInTransaction(tx, {
            type: ProcessingJobType.WEBHOOK_FANOUT,
            resourceType: 'DOMAIN_EVENT',
            resourceId: orphan.id,
          }),
        );
        await this.dispatcher.dispatchNow(job.id);
        created += 1;
      } catch (error) {
        // One unreachable event must not stop the pass for the rest.
        this.logger.warn(
          { err: error, domainEventId: orphan.id },
          'could not reconcile a webhook fan-out job',
        );
      }
    }

    if (created > 0) {
      this.logger.info({ created }, 'webhook fan-out reconciler created missing jobs');
    }
    return created;
  }
}
