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
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type AdminManualTopUpQueueView,
  type AdminManualTopUpRequestView,
  type ManualTopUpNotificationReportView,
  type DownloadAuthorizationView,
} from '@palcert/contracts';
import type { Request } from 'express';
import type { RequestPrincipal } from '../../auth/authenticated-request';
import {
  CurrentUser,
  RequirePermissions,
  RequireRecentAuthentication,
} from '../../auth/decorators/auth.decorators';
import {
  ApproveManualTopUpDto,
  ManualTopUpParamDto,
  ManualTopUpQueueQueryDto,
  RejectManualTopUpDto,
} from '../dto/manual-topup.dto';
import { ManualTopUpReviewService } from '../services/manual-topup-review.service';
import { contextOf } from './request-context';

/**
 * PalCert finance's review of reported transfers.
 *
 * Reading, opening, approving and rejecting are four permissions. Only
 * PALCERT_FINANCE holds the two that decide; a platform administrator reads
 * the queue and cannot credit anybody. Approval — the one route here that
 * creates money in a balance — also demands a recent authentication.
 */
@ApiTags('admin-manual-topups')
@ApiCookieAuth()
@Controller('admin/manual-topups')
export class AdminManualTopUpsController {
  constructor(private readonly review: ManualTopUpReviewService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_MANUAL_TOPUP_READ)
  @ApiOperation({
    summary: 'The review queue',
    description:
      'Submitted requests, oldest first, with pending totals per currency. Drafts never appear.',
  })
  @ApiResponse({ status: 200 })
  queue(
    @CurrentUser() actor: RequestPrincipal,
    @Query() query: ManualTopUpQueueQueryDto,
  ): Promise<AdminManualTopUpQueueView> {
    return this.review.queue(actor.userId, query);
  }

  @Get(':requestId')
  @RequirePermissions(Permission.FINANCE_MANUAL_TOPUP_READ)
  @ApiOperation({
    summary: 'One request: the reported transfer, the destination snapshot, the history',
  })
  @ApiResponse({ status: 200 })
  get(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: ManualTopUpParamDto,
  ): Promise<AdminManualTopUpRequestView> {
    return this.review.get(actor.userId, params.requestId);
  }

  @Get(':requestId/receipt')
  @RequirePermissions(Permission.FINANCE_MANUAL_TOPUP_READ)
  @ApiOperation({
    summary: 'View the receipt',
    description: 'A short-lived signed URL to the scanned file. Every viewing is audited.',
  })
  @ApiResponse({ status: 200 })
  receipt(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: ManualTopUpParamDto,
    @Req() request: Request,
  ): Promise<DownloadAuthorizationView> {
    return this.review.receiptDownload(actor.userId, params.requestId, contextOf(request));
  }

  @Get(':requestId/notifications')
  @RequirePermissions(Permission.ADMIN_PAYMENT_METHOD_MANAGE)
  @ApiOperation({
    summary: 'Who was alerted about this top-up, and whether the email arrived',
    description:
      'Administrators only. Recipients of the submission alert with in-app and email ' +
      'delivery status and skip reasons, the routing used, and assigned reviewers who ' +
      'could not be alerted. Addresses are masked; no provider detail is returned.',
  })
  @ApiResponse({ status: 200 })
  notificationReport(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: ManualTopUpParamDto,
  ): Promise<ManualTopUpNotificationReportView> {
    return this.review.notificationReport(actor.userId, params.requestId);
  }

  @Post(':requestId/start-review')
  @RequirePermissions(Permission.FINANCE_MANUAL_TOPUP_REVIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Open for review',
    description: 'Records who is reviewing. From here on the customer can no longer cancel.',
  })
  @ApiResponse({ status: 200 })
  startReview(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: ManualTopUpParamDto,
    @Req() request: Request,
  ): Promise<AdminManualTopUpRequestView> {
    return this.review.startReview(actor.userId, params.requestId, contextOf(request));
  }

  @Post(':requestId/approve')
  @RequirePermissions(Permission.FINANCE_MANUAL_TOPUP_APPROVE)
  @RequireRecentAuthentication()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve and credit',
    description:
      'Appends exactly one MANUAL_TOPUP_CREDIT entry to the customer’s CASH balance for the ' +
      'reported amount, in the same transaction as the decision. The amount cannot be edited; ' +
      'the reviewer restates it as confirmation.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'MANUAL_TOPUP_ALREADY_DECIDED' })
  @ApiResponse({ status: 422, description: 'MANUAL_TOPUP_CONFIRMATION_REQUIRED' })
  approve(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: ManualTopUpParamDto,
    @Body() body: ApproveManualTopUpDto,
    @Req() request: Request,
  ): Promise<AdminManualTopUpRequestView> {
    return this.review.approve(actor.userId, params.requestId, body, contextOf(request));
  }

  @Post(':requestId/reject')
  @RequirePermissions(Permission.FINANCE_MANUAL_TOPUP_REJECT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject with a reason', description: 'Moves no money.' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'MANUAL_TOPUP_ALREADY_DECIDED' })
  reject(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: ManualTopUpParamDto,
    @Body() body: RejectManualTopUpDto,
    @Req() request: Request,
  ): Promise<AdminManualTopUpRequestView> {
    return this.review.reject(actor.userId, params.requestId, body, contextOf(request));
  }
}
