import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type CertificateEventView,
  type CertificateView,
  type DownloadAuthorizationView,
  type SubmissionCertificateStatusView,
} from '@palcert/contracts';
import type { RequestPrincipal } from '../../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../../auth/decorators/auth.decorators';
import { CertificateParamDto, SubmissionRevisionParamDto } from '../dto/certificate.dto';
import { CertificateReadService } from '../services/certificate-read.service';

/**
 * The subject's own certificates (§116, §118).
 *
 * Read and download only. There is no route here that creates a certificate,
 * because nobody asks PalCert for one: it follows from an institution
 * approving a compliant submission, and a "generate certificate" button would
 * be exactly the self-certification the phase forbids (§190, §191).
 */
@ApiTags('certificates')
@ApiCookieAuth()
@Controller('certificates')
export class CertificatesController {
  constructor(private readonly certificates: CertificateReadService) {}

  @Get()
  @RequirePermissions(Permission.CERTIFICATE_READ_SELF)
  @ApiOperation({ summary: 'Certificates issued for your own official submissions' })
  @ApiResponse({ status: 200 })
  list(@CurrentUser() principal: RequestPrincipal): Promise<CertificateView[]> {
    return this.certificates.listForUser(principal.userId);
  }

  // Declared before ':certificateId' so the literal segment wins the match.
  @Get('revisions/:revisionId')
  @RequirePermissions(Permission.CERTIFICATE_READ_SELF)
  @ApiOperation({
    summary: 'Whether one of your submission revisions has a certificate',
    description:
      'And when it does not, which half of the rule is unmet: PalCert did not find the ' +
      'document compliant, or the institution has not recorded an approval. Never a shared ' +
      '“not eligible” that leaves a person guessing which authority said no.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'CERTIFICATE_NOT_FOUND' })
  status(
    @Param() params: SubmissionRevisionParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<SubmissionCertificateStatusView> {
    return this.certificates.statusForRevision(principal.userId, params.revisionId);
  }

  @Get(':certificateId')
  @RequirePermissions(Permission.CERTIFICATE_READ_SELF)
  @ApiOperation({
    summary: 'One of your certificates',
    description: 'Another person’s certificate id is not found, never forbidden.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'CERTIFICATE_NOT_FOUND' })
  get(
    @Param() params: CertificateParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<CertificateView> {
    return this.certificates.forUser(principal.userId, params.certificateId);
  }

  @Get(':certificateId/events')
  @RequirePermissions(Permission.CERTIFICATE_READ_SELF)
  @ApiOperation({
    summary: 'What has happened to your certificate',
    description: 'Issued, and revoked if it was. Never an internal failure detail.',
  })
  @ApiResponse({ status: 200 })
  events(
    @Param() params: CertificateParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<CertificateEventView[]> {
    return this.certificates.events_({
      certificateId: params.certificateId,
      userId: principal.userId,
    });
  }

  @Post(':certificateId/download')
  @RequirePermissions(Permission.CERTIFICATE_READ_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Download your certificate',
    description:
      'A short-lived signed GET of the exact stored PDF version. A revoked certificate is ' +
      'still downloadable — it is the record of what was issued; what changed is what public ' +
      'verification says about it.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'CERTIFICATE_NOT_ISSUED' })
  download(
    @Param() params: CertificateParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<DownloadAuthorizationView> {
    return this.certificates.download({
      certificateId: params.certificateId,
      userId: principal.userId,
    });
  }
}
