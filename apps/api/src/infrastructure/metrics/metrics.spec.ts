import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiConfigService } from '../../config/api-config.service';
import {
  HttpMetricsMiddleware,
  UNMATCHED_ROUTE,
  routeLabel,
  statusClass,
} from './http-metrics.middleware';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

function configFor(metrics: { enabled: boolean; token: string | undefined }): ApiConfigService {
  return {
    appName: 'palcert-api',
    appVersion: '0.1.0',
    nodeEnv: 'test',
    release: { commit: 'abc1234' },
    metrics,
  } as unknown as ApiConfigService;
}

function service(): MetricsService {
  return new MetricsService(configFor({ enabled: true, token: undefined }));
}

/** A request as Express presents it once the router has matched. */
function request(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    originalUrl: '/api/v1/documents/9f3c1f6e-1111-2222-3333-444455556666',
    url: '/api/v1/documents/9f3c1f6e-1111-2222-3333-444455556666',
    baseUrl: '/api/v1/documents',
    route: { path: '/:documentId' },
    ...overrides,
  } as unknown as Request;
}

/** A response that records its listeners so a test can fire them. */
function response(statusCode = 200) {
  const listeners = new Map<string, Array<() => void>>();
  const headers = new Map<string, string>();
  const res = {
    statusCode,
    on(event: string, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return res;
    },
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    headers,
  };
  return res as unknown as Response & { emit(event: string): void; headers: Map<string, string> };
}

async function valueOf(metrics: MetricsService, name: string) {
  const snapshot = await metrics.snapshot();
  return snapshot.find((metric) => metric.name === name);
}

describe('routeLabel', () => {
  it('uses the matched template rather than the requested path', () => {
    expect(routeLabel(request())).toBe('/api/v1/documents/:documentId');
  });

  it('never leaks an identifier when no route matched', () => {
    const unmatched = request({ route: undefined, baseUrl: '' });
    expect(routeLabel(unmatched)).toBe(UNMATCHED_ROUTE);
    expect(routeLabel(unmatched)).not.toContain('9f3c1f6e');
  });

  it('falls back to the constant for an empty template', () => {
    expect(routeLabel(request({ route: { path: '' }, baseUrl: '' } as Partial<Request>))).toBe(
      UNMATCHED_ROUTE,
    );
  });
});

describe('statusClass', () => {
  it.each([
    [200, '2xx'],
    [204, '2xx'],
    [302, '3xx'],
    [404, '4xx'],
    [503, '5xx'],
  ])('maps %i to %s', (code, expected) => {
    expect(statusClass(code)).toBe(expected);
  });

  it('refuses to mint a label for a nonsense status', () => {
    expect(statusClass(0)).toBe('unknown');
    expect(statusClass(999)).toBe('unknown');
  });
});

describe('HttpMetricsMiddleware', () => {
  it('records one observation per request, labelled by template', async () => {
    const metrics = service();
    const middleware = new HttpMetricsMiddleware(metrics);
    const res = response(201);

    middleware.use(request(), res, () => undefined);
    res.emit('finish');

    const counter = await valueOf(metrics, 'palcert_http_requests_total');
    expect(counter?.values).toHaveLength(1);
    expect(counter?.values[0]?.labels).toEqual({
      route: '/api/v1/documents/:documentId',
      method: 'GET',
      status_class: '2xx',
    });
    expect(counter?.values[0]?.value).toBe(1);
  });

  it('counts once when both finish and close fire', async () => {
    const metrics = service();
    const middleware = new HttpMetricsMiddleware(metrics);
    const res = response();

    middleware.use(request(), res, () => undefined);
    res.emit('finish');
    res.emit('close');

    const counter = await valueOf(metrics, 'palcert_http_requests_total');
    expect(counter?.values[0]?.value).toBe(1);
  });

  it('releases the in-flight gauge when a client disconnects without finishing', async () => {
    const metrics = service();
    const middleware = new HttpMetricsMiddleware(metrics);
    const res = response();

    middleware.use(request(), res, () => undefined);
    const during = await valueOf(metrics, 'palcert_http_requests_in_flight');
    expect(during?.values[0]?.value).toBe(1);

    res.emit('close');
    const after = await valueOf(metrics, 'palcert_http_requests_in_flight');
    expect(after?.values[0]?.value).toBe(0);
  });

  it('ignores probe and scrape traffic so it cannot dominate every panel', async () => {
    const metrics = service();
    const middleware = new HttpMetricsMiddleware(metrics);

    for (const path of ['/health/ready', '/health/live', '/metrics']) {
      const res = response();
      middleware.use(request({ originalUrl: path, url: path }), res, () => undefined);
      res.emit('finish');
    }

    const counter = await valueOf(metrics, 'palcert_http_requests_total');
    expect(counter?.values ?? []).toHaveLength(0);
  });

  it('does not mint a timeseries per probed path when nothing matched', async () => {
    const metrics = service();
    const middleware = new HttpMetricsMiddleware(metrics);

    for (const path of ['/wp-admin', '/.env', '/phpmyadmin']) {
      const res = response(404);
      middleware.use(
        request({ originalUrl: path, url: path, baseUrl: '', route: undefined }),
        res,
        () => undefined,
      );
      res.emit('finish');
    }

    const counter = await valueOf(metrics, 'palcert_http_requests_total');
    expect(counter?.values).toHaveLength(1);
    expect(counter?.values[0]?.labels.route).toBe(UNMATCHED_ROUTE);
    expect(counter?.values[0]?.value).toBe(3);
  });
});

describe('MetricsService', () => {
  it('publishes the running build as labels on a constant gauge', async () => {
    const metrics = service();
    const info = await valueOf(metrics, 'palcert_build_info');
    expect(info?.values[0]?.value).toBe(1);
    expect(info?.values[0]?.labels).toEqual({
      service: 'palcert-api',
      version: '0.1.0',
      commit: 'abc1234',
      environment: 'test',
    });
  });

  it('exposes process metrics so runtime trouble is visible without a vendor agent', async () => {
    const text = await service().render();
    expect(text).toContain('palcert_process_resident_memory_bytes');
    expect(text).toContain('palcert_nodejs_eventloop_lag_seconds');
  });

  it('renders the Prometheus text exposition format', async () => {
    const metrics = service();
    expect(metrics.contentType).toContain('text/plain');
    expect(await metrics.render()).toMatch(/^# HELP /m);
  });

  it('runs registered refreshers before serving a scrape', async () => {
    const metrics = service();
    let refreshed = 0;
    metrics.registerRefresher(async () => {
      refreshed += 1;
    });

    await metrics.render();
    await metrics.render();
    expect(refreshed).toBe(2);
  });
});

describe('metric label declarations', () => {
  /**
   * Every metric, exercised with the labels its call sites actually pass.
   *
   * prom-client validates labels at *observe* time, not at declaration time,
   * so a metric declared without its `labelNames` looks perfectly healthy
   * until the first real observation throws. That is exactly what happened to
   * `palcert_job_duration_seconds`, and because the observation sat inside
   * the worker's job try-block, the throw was caught as a job failure — a
   * job that had already succeeded was told to retry, and the ledger's guard
   * refused the transition.
   *
   * Cheap to write, and it fails at the declaration rather than in
   * production.
   */
  it('accepts the labels every call site passes', () => {
    const metrics = service();

    expect(() => {
      metrics.httpRequests.inc({ route: '/r', method: 'GET', status_class: '2xx' });
      metrics.httpDuration.observe({ route: '/r', method: 'GET' }, 0.1);
      metrics.httpInFlight.inc();
      metrics.httpInFlight.dec();
      metrics.jobExecutions.inc({ job_type: 'WEBHOOK_DELIVER', outcome: 'succeeded' });
      metrics.jobDuration.startTimer({ job_type: 'WEBHOOK_DELIVER' })();
      metrics.jobDuration.observe({ job_type: 'WEBHOOK_DELIVER' }, 1);
      metrics.storageOperations.inc({ operation: 'putObject', outcome: 'succeeded' });
      metrics.securityEvents.inc({ type: 'LOGIN_FAILED' });
      metrics.apiClientAuth.inc({ outcome: 'refused' });
      metrics.apiClientThrottled.inc({ window: 'auth' });
      metrics.collectorUp.set(1);
      metrics.collectorDuration.startTimer()();
    }).not.toThrow();
  });

  it('refuses a label nobody declared, which is why the test above exists', () => {
    const metrics = service();

    expect(() => metrics.httpInFlight.inc({ route: '/r' } as never)).toThrow();
  });
});

describe('operational event counters', () => {
  it('records storage outcomes by operation, never by bucket or key', async () => {
    const metrics = service();

    metrics.storageOperations.inc({ operation: 'putObject', outcome: 'succeeded' });
    metrics.storageOperations.inc({ operation: 'getObjectStream', outcome: 'unavailable' });
    metrics.storageOperations.inc({ operation: 'headObject', outcome: 'not_found' });

    const counter = await valueOf(metrics, 'palcert_storage_operations_total');
    expect(counter?.values).toHaveLength(3);
    expect(counter?.values.map((value) => value.labels.outcome).sort()).toEqual([
      'not_found',
      'succeeded',
      'unavailable',
    ]);

    // An object key identifies a document, and a document is somebody's
    // unpublished work. Neither it nor the bucket has anywhere to go here.
    const labelNames = counter?.values.flatMap((value) => Object.keys(value.labels)) ?? [];
    expect([...new Set(labelNames)].sort()).toEqual(['operation', 'outcome']);
  });

  it('records security events by type and by nothing else', async () => {
    const metrics = service();

    metrics.securityEvents.inc({ type: 'LOGIN_FAILED' });
    metrics.securityEvents.inc({ type: 'LOGIN_FAILED' });
    metrics.securityEvents.inc({ type: 'LOGIN_SUCCEEDED' });

    const counter = await valueOf(metrics, 'palcert_security_events_total');
    const failed = counter?.values.find((value) => value.labels.type === 'LOGIN_FAILED');
    expect(failed?.value).toBe(2);

    // Whose login failed is a question the security-event table answers.
    const labelNames = counter?.values.flatMap((value) => Object.keys(value.labels)) ?? [];
    expect([...new Set(labelNames)]).toEqual(['type']);
  });

  it('keeps API client authentication to two outcomes', async () => {
    const metrics = service();

    metrics.apiClientAuth.inc({ outcome: 'succeeded' });
    metrics.apiClientAuth.inc({ outcome: 'refused' });

    // Phase 19 refuses every credential failure identically on the wire so a
    // caller cannot tell "no such client" from "wrong secret". A metric split
    // by reason would rebuild that oracle for anyone who can read this.
    const counter = await valueOf(metrics, 'palcert_api_client_auth_total');
    expect(counter?.values.map((value) => value.labels.outcome).sort()).toEqual([
      'refused',
      'succeeded',
    ]);
  });
});

describe('MetricsController', () => {
  it('serves the exposition with no-store when telemetry is on and open', async () => {
    const metrics = service();
    const res = response();
    const controller = new MetricsController(
      metrics,
      configFor({ enabled: true, token: undefined }),
    );

    const body = await controller.scrape(res);
    expect(body).toContain('palcert_build_info');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Type')).toContain('text/plain');
  });

  it('looks like it was never built when telemetry is disabled', async () => {
    const controller = new MetricsController(
      service(),
      configFor({ enabled: false, token: undefined }),
    );
    await expect(controller.scrape(response())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses every wrong or missing token when one is configured', async () => {
    const controller = new MetricsController(
      service(),
      configFor({ enabled: true, token: 'scrape-secret' }),
    );

    for (const header of [
      undefined,
      '',
      'scrape-secret',
      'Basic scrape-secret',
      'Bearer wrong',
      'Bearer scrape-secre',
      'Bearer scrape-secrett',
    ]) {
      await expect(controller.scrape(response(), header)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
  });

  it('accepts the configured token, case-insensitively on the scheme', async () => {
    const controller = new MetricsController(
      service(),
      configFor({ enabled: true, token: 'scrape-secret' }),
    );

    await expect(controller.scrape(response(), 'Bearer scrape-secret')).resolves.toContain(
      'palcert_build_info',
    );
    await expect(controller.scrape(response(), 'bearer scrape-secret')).resolves.toContain(
      'palcert_build_info',
    );
  });

  it('never echoes the configured token in what it serves', async () => {
    const controller = new MetricsController(
      service(),
      configFor({ enabled: true, token: 'scrape-secret' }),
    );
    const body = await controller.scrape(response(), 'Bearer scrape-secret');
    expect(body).not.toContain('scrape-secret');
  });
});
