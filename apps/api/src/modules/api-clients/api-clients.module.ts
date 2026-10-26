import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SecurityEventService } from '../auth/services/security-event.service';
import { ApiClientsController } from './controllers/api-clients.controller';
import { IntegrationController } from './controllers/integration.controller';
import { ApiClientGuard } from './guards/api-client.guard';
import { ApiClientAuthService } from './services/api-client-auth.service';
import { ApiClientCredentialService } from './services/api-client-credential.service';
import { ApiClientThrottleService } from './services/api-client-throttle.service';
import { ApiClientService } from './services/api-client.service';
import { IntegrationReadService } from './services/integration-read.service';

/**
 * API clients and the public integration API (Phase 19).
 *
 * `ApiClientGuard` is registered globally rather than on the integration
 * controller, for the same reason `SessionGuard` is: a guard applied per
 * controller is a guard the next controller can forget. It does nothing at all
 * on a route without `@MachineOnly()`, so the cost of that reach is one
 * metadata lookup per request.
 */
@Module({
  controllers: [ApiClientsController, IntegrationController],
  providers: [
    ApiClientService,
    ApiClientAuthService,
    ApiClientCredentialService,
    ApiClientThrottleService,
    IntegrationReadService,
    // Provided locally rather than imported: AuthModule imports guards that
    // reference this module, and a circular import would be a worse answer to
    // a shared, stateless writer than a second provider of it.
    SecurityEventService,
    { provide: APP_GUARD, useClass: ApiClientGuard },
  ],
  exports: [ApiClientService, ApiClientAuthService],
})
export class ApiClientsModule {}
