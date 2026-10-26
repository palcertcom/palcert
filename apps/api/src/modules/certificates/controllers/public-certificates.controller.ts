import { Controller, Get, Header, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { PublicCertificateVerificationView } from '@palcert/contracts';
import type { Request } from 'express';
import { Public } from '../../auth/decorators/auth.decorators';
import { AuthThrottleService, ThrottleScope } from '../../auth/services/auth-throttle.service';
import { VerificationCodeParamDto } from '../dto/certificate.dto';
import { PublicCertificateService } from '../services/public-certificate.service';

/**
 * Verifying a certificate, for whoever holds one (§17, §19, §215).
 *
 * The only unauthenticated route in PalCert that answers about somebody's
 * work, and the design is what makes that safe:
 *
 *   * There is exactly one route. No list, no search, no lookup by name,
 *     email, organization, hash or date — a directory of who was certified
 *     is not a thing PalCert will publish (§19).
 *   * It takes a 160-bit code. Finding a certificate requires already having
 *     been given one.
 *   * It creates no session and reads no cookie (§215).
 *   * Unknown, malformed, still-preparing and failed all answer the same flat
 *     404, so nothing can be probed for (§153–§155).
 *   * A revoked certificate answers 200 REVOKED rather than 404, because an
 *     old QR telling its holder the truth is the entire point (§157).
 */
@ApiTags('public-certificates')
@Controller('public/certificates')
export class PublicCertificatesController {
  constructor(
    private readonly certificates: PublicCertificateService,
    private readonly throttle: AuthThrottleService,
  ) {}

  @Get(':verificationCode')
  @Public()
  // §21: a verification page is a capability someone was handed, not content
  // for a search index. A crawler that found one must not publish it.
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  // §23: correct revocation matters more than a cache hit. A verifier must
  // never be shown a stale VALID for a certificate that was withdrawn.
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @ApiOperation({
    summary: 'Verify a certificate by its code',
    description:
      'Unauthenticated. Returns the certificate’s immutable claim and its current validity. ' +
      'Contains no identity, no document title, no comments and no internal identifiers.',
  })
  @ApiResponse({ status: 200, description: 'VALID, REVOKED or EXPIRED' })
  @ApiResponse({ status: 404, description: 'CERTIFICATE_NOT_FOUND' })
  @ApiResponse({ status: 429, description: 'RATE_LIMITED' })
  async verify(
    @Param() params: VerificationCodeParamDto,
    @Req() request: Request,
  ): Promise<PublicCertificateVerificationView> {
    // Throttled per client, never per code: limiting by code would let an
    // attacker exhaust a legitimate holder's budget, and would mean storing
    // the code as a rate-limit key.
    await this.throttle.consume(ThrottleScope.PUBLIC_CERTIFICATE_VERIFY, request.ip ?? 'unknown');
    return this.certificates.verify(params.verificationCode);
  }
}
