import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { Public } from '../../modules/auth/decorators/auth.decorators';
import { ApiConfigService } from '../../config/api-config.service';
import { MetricsService } from './metrics.service';

/**
 * The scrape endpoint (Phase 20 Checkpoint 3, §13).
 *
 * Mounted outside the versioned `/api/v1` prefix and version-neutral, for the
 * same reason the health probes are: this is operational infrastructure, not
 * part of the product API contract, and a scrape URL must stay stable across
 * API versions.
 *
 * **It is excluded from the OpenAPI document.** Publishing "here is the
 * endpoint that describes everything this system is doing" in the public API
 * specification would be an odd way to keep it internal.
 *
 * **Two independent controls, and the first one is topology.** The reverse
 * proxy has no `location` for `/metrics`, so an external request never reaches
 * this handler — proved in the release stack, not asserted. `METRICS_TOKEN` is
 * the second lock for deployments whose internal network is shared; when it is
 * unset the endpoint sits at the same trust level as `/health`, which is a
 * deliberate choice a deployment makes rather than a default that pretends to
 * be security.
 *
 * Throttling is skipped: a scraper hitting a fixed interval is not abuse, and
 * a rate-limited metrics endpoint produces gaps that look like an outage.
 */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ApiConfigService,
  ) {}

  @Get()
  async scrape(
    @Res({ passthrough: true }) response: Response,
    @Headers('authorization') authorization?: string,
  ): Promise<string> {
    const { enabled, token } = this.config.metrics;

    // 404, not 403: a deployment that has turned telemetry off should look
    // like one that never had it, rather than advertising a disabled feature.
    if (!enabled) throw new NotFoundException();

    if (token !== undefined && !presentedTokenMatches(authorization, token)) {
      throw new ForbiddenException();
    }

    response.setHeader('Content-Type', this.metrics.contentType);
    // A scrape is a point-in-time reading and must never be served from a
    // cache in front of it.
    response.setHeader('Cache-Control', 'no-store');
    return this.metrics.render();
  }
}

/**
 * Constant-time comparison of the presented bearer token.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first — and that comparison is not itself a leak worth avoiding: the token's
 * length is not the secret, its value is.
 */
function presentedTokenMatches(authorization: string | undefined, expected: string): boolean {
  if (authorization === undefined) return false;

  const [scheme, presented] = authorization.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || presented === undefined) return false;

  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
