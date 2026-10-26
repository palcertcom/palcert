import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { OrganizationContextGuard } from './guards/organization-context.guard';
import { OrganizationPermissionsGuard } from './guards/organization-permissions.guard';
import { InvitationsController, OrganizationTeamController } from './members.controller';
import { OrganizationsController } from './organizations.controller';
import { InvitationService } from './services/invitation.service';
import { MembershipService } from './services/membership.service';
import { OrganizationsService } from './services/organizations.service';
import { TenantResolverService } from './services/tenant-resolver.service';
import { VerificationService } from './services/verification.service';

/**
 * Guard order matters and is fixed by registration order in `AppModule`:
 *
 *   Csrf → Session → Permissions(global) → OrganizationContext → OrganizationPermissions
 *
 * Identity is established before tenancy, and tenancy before tenant
 * authorization. The two permission guards evaluate different sets and are kept
 * separate on purpose: a platform permission must never satisfy an organization
 * requirement, nor the reverse.
 */
@Module({
  imports: [AuthModule],
  controllers: [OrganizationsController, OrganizationTeamController, InvitationsController],
  providers: [
    OrganizationsService,
    MembershipService,
    InvitationService,
    VerificationService,
    TenantResolverService,
    { provide: APP_GUARD, useClass: OrganizationContextGuard },
    { provide: APP_GUARD, useClass: OrganizationPermissionsGuard },
  ],
  exports: [OrganizationsService, MembershipService, InvitationService, VerificationService],
})
export class OrganizationsModule {}
