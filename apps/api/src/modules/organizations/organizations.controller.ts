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
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  VERIFICATION_SEMANTICS,
  type OrganizationMembershipSummary,
  type OrganizationProfile,
  type OrganizationVerificationView,
} from '@palcert/contracts';
import {
  requestIdOf,
  type AuthenticatedRequest,
  type RequestPrincipal,
} from '../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../auth/decorators/auth.decorators';
import {
  OrganizationScoped,
  RequireOrganizationPermissions,
  Tenant,
} from './decorators/tenant.decorators';
import {
  CreateOrganizationDto,
  OrganizationIdParamDto,
  RequestVerificationDto,
  UpdateOrganizationDto,
} from './dto/organization.dto';
import {
  OrganizationProfileDto,
  OrganizationVerificationDto,
  UserOrganizationDto,
} from './dto/organization-response.dto';
import { OrganizationsService } from './services/organizations.service';
import { VerificationService } from './services/verification.service';
import type { TenantContext } from './tenant-context';

@ApiTags('organizations')
@ApiCookieAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly verification: VerificationService,
  ) {}

  @Post()
  @RequirePermissions(Permission.PROFILE_READ_SELF)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an organization',
    description:
      'The creator becomes ORGANIZATION_OWNER in the same transaction, so an organization can ' +
      'never exist without an owner. It starts ACTIVE and UNVERIFIED.',
  })
  @ApiResponse({ status: 201, type: OrganizationProfileDto })
  @ApiResponse({ status: 409, description: 'ORGANIZATION_SLUG_TAKEN' })
  async create(
    @Body() dto: CreateOrganizationDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<OrganizationProfile> {
    return this.organizations.create({
      userId: principal.userId,
      type: dto.type,
      displayName: dto.displayName,
      legalName: dto.legalName,
      slug: dto.slug,
      countryCode: dto.countryCode,
      timezone: dto.timezone,
      website: dto.website,
      defaultLocale: dto.defaultLocale ?? principal.preferredLocale,
      requestId: requestIdOf(request),
      ipAddress: request.ip ?? null,
    });
  }

  @Get()
  @RequirePermissions(Permission.PROFILE_READ_SELF)
  @ApiOperation({
    summary: 'List the organizations you belong to',
    description:
      'Returns only organizations where the caller holds a membership. This is not a directory: ' +
      'row-level security makes it structurally incapable of returning an organization the ' +
      'caller has no standing in.',
  })
  @ApiResponse({ status: 200, type: [UserOrganizationDto] })
  async listMine(
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<OrganizationMembershipSummary[]> {
    return this.organizations.listForUser(principal.userId);
  }

  @Get(':organizationId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.ORGANIZATION_PROFILE_READ)
  @ApiOperation({ summary: 'Read an organization profile' })
  @ApiResponse({ status: 200, type: OrganizationProfileDto })
  @ApiResponse({
    status: 404,
    description:
      'ORGANIZATION_NOT_FOUND — returned identically whether the organization does not exist ' +
      'or the caller is not a member, so it cannot be used to discover organization ids.',
  })
  async read(
    @Param() _params: OrganizationIdParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<OrganizationProfile> {
    return this.organizations.getProfile(tenant);
  }

  @Patch(':organizationId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.ORGANIZATION_PROFILE_UPDATE)
  @ApiOperation({
    summary: 'Update an organization profile',
    description:
      'Accepts profile fields only. Verification status, operational status and internal ' +
      'metadata are not addressable here; an attempt to set one is rejected.',
  })
  @ApiResponse({ status: 200, type: OrganizationProfileDto })
  @ApiResponse({ status: 403, description: 'ORGANIZATION_ACCESS_DENIED' })
  async update(
    @Param() _params: OrganizationIdParamDto,
    @Body() dto: UpdateOrganizationDto,
    @Tenant() tenant: TenantContext,
  ): Promise<OrganizationProfile> {
    return this.organizations.updateProfile(tenant, dto);
  }

  @Get(':organizationId/verification')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.ORGANIZATION_VERIFICATION_READ)
  @ApiOperation({
    summary: 'Read verification status',
    description: VERIFICATION_SEMANTICS,
  })
  @ApiResponse({ status: 200, type: OrganizationVerificationDto })
  async readVerification(
    @Param() _params: OrganizationIdParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<OrganizationVerificationView> {
    return this.verification.view(tenant);
  }

  @Post(':organizationId/verification')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.ORGANIZATION_VERIFICATION_REQUEST)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request organization verification',
    description: `Moves the organization to PENDING for PalCert review. ${VERIFICATION_SEMANTICS}`,
  })
  @ApiResponse({ status: 202, type: OrganizationVerificationDto })
  @ApiResponse({
    status: 409,
    description: 'ORGANIZATION_ALREADY_VERIFIED / ORGANIZATION_VERIFICATION_PENDING',
  })
  async requestVerification(
    @Param() _params: OrganizationIdParamDto,
    @Body() dto: RequestVerificationDto,
    @Tenant() tenant: TenantContext,
  ): Promise<OrganizationVerificationView> {
    return this.verification.request(tenant, dto.note);
  }
}
