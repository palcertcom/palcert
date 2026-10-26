import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/metrics/route';
import type { NextRequest } from 'next/server';

/**
 * The web tier's scrape endpoint (Phase 20 Checkpoint 3).
 *
 * The assertions are about exposure and about absence: what a scrape reveals
 * when nobody protected it, and that a rendering server publishes nothing
 * about the people using it.
 */
function request(authorization?: string): NextRequest {
  return {
    headers: new Headers(authorization === undefined ? {} : { authorization }),
  } as unknown as NextRequest;
}

const SAVED = { ...process.env };

beforeEach(() => {
  delete process.env.METRICS_ENABLED;
  delete process.env.METRICS_TOKEN;
  process.env.APP_COMMIT = 'abc1234';
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe('web metrics route', () => {
  it('serves the Prometheus text exposition, uncacheable', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/plain');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('# HELP palcert_build_info');
  });

  it('reports the runtime signals only this process can report', async () => {
    const body = await (await GET(request())).text();

    expect(body).toContain('palcert_process_resident_memory_bytes');
    expect(body).toContain('palcert_nodejs_eventloop_lag_seconds');
  });

  it('identifies the running build', async () => {
    const body = await (await GET(request())).text();

    expect(body).toMatch(/palcert_build_info\{[^}]*commit="abc1234"[^}]*\} 1/);
  });

  it('looks like it was never built when telemetry is disabled', async () => {
    process.env.METRICS_ENABLED = 'false';

    expect((await GET(request())).status).toBe(404);
  });

  it('refuses every wrong or missing token when one is configured', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret';

    for (const header of [
      undefined,
      'scrape-secret',
      'Basic scrape-secret',
      'Bearer wrong',
      'Bearer scrape-secre',
      'Bearer scrape-secrett',
    ]) {
      expect((await GET(request(header))).status).toBe(403);
    }
  });

  it('accepts the configured token and never echoes it', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret';

    const response = await GET(request('Bearer scrape-secret'));

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('scrape-secret');
  });

  it('publishes nothing about a user, a locale or a page', async () => {
    // Label *names*, not substrings of metric names: Node's own
    // `process_cpu_user_seconds_total` legitimately contains "user", and a
    // test that fails on that is a test nobody will keep.
    const labelNames = (await (await GET(request())).text())
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .flatMap((line) => [...(/\{(.*)\}/.exec(line)?.[1] ?? '').matchAll(/([A-Za-z_]+)=/g)])
      .map((match) => match[1]);

    for (const forbidden of [
      'user',
      'user_id',
      'session',
      'locale',
      'organization',
      'document',
      'email',
      'path',
      'url',
    ]) {
      expect(labelNames).not.toContain(forbidden);
    }
  });
});
