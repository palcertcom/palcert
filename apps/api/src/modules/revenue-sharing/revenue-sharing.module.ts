import { Module } from '@nestjs/common';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort, SystemClock } from '../auth/ports/clock.port';
import { SecurityEventService } from '../auth/services/security-event.service';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AttestationsModule } from '../attestations/attestations.module';
import {
  AdminRevenueSharingController,
  OrganizationServiceRevenueController,
} from './revenue-sharing.controller';
import { RevenueSharingService } from './revenue-sharing.service';

@Module({
  imports: [AuthModule, OrganizationsModule, AttestationsModule],
  controllers: [AdminRevenueSharingController, OrganizationServiceRevenueController],
  providers: [
    TenantPrismaService,
    SecurityEventService,
    { provide: ClockPort, useClass: SystemClock },
    RevenueSharingService,
  ],
})
export class RevenueSharingModule {}
