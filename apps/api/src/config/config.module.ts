import { Global, Module } from '@nestjs/common';
import { apiEnvSchema, loadEnv, type ApiEnv } from '@palcert/config';
import { ApiConfigService } from './api-config.service';

export const API_ENV = Symbol('API_ENV');

/**
 * Validates the process environment at module initialization.
 * A misconfigured process fails fast here instead of at request time.
 */
@Global()
@Module({
  providers: [
    {
      provide: API_ENV,
      useFactory: (): ApiEnv => loadEnv(apiEnvSchema),
    },
    {
      provide: ApiConfigService,
      useFactory: (env: ApiEnv) => new ApiConfigService(env),
      inject: [API_ENV],
    },
  ],
  exports: [ApiConfigService, API_ENV],
})
export class ConfigModule {}
