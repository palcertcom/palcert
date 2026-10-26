import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppError, PalCertErrorCode } from '@palcert/contracts';
import type { Request } from 'express';
import { Public, ProviderSigned } from '../auth/decorators/auth.decorators';
import { ResendWebhookService } from './resend-webhook.service';

/**
 * Resend's delivery webhook (ADR-0146).
 *
 * No session and no CSRF token: it is authenticated by the Svix signature over
 * the exact request bytes, under the signing secret an administrator saved
 * (encrypted) in the dashboard. It only ever updates delivery metadata.
 */
@ApiTags('webhooks')
@Controller()
export class ResendWebhookController {
  constructor(private readonly webhooks: ResendWebhookService) {}

  @Post('webhooks/resend')
  @Public()
  @ProviderSigned()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resend delivery webhook',
    description:
      'Authenticated by the Svix signature headers over the raw body. Idempotent by svix-id; ' +
      'out-of-order events never move a delivery backwards. Stores a payload hash, never the payload.',
  })
  @ApiResponse({ status: 200, description: 'Received. Includes duplicates, which are no-ops.' })
  @ApiResponse({ status: 400, description: 'EMAIL_WEBHOOK_SIGNATURE_INVALID. No effect.' })
  receive(
    @Req() request: RawBodyRequest<Request>,
  ): Promise<{ received: true; duplicate: boolean }> {
    const rawBody = request.rawBody;
    if (rawBody === undefined) {
      throw new AppError(PalCertErrorCode.INTERNAL_ERROR, {
        message: 'An unexpected error occurred.',
        internalContext: { reason: 'the raw request body was not preserved' },
      });
    }
    return this.webhooks.ingest({
      rawBody,
      svixId: header(request, 'svix-id'),
      svixTimestamp: header(request, 'svix-timestamp'),
      svixSignature: header(request, 'svix-signature'),
    });
  }
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
