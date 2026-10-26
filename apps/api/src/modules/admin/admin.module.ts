import { Module } from '@nestjs/common';
import { AdminOrganizationsController } from './admin-organizations.controller';
import { AdminOverviewController } from './admin-overview.controller';
import { AdminUsersController } from './admin-users.controller';
import { OutboundEmailModule } from '../../infrastructure/email/outbound-email.module';
import { AuthModule } from '../auth/auth.module';
import { AdminEmailController } from './email/admin-email.controller';
import { AdminEmailService } from './email/admin-email.service';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [AuthModule, OrganizationsModule, OutboundEmailModule],
  controllers: [
    AdminUsersController,
    AdminOrganizationsController,
    AdminOverviewController,
    AdminEmailController,
  ],
  providers: [AdminEmailService],
})
export class AdminModule {}
