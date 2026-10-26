import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { CertificatesCoreModule } from '../certificates/certificates-core.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { ClockPort, SystemClock } from '../auth/ports/clock.port';
import { SecurityEventService } from '../auth/services/security-event.service';
import { OfficialSubmissionService } from './services/official-submission.service';
import { SubmissionDownloadService } from './services/submission-download.service';
import { SubmissionEligibilityService } from './services/submission-eligibility.service';
import { SubmissionReadService } from './services/submission-read.service';
import { SubmissionReviewService } from './services/submission-review.service';

/**
 * Official submissions without any HTTP surface.
 *
 * Split from `SubmissionsModule` for the same reason the checks are: the
 * preparation worker needs the services and must not serve the routes.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    QueueModule,
    StorageModule,
    CertificatesCoreModule,
    NotificationsCoreModule,
  ],
  providers: [
    TenantPrismaService,
    SecurityEventService,
    { provide: ClockPort, useClass: SystemClock },
    SubmissionEligibilityService,
    OfficialSubmissionService,
    SubmissionReadService,
    SubmissionReviewService,
    SubmissionDownloadService,
  ],
  exports: [
    SubmissionEligibilityService,
    OfficialSubmissionService,
    SubmissionReadService,
    SubmissionReviewService,
    SubmissionDownloadService,
  ],
})
export class SubmissionsCoreModule {}
