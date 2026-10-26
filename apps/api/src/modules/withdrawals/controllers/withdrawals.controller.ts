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
  type PayoutDestinationView,
  type UserWithdrawableView,
  type WithdrawalRequestView,
} from '@palcert/contracts';
import type { Request } from 'express';
import type { RequestPrincipal } from '../../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../../auth/decorators/auth.decorators';
import {
  DestinationParamDto,
  ListDestinationsQueryDto,
  OptionalVersionDto,
  PayoutDestinationDto,
  SubmitWithdrawalDto,
  UpdatePayoutDestinationDto,
  VersionDto,
  WithdrawableQueryDto,
  WithdrawalListQueryDto,
  WithdrawalParamDto,
} from '../dto/withdrawal.dto';
import { PayoutDestinationService } from '../services/payout-destination.service';
import { WithdrawalRequestService } from '../services/withdrawal-request.service';
import type { WithdrawalOwner } from '../withdrawal-support';
import { contextOf, destinationInput, idempotencyKeyOf } from './request-context';

function self(principal: RequestPrincipal): WithdrawalOwner {
  return { scope: WithdrawalScope.USER, userId: principal.userId };
}

/**
 * A person's own withdrawals and payout destinations (spec §29, §36).
 *
 * Every route is the caller's own money: the beneficiary is the session's
 * user, never a value in the body, and every read and write runs under that
 * user's RLS scope. A card top-up is refunded to its card through the
 * existing refund path; nothing here pays card money out to a bank (D2).
 */
@ApiTags('balance')
@ApiCookieAuth()
@Controller('balance')
export class WithdrawalsController {
  constructor(
    private readonly requests: WithdrawalRequestService,
    private readonly destinations: PayoutDestinationService,
  ) {}

  @Get('withdrawable')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({
    summary: 'What you can withdraw, and why it differs from your balance',
    description:
      'Cash, promotional credit, reservations, manual top-ups still clearing, cash that is ' +
      'spendable but not withdrawable, and the withdrawable amount, for one currency.',
  })
  @ApiResponse({ status: 200 })
  withdrawable(
    @CurrentUser() principal: RequestPrincipal,
    @Query() query: WithdrawableQueryDto,
  ): Promise<UserWithdrawableView> {
    return this.requests.userWithdrawable(principal.userId, query.currency);
  }

  // --- Destinations -------------------------------------------------------

  @Get('payout-destinations')
  @RequirePermissions(Permission.BALANCE_WITHDRAW_SELF)
  @ApiOperation({ summary: 'Your saved payout destinations, masked' })
  @ApiResponse({ status: 200 })
  listDestinations(
    @CurrentUser() principal: RequestPrincipal,
    @Query() query: ListDestinationsQueryDto,
  ): Promise<readonly PayoutDestinationView[]> {
    return this.destinations.list(self(principal), {
      includeArchived: query.includeArchived === 'true',
    });
  }

  @Post('payout-destinations')
  @RequirePermissions(Permission.BALANCE_WITHDRAW_SELF)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Save a payout destination',
    description: 'Details are encrypted at rest; only a masked summary is ever returned.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 422, description: 'PAYOUT_DESTINATION_INVALID' })
  @ApiResponse({ status: 503, description: 'PAYOUT_DESTINATION_ENCRYPTION_UNAVAILABLE' })
  createDestination(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: PayoutDestinationDto,
    @Req() request: Request,
  ): Promise<PayoutDestinationView> {
    return this.destinations.create(self(principal), destinationInput(body), contextOf(request));
  }

  @Patch('payout-destinations/:destinationId')
  @RequirePermissions(Permission.BALANCE_WITHDRAW_SELF)
  @ApiOperation({
    summary: 'Change a payout destination',
    description: 'Requests already submitted keep the destination frozen at their submission.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 412, description: 'PAYOUT_DESTINATION_CONFLICT' })
  updateDestination(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: DestinationParamDto,
    @Body() body: UpdatePayoutDestinationDto,
    @Req() request: Request,
  ): Promise<PayoutDestinationView> {
    return this.destinations.update(
      self(principal),
      params.destinationId,
      destinationInput(body),
      body.expectedVersion,
      contextOf(request),
    );
  }

  @Post('payout-destinations/:destinationId/archive')
  @RequirePermissions(Permission.BALANCE_WITHDRAW_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a payout destination for good' })
  @ApiResponse({ status: 200 })
  archiveDestination(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: DestinationParamDto,
    @Body() body: VersionDto,
    @Req() request: Request,
  ): Promise<PayoutDestinationView> {
    return this.destinations.archive(
      self(principal),
      params.destinationId,
      body.expectedVersion,
      contextOf(request),
    );
  }

  // --- Withdrawals --------------------------------------------------------

  @Post('withdrawals')
  @RequirePermissions(Permission.BALANCE_WITHDRAW_SELF)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Request a withdrawal',
    description:
      'Recalculates what you can withdraw, refuses anything above it, freezes the chosen ' +
      'destination and reserves the amount, all at once. PalCert finance then reviews it.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({
    status: 409,
    description: 'WITHDRAWAL_EXCEEDS_AVAILABLE, WITHDRAWAL_TOO_MANY_OPEN',
  })
  @ApiResponse({ status: 422, description: 'WITHDRAWAL_AMOUNT_OUT_OF_RANGE' })
  submit(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: SubmitWithdrawalDto,
    @Req() request: Request,
  ): Promise<WithdrawalRequestView> {
    return this.requests.submit(
      self(principal),
      body,
      idempotencyKeyOf(request),
      contextOf(request),
    );
  }

  @Get('withdrawals')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({ summary: 'Your withdrawals, newest first' })
  @ApiResponse({ status: 200 })
  list(
    @CurrentUser() principal: RequestPrincipal,
    @Query() query: WithdrawalListQueryDto,
  ): Promise<{ items: readonly WithdrawalRequestView[]; nextCursor: string | null }> {
    return this.requests.list(self(principal), query);
  }

  @Get('withdrawals/:requestId')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({ summary: 'One withdrawal, with its timeline' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'WITHDRAWAL_NOT_FOUND, also for another person’s' })
  get(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
  ): Promise<WithdrawalRequestView> {
    return this.requests.get(self(principal), params.requestId);
  }

  @Post('withdrawals/:requestId/cancel')
  @RequirePermissions(Permission.BALANCE_WITHDRAW_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a withdrawal',
    description:
      'Possible until PalCert finance starts the transfer. Releases the reserved amount.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'WITHDRAWAL_TRANSITION_INVALID' })
  cancel(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
    @Body() body: OptionalVersionDto,
    @Req() request: Request,
  ): Promise<WithdrawalRequestView> {
    return this.requests.cancel(
      self(principal),
      params.requestId,
      body.expectedVersion,
      contextOf(request),
    );
  }

  @Get('withdrawals/:requestId/proof')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({ summary: 'The payout proof finance attached, by a short-lived link' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'WITHDRAWAL_PROOF_NOT_FOUND' })
  proof(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
    @Req() request: Request,
  ): Promise<DownloadAuthorizationView> {
    return this.requests.proofDownload(self(principal), params.requestId, contextOf(request));
  }
}
