import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type WithdrawalPolicyView,
  type WithdrawalReconciliationView,
  type WithdrawalReviewerCandidateView,
  type WithdrawalReviewerView,
} from '@palcert/contracts';
import type { Request } from 'express';
import type { RequestPrincipal } from '../../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../../auth/decorators/auth.decorators';
import {
  UpdateWithdrawalPolicyDto,
  WithdrawalLimitDto,
  WithdrawalReviewersDto,
} from '../dto/withdrawal.dto';
import { WithdrawalPolicyService } from '../services/withdrawal-policy.service';
import { WithdrawalReconciliationService } from '../services/withdrawal-reconciliation.service';
import { contextOf } from './request-context';

/**
 * Withdrawal policy, limits, reviewer assignment and reconciliation
 * (spec §19, §28, §38; D3, D4).
 */
@ApiTags('admin-withdrawals')
@ApiCookieAuth()
@Controller('admin/withdrawal-settings')
export class AdminWithdrawalSettingsController {
  constructor(
    private readonly policy: WithdrawalPolicyService,
    private readonly reconciliation: WithdrawalReconciliationService,
  ) {}

  @Get('policy')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_READ)
  @ApiOperation({ summary: 'Clearing periods and per-currency limits. No fee exists in v1.' })
  @ApiResponse({ status: 200 })
  getPolicy(@CurrentUser() actor: RequestPrincipal): Promise<WithdrawalPolicyView> {
    return this.policy.view(actor.userId);
  }

  @Put('policy')
  @RequirePermissions(Permission.ADMIN_WITHDRAWAL_POLICY_MANAGE)
  @ApiOperation({
    summary: 'Change the clearing periods (manual top-ups 0–90 days, organizations 0–180)',
  })
  @ApiResponse({ status: 200 })
  updatePolicy(
    @CurrentUser() actor: RequestPrincipal,
    @Body() body: UpdateWithdrawalPolicyDto,
    @Req() request: Request,
  ): Promise<WithdrawalPolicyView> {
    return this.policy.update(actor.userId, body, contextOf(request));
  }

  @Put('limits')
  @RequirePermissions(Permission.ADMIN_WITHDRAWAL_POLICY_MANAGE)
  @ApiOperation({ summary: 'Set or clear one currency’s minimum and maximum per request' })
  @ApiResponse({ status: 200 })
  setLimit(
    @CurrentUser() actor: RequestPrincipal,
    @Body() body: WithdrawalLimitDto,
    @Req() request: Request,
  ): Promise<WithdrawalPolicyView> {
    return this.policy.setLimit(
      actor.userId,
      {
        currency: body.currency,
        minAmountMinor:
          body.minAmountMinorUnits === undefined || body.minAmountMinorUnits === null
            ? null
            : BigInt(body.minAmountMinorUnits),
        maxAmountMinor:
          body.maxAmountMinorUnits === undefined || body.maxAmountMinorUnits === null
            ? null
            : BigInt(body.maxAmountMinorUnits),
      },
      contextOf(request),
    );
  }

  @Get('reviewers')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_READ)
  @ApiOperation({ summary: 'Assigned withdrawal reviewers, and whether each can still review' })
  @ApiResponse({ status: 200 })
  reviewers(@CurrentUser() actor: RequestPrincipal): Promise<readonly WithdrawalReviewerView[]> {
    return this.policy.reviewers(actor.userId);
  }

  @Get('reviewers/candidates')
  @RequirePermissions(Permission.ADMIN_WITHDRAWAL_POLICY_MANAGE)
  @ApiOperation({ summary: 'Active staff holding finance:withdrawal:review through a global role' })
  @ApiResponse({ status: 200 })
  candidates(
    @CurrentUser() actor: RequestPrincipal,
  ): Promise<readonly WithdrawalReviewerCandidateView[]> {
    return this.policy.reviewerCandidates(actor.userId);
  }

  @Put('reviewers')
  @RequirePermissions(Permission.ADMIN_WITHDRAWAL_POLICY_MANAGE)
  @ApiOperation({
    summary: 'Replace the assigned withdrawal reviewers',
    description: 'An empty list means every global finance reviewer is alerted.',
  })
  @ApiResponse({ status: 200 })
  replaceReviewers(
    @CurrentUser() actor: RequestPrincipal,
    @Body() body: WithdrawalReviewersDto,
    @Req() request: Request,
  ): Promise<readonly WithdrawalReviewerView[]> {
    return this.policy.replaceReviewers(actor.userId, body.userIds, contextOf(request));
  }

  @Post('reconciliation')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_READ)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify every withdrawal invariant. Reports; never repairs.' })
  @ApiResponse({ status: 200 })
  reconcile(@CurrentUser() actor: RequestPrincipal): Promise<WithdrawalReconciliationView> {
    return this.reconciliation.run(actor.userId);
  }
}
