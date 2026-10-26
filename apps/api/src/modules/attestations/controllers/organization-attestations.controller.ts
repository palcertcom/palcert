import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type AttestationQueueCountsView,
  type AttestationQueueEntryView,
  type AttestationRequestReviewView,
  type AttestationTypeView,
  type DownloadAuthorizationView,
  type OrganizationAttestationDashboardView,
  type OrganizationAttestationRevenueView,
  type Page,
} from '@palcert/contracts';
import type { Response } from 'express';
import {
  OrganizationScoped,
  RequireOrganizationPermissions,
  Tenant,
} from '../../organizations/decorators/tenant.decorators';
import type { TenantContext } from '../../organizations/tenant-context';
import {
  ApproveDto,
  ArtifactLinkQueryDto,
  AssignDto,
  AttestationFeeDto,
  AttestationTypeDto,
  OrganizationAttestationParamDto,
  OrganizationParamDto,
  OrganizationRequestParamDto,
  OrganizationTypeParamDto,
  QrQueryDto,
  QueueQueryDto,
  RejectDto,
  RequestInformationDto,
  RevenueQueryDto,
  RevokeDto,
} from '../dto/attestation.dto';
import { AttestationFinanceService } from '../services/attestation-finance.service';
import { AttestationReviewService } from '../services/attestation-review.service';
import { AttestationTypeService } from '../services/attestation-type.service';
import { attestationQrPng, attestationQrSvg } from '../services/attestation-verification.service';

/**
 * The receiving institution's side (§5–§7, §16, §23, §39).
 *
 * Organization-scoped: the path's organization id is a selector that became a
 * verified tenant context by passing the guard. Every permission is a
 * permission, never a role name, so an institution can let a coordinator
 * triage a queue without letting them approve, and let a reviewer approve
 * without letting them revoke or set prices.
 */
@ApiTags('organization-attestations')
@ApiCookieAuth()
@Controller('organizations/:organizationId')
@OrganizationScoped()
export class OrganizationAttestationsController {
  constructor(
    private readonly review: AttestationReviewService,
    private readonly types: AttestationTypeService,
    private readonly finance: AttestationFinanceService,
  ) {}

  // --- Queue ----------------------------------------------------------------

  @Get('attestation-requests')
  @RequireOrganizationPermissions(Permission.ATTESTATION_REQUEST_READ)
  @ApiOperation({ summary: 'The attestation queue, with filters, search, sorting and pages' })
  @ApiResponse({ status: 200 })
  queue(
    @Tenant() tenant: TenantContext,
    @Query() query: QueueQueryDto,
  ): Promise<Page<AttestationQueueEntryView>> {
    return this.review.queue(tenant, query);
  }

  @Get('attestation-requests/counts')
  @RequireOrganizationPermissions(Permission.ATTESTATION_REQUEST_READ)
  @ApiOperation({ summary: 'How many requests are in each queue tab' })
  @ApiResponse({ status: 200 })
  counts(@Tenant() tenant: TenantContext): Promise<AttestationQueueCountsView> {
    return this.review.counts(tenant);
  }

  @Get('attestation-dashboard')
  @RequireOrganizationPermissions(Permission.ATTESTATION_REQUEST_READ)
  @ApiOperation({
    summary: 'Attestation dashboard figures',
    description: 'Revenue is included only for callers who may read attestation finance.',
  })
  @ApiResponse({ status: 200 })
  dashboard(@Tenant() tenant: TenantContext): Promise<OrganizationAttestationDashboardView> {
    return this.review.dashboard(
      tenant,
      tenant.permissions.has(Permission.ATTESTATION_FINANCE_READ),
    );
  }

  @Get('attestation-requests/:requestId')
  @RequireOrganizationPermissions(Permission.ATTESTATION_REQUEST_READ)
  @ApiOperation({ summary: 'One request, with its file, history, fee and same-file requests' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'ATTESTATION_REQUEST_NOT_FOUND' })
  get(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationRequestParamDto,
  ): Promise<AttestationRequestReviewView> {
    return this.review.get(tenant, params.requestId);
  }

  @Get('attestation-requests/:requestId/artifact')
  @RequireOrganizationPermissions(Permission.ATTESTATION_REQUEST_READ)
  @ApiOperation({ summary: 'A short-lived link to the submitted file (audited)' })
  @ApiResponse({ status: 200 })
  artifact(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationRequestParamDto,
    @Query() query: ArtifactLinkQueryDto,
  ): Promise<DownloadAuthorizationView> {
    return this.review.artifactLink(tenant, params.requestId, query.disposition ?? 'attachment');
  }

  // --- Decisions ------------------------------------------------------------

  @Post('attestation-requests/:requestId/start-review')
  @RequireOrganizationPermissions(Permission.ATTESTATION_REQUEST_REVIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Take a submitted request into review (assigns it to you)' })
  @ApiResponse({ status: 200 })
  startReview(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationRequestParamDto,
  ): Promise<AttestationRequestReviewView> {
    return this.review.startReview(tenant, params.requestId);
  }

  @Post('attestation-requests/:requestId/assign')
  @RequireOrganizationPermissions(Permission.ATTESTATION_REQUEST_REVIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign the request to a member, or clear the assignment' })
  @ApiResponse({ status: 200 })
  assign(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationRequestParamDto,
    @Body() body: AssignDto,
  ): Promise<AttestationRequestReviewView> {
    return this.review.assign(tenant, params.requestId, body.reviewerUserId ?? null);
  }

  @Post('attestation-requests/:requestId/request-information')
  @RequireOrganizationPermissions(Permission.ATTESTATION_REQUEST_REVIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the requester for more information' })
  @ApiResponse({ status: 200 })
  requestInformation(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationRequestParamDto,
    @Body() body: RequestInformationDto,
  ): Promise<AttestationRequestReviewView> {
    return this.review.requestInformation(tenant, params.requestId, body.message);
  }

  @Post('attestation-requests/:requestId/reject')
  @RequireOrganizationPermissions(Permission.ATTESTATION_REQUEST_REVIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject; the requester sees the reason and any reserved fee is released in full',
  })
  @ApiResponse({ status: 200 })
  reject(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationRequestParamDto,
    @Body() body: RejectDto,
  ): Promise<AttestationRequestReviewView> {
    return this.review.reject(tenant, params.requestId, body.reason);
  }

  @Post('attestation-requests/:requestId/approve')
  @RequireOrganizationPermissions(Permission.ATTESTATION_REQUEST_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve and issue the attestation',
    description:
      'Re-hashes the stored file before anything is written. Records confirmed metadata and ' +
      'explicit validFrom/validUntil instants on an immutable attestation with a public link ' +
      'and QR. The reserved fee is then captured and split by PalCert’s settlement job.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({
    status: 409,
    description: 'ATTESTATION_ARTIFACT_INTEGRITY_FAILED / ATTESTATION_TRANSITION_INVALID',
  })
  @ApiResponse({
    status: 422,
    description: 'ATTESTATION_VALIDITY_INVALID / ATTESTATION_CONFIRMATION_REQUIRED',
  })
  approve(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationRequestParamDto,
    @Body() body: ApproveDto,
  ): Promise<AttestationRequestReviewView> {
    return this.review.approve(tenant, params.requestId, body);
  }

  @Post('attestations/:attestationId/revoke')
  @RequireOrganizationPermissions(Permission.ATTESTATION_RECORD_REVOKE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke an attestation',
    description:
      'The public page shows REVOKED immediately. The record is kept; no fee is refunded automatically.',
  })
  @ApiResponse({ status: 200 })
  revoke(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationAttestationParamDto,
    @Body() body: RevokeDto,
  ): Promise<AttestationRequestReviewView> {
    return this.review.revoke(tenant, params.attestationId, body.reason);
  }

  @Get('attestations/:attestationId/qr')
  @RequireOrganizationPermissions(Permission.ATTESTATION_REQUEST_READ)
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({ summary: 'The attestation’s QR code (PNG or SVG)' })
  @ApiResponse({ status: 200 })
  async qr(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationAttestationParamDto,
    @Query() query: QrQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const url = await this.review.verificationUrl(tenant, params.attestationId);
    if (query.format === 'svg') {
      response.type('image/svg+xml').send(await attestationQrSvg(url));
      return;
    }
    response.type('image/png').send(await attestationQrPng(url));
  }

  // --- Types and fees -------------------------------------------------------

  @Get('attestation-types')
  @RequireOrganizationPermissions(Permission.ATTESTATION_REQUEST_READ)
  @ApiOperation({ summary: 'This organization’s attestation types' })
  @ApiResponse({ status: 200 })
  listTypes(
    @Tenant() tenant: TenantContext,
    @Param() _params: OrganizationParamDto,
  ): Promise<AttestationTypeView[]> {
    return this.types.list(tenant);
  }

  @Post('attestation-types')
  @RequireOrganizationPermissions(Permission.ATTESTATION_TYPE_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an attestation type',
    description: 'A non-zero fee additionally requires the attestation fee permission.',
  })
  @ApiResponse({ status: 201 })
  createType(
    @Tenant() tenant: TenantContext,
    @Body() body: AttestationTypeDto,
  ): Promise<AttestationTypeView> {
    return this.types.create(tenant, body);
  }

  @Get('attestation-types/:typeId')
  @RequireOrganizationPermissions(Permission.ATTESTATION_REQUEST_READ)
  @ApiOperation({ summary: 'One attestation type' })
  @ApiResponse({ status: 200 })
  getType(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationTypeParamDto,
  ): Promise<AttestationTypeView> {
    return this.types.get(tenant, params.typeId);
  }

  @Patch('attestation-types/:typeId')
  @RequireOrganizationPermissions(Permission.ATTESTATION_TYPE_MANAGE)
  @ApiOperation({ summary: 'Configure a type (everything but the fee)' })
  @ApiResponse({ status: 200 })
  updateType(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationTypeParamDto,
    @Body() body: AttestationTypeDto,
  ): Promise<AttestationTypeView> {
    return this.types.update(tenant, params.typeId, body);
  }

  @Put('attestation-types/:typeId/fee')
  @RequireOrganizationPermissions(Permission.ATTESTATION_FEE_MANAGE)
  @ApiOperation({
    summary: 'Set a type’s fee',
    description: 'Affects only requests submitted afterwards; submitted requests keep their price.',
  })
  @ApiResponse({ status: 200 })
  setFee(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationTypeParamDto,
    @Body() body: AttestationFeeDto,
  ): Promise<AttestationTypeView> {
    return this.types.setFee(tenant, params.typeId, body);
  }

  // --- Revenue --------------------------------------------------------------

  @Get('attestation-revenue')
  @RequireOrganizationPermissions(Permission.ATTESTATION_FINANCE_READ)
  @ApiOperation({
    summary: 'Attestation revenue: gross, PalCert commission, net, reserved, settled, released',
  })
  @ApiResponse({ status: 200 })
  revenue(
    @Tenant() tenant: TenantContext,
    @Query() query: RevenueQueryDto,
  ): Promise<OrganizationAttestationRevenueView> {
    return this.finance.organizationRevenue(tenant, query);
  }
}
