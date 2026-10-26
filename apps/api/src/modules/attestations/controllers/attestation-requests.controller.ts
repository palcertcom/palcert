import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type AttestationCatalogueOrganizationView,
  type AttestationQuoteView,
  type AttestationReceiptView,
  type AttestationRequestListItemView,
  type AttestationRequestOwnerView,
  type AttestationRequestSummaryView,
  type AttestationTypePublicView,
  type AttestationUploadAuthorizationView,
  type CreateAttestationArtifactResponse,
  type DownloadAuthorizationView,
} from '@palcert/contracts';
import type { Request, Response } from 'express';
import { requestIdOf, type RequestPrincipal } from '../../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../../auth/decorators/auth.decorators';
import {
  CreateArtifactDto,
  CreateAttestationRequestDto,
  MetadataDto,
  OrganizationParamDto,
  OwnerRequestListQueryDto,
  QrQueryDto,
  RequestArtifactParamDto,
  RequestParamDto,
  RespondDto,
} from '../dto/attestation.dto';
import { AttestationArtifactService } from '../services/attestation-artifact.service';
import { AttestationCatalogueService } from '../services/attestation-catalogue.service';
import { AttestationRequestService } from '../services/attestation-request.service';
import { attestationQrPng, attestationQrSvg } from '../services/attestation-verification.service';

function contextOf(request: Request): { requestId: string | null; ipAddress: string | null } {
  return { requestId: requestIdOf(request), ipAddress: request.ip ?? null };
}

/**
 * The certificate owner's side (§2, §19, §25, §38).
 *
 * Every route acts on the caller's own requests under their own row-level
 * security scope. Another person's request id is not found, never forbidden.
 * No route here takes an organization id as authority: the catalogue lists
 * institutions, and a request's institution is its attestation type's.
 */
@ApiTags('attestations')
@ApiCookieAuth()
@Controller()
export class AttestationRequestsController {
  constructor(
    private readonly catalogue: AttestationCatalogueService,
    private readonly requests: AttestationRequestService,
    private readonly artifacts: AttestationArtifactService,
  ) {}

  // --- Catalogue ------------------------------------------------------------

  @Get('attestation-catalogue/organizations')
  @RequirePermissions(Permission.ATTESTATION_SUBMIT_SELF)
  @ApiOperation({ summary: 'Institutions that attest certificates (active, PalCert-verified)' })
  @ApiResponse({ status: 200 })
  organizations(): Promise<AttestationCatalogueOrganizationView[]> {
    return this.catalogue.organizations();
  }

  @Get('attestation-catalogue/organizations/:organizationId/types')
  @RequirePermissions(Permission.ATTESTATION_SUBMIT_SELF)
  @ApiOperation({ summary: 'An institution’s enabled attestation types, with fees' })
  @ApiResponse({ status: 200 })
  types(@Param() params: OrganizationParamDto): Promise<AttestationTypePublicView[]> {
    return this.catalogue.types(params.organizationId);
  }

  // --- Requests -------------------------------------------------------------

  @Get('attestation-requests')
  @RequirePermissions(Permission.ATTESTATION_READ_SELF)
  @ApiOperation({ summary: 'Your attestation requests' })
  @ApiResponse({ status: 200 })
  list(
    @CurrentUser() principal: RequestPrincipal,
    @Query() query: OwnerRequestListQueryDto,
  ): Promise<AttestationRequestListItemView[]> {
    return this.requests.list(principal.userId, { status: query.status });
  }

  @Get('attestation-requests/summary')
  @RequirePermissions(Permission.ATTESTATION_READ_SELF)
  @ApiOperation({ summary: 'Counts for your attestation dashboard' })
  @ApiResponse({ status: 200 })
  summary(@CurrentUser() principal: RequestPrincipal): Promise<AttestationRequestSummaryView> {
    return this.requests.summary(principal.userId);
  }

  @Post('attestation-requests')
  @RequirePermissions(Permission.ATTESTATION_SUBMIT_SELF)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a request (a draft)',
    description:
      'Creates a DRAFT the institution cannot see. Nothing is charged or reserved until submit. ' +
      'Pass previousAttestationId to re-attest (renew) an earlier attestation; the earlier record ' +
      'is never modified.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({
    status: 409,
    description: 'ATTESTATION_TYPE_DISABLED / ATTESTATION_TOO_MANY_PENDING',
  })
  create(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: CreateAttestationRequestDto,
    @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<AttestationRequestOwnerView> {
    return this.requests.create(
      principal.userId,
      { ...body, idempotencyKey: idempotencyKey?.trim() || undefined },
      contextOf(request),
    );
  }

  @Get('attestation-requests/:requestId')
  @RequirePermissions(Permission.ATTESTATION_READ_SELF)
  @ApiOperation({ summary: 'One of your attestation requests' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'ATTESTATION_REQUEST_NOT_FOUND' })
  get(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: RequestParamDto,
  ): Promise<AttestationRequestOwnerView> {
    return this.requests.get(principal.userId, params.requestId);
  }

  @Patch('attestation-requests/:requestId')
  @RequirePermissions(Permission.ATTESTATION_SUBMIT_SELF)
  @ApiOperation({
    summary: 'Edit the certificate details (draft, or when information was requested)',
  })
  @ApiResponse({ status: 200 })
  update(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: RequestParamDto,
    @Body() body: MetadataDto,
    @Req() request: Request,
  ): Promise<AttestationRequestOwnerView> {
    return this.requests.update(principal.userId, params.requestId, body, contextOf(request));
  }

  @Get('attestation-requests/:requestId/quote')
  @RequirePermissions(Permission.ATTESTATION_READ_SELF)
  @ApiOperation({ summary: 'The fee, against your available cash balance' })
  @ApiResponse({ status: 200 })
  quote(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: RequestParamDto,
  ): Promise<AttestationQuoteView> {
    return this.requests.quote(principal.userId, params.requestId);
  }

  @Post('attestation-requests/:requestId/submit')
  @RequirePermissions(Permission.ATTESTATION_SUBMIT_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit to the institution and reserve the fee',
    description:
      'Atomic: the request is priced (fee and PalCert commission copied and frozen), the fee is ' +
      'reserved from your cash balance under a row lock, and the institution is told — or none of ' +
      'it happens. A rejected request releases the reservation in full; an approved one is charged.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 402, description: 'INSUFFICIENT_BALANCE' })
  @ApiResponse({
    status: 409,
    description: 'ATTESTATION_ARTIFACT_NOT_READY / ATTESTATION_TRANSITION_INVALID',
  })
  submit(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: RequestParamDto,
    @Req() request: Request,
  ): Promise<AttestationRequestOwnerView> {
    return this.requests.submit(principal.userId, params.requestId, contextOf(request));
  }

  @Post('attestation-requests/:requestId/cancel')
  @RequirePermissions(Permission.ATTESTATION_SUBMIT_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel before review starts; any reserved fee is released in full',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'ATTESTATION_TRANSITION_INVALID' })
  cancel(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: RequestParamDto,
    @Req() request: Request,
  ): Promise<AttestationRequestOwnerView> {
    return this.requests.cancel(principal.userId, params.requestId, contextOf(request));
  }

  @Post('attestation-requests/:requestId/respond')
  @RequirePermissions(Permission.ATTESTATION_SUBMIT_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Answer the institution’s request for information' })
  @ApiResponse({ status: 200 })
  respond(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: RequestParamDto,
    @Body() body: RespondDto,
    @Req() request: Request,
  ): Promise<AttestationRequestOwnerView> {
    return this.requests.respond(principal.userId, params.requestId, body, contextOf(request));
  }

  @Get('attestation-requests/:requestId/receipt')
  @RequirePermissions(Permission.ATTESTATION_READ_SELF)
  @ApiOperation({ summary: 'The payment receipt for this request' })
  @ApiResponse({ status: 200 })
  receipt(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: RequestParamDto,
  ): Promise<AttestationReceiptView> {
    return this.requests.receipt(principal.userId, params.requestId);
  }

  @Get('attestation-requests/:requestId/qr')
  @RequirePermissions(Permission.ATTESTATION_READ_SELF)
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'The attestation’s QR code (PNG or SVG)',
    description: 'Encodes the public verification URL and nothing else.',
  })
  @ApiResponse({ status: 200 })
  async qr(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: RequestParamDto,
    @Query() query: QrQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const url = await this.requests.verificationUrl(principal.userId, params.requestId);
    if (query.format === 'svg') {
      response.type('image/svg+xml').send(await attestationQrSvg(url));
      return;
    }
    response.type('image/png').send(await attestationQrPng(url));
  }

  // --- The certificate file -------------------------------------------------

  @Post('attestation-requests/:requestId/artifacts')
  @RequirePermissions(Permission.ATTESTATION_SUBMIT_SELF)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start uploading your certificate (PDF, PNG, JPEG or WebP)',
    description:
      'Returns a short-lived presigned PUT for a server-generated quarantine key. The file type ' +
      'is decided by its bytes after upload, never by its name.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 413, description: 'FILE_TOO_LARGE' })
  @ApiResponse({ status: 422, description: 'ATTESTATION_ARTIFACT_TYPE_NOT_ALLOWED' })
  createArtifact(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: RequestParamDto,
    @Body() body: CreateArtifactDto,
    @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CreateAttestationArtifactResponse> {
    return this.artifacts.create(
      principal.userId,
      params.requestId,
      { ...body, idempotencyKey: idempotencyKey?.trim() || undefined },
      contextOf(request),
    );
  }

  @Post('attestation-requests/:requestId/artifacts/:artifactId/finalize')
  @RequirePermissions(Permission.ATTESTATION_SUBMIT_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Finish the upload; security checks run next' })
  @ApiResponse({ status: 200 })
  finalizeArtifact(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: RequestArtifactParamDto,
    @Req() request: Request,
  ): Promise<CreateAttestationArtifactResponse['artifact']> {
    return this.artifacts.finalize(
      principal.userId,
      params.requestId,
      params.artifactId,
      contextOf(request),
    );
  }

  @Post('attestation-requests/:requestId/artifacts/:artifactId/upload-authorization')
  @RequirePermissions(Permission.ATTESTATION_SUBMIT_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A fresh upload URL for a file not yet uploaded' })
  @ApiResponse({ status: 200 })
  reauthorize(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: RequestArtifactParamDto,
  ): Promise<AttestationUploadAuthorizationView> {
    return this.artifacts.reauthorize(principal.userId, params.requestId, params.artifactId);
  }

  @Get('attestation-requests/:requestId/artifact/download')
  @RequirePermissions(Permission.ATTESTATION_READ_SELF)
  @ApiOperation({ summary: 'A short-lived link to your own submitted file' })
  @ApiResponse({ status: 200 })
  download(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: RequestParamDto,
  ): Promise<DownloadAuthorizationView> {
    return this.artifacts.ownerDownload(principal.userId, params.requestId);
  }
}
