import { Module } from '@nestjs/common';

import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { WebhooksController } from './controllers/webhooks.controller';
import { WebhookAdminService } from './services/webhook-admin.service';
import { WebhooksCoreModule } from './webhooks-core.module';

/**
 * Phase 17's HTTP surface: one organization-scoped controller.
 *
 * There is no self-service counterpart and no platform-admin one. A webhook
 * belongs to an organization, and the platform has no business reading where a
 * customer's events go.
 */
@Module({
  imports: [WebhooksCoreModule, PrismaModule, QueueModule, AuthModule, OrganizationsModule],
  controllers: [WebhooksController],
  // The admin service lives here rather than in the core module because it is
  // the only part of Phase 17 that writes an audit event, and the worker has no
  // business holding something that can.
  providers: [WebhookAdminService],
  exports: [WebhooksCoreModule],
})
export class WebhooksModule {}
