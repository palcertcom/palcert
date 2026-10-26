import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { PublicAttestationFileMatchView, PublicAttestationView } from '@palcert/contracts';
import type { Request } from 'express';
import { Public } from '../../auth/decorators/auth.decorators';
import { AuthThrottleService, ThrottleScope } from '../../auth/services/auth-throttle.service';
import { PublicTokenParamDto, VerifyFileDto } from '../dto/attestation.dto';
import { AttestationVerificationService } from '../services/attestation-verification.service';

/**
 * Public attestation verification (§11, §30, §31).
 *
 * Read-only, unauthenticated, throttled per client (never per token), and not
 * enumerable: a token is 160 random bits, looked up by its hash, and a
 * malformed token and an unknown one get the same 404. There is no list, no
 * search, and no lookup by name, email, institution or reference.
 */
@ApiTags('public-attestations')
@Controller('public/attestations')
export class PublicAttestationsController {
  constructor(
    private readonly verification: AttestationVerificationService,
    private readonly throttle: AuthThrottleService,
  ) {}

  @Get(':token')
  @Public()
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @ApiOperation({
    summary: 'Verify an attestation by its public token',
    description:
      'VALID, EXPIRED or REVOKED. Public fields only: no user id, email, storage key, reviewer, ' +
      'fee or private note. The submitted certificate itself is never available here.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'ATTESTATION_NOT_FOUND' })
  @ApiResponse({ status: 429, description: 'RATE_LIMITED' })
  async verify(
    @Param() params: PublicTokenParamDto,
    @Req() request: Request,
  ): Promise<PublicAttestationView> {
    await this.throttle.consume(ThrottleScope.PUBLIC_ATTESTATION_VERIFY, request.ip ?? 'unknown');
    return this.verification.verify(params.token);
  }

  @Post('verify-file')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Is there a valid attestation for exactly this file?',
    description:
      'Takes the SHA-256 the visitor’s browser computed. The file is never uploaded, so there is ' +
      'nothing for PalCert to retain. Matches only unrevoked, unexpired attestations.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 429, description: 'RATE_LIMITED' })
  async verifyFile(
    @Body() body: VerifyFileDto,
    @Req() request: Request,
  ): Promise<PublicAttestationFileMatchView> {
    await this.throttle.consume(ThrottleScope.PUBLIC_ATTESTATION_VERIFY, request.ip ?? 'unknown');
    return this.verification.verifyDigest(body.sha256);
  }
}
