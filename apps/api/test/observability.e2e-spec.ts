import request from 'supertest';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../src/config/api-config.service';
import { DatabaseMetricsCollector } from '../src/infrastructure/metrics/database-metrics.collector';
import { MetricsService } from '../src/infrastructure/metrics/metrics.service';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Telemetry against a real database (Phase 20 Checkpoint 3).
 *
 * The properties that matter about these metrics are properties of the whole
 * system, not of a function: that the numbers come from the job ledger rather
 * than from a process's memory, that they survive a restart, and that none of
 * them carries an identifier. Only a running stack can show that.
 */
describe('Observability (e2e)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  const server = () => context.app.getHttpServer();
  const scrape = async () => (await request(server()).get('/metrics').expect(200)).text;

  /**
   * A terminal job, exactly as the worker leaves one after exhausting attempts.
   *
   * A webhook delivery rather than a document analysis: the ledger's tenancy
   * check requires an owner for user-scoped work, and this suite is about
   * telemetry rather than about tenancy. A system-scoped job needs no fixture
   * user to exist.
   */
  async function insertDeadJob(jobType: string, resourceId: string): Promise<void> {
    await context.adminDb.processingJob.create({
      data: {
        jobType: jobType as never,
        resourceType: 'WEBHOOK_DELIVERY',
        resourceId,
        idempotencyKey: `${jobType}:${resourceId}`,
        status: 'DEAD',
        attemptCount: 5,
        maxAttempts: 5,
        lastFailureCode: 'WORKER_ERROR',
        lastFailureMessage: 'attempts exhausted',
        deadAt: new Date(),
      },
    });
  }

  /**
   * A collector reading the same database from nothing but the database.
   *
   * This is what a restarted worker is: a fresh process with an empty
   * registry. If the gauges were counted in memory, this would read zero.
   */
  async function freshProcessScrape(): Promise<string> {
    const metrics = new MetricsService(context.app.get(ApiConfigService));
    // A silent logger rather than the application's: `PinoLogger` is
    // request-scoped and cannot be pulled out of the container, and this test
    // is about what the collector reads, not what it writes.
    const logger = {
      setContext: () => undefined,
      warn: () => undefined,
    } as unknown as PinoLogger;
    const collector = new DatabaseMetricsCollector(context.app.get(PrismaService), metrics, logger);
    collector.onModuleInit();
    return metrics.render();
  }

  afterEach(async () => {
    await resetState(context);
  });

  it('serves the Prometheus exposition without authentication or a version prefix', async () => {
    const body = await scrape();

    expect(body).toContain('# HELP palcert_build_info');
    expect(body).toContain('palcert_jobs_queue_depth');
    await request(server()).get('/api/v1/metrics').expect(404);
  });

  it('reports the DEAD count from the ledger, identified by job type', async () => {
    const resourceId = '11111111-2222-3333-4444-555555555555';
    await insertDeadJob('DOCX_ANALYSIS', resourceId);

    const body = await scrape();

    expect(body).toMatch(/^palcert_jobs_dead\{job_type="DOCX_ANALYSIS"\} 1$/m);
    expect(body).toMatch(/^palcert_jobs\{job_type="DOCX_ANALYSIS",status="DEAD"\} 1$/m);
  });

  it('keeps the DEAD signal across a restart, because the ledger holds it', async () => {
    await insertDeadJob('DOCX_ANALYSIS', '11111111-2222-3333-4444-555555555556');

    // Restarting the worker is the first thing somebody tries when jobs are
    // failing. A process-local counter would zero here and the alert would
    // clear itself — which is precisely the failure this design avoids.
    const afterRestart = await freshProcessScrape();

    expect(afterRestart).toMatch(/^palcert_jobs_dead\{job_type="DOCX_ANALYSIS"\} 1$/m);
  });

  it('never carries the job, the resource or the failure text into a label', async () => {
    const resourceId = '11111111-2222-3333-4444-555555555557';
    await insertDeadJob('DOCX_ANALYSIS', resourceId);

    const body = await scrape();

    expect(body).not.toContain(resourceId);
    expect(body).not.toContain('attempts exhausted');
    expect(body).not.toContain('WEBHOOK_DELIVERY');
    // No UUID anywhere: one would mean a timeseries per document, user or
    // organization, which is a memory leak with a dashboard.
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('reports queue depth and backlog age from waiting work', async () => {
    await context.adminDb.processingJob.create({
      data: {
        jobType: 'WEBHOOK_FANOUT' as never,
        resourceType: 'DOMAIN_EVENT',
        resourceId: '22222222-2222-3333-4444-555555555555',
        idempotencyKey: 'WEBHOOK_FANOUT:22222222-2222-3333-4444-555555555555',
        status: 'PENDING',
        maxAttempts: 5,
        availableAt: new Date(Date.now() - 120_000),
      },
    });

    const body = await scrape();

    expect(body).toMatch(/^palcert_jobs_queue_depth\{job_type="WEBHOOK_FANOUT"\} 1$/m);
    const age = /^palcert_jobs_oldest_queued_age_seconds\{job_type="WEBHOOK_FANOUT"\} (\d+)/m.exec(
      body,
    );
    expect(Number(age?.[1] ?? 0)).toBeGreaterThanOrEqual(100);
  });

  it('says the collectors answered, so an outage cannot look like an idle system', async () => {
    expect(await scrape()).toMatch(/^palcert_metrics_collector_up 1$/m);
  });

  it('labels HTTP traffic by route template, never by the requested URL', async () => {
    await request(server()).get('/api/v1/documents/9f3c1f6e-1111-2222-3333-444455556666');

    const body = await scrape();
    const httpLines = body
      .split('\n')
      .filter((line) => line.startsWith('palcert_http_requests_total{'));

    expect(httpLines.length).toBeGreaterThan(0);
    expect(httpLines.every((line) => !line.includes('9f3c1f6e'))).toBe(true);
  });

  it('does not count its own scrapes or the health probes as traffic', async () => {
    await request(server()).get('/health/ready');
    await scrape();

    const body = await scrape();
    const httpLines = body
      .split('\n')
      .filter((line) => line.startsWith('palcert_http_requests_total{'));

    expect(httpLines.some((line) => line.includes('/health'))).toBe(false);
    expect(httpLines.some((line) => line.includes('/metrics'))).toBe(false);
  });

  it('keeps the series count bounded no matter how many distinct URLs are probed', async () => {
    const before = (await scrape())
      .split('\n')
      .filter((line) => line.startsWith('palcert_http_requests_total{')).length;

    for (let index = 0; index < 25; index += 1) {
      await request(server()).get(`/api/v1/does-not-exist-${index}`);
    }

    const after = (await scrape())
      .split('\n')
      .filter((line) => line.startsWith('palcert_http_requests_total{')).length;

    // At most one new series — the `<unmatched>` bucket — for 25 distinct
    // paths. Telemetry must not become a memory leak.
    expect(after - before).toBeLessThanOrEqual(1);
  });
});
