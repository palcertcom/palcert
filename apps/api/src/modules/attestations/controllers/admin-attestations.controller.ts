import { Body, Controller, Get, Param, Put, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type AttestationCommissionView,
  type OrganizationAttestationRevenueView,
  type PlatformAttestationOverviewView,
} from '@palcert/contracts';
import type { Request } from 'express';
import { requestIdOf, type RequestPrincipal } from '../../auth/authenticated-request';
import {
  CurrentUser,
  RequirePermissions,
  RequireRecentAuthentication,
} from '../../auth/decorators/auth.decorators';
import {
  OrganizationParamDto,
  PlatformOverviewQueryDto,
  RevenueQueryDto,
  SetCommissionDto,
} from '../dto/attestation.dto';
import { AttestationFinanceService } from '../services/attestation-finance.service';

/**
 * PalCert administration of attestation money (§22, §24, §40).
 *
 * Cross-tenant by nature, so every route demands an explicit platform
 * permission and runs through the audited platform elevation. Changing a
 * commission also demands a recent authentication: it changes what every
 * future request to that institution will pay PalCert.
 */
@ApiTags('admin-attestations')
@ApiCookieAuth()
@Controller('admin')
export class AdminAttestationsController {
  constructor(private readonly finance: AttestationFinanceService) {}

  @Get('organizations/:organizationId/attestation-commission')
  @RequirePermissions(Permission.ADMIN_ATTESTATION_FINANCE_READ)
  @ApiOperation({ summary: 'An organization’s current platform commission and its history' })
  @ApiResponse({ status: 200 })
  commission(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: OrganizationParamDto,
  ): Promise<AttestationCommissionView> {
    return this.finance.commission(actor.userId, params.organizationId);
  }

  @Put('organizations/:organizationId/attestation-commission')
  @RequirePermissions(Permission.ADMIN_ATTESTATION_COMMISSION_MANAGE)
  @RequireRecentAuthentication()
  @ApiOperation({
    summary: 'Set an organization’s platform commission',
    description:
      'Appends a new rate with its effective time, author and reason. Requests already submitted ' +
      'keep the rate they were submitted under.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 422, description: 'ATTESTATION_COMMISSION_INVALID' })
  setCommission(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: OrganizationParamDto,
    @Body() body: SetCommissionDto,
    @Req() request: Request,
  ): Promise<AttestationCommissionView> {
    return this.finance.setCommission(
      actor.userId,
      params.organizationId,
      body,
      requestIdOf(request),
    );
  }

  @Get('attestations/finance')
  @RequirePermissions(Permission.ADMIN_ATTESTATION_FINANCE_READ)
  @ApiOperation({ summary: 'Platform attestation totals and per-organization revenue' })
  @ApiResponse({ status: 200 })
  overview(
    @CurrentUser() actor: RequestPrincipal,
    @Query() query: PlatformOverviewQueryDto,
  ): Promise<PlatformAttestationOverviewView> {
    return this.finance.platformOverview(actor.userId, query);
  }

  @Get('organizations/:organizationId/attestation-revenue')
  @RequirePermissions(Permission.ADMIN_ATTESTATION_FINANCE_READ)
  @ApiOperation({ summary: 'Drill-down: one organization’s attestation settlements' })
  @ApiResponse({ status: 200 })
  organizationRevenue(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: OrganizationParamDto,
    @Query() query: RevenueQueryDto,
  ): Promise<OrganizationAttestationRevenueView> {
    return this.finance.adminOrganizationRevenue(actor.userId, params.organizationId, query);
  }
}
