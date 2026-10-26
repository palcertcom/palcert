import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Gauge } from 'prom-client';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from './metrics.service';

/** One row of `app_operational_counts()`. */
interface CountRow {
  readonly metric: string;
  readonly a: string | null;
  readonly b: string | null;
  readonly n: bigint;
}

/** One row of `app_operational_ages()`. */
interface AgeRow {
  readonly metric: string;
  readonly a: string | null;
  readonly seconds: number | null;
}

/**
 * Operational state read from the database at scrape time
 * (Phase 20 Checkpoint 3, §4).
 *
 * **Why the database and not a counter in the worker.** The job ledger is the
 * authority — Phase 5 put it there deliberately, and the lease/reclaim model
 * depends on it. A worker-local counter would answer a different question:
 * "how many jobs has *this process* seen since *it* started". Queue depth
 * would reset on every deploy, a backlog would vanish when the worker that
 * built it restarted, and the `DEAD` terminal state — the specific signal
 * Checkpoint 20.1 called out — would disappear exactly when somebody
 * restarted the worker to try to fix it.
 *
 * Reading the ledger instead means every one of these gauges survives a
 * restart, is identical on every replica, and says what is actually true
 * rather than what one process remembers.
 *
 * **Why two SECURITY DEFINER functions and not seven queries.** Reading the
 * tables directly from the request-path role does not work, and the way it
 * fails is the dangerous part: `webhook_deliveries` carries no SELECT grant
 * for that role at all, and four of the others have row-level security
 * FORCEd, so the same aggregate outside a tenant context returns zero rows
 * and the gauge reports a confident, wrong 0. A dashboard showing no backlog
 * because it cannot see the backlog is worse than no dashboard. The functions
 * (Phase 20 migration `phase20_operational_metrics`) return counts and
 * timestamps only — never a row, an identifier, a payload, an amount or an
 * address — and are granted EXECUTE rather than table SELECT, so the app
 * role's table privileges are exactly what they were.
 *
 * **Cost.** These run once per scrape, not per request. Each is an aggregate
 * over an indexed column; the whole set is measured into
 * `palcert_metrics_collector_duration_seconds` so the cost of observing is
 * itself observable. If a scrape fails, `palcert_metrics_collector_up` goes to
 * 0 rather than the gauges silently disappearing — "no data" and "no backlog"
 * must not look the same.
 *
 * Every gauge declares `registers: []` and is attached to the service's own
 * registry in the constructor. Left to default, prom-client would also put it
 * on the global registry, where a second instance — every test that builds
 * one — collides by name.
 *
 * **Cardinality.** Every label is a database enum: job type (20), job status
 * (6), delivery status (6), analysis status, issuance status. Nothing is
 * labelled by organization, user, document or error text.
 */
@Injectable()
export class DatabaseMetricsCollector implements OnModuleInit {
  private readonly gauges = {
    jobs: new Gauge({
      name: 'palcert_jobs',
      help: 'Processing jobs in the ledger, by type and status.',
      labelNames: ['job_type', 'status'] as const,
      registers: [],
    }),
    queueDepth: new Gauge({
      name: 'palcert_jobs_queue_depth',
      help: 'Jobs waiting to be claimed (PENDING or RETRY_PENDING), by type.',
      labelNames: ['job_type'] as const,
      registers: [],
    }),
    oldestQueuedAge: new Gauge({
      name: 'palcert_jobs_oldest_queued_age_seconds',
      help: 'Age of the oldest job waiting to be claimed, by type. 0 when none waits.',
      labelNames: ['job_type'] as const,
      registers: [],
    }),
    oldestRunningAge: new Gauge({
      name: 'palcert_jobs_oldest_running_age_seconds',
      help: 'Age of the oldest job currently claimed, by type. 0 when none runs.',
      labelNames: ['job_type'] as const,
      registers: [],
    }),
    dead: new Gauge({
      name: 'palcert_jobs_dead',
      help: 'Jobs in the terminal DEAD state, by type. Never clears on its own.',
      labelNames: ['job_type'] as const,
      registers: [],
    }),
    retrying: new Gauge({
      name: 'palcert_jobs_retrying',
      help: 'Jobs that have failed at least once and are awaiting a retry, by type.',
      labelNames: ['job_type'] as const,
      registers: [],
    }),
    expiredLeases: new Gauge({
      name: 'palcert_jobs_expired_leases',
      help: 'Claimed jobs whose lease has lapsed and which a sweep will reclaim.',
      registers: [],
    }),
    notifications: new Gauge({
      name: 'palcert_notification_deliveries',
      help: 'Notification deliveries by channel and status.',
      labelNames: ['channel', 'status'] as const,
      registers: [],
    }),
    notificationOldestPending: new Gauge({
      name: 'palcert_notification_oldest_pending_age_seconds',
      help: 'Age of the oldest notification delivery not yet sent, by channel.',
      labelNames: ['channel'] as const,
      registers: [],
    }),
    webhooks: new Gauge({
      name: 'palcert_webhook_deliveries',
      help: 'Webhook deliveries by status.',
      labelNames: ['status'] as const,
      registers: [],
    }),
    webhookOldestPending: new Gauge({
      name: 'palcert_webhook_oldest_pending_age_seconds',
      help: 'Age of the oldest webhook delivery not yet delivered.',
      registers: [],
    }),
    analyses: new Gauge({
      name: 'palcert_document_analyses',
      help: 'Document analyses by analyzer and status.',
      labelNames: ['analyzer', 'status'] as const,
      registers: [],
    }),
    certificates: new Gauge({
      name: 'palcert_certificates',
      help: 'Compliance certificates by issuance status.',
      labelNames: ['issuance_status'] as const,
      registers: [],
    }),
    topups: new Gauge({
      name: 'palcert_balance_topups',
      help: 'Balance top-ups by status. Operational outcome only — no amounts.',
      labelNames: ['status'] as const,
      registers: [],
    }),
    apiClients: new Gauge({
      name: 'palcert_api_clients',
      help: 'API clients by status.',
      labelNames: ['status'] as const,
      registers: [],
    }),
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DatabaseMetricsCollector.name);
    for (const gauge of Object.values(this.gauges)) {
      this.metrics.registry.registerMetric(gauge);
    }
  }

  onModuleInit(): void {
    // Refreshed immediately before every scrape, so the readings are
    // point-in-time rather than a cache somebody has to remember to update.
    this.metrics.registerRefresher(() => this.refresh());
  }

  /**
   * Re-read every gauge from the database.
   *
   * Public so a test can drive it without scraping, and so the release-stack
   * smoke test can assert the values rather than the format.
   */
  async refresh(): Promise<void> {
    const endTimer = this.metrics.collectorDuration.startTimer();
    try {
      const [counts, ages] = await Promise.all([
        this.prisma.$queryRaw<CountRow[]>`SELECT * FROM app_operational_counts()`,
        this.prisma.$queryRaw<AgeRow[]>`SELECT * FROM app_operational_ages()`,
      ]);
      this.applyCounts(counts);
      this.applyAges(ages);
      this.metrics.collectorUp.set(1);
    } catch (error) {
      // Deliberately not rethrown: a scrape that fails entirely produces no
      // output at all, and a monitoring system reading nothing cannot tell a
      // broken collector from a healthy idle system. Reporting 0 here makes
      // the failure itself the alertable signal.
      this.metrics.collectorUp.set(0);
      this.logger.warn({ err: error }, 'Database-backed metrics collection failed');
    } finally {
      endTimer();
    }
  }

  private applyCounts(rows: readonly CountRow[]): void {
    // Reset before applying, so a series the database no longer reports
    // disappears instead of freezing at its last value. A stale gauge is a
    // lie that an alert will act on.
    this.gauges.jobs.reset();
    this.gauges.queueDepth.reset();
    this.gauges.dead.reset();
    this.gauges.retrying.reset();
    this.gauges.notifications.reset();
    this.gauges.webhooks.reset();
    this.gauges.analyses.reset();
    this.gauges.certificates.reset();
    this.gauges.topups.reset();
    this.gauges.apiClients.reset();

    const queued = new Map<string, number>();
    for (const row of rows) {
      const a = row.a ?? 'unknown';
      const b = row.b ?? 'unknown';
      const n = Number(row.n);

      switch (row.metric) {
        case 'jobs': {
          this.gauges.jobs.set({ job_type: a, status: b }, n);
          if (b === 'PENDING' || b === 'RETRY_PENDING') {
            queued.set(a, (queued.get(a) ?? 0) + n);
          }
          if (b === 'RETRY_PENDING') this.gauges.retrying.set({ job_type: a }, n);
          if (b === 'DEAD') this.gauges.dead.set({ job_type: a }, n);
          break;
        }
        case 'job_expired_leases':
          this.gauges.expiredLeases.set(n);
          break;
        case 'notification_deliveries':
          this.gauges.notifications.set({ channel: a, status: b }, n);
          break;
        case 'webhook_deliveries':
          this.gauges.webhooks.set({ status: a }, n);
          break;
        case 'document_analyses':
          this.gauges.analyses.set({ analyzer: a, status: b }, n);
          break;
        case 'certificates':
          this.gauges.certificates.set({ issuance_status: a }, n);
          break;
        case 'balance_topups':
          // Status only. Amounts, currencies, provider references and
          // anything that could describe one customer's spending stay out of
          // telemetry entirely — this is an operational failure signal, and a
          // finance metric that carried money would be a reporting surface
          // nobody authorized.
          this.gauges.topups.set({ status: a }, n);
          break;
        case 'api_clients':
          this.gauges.apiClients.set({ status: a }, n);
          break;
        default:
          // A metric family the database knows about and this build does not.
          // Ignored rather than guessed at: inventing a label from an
          // unrecognized name is how a closed label set stops being closed.
          break;
      }
    }

    for (const [jobType, n] of queued) this.gauges.queueDepth.set({ job_type: jobType }, n);
  }

  private applyAges(rows: readonly AgeRow[]): void {
    this.gauges.oldestQueuedAge.reset();
    this.gauges.oldestRunningAge.reset();
    this.gauges.notificationOldestPending.reset();

    // Nothing pending means no age at all, which reads as 0 rather than as a
    // missing series: an alert on an absent series is an alert that never
    // fires.
    this.gauges.webhookOldestPending.set(0);

    for (const row of rows) {
      const a = row.a ?? 'unknown';
      const seconds = Math.max(0, row.seconds ?? 0);

      switch (row.metric) {
        case 'jobs_queued':
          this.gauges.oldestQueuedAge.set({ job_type: a }, seconds);
          break;
        case 'jobs_running':
          this.gauges.oldestRunningAge.set({ job_type: a }, seconds);
          break;
        case 'notifications_pending':
          this.gauges.notificationOldestPending.set({ channel: a }, seconds);
          break;
        case 'webhooks_pending':
          this.gauges.webhookOldestPending.set(seconds);
          break;
        default:
          break;
      }
    }
  }
}
