import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigurationError } from '@palcert/config';
import { Logger } from 'nestjs-pino';
import { ApiConfigService } from './config/api-config.service';
import { validateEnvironment } from './config/validate-environment';
import { WorkerModule } from './worker/worker.module';

const EXIT_CONFIG_ERROR = 78;

/**
 * File-processing worker entrypoint.
 *
 * A separate process from the API (ADR-0001): it consumes the processing
 * queue and exposes only health probes. Started with `pnpm start:worker`.
 */
async function main(): Promise<void> {
  validateEnvironment();

  const app = await NestFactory.create(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const config = app.get(ApiConfigService);
  await app.listen(config.queue.workerPort, config.queue.workerHost);
  app.get(Logger).log({ port: config.queue.workerPort }, 'PalCert file-processing worker started');
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    console.error(error.message);
    process.exit(EXIT_CONFIG_ERROR);
  }
  console.error('Failed to start PalCert worker', error);
  process.exit(1);
});
