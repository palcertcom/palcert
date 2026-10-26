import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type Job, type Processor } from 'bullmq';
import IORedis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../config/api-config.service';

/** The one queue name. Job *types* are distinguished by the ledger row, not by queue. */
export const PROCESSING_QUEUE_NAME = 'palcert-processing';

/** The whole payload. Identifiers only; the worker reloads everything else (§55). */
export interface ProcessingQueuePayload {
  readonly processingJobId: string;
}

/**
 * BullMQ over the existing Redis (ADR-0036).
 *
 * Deliberately thin: durability lives in the `processing_jobs` table, retry
 * policy lives in `ProcessingJobService`, and this class only publishes and
 * consumes. BullMQ's own retries are disabled (`attempts: 1`) so there is
 * exactly one retry policy, the one in the database.
 */
@Injectable()
export class ProcessingQueue implements OnModuleDestroy {
  private readonly connection: IORedis;
  private readonly queue: Queue<ProcessingQueuePayload>;
  private readonly workers: Worker[] = [];
  /** Connections handed to workers: BullMQ never closes an instance it did not create. */
  private readonly workerConnections: IORedis[] = [];

  constructor(
    config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProcessingQueue.name);
    this.connection = new IORedis(config.redisUrl, {
      // BullMQ requires this for blocking commands; an outage then surfaces as
      // an error from `add` rather than an indefinitely queued command.
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    this.connection.on('error', (error: Error) => {
      this.logger.warn({ err: error }, 'Processing queue Redis error');
    });
    this.queue = new Queue<ProcessingQueuePayload>(PROCESSING_QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: { attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 },
    });
  }

  /**
   * Publish one ledger row.
   *
   * The BullMQ job id is `{ledgerId}-{attempt}` (BullMQ reserves `:`): a duplicate publish of the
   * same attempt is deduplicated by BullMQ, and a later attempt is a new job
   * (BullMQ will not re-add an id it has already completed).
   */
  async publish(job: { readonly id: string; readonly attemptCount: number }): Promise<void> {
    await this.queue.add(
      'process',
      { processingJobId: job.id },
      { jobId: `${job.id}-${job.attemptCount}` },
    );
  }

  createWorker(
    processor: Processor<ProcessingQueuePayload>,
    options: { readonly concurrency: number; readonly lockDurationMs: number },
  ): Worker<ProcessingQueuePayload> {
    const connection = this.connection.duplicate();
    connection.on('error', (error: Error) =>
      this.logger.warn({ err: error }, 'Worker Redis error'),
    );
    this.workerConnections.push(connection);
    const worker = new Worker<ProcessingQueuePayload>(PROCESSING_QUEUE_NAME, processor, {
      connection,
      concurrency: options.concurrency,
      lockDuration: options.lockDurationMs,
      autorun: true,
    });
    worker.on('error', (error: Error) => this.logger.warn({ err: error }, 'Worker error'));
    this.workers.push(worker);
    return worker;
  }

  async depth(): Promise<{ waiting: number; active: number; delayed: number; failed: number }> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    return {
      waiting: counts['waiting'] ?? 0,
      active: counts['active'] ?? 0,
      delayed: counts['delayed'] ?? 0,
      failed: counts['failed'] ?? 0,
    };
  }

  async checkReadiness(): Promise<{ ok: boolean; message?: string }> {
    try {
      const reply = await this.connection.ping();
      return reply === 'PONG' ? { ok: true } : { ok: false, message: 'unexpected reply' };
    } catch {
      return { ok: false, message: 'unreachable' };
    }
  }

  /** Test helper: drain the queue between cases. */
  async obliterate(): Promise<void> {
    await this.queue.obliterate({ force: true });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await this.queue.close();
    for (const connection of this.workerConnections) {
      connection.disconnect();
    }
    this.connection.disconnect();
  }
}

export type ProcessingQueueJob = Job<ProcessingQueuePayload>;
