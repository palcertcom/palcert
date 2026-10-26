import { Controller, Get, HttpCode, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HealthStatus, type HealthResponse } from '@palcert/contracts';
import type { Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../modules/auth/decorators/auth.decorators';
import { HealthService } from './health.service';

/**
 * Health endpoints are deliberately mounted OUTSIDE the versioned `/api/v1`
 * prefix: they are operational infrastructure (probes, load balancers), not
 * part of the product API contract.
 *
 * Excluding them from the global prefix is not sufficient — URI versioning
 * would still mount them at `/v1/health/*` — so the controller is also marked
 * version-neutral. Probe URLs must stay stable across API versions.
 */
@ApiTags('health')
@Public()
@SkipThrottle()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness probe — is the process running?' })
  @ApiResponse({ status: 200, description: 'Process is alive.' })
  live(): HealthResponse {
    return this.health.live();
  }

  /**
   * AI provider availability, deliberately separate from readiness (§57).
   *
   * PalCert's core product is deterministic and must keep serving traffic when
   * a third-party AI provider does not. Folding this into `/health/ready`
   * would take the whole platform out of a load balancer because somebody
   * else's API was having an afternoon — so it is its own diagnostic, and it
   * always answers 200 with a status inside.
   *
   * It sits under the versioned API prefix rather than beside `live` and
   * `ready`: those two are unprefixed because infrastructure probes them, and
   * this one is consumed by the product — the UI uses it to decide whether to
   * offer AI review at all.
   */
  @Get('ai')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'AI provider availability — does NOT affect platform readiness',
    description:
      'Reports whether AI review is currently available. An unavailable provider never fails ' +
      'this probe with a 5xx and never makes the platform unready: deterministic checks and ' +
      'reports are unaffected.',
  })
  @ApiResponse({ status: 200 })
  aiAvailability(): Promise<{ enabled: boolean; available: boolean }> {
    return this.health.aiAvailability();
  }

  /**
   * Payment availability, for the same reason and with the same shape.
   *
   * A payment company being down is not PalCert being down (§110).
   */
  @Get('payments')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Payment provider availability — does NOT affect platform readiness',
    description:
      'Reports whether adding credit is currently possible. An unavailable provider never ' +
      'fails this probe with a 5xx and never makes the platform unready: existing balances ' +
      'stay visible and spendable.',
  })
  @ApiResponse({ status: 200 })
  paymentsAvailability(): Promise<{ enabled: boolean; available: boolean; provider: string }> {
    return this.health.paymentsAvailability();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — can the API serve traffic?' })
  @ApiResponse({ status: 200, description: 'All dependencies reachable.' })
  @ApiResponse({ status: 503, description: 'At least one dependency is unavailable.' })
  async ready(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    const result = await this.health.ready();
    response.status(
      result.status === HealthStatus.ERROR ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK,
    );
    return result;
  }
}
