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
  type PayoutDestinationView,
  type PlatformFundsView,
  type WithdrawalRequestView,
} from '@palcert/contracts';
import type { Request } from 'express';
import type { RequestPrincipal } from '../../auth/authenticated-request';
import {
  CurrentUser,
  RequirePermissions,
  RequireRecentAuthentication,
} from '../../auth/decorators/auth.decorators';
import {
  DestinationParamDto,
  ListDestinationsQueryDto,
  OptionalVersionDto,
  PayoutDestinationDto,
  SubmitWithdrawalDto,
  UpdatePayoutDestinationDto,
  VersionDto,
  WithdrawalListQueryDto,
  WithdrawalParamDto,
} from '../dto/withdrawal.dto';
import { PayoutDestinationService } from '../services/payout-destination.service';
import { WithdrawalRequestService } from '../services/withdrawal-request.service';
import type { WithdrawalOwner } from '../withdrawal-support';
import { contextOf, destinationInput, idempotencyKeyOf } from './request-context';

function platform(principal: RequestPrincipal): WithdrawalOwner {
  return { scope: WithdrawalScope.PLATFORM, userId: principal.userId };
}

/**
 * PalCert's own funds and treasury payouts (spec §31, D5).
 *
 * Realized revenue only, per currency, never summed. Requesting a platform
 * payout needs finance:platform-withdrawal:request and a recent
 * authentication; approving and executing it then need two other people.
 */
@ApiTags('admin-platform-funds')
@ApiCookieAuth()
@Controller('admin/platform-funds')
export class AdminPlatformFundsController {
  constructor(
    private readonly requests: WithdrawalRequestService,
    private readonly destinations: PayoutDestinationService,
  ) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_READ)
  @ApiOperation({
    summary: 'PalCert realized revenue and payout availability, by currency',
    description:
      'CASH-funded captured services plus settled attestation commission, less refunds, ' +
      'unrecovered chargeback losses, paid platform payouts and open reservations.',
  })
  @ApiResponse({ status: 200 })
  funds(@CurrentUser() actor: RequestPrincipal): Promise<PlatformFundsView> {
    return this.requests.platformFunds(actor.userId);
  }

  // --- Treasury destinations ----------------------------------------------

  @Get('destinations')
  @RequirePermissions(Permission.FINANCE_PAYOUT_DESTINATION_READ)
  @ApiOperation({ summary: 'PalCert treasury payout destinations, masked' })
  @ApiResponse({ status: 200 })
  listDestinations(
    @CurrentUser() actor: RequestPrincipal,
    @Query() query: ListDestinationsQueryDto,
  ): Promise<readonly PayoutDestinationView[]> {
    return this.destinations.list(platform(actor), {
      includeArchived: query.includeArchived === 'true',
    });
  }

  @Post('destinations')
  @RequirePermissions(Permission.FINANCE_PAYOUT_DESTINATION_MANAGE)
  @RequireRecentAuthentication()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a PalCert treasury payout destination' })
  @ApiResponse({ status: 201 })
  createDestination(
    @CurrentUser() actor: RequestPrincipal,
    @Body() body: PayoutDestinationDto,
    @Req() request: Request,
  ): Promise<PayoutDestinationView> {
    return this.destinations.create(platform(actor), destinationInput(body), contextOf(request));
  }

  @Patch('destinations/:destinationId')
  @RequirePermissions(Permission.FINANCE_PAYOUT_DESTINATION_MANAGE)
  @RequireRecentAuthentication()
  @ApiOperation({ summary: 'Change a PalCert treasury payout destination' })
  @ApiResponse({ status: 200 })
  updateDestination(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: DestinationParamDto,
    @Body() body: UpdatePayoutDestinationDto,
    @Req() request: Request,
  ): Promise<PayoutDestinationView> {
    return this.destinations.update(
      platform(actor),
      params.destinationId,
      destinationInput(body),
      body.expectedVersion,
      contextOf(request),
    );
  }

  @Post('destinations/:destinationId/archive')
  @RequirePermissions(Permission.FINANCE_PAYOUT_DESTINATION_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a PalCert treasury payout destination' })
  @ApiResponse({ status: 200 })
  archiveDestination(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: DestinationParamDto,
    @Body() body: VersionDto,
    @Req() request: Request,
  ): Promise<PayoutDestinationView> {
    return this.destinations.archive(
      platform(actor),
      params.destinationId,
      body.expectedVersion,
      contextOf(request),
    );
  }

  // --- Platform payout requests -------------------------------------------

  @Post('withdrawals')
  @RequirePermissions(Permission.FINANCE_PLATFORM_WITHDRAWAL_REQUEST)
  @RequireRecentAuthentication()
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Request a payout of PalCert revenue',
    description:
      'Reserves against available realized revenue. Somebody else must approve, and a third person execute.',
  })
  @ApiResponse({ status: 201 })
  submit(
    @CurrentUser() actor: RequestPrincipal,
    @Body() body: SubmitWithdrawalDto,
    @Req() request: Request,
  ): Promise<WithdrawalRequestView> {
    return this.requests.submit(
      platform(actor),
      body,
      idempotencyKeyOf(request),
      contextOf(request),
    );
  }

  @Get('withdrawals')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_READ)
  @ApiOperation({ summary: 'Platform payout history, newest first' })
  @ApiResponse({ status: 200 })
  list(
    @CurrentUser() actor: RequestPrincipal,
    @Query() query: WithdrawalListQueryDto,
  ): Promise<{ items: readonly WithdrawalRequestView[]; nextCursor: string | null }> {
    return this.requests.list(platform(actor), query);
  }

  @Post('withdrawals/:requestId/cancel')
  @RequirePermissions(Permission.FINANCE_PLATFORM_WITHDRAWAL_REQUEST)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel your platform payout request before the transfer starts' })
  @ApiResponse({ status: 200 })
  cancel(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
    @Body() body: OptionalVersionDto,
    @Req() request: Request,
  ): Promise<WithdrawalRequestView> {
    return this.requests.cancel(
      platform(actor),
      params.requestId,
      body.expectedVersion,
      contextOf(request),
    );
  }
}
