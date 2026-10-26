import { Controller, Get } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Permission, type AdminOverviewView } from '@palcert/contracts';
import type { RequestPrincipal } from '../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../auth/decorators/auth.decorators';
import { OrganizationsService } from '../organizations/services/organizations.service';

/**
 * The staff dashboard's numbers.
 *
 * Counts only, grouped by status, read at request time. Both read
 * permissions are required because the answer covers both organizations and
 * accounts; every PalCert staff role holds both, and nobody else holds
 * either.
 */
@ApiTags('admin')
@ApiCookieAuth()
@Controller('admin/overview')
export class AdminOverviewController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  @RequirePermissions(Permission.ADMIN_ORGANIZATION_READ, Permission.ADMIN_USER_READ)
  @ApiOperation({ summary: 'Platform counts for the staff dashboard' })
  @ApiResponse({ status: 200 })
  overview(@CurrentUser() actor: RequestPrincipal): Promise<AdminOverviewView> {
    return this.organizations.overviewForAdmin(actor.userId);
  }
}
