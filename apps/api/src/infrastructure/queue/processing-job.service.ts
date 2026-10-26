import { Injectable } from '@nestjs/common';
import {
  ProcessingJobStatus,
  type DocumentFailureCode,
  type ProcessingJobType,
  processingJobIdempotencyKey,
} from '@palcert/contracts';
import type { ProcessingJob } from '@palcert/database';
import { ApiConfigService } from '../../config/api-config.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantClient } from '../tenant/tenant-prisma.service';
import { ClockPort } from '../../modules/auth/ports/clock.port';

export type ProcessingResourceType =
  | 'DOCUMENT_VERSION'
  | 'DOCUMENT'
  | 'DOCUMENT_ANALYSIS'
  // Phase 11: getting one paid check moving, durably.
  | 'DOCUMENT_CHECK'
  | 'CHECK_RUN'
  | 'AI_REVIEW'
  // Phase 9: organization-owned work, which carries an organization instead of
  // relying on the owner's own scope.
  | 'STANDARD_SOURCE_ASSET'
  | 'RULE_EXTRACTION_RUN'
  // Phase 10: platform-owned financial work, which belongs to no customer.
  | 'PAYMENT_PROVIDER_EVENT'
  | 'PAYMENT_RECONCILIATION'
  // Phase 12: one paid correction of one customer's document.
  | 'SMARTFIX_REQUEST'
  // Phase 14: copying one official submission's evidence into its snapshot.
  // Owned by the submitting user, because the author is who authorized the
  // handoff and whose scope the copy runs under.
  | 'SUBMISSION_REVISION'
  | 'COMPLIANCE_CERTIFICATE'
  // Phase 16: PalCert's own work rather than one customer's. A fan-out serves
  // every recipient of an event, several of whom are reviewers in an
  // organization the subject does not belong to, so filing it under the
  // subject's user id would say something false about whose work it is.
  | 'DOMAIN_EVENT'
  | 'NOTIFICATION_DELIVERY'
  // Phase 17: an integration belongs to the organization whose events it
  // projects, not to any person, and a verification belongs to the intent
  // rather than to whoever happened to click the button.
  | 'WEBHOOK_DELIVERY'
  | 'WEBHOOK_VERIFICATION_OPERATION'
  // Certificate attestation. Ingesting an upload is the owner's work; moving
  // the money a decision implies is PalCert's, and belongs to neither party.
  | 'ATTESTATION_ARTIFACT'
  | 'ATTESTATION_REQUEST'
  // Manual top-ups: scanning a receipt is its owner's work; scanning a payment
  // method's logo is the uploading administrator's.
  | 'MANUAL_TOPUP_RECEIPT'
  | 'MANUAL_PAYMENT_METHOD_LOGO'
  | 'WITHDRAWAL_PROOF';

/**
 * The job ledger and transactional outbox (ADR-0036, ADR-0037).
 *
 * A job row is written in the *same transaction* as the state it will
 * process, so a finalize that commits has a job that commits with it. The
 * queue is told about it afterwards, and if that fails the row simply stays
 * PENDING until the next sweep. Every status change here is guarded by the
 * database trigger, so a stray UPDATE cannot skip a state either.
 *
 * `processing_jobs` is a SYSTEM table: the worker must read a job by id
 * before it knows whose scope to enter, and it enters that scope from the
 * row's `owner_user_id`, never from the queue message (§56).
 */
@Injectable()
export class ProcessingJobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
  ) {}

  /**
   * Record the intent to process a resource, inside the caller's transaction.
   *
   * Idempotent by construction: a second call for the same resource returns
   * the existing live job. A DEAD job is resurrected (the owner asked for a
   * retry); a SUCCEEDED one is returned untouched, because the work is done.
   */
  async enqueueInTransaction(
    tx: TenantClient,
    params: {
      readonly type: ProcessingJobType;
      readonly resourceType: ProcessingResourceType;
      readonly resourceId: string;
      /**
       * The customer this work is for.
       *
       * Optional since Phase 10: settling a payment and reconciling against
       * the provider are PalCert's own work, belonging to no customer. Which
       * job types may omit it is decided by a database CHECK, not here.
       */
      readonly ownerUserId?: string | undefined;
      /**
       * The tenant, for organization-owned work (Phase 9).
       *
       * The worker re-establishes its scope from this column rather than from
       * the queue message, exactly as it does from `ownerUserId`.
       */
      readonly organizationId?: string | undefined;
    },
  ): Promise<ProcessingJob> {
    const idempotencyKey = processingJobIdempotencyKey(params.type, params.resourceId);
    const now = this.clock.now();
    const existing = await tx.processingJob.findUnique({ where: { idempotencyKey } });

    if (existing === null) {
      return tx.processingJob.create({
        data: {
          jobType: params.type,
          resourceType: params.resourceType,
          resourceId: params.resourceId,
          ownerUserId: params.ownerUserId ?? null,
          organizationId: params.organizationId ?? null,
          idempotencyKey,
          status: ProcessingJobStatus.PENDING,
          maxAttempts: this.config.queue.maxAttempts,
          availableAt: now,
        },
      });
    }

    if (existing.status === ProcessingJobStatus.DEAD) {
      return tx.processingJob.update({
        where: { id: existing.id },
        data: {
          status: ProcessingJobStatus.PENDING,
          // The attempt counter keeps counting: every queue delivery id is
          // `{job}-{attempt}` and must never repeat, so a retry grants a
          // fresh budget on top rather than rewinding to zero.
          maxAttempts: existing.attemptCount + this.config.queue.maxAttempts,
          availableAt: now,
          dispatchedAt: null,
          startedAt: null,
          leaseExpiresAt: null,
          completedAt: null,
          deadAt: null,
          lastFailureCode: null,
          lastFailureMessage: null,
          workerId: null,
        },
      });
    }

    return existing;
  }

  /**
   * Re-arm a finished job for a *business* retry (Phase 17).
   *
   * `enqueueInTransaction` deliberately returns a SUCCEEDED job unchanged: for
   * every phase before this one, a job that finished did the work exactly once
   * and re-running it would be a duplicate. Phase 17 has a case that genuinely
   * is not a duplicate — a webhook whose receiver answered 503 has a job that
   * succeeded (it made the attempt and recorded the answer) and a delivery that
   * is owed another attempt hours later.
   *
   * That is a separate doorway rather than a relaxation of the existing one,
   * because the distinction is the whole of the phase's retry design:
   *
   *   - the queue ladder is short and handles *interruption* — the process
   *     died, the database blinked, the lease lapsed;
   *   - the webhook ladder is long (1m … 24h) and handles *a receiver that is
   *     not ready*, which is not a failure of PalCert's and must not occupy a
   *     queue slot for a day.
   *
   * Only a caller that has already persisted a business outcome may call this,
   * and the delivery's own `nextAttemptAt` is what decides when.
   */
  async rearmForBusinessRetry(
    tx: TenantClient,
    params: {
      readonly type: ProcessingJobType;
      readonly resourceType: ProcessingResourceType;
      readonly resourceId: string;
    },
  ): Promise<ProcessingJob> {
    const idempotencyKey = processingJobIdempotencyKey(params.type, params.resourceId);
    const now = this.clock.now();
    const existing = await tx.processingJob.findUnique({ where: { idempotencyKey } });

    if (existing === null) {
      return this.enqueueInTransaction(tx, params);
    }

    if (
      existing.status === ProcessingJobStatus.PENDING ||
      existing.status === ProcessingJobStatus.DISPATCHED ||
      existing.status === ProcessingJobStatus.RUNNING ||
      existing.status === ProcessingJobStatus.RETRY_PENDING
    ) {
      // Already owed an attempt. A second one would be the duplicate this
      // whole mechanism exists to avoid.
      return existing;
    }

    return tx.processingJob.update({
      where: { id: existing.id },
      data: {
        status: ProcessingJobStatus.PENDING,
        // The counter keeps climbing, as it does for a revived DEAD job: every
        // queue delivery id is `{job}-{attempt}` and must never repeat.
        maxAttempts: existing.attemptCount + this.config.queue.maxAttempts,
        availableAt: now,
        dispatchedAt: null,
        startedAt: null,
        leaseExpiresAt: null,
        completedAt: null,
        deadAt: null,
        lastFailureCode: null,
        lastFailureMessage: null,
        workerId: null,
      },
    });
  }

  findById(id: string): Promise<ProcessingJob | null> {
    return this.prisma.processingJob.findUnique({ where: { id } });
  }

  findByResource(type: ProcessingJobType, resourceId: string): Promise<ProcessingJob | null> {
    return this.prisma.processingJob.findUnique({
      where: { idempotencyKey: processingJobIdempotencyKey(type, resourceId) },
    });
  }

  /**
   * Take every job that is due, marking it DISPATCHED under a lease.
   *
   * `FOR UPDATE SKIP LOCKED` lets the API's immediate dispatch and a sweep on
   * another process race safely: each row is claimed by exactly one of them.
   */
  async claimDue(limit: number, onlyJobId?: string): Promise<ProcessingJob[]> {
    const now = this.clock.now();
    const lease = new Date(now.getTime() + this.config.queue.leaseSeconds * 1000);
    return this.prisma.$queryRaw<ProcessingJob[]>`
      WITH due AS (
        SELECT "id" FROM "processing_jobs"
        WHERE "status" IN ('PENDING', 'RETRY_PENDING')
          AND "available_at" <= ${now}
          AND (${onlyJobId ?? null}::uuid IS NULL OR "id" = ${onlyJobId ?? null}::uuid)
        ORDER BY "available_at"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "processing_jobs" j
      SET "status" = 'DISPATCHED', "dispatched_at" = ${now}, "lease_expires_at" = ${lease}, "updated_at" = ${now}
      FROM due WHERE j."id" = due."id"
      RETURNING j."id", j."job_type" AS "jobType", j."resource_type" AS "resourceType",
        j."resource_id" AS "resourceId", j."owner_user_id" AS "ownerUserId",
        j."idempotency_key" AS "idempotencyKey", j."status", j."attempt_count" AS "attemptCount",
        j."max_attempts" AS "maxAttempts", j."available_at" AS "availableAt",
        j."dispatched_at" AS "dispatchedAt", j."started_at" AS "startedAt",
        j."lease_expires_at" AS "leaseExpiresAt", j."completed_at" AS "completedAt",
        j."dead_at" AS "deadAt", j."last_failure_code" AS "lastFailureCode",
        j."last_failure_message" AS "lastFailureMessage", j."worker_id" AS "workerId",
        j."created_at" AS "createdAt", j."updated_at" AS "updatedAt"
    `;
  }

  /** A publish failed after the claim: hand the row back to the outbox. */
  async releaseToPending(id: string): Promise<void> {
    await this.prisma.processingJob.updateMany({
      where: { id, status: ProcessingJobStatus.DISPATCHED },
      data: {
        status: ProcessingJobStatus.PENDING,
        leaseExpiresAt: null,
        updatedAt: this.clock.now(),
      },
    });
  }

  /**
   * Jobs whose lease lapsed while DISPATCHED or RUNNING: the publish was lost
   * or the worker died. Each is returned to the outbox as one spent attempt.
   * Returns the rows that ran out of attempts, so the caller can fail the
   * resource they were processing (which needs the owner's scope).
   */
  async reapAbandoned(): Promise<{ readonly requeued: number; readonly dead: ProcessingJob[] }> {
    const now = this.clock.now();
    const abandoned = await this.prisma.processingJob.findMany({
      where: {
        status: { in: [ProcessingJobStatus.DISPATCHED, ProcessingJobStatus.RUNNING] },
        leaseExpiresAt: { lte: now },
      },
      take: 100,
    });

    let requeued = 0;
    const dead: ProcessingJob[] = [];
    for (const job of abandoned) {
      const attempts = job.attemptCount + 1;
      if (attempts >= job.maxAttempts) {
        const updated = await this.prisma.processingJob.update({
          where: { id: job.id },
          data: {
            status: ProcessingJobStatus.DEAD,
            attemptCount: attempts,
            deadAt: now,
            lastFailureCode: 'WORKER_ERROR',
            lastFailureMessage: 'lease expired; attempts exhausted',
            leaseExpiresAt: null,
          },
        });
        dead.push(updated);
      } else {
        await this.prisma.processingJob.update({
          where: { id: job.id },
          data: {
            status: ProcessingJobStatus.PENDING,
            attemptCount: attempts,
            // The job did not fail, its worker vanished: re-run it now. The
            // attempt bound above still stops a job that keeps killing workers.
            availableAt: now,
            leaseExpiresAt: null,
            lastFailureCode: 'WORKER_ERROR',
            lastFailureMessage: 'lease expired',
          },
        });
        requeued += 1;
      }
    }
    return { requeued, dead };
  }

  /**
   * Begin an attempt. Null means "nothing to do": the job already succeeded,
   * is dead, or is being run by a worker whose lease is still live — every
   * one of which is what a duplicate delivery looks like (§52).
   */
  async start(id: string, workerId: string): Promise<ProcessingJob | null> {
    const now = this.clock.now();
    const lease = new Date(now.getTime() + this.config.queue.leaseSeconds * 1000);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "processing_jobs"
      SET "status" = 'RUNNING', "started_at" = ${now}, "lease_expires_at" = ${lease},
          "worker_id" = ${workerId}, "updated_at" = ${now}
      WHERE "id" = ${id}::uuid
        AND (
          "status" IN ('PENDING', 'DISPATCHED', 'RETRY_PENDING')
          OR ("status" = 'RUNNING' AND "lease_expires_at" <= ${now})
        )
      RETURNING "id"
    `;
    if (rows.length === 0) return null;
    return this.prisma.processingJob.findUnique({ where: { id } });
  }

  async heartbeat(id: string): Promise<void> {
    const now = this.clock.now();
    await this.prisma.processingJob.updateMany({
      where: { id, status: ProcessingJobStatus.RUNNING },
      data: { leaseExpiresAt: new Date(now.getTime() + this.config.queue.leaseSeconds * 1000) },
    });
  }

  async succeed(id: string): Promise<void> {
    const now = this.clock.now();
    await this.prisma.processingJob.update({
      where: { id },
      data: { status: ProcessingJobStatus.SUCCEEDED, completedAt: now, leaseExpiresAt: null },
    });
  }

  /**
   * A transient failure: spend one attempt. Returns what the caller must do
   * about the resource — nothing yet, or mark it FAILED because the job is
   * now DEAD (§59, §60).
   */
  async failTransient(
    id: string,
    failure: { readonly code: DocumentFailureCode; readonly message: string },
  ): Promise<'retry' | 'dead'> {
    const job = await this.prisma.processingJob.findUniqueOrThrow({ where: { id } });
    const attempts = job.attemptCount + 1;
    const now = this.clock.now();
    const message = failure.message.slice(0, 500);

    if (attempts >= job.maxAttempts) {
      await this.prisma.processingJob.update({
        where: { id },
        data: {
          status: ProcessingJobStatus.DEAD,
          attemptCount: attempts,
          deadAt: now,
          leaseExpiresAt: null,
          lastFailureCode: failure.code,
          lastFailureMessage: message,
        },
      });
      return 'dead';
    }

    await this.prisma.processingJob.update({
      where: { id },
      data: {
        status: ProcessingJobStatus.RETRY_PENDING,
        attemptCount: attempts,
        availableAt: new Date(now.getTime() + this.backoffMs(attempts)),
        leaseExpiresAt: null,
        lastFailureCode: failure.code,
        lastFailureMessage: message,
      },
    });
    return 'retry';
  }

  /** Exponential backoff with full jitter, capped (§59). */
  backoffMs(attempt: number): number {
    const { backoffBaseMs, backoffMaxMs } = this.config.queue;
    const exponential = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.max(0, attempt - 1));
    return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.prisma.processingJob.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
  }
}
