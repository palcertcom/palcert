import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type AdminManualPaymentMethodView,
  type ManualPaymentMethodLogoUploadResponse,
  type ManualTopUpReviewerCandidateView,
  type ManualTopUpUploadAuthorizationView,
} from '@palcert/contracts';
import type { Request } from 'express';
import type { RequestPrincipal } from '../../auth/authenticated-request';
import {
  CurrentUser,
  RequirePermissions,
  RequireRecentAuthentication,
} from '../../auth/decorators/auth.decorators';
import {
  CreateManualTopUpFileDto,
  CreatePaymentMethodDto,
  PaymentMethodLogoParamDto,
  PaymentMethodParamDto,
  PaymentMethodVersionDto,
  UpdatePaymentMethodDto,
} from '../dto/manual-topup.dto';
import { ManualPaymentMethodService } from '../services/manual-payment-method.service';
import { contextOf, idempotencyKeyOf } from './request-context';

/**
 * Where PalCert asks people to send money.
 *
 * A platform administrator's job, not finance's: publishing an account is
 * separate from deciding that money arrived in it. Every change that alters
 * where customers pay — editing, enabling, disabling, archiving — demands a
 * recent authentication, because a quietly swapped IBAN is how a payment
 * page is turned against its users.
 */
@ApiTags('admin-payment-methods')
@ApiCookieAuth()
@Controller('admin/payment-methods')
export class AdminPaymentMethodsController {
  constructor(private readonly methods: ManualPaymentMethodService) {}

  @Get()
  @RequirePermissions(Permission.ADMIN_PAYMENT_METHOD_READ)
  @ApiOperation({ summary: 'Every manual payment method, enabled or not' })
  @ApiResponse({ status: 200 })
  list(@CurrentUser() actor: RequestPrincipal): Promise<readonly AdminManualPaymentMethodView[]> {
    return this.methods.list(actor.userId);
  }

  // Declared before ':methodId' so the literal segment wins the match.
  @Get('reviewer-candidates')
  @RequirePermissions(Permission.ADMIN_PAYMENT_METHOD_MANAGE)
  @ApiOperation({
    summary: 'Who may be assigned to review top-ups',
    description:
      'Active PalCert users holding finance:manual-topup:review through a platform role. ' +
      'Nobody else is listed, and no free-text address can be assigned.',
  })
  @ApiResponse({ status: 200 })
  reviewerCandidates(
    @CurrentUser() actor: RequestPrincipal,
  ): Promise<readonly ManualTopUpReviewerCandidateView[]> {
    return this.methods.reviewerCandidates(actor.userId);
  }

  @Get(':methodId')
  @RequirePermissions(Permission.ADMIN_PAYMENT_METHOD_READ)
  @ApiOperation({ summary: 'One manual payment method' })
  @ApiResponse({ status: 200 })
  get(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: PaymentMethodParamDto,
  ): Promise<AdminManualPaymentMethodView> {
    return this.methods.get(actor.userId, params.methodId);
  }

  @Post()
  @RequirePermissions(Permission.ADMIN_PAYMENT_METHOD_MANAGE)
  @RequireRecentAuthentication()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a payment method',
    description: 'Created disabled. Customers see it only once it is enabled.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 409, description: 'MANUAL_PAYMENT_METHOD_CODE_TAKEN' })
  @ApiResponse({ status: 422, description: 'MANUAL_PAYMENT_METHOD_INVALID' })
  create(
    @CurrentUser() actor: RequestPrincipal,
    @Body() body: CreatePaymentMethodDto,
    @Req() request: Request,
  ): Promise<AdminManualPaymentMethodView> {
    return this.methods.create(actor.userId, body, contextOf(request));
  }

  @Patch(':methodId')
  @RequirePermissions(Permission.ADMIN_PAYMENT_METHOD_MANAGE)
  @RequireRecentAuthentication()
  @ApiOperation({
    summary: 'Edit a payment method',
    description:
      'Requests already made keep the details they were made against. Refused with 412 when ' +
      'the method changed since it was read.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 412, description: 'MANUAL_PAYMENT_METHOD_CONFLICT' })
  update(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: PaymentMethodParamDto,
    @Body() body: UpdatePaymentMethodDto,
    @Req() request: Request,
  ): Promise<AdminManualPaymentMethodView> {
    return this.methods.update(actor.userId, params.methodId, body, contextOf(request));
  }

  @Post(':methodId/enable')
  @RequirePermissions(Permission.ADMIN_PAYMENT_METHOD_MANAGE)
  @RequireRecentAuthentication()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Offer this method to customers' })
  @ApiResponse({ status: 200 })
  @ApiResponse({
    status: 422,
    description: 'MANUAL_PAYMENT_METHOD_REVIEWER_REQUIRED — assign an eligible reviewer first',
  })
  enable(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: PaymentMethodParamDto,
    @Body() body: PaymentMethodVersionDto,
    @Req() request: Request,
  ): Promise<AdminManualPaymentMethodView> {
    return this.methods.setEnabled(
      actor.userId,
      params.methodId,
      true,
      body.expectedVersion,
      contextOf(request),
    );
  }

  @Post(':methodId/disable')
  @RequirePermissions(Permission.ADMIN_PAYMENT_METHOD_MANAGE)
  @RequireRecentAuthentication()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stop offering this method',
    description: 'Pending requests stay reviewable; drafts against it can no longer be submitted.',
  })
  @ApiResponse({ status: 200 })
  disable(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: PaymentMethodParamDto,
    @Body() body: PaymentMethodVersionDto,
    @Req() request: Request,
  ): Promise<AdminManualPaymentMethodView> {
    return this.methods.setEnabled(
      actor.userId,
      params.methodId,
      false,
      body.expectedVersion,
      contextOf(request),
    );
  }

  @Post(':methodId/archive')
  @RequirePermissions(Permission.ADMIN_PAYMENT_METHOD_MANAGE)
  @RequireRecentAuthentication()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retire this method permanently',
    description: 'Methods are never deleted: requests name them. Archiving cannot be undone.',
  })
  @ApiResponse({ status: 200 })
  archive(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: PaymentMethodParamDto,
    @Body() body: PaymentMethodVersionDto,
    @Req() request: Request,
  ): Promise<AdminManualPaymentMethodView> {
    return this.methods.archive(
      actor.userId,
      params.methodId,
      body.expectedVersion,
      contextOf(request),
    );
  }

  @Post(':methodId/logo')
  @RequirePermissions(Permission.ADMIN_PAYMENT_METHOD_MANAGE)
  @RequireRecentAuthentication()
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Upload a logo',
    description: 'PNG, JPEG or WebP, at most 1 MB. SVG is refused. Scanned before it is shown.',
  })
  @ApiResponse({ status: 201 })
  createLogo(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: PaymentMethodParamDto,
    @Body() body: CreateManualTopUpFileDto,
    @Req() request: Request,
  ): Promise<ManualPaymentMethodLogoUploadResponse> {
    return this.methods.createLogoUpload(
      actor.userId,
      params.methodId,
      { ...body, idempotencyKey: idempotencyKeyOf(request) },
      contextOf(request),
    );
  }

  @Post(':methodId/logo/:logoId/upload-url')
  @RequirePermissions(Permission.ADMIN_PAYMENT_METHOD_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A fresh upload URL for a logo still awaiting its bytes' })
  @ApiResponse({ status: 200 })
  reauthorizeLogo(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: PaymentMethodLogoParamDto,
  ): Promise<ManualTopUpUploadAuthorizationView> {
    return this.methods.reauthorizeLogo(actor.userId, params.methodId, params.logoId);
  }

  @Post(':methodId/logo/:logoId/finalize')
  @RequirePermissions(Permission.ADMIN_PAYMENT_METHOD_MANAGE)
  @RequireRecentAuthentication()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Make an uploaded logo this method’s logo and start its scan' })
  @ApiResponse({ status: 200 })
  finalizeLogo(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: PaymentMethodLogoParamDto,
    @Req() request: Request,
  ): Promise<AdminManualPaymentMethodView> {
    return this.methods.finalizeLogo(
      actor.userId,
      params.methodId,
      params.logoId,
      contextOf(request),
    );
  }

  @Post(':methodId/logo/remove')
  @RequirePermissions(Permission.ADMIN_PAYMENT_METHOD_MANAGE)
  @RequireRecentAuthentication()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop showing a logo for this method' })
  @ApiResponse({ status: 200 })
  removeLogo(
    @CurrentUser() actor: RequestPrincipal,
    @Param() params: PaymentMethodParamDto,
    @Body() body: PaymentMethodVersionDto,
    @Req() request: Request,
  ): Promise<AdminManualPaymentMethodView> {
    return this.methods.removeLogo(
      actor.userId,
      params.methodId,
      body.expectedVersion,
      contextOf(request),
    );
  }
}
