import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort, SystemClock } from '../auth/ports/clock.port';
import { SecurityEventService } from '../auth/services/security-event.service';
import { FinanceCoreModule } from '../finance/finance-core.module';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { AttestationCatalogueService } from './services/attestation-catalogue.service';
import { AttestationHousekeepingService } from './services/attestation-housekeeping.service';
import { AttestationPaymentService } from './services/attestation-payment.service';

/**
 * What the worker needs from attestation: the type catalogue, the payment
 * settlement, and the recurring housekeeping. Nothing request-facing.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    QueueModule,
    StorageModule,
    FinanceCoreModule,
    NotificationsCoreModule,
  ],
  providers: [
    TenantPrismaService,
    SecurityEventService,
    { provide: ClockPort, useClass: SystemClock },
    AttestationCatalogueService,
    AttestationPaymentService,
    AttestationHousekeepingService,
  ],
  exports: [AttestationCatalogueService, AttestationPaymentService, AttestationHousekeepingService],
})
export class AttestationsCoreModule {}
