import type { PinoLogger } from 'nestjs-pino';
import type { ApiConfigService } from '../../config/api-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { DatabaseMetricsCollector } from './database-metrics.collector';
import { MetricsService } from './metrics.service';

const config = {
  appName: 'palcert-worker',
  appVersion: '0.1.0',
  nodeEnv: 'test',
  release: { commit: 'abc1234' },
} as unknown as ApiConfigService;

const logger = {
  setContext: () => undefined,
  warn: () => undefined,
} as unknown as PinoLogger;

type CountRow = { metric: string; a: string | null; b: string | null; n: bigint };
type AgeRow = { metric: string; a: string | null; seconds: number | null };

/**
 * A Prisma stand-in answering the two operational aggregate functions.
 *
 * The collector reads `app_operational_counts()` and `app_operational_ages()`
 * rather than the tables, because the request-path role cannot read four of
 * them truthfully and one of them at all. The stub matches on the function
 * name so a query aimed at the wrong one gets no rows instead of silently
 * reusing the other's answer.
 */
function prismaReturning(counts: CountRow[], ages: AgeRow[], onQuery?: (sql: string) => void) {
  return {
    $queryRaw: (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      onQuery?.(sql);
      if (sql.includes('app_operational_counts')) return Promise.resolve(counts);
      if (sql.includes('app_operational_ages')) return Promise.resolve(ages);
      return Promise.resolve([]);
    },
  } as unknown as PrismaService;
}

const COUNTS: CountRow[] = [
  { metric: 'jobs', a: 'DOCUMENT_ANALYSIS', b: 'PENDING', n: 4n },
  { metric: 'jobs', a: 'DOCUMENT_ANALYSIS', b: 'RETRY_PENDING', n: 2n },
  { metric: 'jobs', a: 'DOCUMENT_ANALYSIS', b: 'DEAD', n: 1n },
  { metric: 'jobs', a: 'WEBHOOK_DELIVER', b: 'SUCCEEDED', n: 9n },
  { metric: 'job_expired_leases', a: null, b: null, n: 3n },
  { metric: 'notification_deliveries', a: 'EMAIL', b: 'PENDING', n: 3n },
  { metric: 'webhook_deliveries', a: 'FAILED_RETRYABLE', b: null, n: 5n },
  { metric: 'document_analyses', a: 'docx-ooxml', b: 'SUCCEEDED', n: 7n },
  { metric: 'certificates', a: 'ISSUED', b: null, n: 2n },
  { metric: 'balance_topups', a: 'SUCCEEDED', b: null, n: 6n },
  { metric: 'api_clients', a: 'ACTIVE', b: null, n: 1n },
];

const AGES: AgeRow[] = [
  { metric: 'jobs_queued', a: 'DOCUMENT_ANALYSIS', seconds: 42 },
  { metric: 'jobs_running', a: 'DOCUMENT_ANALYSIS', seconds: 7 },
  { metric: 'notifications_pending', a: 'EMAIL', seconds: 90 },
  { metric: 'webhooks_pending', a: null, seconds: 120 },
];

function build(
  counts: CountRow[] = COUNTS,
  ages: AgeRow[] = AGES,
  onQuery?: (sql: string) => void,
) {
  const metrics = new MetricsService(config);
  const collector = new DatabaseMetricsCollector(
    prismaReturning(counts, ages, onQuery),
    metrics,
    logger,
  );
  collector.onModuleInit();
  return { metrics, collector };
}

async function seriesOf(metrics: MetricsService, name: string) {
  const snapshot = await metrics.snapshot();
  return snapshot.find((metric) => metric.name === name)?.values ?? [];
}

describe('DatabaseMetricsCollector', () => {
  it('reads the operational aggregates rather than counting in the process', async () => {
    const seen: string[] = [];
    const { metrics } = build(COUNTS, AGES, (sql) => seen.push(sql));
    await metrics.render();

    expect(seen.some((sql) => sql.includes('app_operational_counts'))).toBe(true);
    expect(seen.some((sql) => sql.includes('app_operational_ages'))).toBe(true);
    expect(await seriesOf(metrics, 'palcert_jobs')).toHaveLength(4);
  });

  it('reports queue depth as PENDING plus RETRY_PENDING for a type', async () => {
    const { metrics } = build();

    expect(await seriesOf(metrics, 'palcert_jobs_queue_depth')).toEqual([
      { labels: { job_type: 'DOCUMENT_ANALYSIS' }, value: 6 },
    ]);
  });

  it('keeps the terminal DEAD count visible and identified by job type', async () => {
    const { metrics } = build();

    expect(await seriesOf(metrics, 'palcert_jobs_dead')).toEqual([
      { labels: { job_type: 'DOCUMENT_ANALYSIS' }, value: 1 },
    ]);
  });

  it('survives a restart, because the reading comes from the ledger', async () => {
    const first = build();
    await first.metrics.render();
    expect(await seriesOf(first.metrics, 'palcert_jobs_dead')).toEqual([
      { labels: { job_type: 'DOCUMENT_ANALYSIS' }, value: 1 },
    ]);

    // A brand-new process, with nothing carried over from the previous one.
    const restarted = build();
    expect(await seriesOf(restarted.metrics, 'palcert_jobs_dead')).toEqual([
      { labels: { job_type: 'DOCUMENT_ANALYSIS' }, value: 1 },
    ]);
  });

  it('clears a series the database no longer reports', async () => {
    let counts = COUNTS;
    const metrics = new MetricsService(config);
    const collector = new DatabaseMetricsCollector(
      {
        $queryRaw: (strings: TemplateStringsArray) =>
          Promise.resolve(strings.join('?').includes('app_operational_counts') ? counts : AGES),
      } as unknown as PrismaService,
      metrics,
      logger,
    );
    collector.onModuleInit();
    expect(await seriesOf(metrics, 'palcert_jobs_dead')).toHaveLength(1);

    counts = [{ metric: 'jobs', a: 'DOCUMENT_ANALYSIS', b: 'SUCCEEDED', n: 12n }];

    // A stale gauge is a lie an alert will act on.
    expect(await seriesOf(metrics, 'palcert_jobs_dead')).toHaveLength(0);
  });

  it('reports backlog age as well as depth', async () => {
    const { metrics } = build();

    expect(await seriesOf(metrics, 'palcert_jobs_oldest_queued_age_seconds')).toEqual([
      { labels: { job_type: 'DOCUMENT_ANALYSIS' }, value: 42 },
    ]);
    expect(await seriesOf(metrics, 'palcert_webhook_oldest_pending_age_seconds')).toEqual([
      { labels: {}, value: 120 },
    ]);
  });

  it('labels notifications by channel and status, never by recipient', async () => {
    const { metrics } = build();

    expect(await seriesOf(metrics, 'palcert_notification_deliveries')).toEqual([
      { labels: { channel: 'EMAIL', status: 'PENDING' }, value: 3 },
    ]);
  });

  it('labels webhooks by status only, never by endpoint or organization', async () => {
    const { metrics } = build();

    expect(await seriesOf(metrics, 'palcert_webhook_deliveries')).toEqual([
      { labels: { status: 'FAILED_RETRYABLE' }, value: 5 },
    ]);
  });

  it('reports top-ups as an outcome count and never as money', async () => {
    const { metrics } = build();
    expect(await seriesOf(metrics, 'palcert_balance_topups')).toEqual([
      { labels: { status: 'SUCCEEDED' }, value: 6 },
    ]);

    // The finance sample lines themselves: the help text says "no amounts",
    // which is the point rather than a leak, and Node's own version metric
    // legitimately carries a `minor` label.
    const samples = (await metrics.render())
      .split('\n')
      .filter((line) => line.startsWith('palcert_balance_topups'));
    expect(samples).toHaveLength(1);
    expect(samples.join('\n')).not.toMatch(/amount|currency|minor|provider|user/i);
  });

  it('ignores a metric family this build does not recognize', async () => {
    const { metrics } = build([
      ...COUNTS,
      { metric: 'something_a_later_migration_added', a: 'x', b: 'y', n: 1n },
    ]);

    // Inventing a label from an unrecognized name is how a closed label set
    // stops being closed.
    expect(await metrics.render()).not.toContain('something_a_later_migration_added');
  });

  it('reports the collector as up once every query answered', async () => {
    const { metrics } = build();
    await metrics.render();

    expect(await seriesOf(metrics, 'palcert_metrics_collector_up')).toEqual([
      { labels: {}, value: 1 },
    ]);
  });

  it('reports the collector as down rather than vanishing when the database fails', async () => {
    const metrics = new MetricsService(config);
    const prisma = {
      $queryRaw: () => Promise.reject(new Error('connection refused')),
    } as unknown as PrismaService;
    const collector = new DatabaseMetricsCollector(prisma, metrics, logger);
    collector.onModuleInit();

    // The scrape still succeeds: a monitoring system that reads nothing at all
    // cannot tell a broken collector from a healthy idle system.
    const text = await metrics.render();
    expect(text).toContain('palcert_metrics_collector_up 0');
    expect(await seriesOf(metrics, 'palcert_metrics_collector_up')).toEqual([
      { labels: {}, value: 0 },
    ]);
  });

  it('measures what observation itself costs', async () => {
    const { metrics } = build();

    const text = await metrics.render();
    expect(text).toMatch(/^palcert_metrics_collector_duration_seconds_count [1-9]\d*$/m);
  });

  it('carries no identifier of any kind into a label', async () => {
    const { metrics } = build();
    const snapshot = await metrics.snapshot();
    const labels = snapshot
      .filter((metric) => metric.name.startsWith('palcert_'))
      .flatMap((metric) => metric.values.flatMap((value) => Object.keys(value.labels ?? {})));

    for (const forbidden of [
      'user_id',
      'organization_id',
      'document_id',
      'email',
      'recipient',
      'client_id',
      'url',
      'error',
    ]) {
      expect(labels).not.toContain(forbidden);
    }
  });
});
