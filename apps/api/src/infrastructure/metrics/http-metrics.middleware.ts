import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/** What an unmatched request is labelled, so a 404 scanner mints no series. */
export const UNMATCHED_ROUTE = '<unmatched>';

/**
 * The route template a request matched, or a constant.
 *
 * Express sets `req.route.path` to the declared pattern — `/:documentId`, not
 * `/9f3c…` — which is exactly the bounded label a metric needs. `baseUrl`
 * carries the prefix the router was mounted under, so the two together are the
 * full template.
 *
 * Exported because the cardinality test asserts directly on it: the property
 * that matters is "no identifier ever reaches a label", and it is cheaper to
 * prove here than by scraping and pattern-matching the output.
 */
export function routeLabel(request: Request): string {
  const template = (request.route as { path?: string } | undefined)?.path;
  if (typeof template !== 'string' || template.length === 0) return UNMATCHED_ROUTE;

  const base = typeof request.baseUrl === 'string' ? request.baseUrl : '';
  const full = `${base}${template}`;
  return full.length > 0 ? full : UNMATCHED_ROUTE;
}

/** `2xx`, `4xx`… — five values instead of sixty. */
export function statusClass(statusCode: number): string {
  if (statusCode < 100 || statusCode > 599) return 'unknown';
  return `${Math.floor(statusCode / 100)}xx`;
}

/**
 * HTTP request metrics (Phase 20 Checkpoint 3).
 *
 * Middleware rather than an interceptor, for one reason that matters:
 * `req.route` is only populated once the router has matched, so the label has
 * to be read when the response finishes rather than when the request starts.
 * `res.on('finish')` also counts responses a Nest exception filter produced,
 * which an interceptor's error path can miss — and a metric that undercounts
 * failures is worse than no metric.
 *
 * Health and metrics endpoints are excluded: probes run every few seconds and
 * would dominate every rate and latency panel with traffic that is not
 * traffic.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const path = request.originalUrl ?? request.url ?? '';
    if (path.startsWith('/health') || path.startsWith('/metrics')) {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();
    this.metrics.httpInFlight.inc();

    let settled = false;
    const settle = (): void => {
      // `finish` and `close` can both fire — a client that disconnects mid
      // response produces the second without the first. Counting twice would
      // inflate every rate, and leaving the in-flight gauge incremented on a
      // dropped connection would make it climb forever.
      if (settled) return;
      settled = true;

      this.metrics.httpInFlight.dec();
      const route = routeLabel(request);
      const method = request.method;
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

      this.metrics.httpRequests.inc({
        route,
        method,
        status_class: statusClass(response.statusCode),
      });
      this.metrics.httpDuration.observe({ route, method }, seconds);
    };

    response.on('finish', settle);
    response.on('close', settle);
    next();
  }
}
