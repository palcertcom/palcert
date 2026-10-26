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
  type DownloadAuthorizationView,
  type ManualPaymentMethodView,
  type ManualTopUpReceiptUploadResponse,
  type ManualTopUpRequestView,
  type ManualTopUpUploadAuthorizationView,
} from '@palcert/contracts';
import type { Request } from 'express';
import type { RequestPrincipal } from '../../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../../auth/decorators/auth.decorators';
import {
  CreateManualTopUpDto,
  CreateManualTopUpFileDto,
  ManualTopUpListQueryDto,
  ManualTopUpParamDto,
  ManualTopUpReceiptParamDto,
  UpdateManualTopUpDto,
} from '../dto/manual-topup.dto';
import { ManualPaymentMethodService } from '../services/manual-payment-method.service';
import { ManualTopUpRequestService } from '../services/manual-topup-request.service';
import { contextOf, idempotencyKeyOf } from './request-context';

/**
 * A person's own manual top-ups.
 *
 * Every route is scoped to the caller and runs under their RLS scope; there is
 * no route by which an organization, or another customer, reaches a request or
 * a receipt. Nothing here credits anything: the most a person can do is hand a
 * complete report to PalCert finance.
 */
@ApiTags('balance')
@ApiCookieAuth()
@Controller('balance')
export class ManualTopUpsController {
  constructor(
    private readonly methods: ManualPaymentMethodService,
    private readonly requests: ManualTopUpRequestService,
  ) {}

  @Get('manual-payment-methods')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({
    summary: 'Where you can send a transfer',
    description:
      'Enabled payment methods with their destination details and limits. Logo URLs are ' +
      'short-lived signed links to scanned images.',
  })
  @ApiResponse({ status: 200 })
  catalogue(
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<readonly ManualPaymentMethodView[]> {
    return this.methods.catalogue(principal.userId);
  }

  @Post('manual-topups')
  @RequirePermissions(Permission.BALANCE_TOPUP_SELF)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Start a manual top-up',
    description:
      'Creates a draft against one payment method and freezes that method’s destination ' +
      'details on it. Credits nothing.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 404, description: 'MANUAL_PAYMENT_METHOD_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'MANUAL_TOPUP_TOO_MANY_OPEN' })
  create(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: CreateManualTopUpDto,
    @Req() request: Request,
  ): Promise<ManualTopUpRequestView> {
    return this.requests.createDraft(
      principal.userId,
      { ...body, idempotencyKey: idempotencyKeyOf(request) },
      contextOf(request),
    );
  }

  @Get('manual-topups')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({ summary: 'Your manual top-ups, newest first' })
  @ApiResponse({ status: 200 })
  list(
    @CurrentUser() principal: RequestPrincipal,
    @Query() query: ManualTopUpListQueryDto,
  ): Promise<{ items: readonly ManualTopUpRequestView[]; nextCursor: string | null }> {
    return this.requests.list(principal.userId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }

  @Get('manual-topups/:requestId')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({ summary: 'One manual top-up, with its history' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'MANUAL_TOPUP_NOT_FOUND, also for another person’s' })
  get(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: ManualTopUpParamDto,
  ): Promise<ManualTopUpRequestView> {
    return this.requests.get(principal.userId, params.requestId);
  }

  @Patch('manual-topups/:requestId')
  @RequirePermissions(Permission.BALANCE_TOPUP_SELF)
  @ApiOperation({ summary: 'Fill in or correct a draft' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'MANUAL_TOPUP_TRANSITION_INVALID once submitted' })
  update(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: ManualTopUpParamDto,
    @Body() body: UpdateManualTopUpDto,
  ): Promise<ManualTopUpRequestView> {
    return this.requests.updateDraft(principal.userId, params.requestId, body);
  }

  @Post('manual-topups/:requestId/receipt')
  @RequirePermissions(Permission.BALANCE_TOPUP_SELF)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Upload a receipt',
    description:
      'Optional. Returns a short-lived URL to PUT a PDF, PNG, JPEG or WebP file (at most 5 MB) ' +
      'to. The file is scanned before anybody can open it, and is private to you and PalCert finance.',
  })
  @ApiResponse({ status: 201 })
  createReceipt(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: ManualTopUpParamDto,
    @Body() body: CreateManualTopUpFileDto,
    @Req() request: Request,
  ): Promise<ManualTopUpReceiptUploadResponse> {
    return this.requests.createReceiptUpload(
      principal.userId,
      params.requestId,
      { ...body, idempotencyKey: idempotencyKeyOf(request) },
      contextOf(request),
    );
  }

  @Post('manual-topups/:requestId/receipt/:receiptId/upload-url')
  @RequirePermissions(Permission.BALANCE_TOPUP_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A fresh upload URL for a receipt still awaiting its bytes' })
  @ApiResponse({ status: 200 })
  reauthorizeReceipt(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: ManualTopUpReceiptParamDto,
  ): Promise<ManualTopUpUploadAuthorizationView> {
    return this.requests.reauthorizeReceipt(principal.userId, params.requestId, params.receiptId);
  }

  @Post('manual-topups/:requestId/receipt/:receiptId/finalize')
  @RequirePermissions(Permission.BALANCE_TOPUP_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Attach an uploaded receipt and start its security checks' })
  @ApiResponse({ status: 200 })
  finalizeReceipt(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: ManualTopUpReceiptParamDto,
    @Req() request: Request,
  ): Promise<ManualTopUpRequestView> {
    return this.requests.finalizeReceipt(
      principal.userId,
      params.requestId,
      params.receiptId,
      contextOf(request),
    );
  }

  @Get('manual-topups/:requestId/receipt/download')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({ summary: 'Your receipt, by a short-lived signed URL' })
  @ApiResponse({ status: 200 })
  receipt(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: ManualTopUpParamDto,
  ): Promise<DownloadAuthorizationView> {
    return this.requests.receiptDownload(principal.userId, params.requestId);
  }

  @Post('manual-topups/:requestId/submit')
  @RequirePermissions(Permission.BALANCE_TOPUP_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit for verification',
    description:
      'Hands the report to PalCert finance. The balance changes only if finance matches the ' +
      'transfer and approves it. Repeating the call is harmless.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({
    status: 409,
    description: 'MANUAL_TOPUP_REFERENCE_UNAVAILABLE or MANUAL_PAYMENT_METHOD_UNAVAILABLE',
  })
  @ApiResponse({
    status: 422,
    description: 'MANUAL_TOPUP_INVALID or MANUAL_TOPUP_AMOUNT_OUT_OF_RANGE',
  })
  submit(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: ManualTopUpParamDto,
    @Req() request: Request,
  ): Promise<ManualTopUpRequestView> {
    return this.requests.submit(principal.userId, params.requestId, contextOf(request));
  }

  @Post('manual-topups/:requestId/cancel')
  @RequirePermissions(Permission.BALANCE_TOPUP_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel',
    description: 'Possible for a draft, or for a submission no reviewer has opened yet.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({
    status: 409,
    description: 'MANUAL_TOPUP_TRANSITION_INVALID once review has started',
  })
  cancel(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: ManualTopUpParamDto,
    @Req() request: Request,
  ): Promise<ManualTopUpRequestView> {
    return this.requests.cancel(principal.userId, params.requestId, contextOf(request));
  }
}
