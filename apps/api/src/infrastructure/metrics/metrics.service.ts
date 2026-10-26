import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
  type MetricObjectWithValues,
  type MetricValue,
} from 'prom-client';
import { ApiConfigService } from '../../config/api-config.service';

/**
 * Every metric PalCert emits, declared in one place (Phase 20 Checkpoint 3).
 *
 * Checkpoint 20.1 classified "no metrics, no tracing, no alert hooks" as a
 * release blocker: queue depth, job age and the terminal `DEAD` state were
 * reachable only by querying the database by hand, and nothing could be
 * alerted on.
 *
 * **Vendor-neutral by construction.** The output is the Prometheus text
 * exposition format, which Prometheus, VictoriaMetrics, Grafana Agent,
 * OpenTelemetry Collector, Datadog's OpenMetrics check and every other
 * mainstream platform can scrape. PalCert depends on none of them: it emits a
 * standard format and a deployment points whatever it uses at the endpoint.
 *
 * **Cardinality is the first design constraint, not an afterthought.** Every
 * label in this file is drawn from a closed set — a route template, an HTTP
 * method, a status class, a database enum. Nothing is labelled by user,
 * organization, document, API client, email address, URL or exception text.
 * A metric labelled by an identifier is a memory leak with a dashboard, and
 * the one place that would be tempting — "which document failed?" — is
 * precisely the question logs answer and metrics must not.
 */
@Injectable()
export class MetricsService implements OnModuleDestroy {
  readonly registry = new Registry();

  // --- HTTP ----------------------------------------------------------------

  /**
   * Requests, by normalized route template.
   *
   * `route` is Express's matched route (`/api/v1/documents/:documentId`), never
   * the requested URL: one timeseries per route rather than one per document.
   * An unmatched request is labelled `<unmatched>` rather than by its path,
   * because a 404 scanner would otherwise mint a timeseries per probe.
   */
  readonly httpRequests = new Counter({
    name: 'palcert_http_requests_total',
    help: 'HTTP requests handled, by route template, method and status class.',
    labelNames: ['route', 'method', 'status_class'] as const,
    registers: [this.registry],
  });

  readonly httpDuration = new Histogram({
    name: 'palcert_http_request_duration_seconds',
    help: 'HTTP request duration, by route template and method.',
    labelNames: ['route', 'method'] as const,
    // Tuned to PalCert's shape: most reads are tens of milliseconds, uploads
    // and report reads are seconds. The top bucket is deliberately generous —
    // a request past 10s is an incident, and the +Inf bucket counts it.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly httpInFlight = new Gauge({
    name: 'palcert_http_requests_in_flight',
    help: 'Requests currently being handled by this process.',
    registers: [this.registry],
  });

  // --- Processing jobs -----------------------------------------------------

  /**
   * Job executions this process completed, by type and how they ended.
   *
   * A counter of *events*, complementing the database-backed gauges of
   * *state*: the gauges say how many jobs are DEAD right now, this says how
   * fast they are arriving. `outcome` is `succeeded`, `retried` (the attempt
   * failed and another is due) or `dead` (attempts exhausted) — three values,
   * never the failure code text, which is unbounded prose and belongs in the
   * log line that already carries it.
   */
  readonly jobExecutions = new Counter({
    name: 'palcert_job_executions_total',
    help: 'Job attempts completed by this process, by job type and outcome.',
    labelNames: ['job_type', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly jobDuration = new Histogram({
    name: 'palcert_job_duration_seconds',
    help: 'Wall time of one job attempt, by job type.',
    labelNames: ['job_type'] as const,
    // Analysis and rendering are seconds; an ingest is sub-second; a SmartFix
    // on a large document is tens of seconds. The top bucket is where a lease
    // is at risk, which is the number an operator actually wants.
    buckets: [0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [this.registry],
  });

  // --- Machine credentials (Phase 19) --------------------------------------

  /**
   * Authentication outcomes for API clients.
   *
   * `outcome` is `succeeded` or `refused` and nothing finer. Phase 19 refuses
   * every credential failure identically on the wire precisely so a caller
   * cannot tell "no such client" from "wrong secret"; splitting the metric by
   * reason would rebuild that oracle for anyone who can read the endpoint.
   * The reason is logged, where the administrator who needs it can see it.
   */
  readonly apiClientAuth = new Counter({
    name: 'palcert_api_client_auth_total',
    help: 'API client authentication attempts by outcome.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly apiClientThrottled = new Counter({
    name: 'palcert_api_client_throttled_total',
    help: 'API client requests refused by a rate limit, by which window was spent.',
    labelNames: ['window'] as const,
    registers: [this.registry],
  });

  // --- Object storage ------------------------------------------------------

  /**
   * Object-storage calls, by operation and how they ended.
   *
   * `operation` is the adapter's own closed set of call names; `outcome` is
   * `succeeded`, `not_found`, `refused` (a 4xx PalCert asked for) or
   * `unavailable` (the transport or a 5xx). Bucket names and object keys are
   * absent by design — an object key identifies a document, and a document is
   * somebody's unpublished work.
   *
   * Checkpoint 20.1's frozen scope named storage errors as a minimum
   * production signal, and they are the failure most likely to look like
   * something else: an upload that cannot be stored surfaces to a user as a
   * generic error, and without this it is invisible until somebody reads logs.
   */
  readonly storageOperations = new Counter({
    name: 'palcert_storage_operations_total',
    help: 'Object-storage operations by operation name and outcome.',
    labelNames: ['operation', 'outcome'] as const,
    registers: [this.registry],
  });

  // --- Account security ----------------------------------------------------

  /**
   * Security events, by type.
   *
   * The label is the `SecurityEventType` enum — a closed set of about forty
   * values — and nothing else. Never the user, the address or the reason:
   * `LOGIN_FAILED` rising sharply is the alertable fact, and *whose* login
   * failed is a question the security-event table answers behind the
   * database's access controls.
   */
  readonly securityEvents = new Counter({
    name: 'palcert_security_events_total',
    help: 'Security events recorded, by event type.',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  // --- Scrape health -------------------------------------------------------

  /**
   * Whether the database-backed collectors answered on the last scrape.
   *
   * Without this a database outage makes every job gauge silently vanish, and
   * "no data" reads the same as "no backlog" on a dashboard and in an alert.
   * This makes the difference explicit and alertable.
   */
  readonly collectorUp = new Gauge({
    name: 'palcert_metrics_collector_up',
    help: '1 when the database-backed collectors answered the last scrape, 0 otherwise.',
    registers: [this.registry],
  });

  readonly collectorDuration = new Histogram({
    name: 'palcert_metrics_collector_duration_seconds',
    help: 'Time spent gathering database-backed metrics during a scrape.',
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  constructor(private readonly config: ApiConfigService) {
    // Process-level metrics: heap, event-loop lag, file descriptors, GC. These
    // are the ones that answer "is the runtime itself in trouble?" and they are
    // free.
    collectDefaultMetrics({ register: this.registry, prefix: 'palcert_' });

    // Release identity as a metric, so a dashboard can show which build is
    // serving and an alert can notice a rollout that did not finish. The value
    // is always 1; the labels carry the information, which is the standard
    // "info metric" shape and keeps cardinality at one series per build.
    const release = this.config.release;
    new Gauge({
      name: 'palcert_build_info',
      help: 'Always 1. Labels identify the running build.',
      labelNames: ['service', 'version', 'commit', 'environment'] as const,
      registers: [this.registry],
    }).set(
      {
        service: this.config.appName,
        version: this.config.appVersion,
        commit: release.commit ?? 'unknown',
        environment: this.config.nodeEnv,
      },
      1,
    );
  }

  /**
   * Register work that must run immediately before a scrape is served.
   *
   * prom-client's per-metric `collect` hook would fire once per metric; the
   * database-backed gauges are filled by a handful of aggregate queries that
   * each set several of them, so they refresh as one batch here instead. A
   * refresher is expected to absorb its own failures — a scrape that throws
   * returns no output at all, and a monitoring system reading nothing cannot
   * tell a broken collector from a healthy idle system.
   */
  registerRefresher(refresh: () => Promise<void>): void {
    this.refreshers.push(refresh);
  }

  private readonly refreshers: Array<() => Promise<void>> = [];

  private async refreshAll(): Promise<void> {
    await Promise.all(this.refreshers.map((refresh) => refresh()));
  }

  /** The exposition text a scraper reads. */
  async render(): Promise<string> {
    await this.refreshAll();
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  /** Every currently known series, for tests that assert on cardinality. */
  async snapshot(): Promise<Array<MetricObjectWithValues<MetricValue<string>>>> {
    await this.refreshAll();
    return this.registry.getMetricsAsJSON() as Promise<
      Array<MetricObjectWithValues<MetricValue<string>>>
    >;
  }

  onModuleDestroy(): void {
    this.registry.clear();
  }
}
