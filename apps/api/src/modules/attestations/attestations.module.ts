import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { AuthModule } from '../auth/auth.module';
import { ClockPort, SystemClock } from '../auth/ports/clock.port';
import { SecurityEventService } from '../auth/services/security-event.service';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AttestationsCoreModule } from './attestations-core.module';
import { AdminAttestationsController } from './controllers/admin-attestations.controller';
import { AttestationRequestsController } from './controllers/attestation-requests.controller';
import { OrganizationAttestationsController } from './controllers/organization-attestations.controller';
import { PublicAttestationsController } from './controllers/public-attestations.controller';
import { AttestationArtifactService } from './services/attestation-artifact.service';
import { AttestationFinanceService } from './services/attestation-finance.service';
import { AttestationRequestService } from './services/attestation-request.service';
import { AttestationReviewService } from './services/attestation-review.service';
import { AttestationTypeService } from './services/attestation-type.service';
import { AttestationVerificationService } from './services/attestation-verification.service';

/** Certificate attestation: owner, institution, PalCert administration and public routes. */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    QueueModule,
    StorageModule,
    AuthModule,
    OrganizationsModule,
    NotificationsCoreModule,
    AttestationsCoreModule,
  ],
  controllers: [
    AttestationRequestsController,
    OrganizationAttestationsController,
    AdminAttestationsController,
    PublicAttestationsController,
  ],
  providers: [
    TenantPrismaService,
    SecurityEventService,
    { provide: ClockPort, useClass: SystemClock },
    AttestationTypeService,
    AttestationRequestService,
    AttestationArtifactService,
    AttestationReviewService,
    AttestationVerificationService,
    AttestationFinanceService,
  ],
  exports: [AttestationsCoreModule],
})
export class AttestationsModule {}
