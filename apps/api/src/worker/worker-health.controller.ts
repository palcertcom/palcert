import { Controller, Get, HttpCode, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthStatus, type HealthDependency, type HealthResponse } from '@palcert/contracts';
import type { Response } from 'express';
import { ApiConfigService } from '../config/api-config.service';
import { aggregateStatus } from '../health/health.service';
import { DatabaseHealthIndicator } from '../health/indicators/database.health-indicator';
import { ProcessingQueue } from '../infrastructure/queue/processing-queue';
import { MalwareScannerPort } from '../infrastructure/scanner/malware-scanner.port';
import { DocumentEnginePort } from '../infrastructure/document-engine/document-engine.port';
import { ObjectStoragePort } from '../infrastructure/storage/object-storage.port';
import { Public } from '../modules/auth/decorators/auth.decorators';

/**
 * Worker probes (§69, Phase 20 §5).
 *
 * **Liveness** answers one question: should this process be restarted? It
 * touches nothing, because a dependency outage is not a reason to kill a
 * healthy process — restarting it would not bring the dependency back and
 * would throw away whatever work it was mid-way through.
 *
 * **Readiness** answers a different one: is it safe for this worker to claim
 * work? A worker claims from one queue and the jobs on it need the database to
 * record progress, Redis to be dispatched at all, object storage to read the
 * bytes, the scanner to clear an upload, and the document engine to analyse
 * anything. A worker missing any of those is alive and not ready: it must not
 * take work it cannot finish, because taking it burns an attempt and moves the
 * job closer to DEAD.
 *
 * Both probes are deliberately about *this* process. Optional third parties —
 * the AI provider, the payment provider — are excluded, exactly as they are
 * for the API: their jobs fail and retry, which is the designed behaviour, and
 * taking a whole worker pool out of rotation because somebody else's API was
 * having an afternoon would be an outage PalCert inflicted on itself.
 */
@ApiTags('health')
@Public()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class WorkerHealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly config: ApiConfigService,
    private readonly database: DatabaseHealthIndicator,
    private readonly queue: ProcessingQueue,
    private readonly storage: ObjectStoragePort,
    private readonly scanner: MalwareScannerPort,
    private readonly engine: DocumentEnginePort,
  ) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Worker liveness — should this process be restarted?',
    description: 'Touches no dependency. A dependency outage is not a reason to kill the process.',
  })
  live(): HealthResponse {
    return this.build([]);
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Worker readiness — is it safe for this worker to claim work?',
    description:
      'The database, Redis, object storage, the malware scanner and document analysis must all ' +
      'answer. Any one of them missing means jobs this worker claims would burn an attempt and ' +
      'move closer to DEAD, so it reports 503 and stays out of rotation.',
  })
  async ready(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    // Every probe that is started is aggregated. The previous version built
    // four and destructured three, so the document-engine result was computed
    // and silently dropped — a worker whose analyzer was unreachable reported
    // READY and kept claiming analysis jobs it could not finish. Collecting
    // the array whole is what stops that recurring.
    const dependencies = await Promise.all([
      this.probe('database', async () => {
        const result = await this.database.check();
        return result.status === HealthStatus.OK
          ? { ok: true }
          : { ok: false, message: result.message ?? 'unreachable' };
      }),
      this.probe('redis', () => this.queue.checkReadiness()),
      this.probe('object-storage', () => this.storage.checkReadiness()),
      this.probe('malware-scanner', () => this.scanner.checkReadiness()),
      // Named for what it does, not for what it is: the response is public and
      // must not disclose internal topology (§116, Phase 5 §93).
      this.probe('document-analysis', () => this.engine.checkReadiness()),
    ]);
    const result = this.build(dependencies);
    response.status(
      result.status === HealthStatus.ERROR ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK,
    );
    return result;
  }

  private async probe(
    name: string,
    check: () => Promise<{ ok: boolean; message?: string }>,
  ): Promise<HealthDependency> {
    const started = Date.now();
    try {
      const outcome = await check();
      return {
        name,
        status: outcome.ok ? HealthStatus.OK : HealthStatus.ERROR,
        latencyMs: Date.now() - started,
        ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      };
    } catch {
      return {
        name,
        status: HealthStatus.ERROR,
        latencyMs: Date.now() - started,
        message: 'unreachable',
      };
    }
  }

  private build(dependencies: readonly HealthDependency[]): HealthResponse {
    return {
      status: aggregateStatus(dependencies),
      service: `${this.config.appName}-worker`,
      version: this.config.appVersion,
      release: this.config.release,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checkedAt: new Date().toISOString(),
      dependencies,
    };
  }
}
