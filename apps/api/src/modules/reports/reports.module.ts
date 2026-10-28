import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { SecurityEventService } from '../auth/services/security-event.service';
import { ClockPort, SystemClock } from '../auth/ports/clock.port';
import { ReportsService } from './reports.service';
import { ReportPdfRenderer } from './report-pdf.renderer';
import {
  PersonalReportsController,
  OrganizationReportsController,
  PlatformReportsController,
} from './reports.controller';
@Module({
  imports: [AuthModule, OrganizationsModule],
  controllers: [
    PersonalReportsController,
    OrganizationReportsController,
    PlatformReportsController,
  ],
  providers: [
    TenantPrismaService,
    SecurityEventService,
    { provide: ClockPort, useClass: SystemClock },
    ReportsService,
    ReportPdfRenderer,
  ],
})
export class ReportsModule {}
