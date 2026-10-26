import { HealthStatus, type HealthResponse } from '@palcert/contracts';
import type { Response } from 'express';
import { ApiConfigService } from '../config/api-config.service';
import type { DatabaseHealthIndicator } from '../health/indicators/database.health-indicator';
import type { ProcessingQueue } from '../infrastructure/queue/processing-queue';
import type { MalwareScannerPort } from '../infrastructure/scanner/malware-scanner.port';
import type { DocumentEnginePort } from '../infrastructure/document-engine/document-engine.port';
import type { ObjectStoragePort } from '../infrastructure/storage/object-storage.port';
import { WorkerHealthController } from './worker-health.controller';

const config = {
  appName: 'palcert',
  appVersion: '0.1.0',
} as unknown as ApiConfigService;

/** A probe outcome, in the shape each port actually returns. */
const up = async () => ({ ok: true });
const down = async () => ({ ok: false, message: 'unreachable' });

function build(
  overrides: {
    database?: HealthStatus;
    redis?: boolean;
    storage?: boolean;
    scanner?: boolean;
    engine?: boolean;
  } = {},
) {
  const database = {
    check: async () => ({
      name: 'database',
      status: overrides.database ?? HealthStatus.OK,
      ...(overrides.database === HealthStatus.ERROR ? { message: 'unreachable' } : {}),
    }),
  } as unknown as DatabaseHealthIndicator;

  return new WorkerHealthController(
    config,
    database,
    { checkReadiness: overrides.redis === false ? down : up } as unknown as ProcessingQueue,
    { checkReadiness: overrides.storage === false ? down : up } as unknown as ObjectStoragePort,
    { checkReadiness: overrides.scanner === false ? down : up } as unknown as MalwareScannerPort,
    { checkReadiness: overrides.engine === false ? down : up } as unknown as DocumentEnginePort,
  );
}

/** Captures the status a controller sets through the passthrough response. */
function recorder(): Response & { captured: number | undefined } {
  const response = {
    captured: undefined as number | undefined,
    status(code: number) {
      response.captured = code;
      return response;
    },
  };
  return response as unknown as Response & { captured: number | undefined };
}

function named(result: HealthResponse, name: string) {
  return result.dependencies.find((dependency) => dependency.name === name);
}

/**
 * The worker's probes (Phase 20 Checkpoint 2).
 *
 * The regression this file exists for: readiness used to start four probes,
 * destructure three, and aggregate the three — so the document engine was
 * measured and its answer thrown away, and a worker whose analyzer was
 * unreachable reported READY and kept claiming analysis jobs it could not
 * finish. Every dependency therefore gets its own failing case, because the
 * bug was not in any one probe but in what the aggregate was built from.
 */
describe('WorkerHealthController', () => {
  describe('liveness', () => {
    it('answers ok while every dependency is down', () => {
      const result = build({
        database: HealthStatus.ERROR,
        redis: false,
        storage: false,
        scanner: false,
        engine: false,
      }).live();

      // Liveness asks whether the process should be restarted. Restarting it
      // would not bring a dependency back, so an outage must never answer yes.
      expect(result.status).toBe(HealthStatus.OK);
      expect(result.dependencies).toEqual([]);
    });

    it('names itself as the worker rather than as the API', () => {
      expect(build().live().service).toBe('palcert-worker');
    });
  });

  describe('readiness', () => {
    it('is ready, and reports every dependency, when all of them answer', async () => {
      const response = recorder();
      const result = await build().ready(response);

      expect(result.status).toBe(HealthStatus.OK);
      expect(response.captured).toBe(200);
      expect(result.dependencies.map((dependency) => dependency.name).sort()).toEqual([
        'database',
        'document-analysis',
        'malware-scanner',
        'object-storage',
        'redis',
      ]);
    });

    it('is not ready when the database is unreachable', async () => {
      const response = recorder();
      const result = await build({ database: HealthStatus.ERROR }).ready(response);

      // A worker records every claim, attempt and outcome in the job ledger.
      // Without the database it cannot even mark a job RUNNING.
      expect(result.status).toBe(HealthStatus.ERROR);
      expect(response.captured).toBe(503);
      expect(named(result, 'database')?.status).toBe(HealthStatus.ERROR);
    });

    it('is not ready when the document engine is unreachable', async () => {
      const response = recorder();
      const result = await build({ engine: false }).ready(response);

      // The defect this checkpoint fixed: this probe used to be computed and
      // discarded, so this case answered 200.
      expect(result.status).toBe(HealthStatus.ERROR);
      expect(response.captured).toBe(503);
      expect(named(result, 'document-analysis')?.status).toBe(HealthStatus.ERROR);
    });

    it('is not ready when Redis is unreachable', async () => {
      const response = recorder();
      const result = await build({ redis: false }).ready(response);

      expect(result.status).toBe(HealthStatus.ERROR);
      expect(response.captured).toBe(503);
    });

    it('is not ready when object storage is unreachable', async () => {
      const response = recorder();
      const result = await build({ storage: false }).ready(response);

      expect(result.status).toBe(HealthStatus.ERROR);
      expect(response.captured).toBe(503);
    });

    it('is not ready when the malware scanner is unreachable', async () => {
      const response = recorder();
      const result = await build({ scanner: false }).ready(response);

      expect(result.status).toBe(HealthStatus.ERROR);
      expect(response.captured).toBe(503);
    });

    it('reports a probe that throws as unreachable rather than failing the request', async () => {
      const controller = build();
      const throwing = {
        checkReadiness: async () => {
          throw new Error('connection refused to internal-host:8000');
        },
      } as unknown as DocumentEnginePort;
      Object.assign(controller, { engine: throwing });

      const response = recorder();
      const result = await controller.ready(response);

      expect(result.status).toBe(HealthStatus.ERROR);
      // The probe response is unauthenticated: it must not disclose the
      // hostname or the driver error that produced it.
      expect(named(result, 'document-analysis')?.message).toBe('unreachable');
      expect(JSON.stringify(result)).not.toContain('internal-host');
    });
  });
});
