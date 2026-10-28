import { Body, Controller, Get, Param, Put, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, Matches } from 'class-validator';
import { Permission, REVENUE_SERVICE_CODES, type RevenueServiceCode } from '@palcert/contracts';
import type { Request } from 'express';
import {
  CurrentUser,
  RequirePermissions,
  RequireRecentAuthentication,
} from '../auth/decorators/auth.decorators';
import { requestIdOf, type RequestPrincipal } from '../auth/authenticated-request';
import {
  OrganizationScoped,
  RequireOrganizationPermissions,
  Tenant,
} from '../organizations/decorators/tenant.decorators';
import type { TenantContext } from '../organizations/tenant-context';
import { RevenueSharingService } from './revenue-sharing.service';

class OrganizationParams {
  @IsUUID() organizationId!: string;
}
class RateParams extends OrganizationParams {
  @IsIn(REVENUE_SERVICE_CODES) serviceCode!: RevenueServiceCode;
}
class SetShare {
  @IsString() @MaxLength(6) institutionPercent!: string;
  @IsString() @MaxLength(500) reason!: string;
  @IsOptional() @IsString() @MaxLength(40) effectiveFrom?: string;
}
class RevenueQuery {
  @IsOptional() @IsString() @Matches(/^\d{1,7}$/) cursor?: string;
}
@ApiTags('institution-revenue')
@ApiCookieAuth()
@Controller('admin/organizations/:organizationId')
export class AdminRevenueSharingController {
  constructor(private readonly service: RevenueSharingService) {}
  @Get('revenue-shares')
  @RequirePermissions(Permission.ADMIN_REVENUE_SHARE_READ)
  @ApiOperation({
    summary: 'Institution and platform shares for every active service, with history',
  })
  rates(@CurrentUser() user: RequestPrincipal, @Param() params: OrganizationParams) {
    return this.service.rates(user.userId, params.organizationId);
  }
  @Put('revenue-shares/:serviceCode')
  @RequirePermissions(Permission.ADMIN_REVENUE_SHARE_MANAGE)
  @RequireRecentAuthentication()
  @ApiOperation({
    summary: 'Append an institution share; existing purchases keep their original rate',
  })
  set(
    @CurrentUser() user: RequestPrincipal,
    @Param() params: RateParams,
    @Body() body: SetShare,
    @Req() request: Request,
  ) {
    return this.service.setRate(
      user.userId,
      params.organizationId,
      params.serviceCode,
      body,
      requestIdOf(request),
    );
  }
  @Get('service-revenue')
  @RequirePermissions(Permission.ADMIN_REVENUE_SHARE_READ)
  @ApiOperation({ summary: 'Cash revenue and reversals by institution, service and currency' })
  revenue(
    @CurrentUser() user: RequestPrincipal,
    @Param() params: OrganizationParams,
    @Query() query: RevenueQuery,
  ) {
    return this.service.adminRevenue(user.userId, params.organizationId, query.cursor);
  }
}
@ApiTags('institution-revenue')
@ApiCookieAuth()
@Controller('organizations/:organizationId/service-revenue')
@OrganizationScoped()
export class OrganizationServiceRevenueController {
  constructor(private readonly service: RevenueSharingService) {}
  @Get()
  @RequireOrganizationPermissions(Permission.ORGANIZATION_WITHDRAWAL_READ)
  @ApiOperation({ summary: 'This institution’s service revenue and refunds by currency' })
  revenue(@Tenant() tenant: TenantContext, @Query() query: RevenueQuery) {
    return this.service.organizationRevenue(tenant, query.cursor);
  }
}
