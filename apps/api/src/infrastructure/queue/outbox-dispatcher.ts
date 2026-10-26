import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../config/api-config.service';
import { ProcessingJobService } from './processing-job.service';
import { ProcessingQueue } from './processing-queue';

/**
 * Moves ledger rows onto the queue (ADR-0036).
 *
 * Two entry points, one mechanism. `dispatchNow` is called right after a
 * finalize commits, so the common case is processed within milliseconds.
 * `sweep` runs on an interval and catches everything else: rows whose
 * immediate publish failed because Redis was down, retries whose backoff has
 * elapsed, and leases that lapsed with a dead worker. Both claim rows with
 * `SKIP LOCKED`, so running the sweep in every process is safe.
 */
@Injectable()
export class OutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  /** Called with every job the reaper declared DEAD, so its resource can be failed. */
  private deadJobHandler: ((jobId: string) => Promise<void>) | null = null;

  constructor(
    private readonly jobs: ProcessingJobService,
    private readonly queue: ProcessingQueue,
    private readonly config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OutboxDispatcher.name);
  }

  onModuleInit(): void {
    const interval = this.config.upload.sweepIntervalMs;
    this.timer = setInterval(() => void this.sweep(), interval);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  onDeadJob(handler: (jobId: string) => Promise<void>): void {
    this.deadJobHandler = handler;
  }

  /** Best effort. A failure here is not an error for the caller: the sweep will publish. */
  async dispatchNow(jobId: string): Promise<boolean> {
    try {
      const claimed = await this.jobs.claimDue(1, jobId);
      if (claimed.length === 0) return false;
      return await this.publishClaimed(claimed[0]!);
    } catch (error) {
      this.logger.warn({ err: error, jobId }, 'Immediate dispatch failed; left for the sweep');
      return false;
    }
  }

  /** Returns how many jobs were published. */
  async sweep(): Promise<{ published: number; requeued: number; dead: number }> {
    if (this.sweeping) return { published: 0, requeued: 0, dead: 0 };
    this.sweeping = true;
    try {
      const reaped = await this.jobs.reapAbandoned();
      for (const job of reaped.dead) {
        try {
          await this.deadJobHandler?.(job.id);
        } catch (error) {
          this.logger.error({ err: error, jobId: job.id }, 'Dead-job handler failed');
        }
      }

      let published = 0;
      const claimed = await this.jobs.claimDue(100);
      for (const job of claimed) {
        if (await this.publishClaimed(job)) published += 1;
      }
      return { published, requeued: reaped.requeued, dead: reaped.dead.length };
    } catch (error) {
      this.logger.warn({ err: error }, 'Outbox sweep failed');
      return { published: 0, requeued: 0, dead: 0 };
    } finally {
      this.sweeping = false;
    }
  }

  private async publishClaimed(job: { id: string; attemptCount: number }): Promise<boolean> {
    try {
      await this.queue.publish(job);
      return true;
    } catch (error) {
      // Redis is down or refused. The row goes back to PENDING and nothing is
      // lost: the user's finalize already committed (§54).
      this.logger.warn({ err: error, jobId: job.id }, 'Queue publish failed; returned to outbox');
      await this.jobs.releaseToPending(job.id);
      return false;
    }
  }
}
