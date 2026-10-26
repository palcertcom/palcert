import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type CertificateEventView,
  type CertificateView,
  type DownloadAuthorizationView,
  type OrganizationCertificateListEntryView,
  type Page,
} from '@palcert/contracts';
import {
  OrganizationScoped,
  RequireOrganizationPermissions,
  Tenant,
} from '../../organizations/decorators/tenant.decorators';
import type { TenantContext } from '../../organizations/tenant-context';
import {
  OrganizationCertificateListQueryDto,
  OrganizationCertificateParamDto,
  OrganizationIdOnlyParamDto,
  RevokeCertificateDto,
} from '../dto/certificate.dto';
import { CertificateReadService } from '../services/certificate-read.service';
import { CertificateRevocationService } from '../services/certificate-revocation.service';

/**
 * Certificates, as the institution that caused them sees them (§119).
 *
 * Reading is part of reviewing, so every role that reviews can do it.
 * Revoking is a separate permission and a heavier act — a certificate is the
 * thing a person shows an employer — so it is withheld by default from
 * reviewers and template managers alike (§63, §213).
 *
 * There is no route here that issues a certificate. An organization's approval
 * is what makes one eligible; it does not grant the ability to create one
 * (§192).
 */
@ApiTags('certificate-review')
@ApiCookieAuth()
@Controller('organizations/:organizationId/certificates')
@OrganizationScoped()
export class CertificateReviewController {
  constructor(
    private readonly certificates: CertificateReadService,
    private readonly revocation: CertificateRevocationService,
  ) {}

  @Get()
  @RequireOrganizationPermissions(Permission.CERTIFICATE_READ)
  @ApiOperation({
    summary: 'The certificates this organization’s approvals produced',
    description:
      'Newest first, paginated. Each row carries the certificate number, read from its own ' +
      'claim, and never the verification code or link.',
  })
  @ApiResponse({ status: 200 })
  list(
    @Tenant() tenant: TenantContext,
    @Param() _params: OrganizationIdOnlyParamDto,
    @Query() query: OrganizationCertificateListQueryDto,
  ): Promise<Page<OrganizationCertificateListEntryView>> {
    return this.certificates.listForOrganization(tenant, {
      status: query.status,
      search: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get(':certificateId')
  @RequireOrganizationPermissions(Permission.CERTIFICATE_READ)
  @ApiOperation({ summary: 'One certificate this organization’s approval produced' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'CERTIFICATE_NOT_FOUND' })
  get(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationCertificateParamDto,
  ): Promise<CertificateView> {
    return this.certificates.forOrganization(tenant, params.certificateId);
  }

  @Get(':certificateId/events')
  @RequireOrganizationPermissions(Permission.CERTIFICATE_READ)
  @ApiOperation({ summary: 'The certificate’s lifecycle' })
  @ApiResponse({ status: 200 })
  events(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationCertificateParamDto,
  ): Promise<CertificateEventView[]> {
    return this.certificates.events_({
      certificateId: params.certificateId,
      userId: tenant.userId,
      organizationId: tenant.organizationId,
    });
  }

  @Post(':certificateId/download')
  @RequireOrganizationPermissions(Permission.CERTIFICATE_READ)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Download the exact certificate PDF' })
  @ApiResponse({ status: 200 })
  download(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationCertificateParamDto,
  ): Promise<DownloadAuthorizationView> {
    return this.certificates.download({
      certificateId: params.certificateId,
      userId: tenant.userId,
      organizationId: tenant.organizationId,
    });
  }

  @Post(':certificateId/revocation')
  @RequireOrganizationPermissions(Permission.CERTIFICATE_REVOKE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw a certificate',
    description:
      'Changes what public verification says, and nothing else. PalCert’s technical result, ' +
      'the institution decision, the Phase 14 history and the issued PDF are all untouched — ' +
      'the artifact keeps existing and its QR now resolves to a page saying it was withdrawn, ' +
      'which is the point of online verification. There is no un-revoke.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'CERTIFICATE_ALREADY_REVOKED' })
  @ApiResponse({ status: 409, description: 'CERTIFICATE_NOT_ISSUED' })
  async revoke(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationCertificateParamDto,
    @Body() body: RevokeCertificateDto,
  ): Promise<CertificateView> {
    await this.revocation.revoke(tenant, params.certificateId, {
      reasonCode: body.reasonCode,
      comment: body.comment,
    });
    return this.certificates.forOrganization(tenant, params.certificateId);
  }
}
