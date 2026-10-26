import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationsCoreModule } from './notifications-core.module';
import { NotificationsController } from './controllers/notifications.controller';
import { NotificationInboxService } from './services/notification-inbox.service';

/**
 * Phase 16's one HTTP surface.
 *
 * One rather than two, because there is only one authority here: the person
 * whose notifications they are. Every other phase has an organization-side
 * controller beside the self-service one; this phase has nothing an
 * organization is entitled to see.
 */
@Module({
  imports: [NotificationsCoreModule, PrismaModule, AuthModule],
  controllers: [NotificationsController],
  providers: [TenantPrismaService, NotificationInboxService],
  exports: [NotificationsCoreModule, NotificationInboxService],
})
export class NotificationsModule {}
