import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type EmailDeliveryView,
  type EmailSettingsView,
  type Page,
  type SendTestEmailResult,
} from '@palcert/contracts';
import type { Request } from 'express';
import { requestIdOf, type RequestPrincipal } from '../../auth/authenticated-request';
import {
  CurrentUser,
  RequirePermissions,
  RequireRecentAuthentication,
} from '../../auth/decorators/auth.decorators';
import { AdminEmailService } from './admin-email.service';
import {
  EmailDeliveryListQueryDto,
  EmailDeliveryParamDto,
  SendTestEmailDto,
  UpdateEmailSettingsDto,
} from './email-settings.dto';

/**
 * Platform email configuration (ADR-0146).
 *
 * Reading is open to auditors; changing anything demands the manage
 * permission and a recent authentication, because it decides where every
 * password-reset link PalCert sends will go. No response ever contains the
 * provider credential in any form — not plaintext, not ciphertext, not IV.
 */
@ApiTags('admin-email')
@ApiCookieAuth()
@Controller('admin')
export class AdminEmailController {
  constructor(private readonly email: AdminEmailService) {}

  @Get('email-settings')
  @RequirePermissions(Permission.ADMIN_EMAIL_SETTINGS_READ)
  @ApiOperation({ summary: 'The platform email configuration, without its secrets' })
  @ApiResponse({ status: 200 })
  settings(): Promise<EmailSettingsView> {
    return this.email.view();
  }

  @Put('email-settings')
  @RequirePermissions(Permission.ADMIN_EMAIL_SETTINGS_MANAGE)
  @RequireRecentAuthentication()
  @ApiOperation({
    summary: 'Change the platform email configuration',
    description:
      'Write-only credential fields are described in docs/api/email.md; leaving one blank keeps ' +
      'the stored value. Resend cannot be enabled without a credential. Credentials are ' +
      'encrypted before storage and never returned.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'EMAIL_ENCRYPTION_UNAVAILABLE' })
  @ApiResponse({ status: 422, description: 'EMAIL_SETTINGS_INVALID' })
  update(
    @CurrentUser() actor: RequestPrincipal,
    @Body() body: UpdateEmailSettingsDto,
    @Req() request: Request,
  ): Promise<EmailSettingsView> {
    return this.email.update(actor.userId, body, requestIdOf(request));
  }

  @Post('email-settings/test')
  @HttpCode(200)
  @RequirePermissions(Permission.ADMIN_EMAIL_SETTINGS_TEST)
  @ApiOperation({
    summary: 'Send a configuration test email',
    description:
      'Rate limited per administrator and platform-wide. Returns a failure category, never provider text.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'EMAIL_PROVIDER_NOT_CONFIGURED' })
  @ApiResponse({ status: 429, description: 'RATE_LIMITED' })
  sendTest(
    @CurrentUser() actor: RequestPrincipal,
    @Body() body: SendTestEmailDto,
    @Req() request: Request,
  ): Promise<SendTestEmailResult> {
    return this.email.sendTest(actor.userId, body, requestIdOf(request));
  }

  @Get('email-deliveries')
  @RequirePermissions(Permission.ADMIN_EMAIL_DELIVERY_READ)
  @ApiOperation({ summary: 'Email delivery history (metadata only)' })
  @ApiResponse({ status: 200 })
  deliveries(@Query() query: EmailDeliveryListQueryDto): Promise<Page<EmailDeliveryView>> {
    return this.email.listDeliveries(query);
  }

  @Get('email-deliveries/:id')
  @RequirePermissions(Permission.ADMIN_EMAIL_DELIVERY_READ)
  @ApiOperation({ summary: 'One email delivery (metadata only)' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'EMAIL_DELIVERY_NOT_FOUND' })
  delivery(@Param() params: EmailDeliveryParamDto): Promise<EmailDeliveryView> {
    return this.email.getDelivery(params.id);
  }
}
