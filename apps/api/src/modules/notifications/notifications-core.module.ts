import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { NotificationEmailRouter } from '../../infrastructure/email/notification-email-router';
import { OutboundEmailModule } from '../../infrastructure/email/outbound-email.module';
import { EmailProviderModule } from '../../infrastructure/notifications/email-provider.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort, SystemClock } from '../auth/ports/clock.port';
import { DomainEventService } from './services/domain-event.service';
import { NotificationEmailService } from './services/notification-email.service';
import { NotificationFanoutService } from './services/notification-fanout.service';

/**
 * Notifications without any HTTP surface (Phase 16).
 *
 * `DomainEventService` is exported because the *producers* live in other
 * modules: a submission's decision transaction, a certificate's issuance, a
 * revision's finalisation. That is the point rather than an accident — an
 * event is emitted inside the transaction that made the thing true, not
 * afterwards by something watching for changes.
 */
@Module({
  imports: [ConfigModule, PrismaModule, QueueModule, EmailProviderModule, OutboundEmailModule],
  providers: [
    TenantPrismaService,
    { provide: ClockPort, useClass: SystemClock },
    DomainEventService,
    NotificationFanoutService,
    NotificationEmailRouter,
    NotificationEmailService,
  ],
  exports: [DomainEventService, NotificationFanoutService, NotificationEmailService],
})
export class NotificationsCoreModule {}
