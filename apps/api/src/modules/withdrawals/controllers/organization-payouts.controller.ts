import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  WithdrawalScope,
  type DownloadAuthorizationView,
  type OrganizationEarningsView,
  type PayoutDestinationView,
  type WithdrawalRequestView,
} from '@palcert/contracts';
import type { Request } from 'express';
import {
  OrganizationScoped,
  RequireOrganizationPermissions,
  Tenant,
} from '../../organizations/decorators/tenant.decorators';
import type { TenantContext } from '../../organizations/tenant-context';
import {
  ListDestinationsQueryDto,
  OptionalVersionDto,
  OrganizationDestinationParamDto,
  OrganizationWithdrawalParamDto,
  PayoutDestinationDto,
  SubmitWithdrawalDto,
  UpdatePayoutDestinationDto,
  VersionDto,
  WithdrawalListQueryDto,
} from '../dto/withdrawal.dto';
import { PayoutDestinationService } from '../services/payout-destination.service';
import { WithdrawalRequestService } from '../services/withdrawal-request.service';
import type { WithdrawalOwner } from '../withdrawal-support';
import { contextOf, destinationInput, idempotencyKeyOf } from './request-context';

function organization(tenant: TenantContext): WithdrawalOwner {
  return {
    scope: WithdrawalScope.ORGANIZATION,
    userId: tenant.userId,
    organizationId: tenant.organizationId,
  };
}

/**
 * An organization's earnings and payouts (spec §30, D4, D6).
 *
 * The organization is the verified tenant from the path, never a body field.
 * Requesting a payout needs organization:withdrawal:request, which only the
 * organization owner holds by default; managing where payouts go needs the
 * organization payout-destination permission. Both are permissions, so an
 * organization can grant them to another role without a code change.
 */
@ApiTags('organization-payouts')
@ApiCookieAuth()
@Controller('organizations/:organizationId/payouts')
@OrganizationScoped()
export class OrganizationPayoutsController {
  constructor(
    private readonly requests: WithdrawalRequestService,
    private readonly destinations: PayoutDestinationService,
  ) {}

  @Get('earnings')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_WITHDRAWAL_READ)
  @ApiOperation({
    summary: 'Organization earnings by currency',
    description:
      'Settled net share only: realized, clearing, reserved for payout, paid out and available ' +
      'for payout, per currency. Never summed across currencies.',
  })
  @ApiResponse({ status: 200 })
  earnings(@Tenant() tenant: TenantContext): Promise<OrganizationEarningsView> {
    return this.requests.organizationEarnings(tenant.organizationId, tenant.userId);
  }

  // --- Destinations -------------------------------------------------------

  @Get('destinations')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_PAYOUT_DESTINATION_READ)
  @ApiOperation({ summary: 'The organization’s payout destinations, masked' })
  @ApiResponse({ status: 200 })
  listDestinations(
    @Tenant() tenant: TenantContext,
    @Query() query: ListDestinationsQueryDto,
  ): Promise<readonly PayoutDestinationView[]> {
    return this.destinations.list(organization(tenant), {
      includeArchived: query.includeArchived === 'true',
    });
  }

  @Post('destinations')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_PAYOUT_DESTINATION_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add an organization payout destination' })
  @ApiResponse({ status: 201 })
  createDestination(
    @Tenant() tenant: TenantContext,
    @Body() body: PayoutDestinationDto,
    @Req() request: Request,
  ): Promise<PayoutDestinationView> {
    return this.destinations.create(
      organization(tenant),
      destinationInput(body),
      contextOf(request),
    );
  }

  @Patch('destinations/:destinationId')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_PAYOUT_DESTINATION_MANAGE)
  @ApiOperation({ summary: 'Change an organization payout destination' })
  @ApiResponse({ status: 200 })
  updateDestination(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationDestinationParamDto,
    @Body() body: UpdatePayoutDestinationDto,
    @Req() request: Request,
  ): Promise<PayoutDestinationView> {
    return this.destinations.update(
      organization(tenant),
      params.destinationId,
      destinationInput(body),
      body.expectedVersion,
      contextOf(request),
    );
  }

  @Post('destinations/:destinationId/archive')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_PAYOUT_DESTINATION_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive an organization payout destination' })
  @ApiResponse({ status: 200 })
  archiveDestination(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationDestinationParamDto,
    @Body() body: VersionDto,
    @Req() request: Request,
  ): Promise<PayoutDestinationView> {
    return this.destinations.archive(
      organization(tenant),
      params.destinationId,
      body.expectedVersion,
      contextOf(request),
    );
  }

  // --- Payout requests ----------------------------------------------------

  @Post()
  @RequireOrganizationPermissions(Permission.ORGANIZATION_WITHDRAWAL_REQUEST)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Request a payout of organization earnings',
    description: 'Reserves the amount against the available settled net share in that currency.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 409, description: 'WITHDRAWAL_EXCEEDS_AVAILABLE' })
  submit(
    @Tenant() tenant: TenantContext,
    @Body() body: SubmitWithdrawalDto,
    @Req() request: Request,
  ): Promise<WithdrawalRequestView> {
    return this.requests.submit(
      organization(tenant),
      body,
      idempotencyKeyOf(request),
      contextOf(request),
    );
  }

  @Get()
  @RequireOrganizationPermissions(Permission.ORGANIZATION_WITHDRAWAL_READ)
  @ApiOperation({ summary: 'Organization payout history, newest first' })
  @ApiResponse({ status: 200 })
  list(
    @Tenant() tenant: TenantContext,
    @Query() query: WithdrawalListQueryDto,
  ): Promise<{ items: readonly WithdrawalRequestView[]; nextCursor: string | null }> {
    return this.requests.list(organization(tenant), query);
  }

  @Get(':requestId')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_WITHDRAWAL_READ)
  @ApiOperation({ summary: 'One organization payout, with its timeline' })
  @ApiResponse({ status: 200 })
  @ApiResponse({
    status: 404,
    description: 'WITHDRAWAL_NOT_FOUND, also for another organization’s',
  })
  get(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationWithdrawalParamDto,
  ): Promise<WithdrawalRequestView> {
    return this.requests.get(organization(tenant), params.requestId);
  }

  @Post(':requestId/cancel')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_WITHDRAWAL_REQUEST)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel your payout request before finance starts the transfer' })
  @ApiResponse({ status: 200 })
  cancel(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationWithdrawalParamDto,
    @Body() body: OptionalVersionDto,
    @Req() request: Request,
  ): Promise<WithdrawalRequestView> {
    return this.requests.cancel(
      organization(tenant),
      params.requestId,
      body.expectedVersion,
      contextOf(request),
    );
  }

  @Get(':requestId/proof')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_WITHDRAWAL_READ)
  @ApiOperation({ summary: 'The payout proof finance attached, by a short-lived link' })
  @ApiResponse({ status: 200 })
  proof(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationWithdrawalParamDto,
    @Req() request: Request,
  ): Promise<DownloadAuthorizationView> {
    return this.requests.proofDownload(organization(tenant), params.requestId, contextOf(request));
  }
}
