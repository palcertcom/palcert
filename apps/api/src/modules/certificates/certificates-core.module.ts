import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { CertificateRendererPort } from '../../infrastructure/certificates/certificate-renderer.port';
import { PdfKitCertificateRenderer } from '../../infrastructure/certificates/pdfkit-certificate-renderer';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { ClockPort, SystemClock } from '../auth/ports/clock.port';
import { SecurityEventService } from '../auth/services/security-event.service';
import { CertificateEligibilityService } from './services/certificate-eligibility.service';
import { CertificateReadService } from './services/certificate-read.service';
import { CertificateReconciliationService } from './services/certificate-reconciliation.service';
import { CertificateRevocationService } from './services/certificate-revocation.service';
import { CertificateSchedulingService } from './services/certificate-scheduling.service';
import { PublicCertificateService } from './services/public-certificate.service';

/**
 * Certificates without any HTTP surface.
 *
 * Split from `CertificatesModule` for the reason every other domain is: the
 * issuance worker needs the services and must not serve the routes.
 */
@Module({
  imports: [ConfigModule, PrismaModule, QueueModule, StorageModule, NotificationsCoreModule],
  providers: [
    TenantPrismaService,
    SecurityEventService,
    { provide: ClockPort, useClass: SystemClock },
    { provide: CertificateRendererPort, useClass: PdfKitCertificateRenderer },
    CertificateEligibilityService,
    CertificateSchedulingService,
    CertificateReadService,
    CertificateRevocationService,
    CertificateReconciliationService,
    PublicCertificateService,
  ],
  exports: [
    CertificateRendererPort,
    CertificateEligibilityService,
    CertificateSchedulingService,
    CertificateReadService,
    CertificateRevocationService,
    CertificateReconciliationService,
    PublicCertificateService,
  ],
})
export class CertificatesCoreModule {}
