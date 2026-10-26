import 'reflect-metadata';
import { ConfigurationError } from '@palcert/config';
import { Logger } from 'nestjs-pino';
import { createApp } from './bootstrap';
import { ApiConfigService } from './config/api-config.service';
import { validateEnvironment } from './config/validate-environment';

/** `EX_CONFIG` from sysexits.h — a configuration problem, not a crash. */
const EXIT_CONFIG_ERROR = 78;

async function main(): Promise<void> {
  // Fail fast and legibly on bad configuration, before the DI container exists.
  validateEnvironment();

  const app = await createApp();
  const config = app.get(ApiConfigService);
  const logger = app.get(Logger);

  await app.listen(config.port, config.host);

  logger.log(
    {
      port: config.port,
      host: config.host,
      env: config.nodeEnv,
      docsEnabled: config.docsEnabled,
    },
    'PalCert API started',
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    // Operator-facing: print the problems plainly. The logger itself depends on
    // configuration, so it is not available here.
    console.error(error.message);
    process.exit(EXIT_CONFIG_ERROR);
  }
  console.error('Failed to start PalCert API', error);
  process.exit(1);
});
