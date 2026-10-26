import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type AdminWithdrawalRequestView,
  type DownloadAuthorizationView,
  type ManualTopUpUploadAuthorizationView,
  type WithdrawalDestinationRevealView,
  type WithdrawalNotificationReportView,
  type WithdrawalProofUploadResponse,
  type WithdrawalQueueView,
} from '@palcert/contracts';
import type { Request } from 'express';
import type { RequestPrincipal } from '../../auth/authenticated-request';
import {
  CurrentUser,
  RequirePermissions,
  RequireRecentAuthentication,
} from '../../auth/decorators/auth.decorators';
import {
  AdminWithdrawalQueueQueryDto,
  ApproveWithdrawalDto,
  CreateWithdrawalProofDto,
  MarkFailedDto,
  MarkPaidDto,
  RejectWithdrawalDto,
  ReleaseWithdrawalDto,
  VersionDto,
  WithdrawalParamDto,
  WithdrawalProofParamDto,
} from '../dto/withdrawal.dto';
import { WithdrawalReviewService, type FinanceActor } from '../services/withdrawal-review.service';
import { contextOf, idempotencyKeyOf } from './request-context';

function financeActor(principal: RequestPrincipal): FinanceActor {
  return {
    userId: principal.userId,
    permissions: principal.permissions,
    sessionId: principal.sessionId,
  };
}

/**
 * PalCert finance's withdrawal queue and actions (spec §21–§27, §32, §33).
 *
 * Viewing is not approving and approving is not executing: each act has its
 * own permission. Approval, execution and release also need a recent
 * authentication, and the service enforces separation of duties on top —
 * holding every permission, PALCERT_ADMIN included, never lets somebody act
 * on their own request (D8). Nothing here calls a bank or a wallet: a payout
 * is sent outside PalCert and recorded here with its transfer reference.
 */
@ApiTags('admin-withdrawals')
@ApiCookieAuth()
@Controller('admin/withdrawals')
export class AdminWithdrawalsController {
  constructor(private readonly review: WithdrawalReviewService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_READ)
  @ApiOperation({
    summary: 'The withdrawal queue',
    description:
      'Filters by status, scope, currency, organization, requester and date. Totals are per currency.',
  })
  @ApiResponse({ status: 200 })
  queue(
    @CurrentUser() actor: RequestPrincipal,
    @Query() query: AdminWithdrawalQueueQueryDto,
  ): Promise<WithdrawalQueueView> {
    return this.review.queue(actor.userId, {
      status: query.status,
      scope: query.scope,
      currency: query.currency,
      organizationId: query.organizationId,
      requesterUserId: query.requesterUserId,
      from: query.from === undefined ? undefined : new Date(query.from),
      to: query.to === undefined ? undefined : new Date(query.to),
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  @Get(':requestId')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_READ)
  @ApiOperation({ summary: 'One withdrawal with its timeline, attempts and allowed actions' })
  @ApiResponse({ status: 200 })
  get(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
  ): Promise<AdminWithdrawalRequestView> {
    return this.review.get(financeActor(actor), params.requestId);
  }

  @Get(':requestId/destination')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_REVIEW)
  @ApiOperation({
    summary: 'The full payout instructions',
    description:
      'Opened from the copy frozen at submission, never from the current saved destination. ' +
      'Every read is audited.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 503, description: 'PAYOUT_DESTINATION_ENCRYPTION_UNAVAILABLE' })
  destination(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
    @Req() request: Request,
  ): Promise<WithdrawalDestinationRevealView> {
    return this.review.revealDestination(financeActor(actor), params.requestId, contextOf(request));
  }

  @Get(':requestId/notifications')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_READ)
  @ApiOperation({ summary: 'Who was notified, and what happened to each in-app copy and email' })
  @ApiResponse({ status: 200 })
  notifications(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
  ): Promise<WithdrawalNotificationReportView> {
    return this.review.notificationReport(actor.userId, params.requestId);
  }

  @Post(':requestId/start-review')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_REVIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Open a withdrawal for review' })
  @ApiResponse({ status: 200 })
  startReview(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
    @Req() request: Request,
  ): Promise<AdminWithdrawalRequestView> {
    return this.review.startReview(financeActor(actor), params.requestId, contextOf(request));
  }

  @Post(':requestId/approve')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_APPROVE)
  @RequireRecentAuthentication()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve the payout',
    description:
      'Authorizes the payout. Moves no money; the reservation stays until it is paid or released.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'WITHDRAWAL_SEPARATION_OF_DUTIES' })
  approve(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
    @Body() body: ApproveWithdrawalDto,
    @Req() request: Request,
  ): Promise<AdminWithdrawalRequestView> {
    return this.review.approve(financeActor(actor), params.requestId, body, contextOf(request));
  }

  @Post(':requestId/reject')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_REVIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject with a reason', description: 'Releases the reserved amount.' })
  @ApiResponse({ status: 200 })
  reject(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
    @Body() body: RejectWithdrawalDto,
    @Req() request: Request,
  ): Promise<AdminWithdrawalRequestView> {
    return this.review.reject(financeActor(actor), params.requestId, body, contextOf(request));
  }

  @Post(':requestId/start-execution')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_EXECUTE)
  @RequireRecentAuthentication()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record that the external transfer is being sent',
    description: 'From APPROVED, or from FAILED as a retry. Each is a new, append-only attempt.',
  })
  @ApiResponse({ status: 200 })
  startExecution(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
    @Body() body: VersionDto,
    @Req() request: Request,
  ): Promise<AdminWithdrawalRequestView> {
    return this.review.startExecution(
      financeActor(actor),
      params.requestId,
      body,
      contextOf(request),
    );
  }

  @Post(':requestId/mark-paid')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_EXECUTE)
  @RequireRecentAuthentication()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record the payout and settle it',
    description:
      'Mandatory transfer reference. Settles exactly once under withdrawal:<id>:settle; a ' +
      'repeated call returns the same result and never settles twice.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({
    status: 422,
    description: 'WITHDRAWAL_REFERENCE_REQUIRED, WITHDRAWAL_CONFIRMATION_REQUIRED',
  })
  markPaid(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
    @Body() body: MarkPaidDto,
    @Req() request: Request,
  ): Promise<AdminWithdrawalRequestView> {
    return this.review.markPaid(financeActor(actor), params.requestId, body, contextOf(request));
  }

  @Post(':requestId/mark-failed')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_EXECUTE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record a failed transfer',
    description: 'Keeps the reservation. Nothing is released or retried automatically.',
  })
  @ApiResponse({ status: 200 })
  markFailed(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
    @Body() body: MarkFailedDto,
    @Req() request: Request,
  ): Promise<AdminWithdrawalRequestView> {
    return this.review.markFailed(financeActor(actor), params.requestId, body, contextOf(request));
  }

  @Post(':requestId/release')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_APPROVE)
  @RequireRecentAuthentication()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Release an approved or failed withdrawal',
    description:
      'A deliberate decision not to pay, with a mandatory reason. Releases the reservation.',
  })
  @ApiResponse({ status: 200 })
  release(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
    @Body() body: ReleaseWithdrawalDto,
    @Req() request: Request,
  ): Promise<AdminWithdrawalRequestView> {
    return this.review.release(financeActor(actor), params.requestId, body, contextOf(request));
  }

  // --- Proof of payout ----------------------------------------------------

  @Post(':requestId/proofs')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_EXECUTE)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Start uploading a payout proof',
    description:
      'PDF, PNG, JPEG or WebP. Scanned before it can be viewed; never public and never emailed.',
  })
  @ApiResponse({ status: 201 })
  createProof(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
    @Body() body: CreateWithdrawalProofDto,
    @Req() request: Request,
  ): Promise<WithdrawalProofUploadResponse> {
    return this.review.createProofUpload(
      financeActor(actor),
      params.requestId,
      body,
      idempotencyKeyOf(request),
      contextOf(request),
    );
  }

  @Post(':requestId/proofs/:proofId/upload-url')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_EXECUTE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A fresh upload link for a proof not yet uploaded' })
  @ApiResponse({ status: 200 })
  reauthorizeProof(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalProofParamDto,
  ): Promise<ManualTopUpUploadAuthorizationView> {
    return this.review.reauthorizeProof(financeActor(actor), params.requestId, params.proofId);
  }

  @Post(':requestId/proofs/:proofId/finalize')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_EXECUTE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Finish a proof upload and queue its scan' })
  @ApiResponse({ status: 200 })
  finalizeProof(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalProofParamDto,
    @Req() request: Request,
  ): Promise<AdminWithdrawalRequestView> {
    return this.review.finalizeProof(
      financeActor(actor),
      params.requestId,
      params.proofId,
      contextOf(request),
    );
  }

  @Get(':requestId/proof')
  @RequirePermissions(Permission.FINANCE_WITHDRAWAL_READ)
  @ApiOperation({ summary: 'The payout proof, by a short-lived link. Every viewing is audited.' })
  @ApiResponse({ status: 200 })
  proof(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: WithdrawalParamDto,
    @Req() request: Request,
  ): Promise<DownloadAuthorizationView> {
    return this.review.proofDownload(financeActor(actor), params.requestId, contextOf(request));
  }
}
