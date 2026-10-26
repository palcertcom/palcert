import { collectDefaultMetrics, Gauge, Registry } from 'prom-client';
import { parseBooleanEnv } from '@palcert/config';

/**
 * Server-side telemetry for the Next.js runtime (Phase 20 Checkpoint 3).
 *
 * The web tier is a rendering server, not a domain service: everything worth
 * counting about compliance, jobs or payments already has an authority in the
 * API and the job ledger, and counting it again here would be a second set of
 * numbers to reconcile whenever they disagreed. What only this process can
 * report is its own runtime — heap, event-loop lag, handles, GC — which is
 * exactly what answers "why did the site get slow?" when the API is fine.
 *
 * So this module deliberately emits process metrics and a build identity, and
 * nothing about users, locales, pages or sessions. A per-route panel here
 * would duplicate what the ingress already measures, and a per-user label
 * would be a privacy problem with a dashboard.
 *
 * Built lazily and cached on `globalThis`: Next.js re-evaluates route modules
 * across compilations in development, and a second `collectDefaultMetrics` on
 * a fresh registry would throw on duplicate names.
 */
const CACHE_KEY = Symbol.for('palcert.web.metrics.registry');

interface Cache {
  [CACHE_KEY]?: Registry;
}

export function metricsRegistry(): Registry {
  const cache = globalThis as unknown as Cache;
  const existing = cache[CACHE_KEY];
  if (existing !== undefined) return existing;

  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'palcert_' });

  new Gauge({
    name: 'palcert_build_info',
    help: 'Always 1. Labels identify the running build.',
    labelNames: ['service', 'version', 'commit', 'environment'] as const,
    registers: [registry],
  }).set(
    {
      service: process.env.NEXT_PUBLIC_APP_NAME ?? 'palcert-web',
      version: process.env.APP_VERSION ?? '0.0.0',
      commit: process.env.APP_COMMIT ?? 'unknown',
      environment: process.env.NODE_ENV ?? 'development',
    },
    1,
  );

  cache[CACHE_KEY] = registry;
  return registry;
}

/**
 * Whether telemetry is switched on. Off means the route answers 404.
 *
 * Parsed with the shared rule rather than by hand. The hand-written version
 * was `!== 'false' && !== '0'`, which accepts every other string: a deployment
 * that set `METRICS_ENABLED=no` meaning *off* got it left on, silently
 * (Phase 20 Checkpoint 7). An unrecognized value now resolves to off, because
 * the subject is an exposure surface and an unreadable instruction about one
 * should not be read as "expose it".
 */
export function metricsEnabled(): boolean {
  return parseBooleanEnv(process.env.METRICS_ENABLED, true);
}

/**
 * The bearer token a scrape must present, when one is configured.
 *
 * Topology is the first control — the release proxy has no route to
 * `/metrics` — and this is the second, for a deployment whose internal
 * network is shared.
 */
export function metricsToken(): string | undefined {
  const token = process.env.METRICS_TOKEN;
  return token !== undefined && token.length > 0 ? token : undefined;
}
