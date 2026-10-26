import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ProcessingJobType } from '@palcert/contracts';
import type { ProcessingJob } from '@palcert/database';
import { hostname } from 'node:os';
import { PinoLogger } from 'nestjs-pino';
import { MetricsService } from '../infrastructure/metrics/metrics.service';
import { ApiConfigService } from '../config/api-config.service';
import { classifyFailure } from '../ingestion/retry-classification';
import { OutboxDispatcher } from '../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../infrastructure/queue/processing-job.service';
import { ProcessingQueue, type ProcessingQueueJob } from '../infrastructure/queue/processing-queue';
import { AnalysisJobHandler } from './analysis-job.handler';
import { AIReviewJobHandler } from './ai-review-job.handler';
import { CheckEvaluationJobHandler } from './check-evaluation-job.handler';
import { CheckPrepareJobHandler } from './check-prepare-job.handler';
import { IngestJobHandler } from './ingest-job.handler';
import { PaymentJobHandler } from './payment-job.handler';
import { PurgeJobHandler } from './purge-job.handler';
import { RuleExtractionJobHandler } from './rule-extraction-job.handler';
import { SmartFixJobHandler } from './smartfix-job.handler';
import { CertificateIssueJobHandler } from './certificate-issue-job.handler';
import { NotificationJobHandler } from './notification-job.handler';
import { WebhookJobHandler } from './webhook-job.handler';
import { SubmissionPrepareJobHandler } from './submission-prepare-job.handler';
import { SourceIngestJobHandler } from './source-ingest-job.handler';
import { AttestationArtifactJobHandler } from './attestation-artifact-job.handler';
import { ManualTopUpFileJobHandler } from './manual-topup-file-job.handler';
import { AttestationPaymentJobHandler } from './attestation-payment-job.handler';

/**
 * The file-processing worker (§61, §65).
 *
 * Consumes ledger ids from the queue, claims each in the database (which is
 * where duplicate delivery is defeated), holds a lease with heartbeats while
 * working, and records the outcome. Every failure is classified: a rejection
 * is an outcome and the job succeeds; anything transient spends an attempt,
 * and the last attempt fails the version.
 */
@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  readonly workerId = `${hostname()}:${process.pid}`;
  private heartbeats = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly queue: ProcessingQueue,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly ingest: IngestJobHandler,
    private readonly purge: PurgeJobHandler,
    private readonly analysis: AnalysisJobHandler,
    private readonly checkPrepare: CheckPrepareJobHandler,
    private readonly checkEvaluation: CheckEvaluationJobHandler,
    private readonly aiReview: AIReviewJobHandler,
    private readonly sourceIngest: SourceIngestJobHandler,
    private readonly ruleExtraction: RuleExtractionJobHandler,
    private readonly payments: PaymentJobHandler,
    private readonly smartFix: SmartFixJobHandler,
    private readonly submissionPrepare: SubmissionPrepareJobHandler,
    private readonly certificateIssue: CertificateIssueJobHandler,
    private readonly notifications: NotificationJobHandler,
    private readonly webhooks: WebhookJobHandler,
    private readonly attestationArtifacts: AttestationArtifactJobHandler,
    private readonly manualTopUpFiles: ManualTopUpFileJobHandler,
    private readonly attestationPayments: AttestationPaymentJobHandler,
    private readonly config: ApiConfigService,
    private readonly metrics: MetricsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WorkerService.name);
  }

  onModuleInit(): void {
    this.dispatcher.onDeadJob((jobId) => this.failDeadJob(jobId));
    this.queue.createWorker((job) => this.process(job), {
      concurrency: this.config.queue.workerConcurrency,
      lockDurationMs: this.config.queue.leaseSeconds * 1000,
    });
    this.logger.info({ workerId: this.workerId }, 'File-processing worker started');
  }

  onModuleDestroy(): void {
    for (const timer of this.heartbeats.values()) clearInterval(timer);
  }

  /** Exposed for tests, which drive jobs without a live BullMQ worker. */
  async process(queued: ProcessingQueueJob): Promise<void> {
    await this.processJobId(queued.data.processingJobId);
  }

  async processJobId(jobId: string): Promise<void> {
    const job = await this.jobs.start(jobId, this.workerId);
    if (job === null) return; // duplicate delivery, already done, or live elsewhere

    const heartbeat = setInterval(
      () => void this.jobs.heartbeat(jobId),
      (this.config.queue.leaseSeconds * 1000) / 3,
    );
    heartbeat.unref();
    this.heartbeats.set(jobId, heartbeat);

    // Correlation, from identifiers that already exist (Phase 20 Checkpoint 3).
    //
    // Nothing new is minted here. The job row already carries the resource the
    // HTTP request created, so `resourceType`/`resourceId` are what join this
    // execution back to the request line that produced it, and `jobId` is what
    // joins it forward to the delivery attempts the handler makes. `attempt`
    // makes a retry distinguishable from a first try in a log search, which is
    // the difference between "this failed once" and "this is failing".
    //
    // Deliberately absent: the owner, the organization, the document name and
    // the payload. The ledger row has them, behind the database's access
    // controls, which is where they belong.
    const correlation = {
      jobId,
      jobType: job.jobType,
      resourceType: job.resourceType,
      resourceId: job.resourceId,
      attempt: job.attemptCount,
      workerId: this.workerId,
    };
    this.logger.info(correlation, 'Job attempt started');

    // The attempt is timed and counted whichever way it ends, so throughput
    // and latency are visible per job type without any handler knowing it is
    // being observed.
    const endTimer = this.metrics.jobDuration.startTimer({ job_type: job.jobType });
    let outcome: 'succeeded' | 'retried' | 'dead' = 'succeeded';
    let failureCode: string | undefined;

    try {
      try {
        await this.dispatch(job);
        await this.jobs.succeed(jobId);
      } catch (error) {
        const failure = classifyFailure(error);
        // A rejection cannot reach here (the pipeline returns it), so this is transient.
        const detail =
          failure.kind === 'transient'
            ? failure
            : { code: 'WORKER_ERROR' as const, detail: 'unexpected' };
        failureCode = detail.code;
        this.logger.warn({ err: error, ...correlation, code: detail.code }, 'Job attempt failed');
        const result = await this.jobs.failTransient(jobId, {
          code: detail.code,
          message: detail.detail,
        });
        outcome = result === 'dead' ? 'dead' : 'retried';
        if (result === 'dead') {
          await this.failResource(job, { code: detail.code, message: detail.detail });
        }
      }
    } finally {
      clearInterval(heartbeat);
      this.heartbeats.delete(jobId);

      // Telemetry last, and deliberately outside the block that decides the
      // job's fate. It sat inside it in the first draft, and a mislabelled
      // histogram threw *after* the job had already been marked SUCCEEDED —
      // the catch then tried to move a succeeded job to RETRY_PENDING, and
      // the ledger's own guard refused it. Observability has no business
      // changing what happens to work; here it cannot.
      endTimer();
      this.metrics.jobExecutions.inc({ job_type: job.jobType, outcome });
      this.logger.info(
        {
          ...correlation,
          outcome,
          ...(failureCode === undefined ? {} : { code: failureCode }),
        },
        'Job attempt finished',
      );
    }
  }

  private async dispatch(job: ProcessingJob): Promise<void> {
    switch (job.jobType) {
      case ProcessingJobType.DOCUMENT_INGEST:
        await this.ingest.handle(job);
        return;
      case ProcessingJobType.DOCUMENT_PURGE:
        await this.purge.handle(job);
        return;
      // Both formats run the same orchestration; only the analyzer the engine
      // reaches for differs, and the ledger keeps them apart (Phase 13 §10).
      case ProcessingJobType.DOCX_ANALYSIS:
      case ProcessingJobType.PDF_ANALYSIS:
        await this.analysis.handle(job);
        return;
      case ProcessingJobType.CHECK_PREPARE:
        await this.checkPrepare.handle(job);
        return;
      case ProcessingJobType.CHECK_EVALUATION:
        await this.checkEvaluation.handle(job);
        return;
      case ProcessingJobType.AI_REVIEW:
        await this.aiReview.handle(job);
        return;
      case ProcessingJobType.STANDARD_SOURCE_INGEST:
        await this.sourceIngest.handle(job);
        return;
      case ProcessingJobType.RULE_EXTRACTION:
        await this.ruleExtraction.handle(job);
        return;
      case ProcessingJobType.PAYMENT_EVENT:
        await this.payments.handleEvent(job);
        return;
      case ProcessingJobType.PAYMENT_RECONCILIATION:
        await this.payments.handleReconciliation();
        return;
      case ProcessingJobType.SMARTFIX_EXECUTE:
        await this.smartFix.execute(job);
        return;
      case ProcessingJobType.SMARTFIX_FINALIZE:
        await this.smartFix.finalizeJob(job);
        return;
      case ProcessingJobType.SUBMISSION_PREPARE:
        await this.submissionPrepare.handle(job);
        return;
      case ProcessingJobType.CERTIFICATE_ISSUE:
        await this.certificateIssue.handle(job);
        return;
      case ProcessingJobType.NOTIFICATION_FANOUT:
        await this.notifications.fanOut(job);
        return;
      case ProcessingJobType.NOTIFICATION_EMAIL_SEND:
        await this.notifications.send(job);
        return;
      case ProcessingJobType.WEBHOOK_FANOUT:
        await this.webhooks.fanOut(job);
        return;
      case ProcessingJobType.WEBHOOK_DELIVER:
        await this.webhooks.deliver(job);
        return;
      case ProcessingJobType.WEBHOOK_ENDPOINT_VERIFY:
        await this.webhooks.verify(job);
        return;
      case ProcessingJobType.ATTESTATION_ARTIFACT_INGEST:
        await this.attestationArtifacts.handle(job);
        return;
      case ProcessingJobType.ATTESTATION_PAYMENT:
        await this.attestationPayments.handle(job);
        return;
      case ProcessingJobType.MANUAL_TOPUP_RECEIPT_INGEST:
      case ProcessingJobType.MANUAL_PAYMENT_METHOD_LOGO_INGEST:
      case ProcessingJobType.WITHDRAWAL_PROOF_INGEST:
        await this.manualTopUpFiles.handle(job);
        return;
      default:
        throw new Error(`unknown job type ${String(job.jobType)}`);
    }
  }

  private async failDeadJob(jobId: string): Promise<void> {
    const job = await this.jobs.findById(jobId);
    if (job === null) return;
    await this.failResource(job, {
      code: 'WORKER_ERROR',
      message: job.lastFailureMessage ?? 'attempts exhausted',
    });
  }

  private async failResource(
    job: ProcessingJob,
    failure: {
      code: ReturnType<typeof classifyFailure> extends infer T
        ? T extends { code: infer C }
          ? C
          : never
        : never;
      message: string;
    },
  ): Promise<void> {
    if (job.jobType === ProcessingJobType.DOCUMENT_INGEST) {
      await this.ingest.fail(job, { code: failure.code as never, message: failure.message });
    }
    if (
      job.jobType === ProcessingJobType.DOCX_ANALYSIS ||
      job.jobType === ProcessingJobType.PDF_ANALYSIS
    ) {
      await this.analysis.failPermanently(job);
    }
    if (job.jobType === ProcessingJobType.CHECK_PREPARE) {
      await this.checkPrepare.failPermanently(job);
    }
    if (job.jobType === ProcessingJobType.CHECK_EVALUATION) {
      await this.checkEvaluation.failPermanently(job);
    }
    if (job.jobType === ProcessingJobType.AI_REVIEW) {
      await this.aiReview.failPermanently(job);
    }
    if (job.jobType === ProcessingJobType.STANDARD_SOURCE_INGEST) {
      await this.sourceIngest.failPermanently(job, failure);
    }
    if (job.jobType === ProcessingJobType.RULE_EXTRACTION) {
      await this.ruleExtraction.failPermanently(job, failure);
    }
    if (
      job.jobType === ProcessingJobType.SMARTFIX_EXECUTE ||
      job.jobType === ProcessingJobType.SMARTFIX_FINALIZE
    ) {
      await this.smartFix.failPermanently(job);
    }
    if (job.jobType === ProcessingJobType.SUBMISSION_PREPARE) {
      await this.submissionPrepare.failPermanently(job);
    }
    if (job.jobType === ProcessingJobType.NOTIFICATION_EMAIL_SEND) {
      // The queue ladder is short and fast; the email ladder is long, because
      // a relay outage measured in hours is a reason to try again later, not
      // a reason for somebody never to learn their certificate was revoked.
      await this.notifications.failExhausted(job);
    }
    if (job.jobType === ProcessingJobType.CERTIFICATE_ISSUE) {
      // A certificate whose job died has not failed on its evidence, so it is
      // marked retryable: reconciliation will pick it up again rather than
      // leaving an eligible approval permanently uncertified.
      await this.certificateIssue.failExhausted(job);
    }
    if (job.jobType === ProcessingJobType.WEBHOOK_DELIVER) {
      // PalCert was interrupted; the receiver did nothing wrong. The delivery
      // stays retryable so the webhook ladder can carry it, because marking it
      // permanently failed would let a PalCert outage cancel an organization's
      // webhook on the receiver's behalf.
      await this.webhooks.failExhaustedDelivery(job);
    }
    if (job.jobType === ProcessingJobType.WEBHOOK_ENDPOINT_VERIFY) {
      await this.webhooks.failExhaustedVerification(job);
    }
    if (job.jobType === ProcessingJobType.ATTESTATION_ARTIFACT_INGEST) {
      await this.attestationArtifacts.failPermanently(job, failure);
    }
    if (
      job.jobType === ProcessingJobType.MANUAL_TOPUP_RECEIPT_INGEST ||
      job.jobType === ProcessingJobType.MANUAL_PAYMENT_METHOD_LOGO_INGEST ||
      job.jobType === ProcessingJobType.WITHDRAWAL_PROOF_INGEST
    ) {
      await this.manualTopUpFiles.failPermanently(job, failure);
    }
    // A dead ATTESTATION_PAYMENT job is revived by attestation housekeeping,
    // which finds decided requests whose fee has not moved: the money a
    // decision implies must move eventually, never be abandoned.
    // A fan-out job that died is picked up again by the reconciler, which
    // revives the DEAD job rather than creating a second one — so an eligible
    // event cannot be lost to a transient outage.

    // A purge that ran out of attempts simply stays DEAD for operations to
    // inspect; nothing user-visible depends on it.
  }
}
