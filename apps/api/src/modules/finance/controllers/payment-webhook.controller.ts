import { Controller, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppError, PalCertErrorCode } from '@palcert/contracts';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public, ProviderSigned } from '../../auth/decorators/auth.decorators';
import { PaymentEventService } from '../services/payment-event.service';

/**
 * The payment provider's webhook endpoint (§47, §48, §54, §119, §122).
 *
 * Unlike every other route in PalCert, this one has no session and no CSRF
 * token. It is authenticated by the provider's own signature over the exact
 * bytes of the request body — a stronger proof than a cookie, and the only one
 * a server-to-server caller can offer.
 *
 * It does the least work that is safe: verify, record durably, acknowledge.
 * The accounting happens afterwards in the worker (§54), because a provider
 * that times out waiting for PalCert to finish will retry — and retries are
 * precisely what all of this is arranged to survive without double-crediting.
 */
@ApiTags('webhooks')
@Controller()
export class PaymentWebhookController {
  constructor(private readonly events: PaymentEventService) {}

  @Post('webhooks/payments/:provider')
  @Public()
  @ProviderSigned()
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'provider', description: 'The configured payment provider’s name.' })
  @ApiOperation({
    summary: 'Payment provider webhook',
    description:
      'Authenticated by provider signature over the raw request body, never by a session, ' +
      'and therefore exempt from browser CSRF checks. Returns quickly; financial work happens ' +
      'asynchronously. The request body is the provider’s own and is documented by the ' +
      'provider, never reproduced here.',
  })
  @ApiResponse({ status: 200, description: 'Received. Includes duplicates, which are no-ops.' })
  @ApiResponse({ status: 400, description: 'WEBHOOK_SIGNATURE_INVALID. No financial effect.' })
  async receive(
    @Param('provider') provider: string,
    @Req() request: RawBodyRequest<Request>,
  ): Promise<{ received: boolean; duplicate: boolean }> {
    // `rawBody` is populated because the app is created with `rawBody: true`.
    // Its absence means middleware consumed the body before it reached here,
    // which would make every signature check fail — so it is an error rather
    // than something to work around by re-serializing the parsed object (§48).
    const rawBody = request.rawBody;
    if (rawBody === undefined) {
      throw new AppError(PalCertErrorCode.INTERNAL_ERROR, {
        message: 'An unexpected error occurred.',
        internalContext: {
          reason: 'the raw request body was not preserved; provider signatures cannot be verified',
        },
      });
    }

    const signature = signatureHeaderOf(request);
    const outcome = await this.events.ingest({ rawBody, signatureHeader: signature });
    // 200 even for a duplicate: the provider has delivered it successfully and
    // should stop retrying (§51, §122).
    return { received: outcome.accepted, duplicate: outcome.duplicate };
  }
}

/**
 * The signature header, whichever provider sent it.
 *
 * Named per provider rather than generic because each one spells it
 * differently; the adapter decides what to do with the value, and this only
 * finds it.
 */
function signatureHeaderOf(request: Request): string | undefined {
  const candidates = ['stripe-signature', 'x-palcert-signature'];
  for (const name of candidates) {
    const value = request.headers[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
