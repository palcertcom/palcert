import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  AppError,
  OrganizationStatus,
  PalCertErrorCode,
  Permission,
  SecurityEventType,
  canTransitionOrganizationStatus,
  type AdminOrganizationDetailView,
  type OrganizationProfile,
  type Page,
} from '@palcert/contracts';
import {
  requestIdOf,
  type AuthenticatedRequest,
  type RequestPrincipal,
} from '../auth/authenticated-request';
import {
  CurrentUser,
  RequirePermissions,
  RequireRecentAuthentication,
} from '../auth/decorators/auth.decorators';
import { SecurityEventService } from '../auth/services/security-event.service';
import { ClockPort } from '../auth/ports/clock.port';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import {
  OrganizationIdParamDto,
  PageQueryDto,
  SuspendOrganizationDto,
  VerificationDecisionDto,
} from '../organizations/dto/organization.dto';
import {
  OrganizationPageDto,
  OrganizationProfileDto,
  PendingVerificationDto,
} from '../organizations/dto/organization-response.dto';
import { OrganizationsService } from '../organizations/services/organizations.service';
import { VerificationService } from '../organizations/services/verification.service';

/**
 * PalCert staff administration over organizations.
 *
 * Every route here reaches across tenants, so every route:
 *  - demands an explicit `admin:organization:*` permission,
 *  - goes through `TenantPrismaService.withPlatformAdmin`, which states a
 *    reason and logs the elevation,
 *  - writes an audit record.
 *
 * Ordinary tenant routes never touch this path, which is what keeps
 * cross-tenant reach an explicit staff capability rather than an ambient
 * property of the application process (§22).
 */
@ApiTags('admin-organizations')
@ApiCookieAuth()
@Controller('admin/organizations')
export class AdminOrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly verification: VerificationService,
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  @Get()
  @RequirePermissions(Permission.ADMIN_ORGANIZATION_READ)
  @ApiOperation({ summary: 'List all organizations' })
  @ApiResponse({ status: 200, type: OrganizationPageDto })
  async list(
    @Query() query: PageQueryDto,
    @CurrentUser() actor: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<Page<OrganizationProfile>> {
    return this.organizations.listAllForAdmin({
      actorUserId: actor.userId,
      cursor: query.cursor,
      limit: query.limit,
      requestId: requestIdOf(request),
    });
  }

  @Get('verification-queue')
  @RequirePermissions(Permission.ADMIN_ORGANIZATION_VERIFY)
  @ApiOperation({ summary: 'Organizations awaiting verification review' })
  @ApiResponse({ status: 200, type: [PendingVerificationDto] })
  async verificationQueue(@CurrentUser() actor: RequestPrincipal): Promise<
    Array<{
      requestId: string;
      organizationId: string;
      organizationName: string;
      requestedAt: string;
      submissionNote: string | null;
    }>
  > {
    return this.verification.listPending(actor.userId);
  }

  // Declared after the literal routes above, so `verification-queue` wins.
  @Get(':organizationId')
  @RequirePermissions(Permission.ADMIN_ORGANIZATION_READ)
  @ApiOperation({
    summary: 'One organization, for staff',
    description:
      'The profile with its real member count, the suspension on record, and its ' +
      'verification history. Internal review notes are included only for callers who may ' +
      'decide verification.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'ORGANIZATION_NOT_FOUND' })
  read(
    @Param() params: OrganizationIdParamDto,
    @CurrentUser() actor: RequestPrincipal,
  ): Promise<AdminOrganizationDetailView> {
    return this.organizations.getForAdmin({
      actorUserId: actor.userId,
      organizationId: params.organizationId,
      includeInternalNotes: actor.permissions.has(Permission.ADMIN_ORGANIZATION_VERIFY),
    });
  }

  @Post(':organizationId/verification')
  @RequirePermissions(Permission.ADMIN_ORGANIZATION_VERIFY)
  @RequireRecentAuthentication()
  @ApiOperation({
    summary: 'Approve or reject organization verification',
    description:
      'Requires a recently authenticated session. `decisionReason` is shown to the ' +
      'organization; `internalNotes` never leaves PalCert.',
  })
  @ApiResponse({ status: 201, description: 'The organization’s new verification status.' })
  @ApiResponse({
    status: 409,
    description: 'CONFLICT — no pending request, or an invalid transition',
  })
  async decideVerification(
    @Param() params: OrganizationIdParamDto,
    @Body() dto: VerificationDecisionDto,
    @CurrentUser() actor: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ status: string }> {
    return this.verification.decide({
      actorUserId: actor.userId,
      organizationId: params.organizationId,
      approve: dto.approve,
      decisionReason: dto.decisionReason,
      internalNotes: dto.internalNotes,
      requestId: requestIdOf(request),
    });
  }

  @Post(':organizationId/suspend')
  @RequirePermissions(Permission.ADMIN_ORGANIZATION_SUSPEND)
  @RequireRecentAuthentication()
  @ApiOperation({
    summary: 'Suspend an organization',
    description:
      'Blocks every organization-scoped operation immediately. Members keep their PalCert ' +
      'accounts and their access to other organizations (§38).',
  })
  @ApiResponse({ status: 201, type: OrganizationProfileDto })
  async suspend(
    @Param() params: OrganizationIdParamDto,
    @Body() dto: SuspendOrganizationDto,
    @CurrentUser() actor: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ id: string; status: string }> {
    return this.changeStatus({
      organizationId: params.organizationId,
      to: OrganizationStatus.SUSPENDED,
      actor,
      request,
      reason: dto.reason,
    });
  }

  @Post(':organizationId/reactivate')
  @RequirePermissions(Permission.ADMIN_ORGANIZATION_SUSPEND)
  @RequireRecentAuthentication()
  @ApiOperation({ summary: 'Reactivate a suspended organization' })
  @ApiResponse({ status: 201, type: OrganizationProfileDto })
  async reactivate(
    @Param() params: OrganizationIdParamDto,
    @CurrentUser() actor: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ id: string; status: string }> {
    return this.changeStatus({
      organizationId: params.organizationId,
      to: OrganizationStatus.ACTIVE,
      actor,
      request,
    });
  }

  private async changeStatus(params: {
    organizationId: string;
    to: OrganizationStatus;
    actor: RequestPrincipal;
    request: AuthenticatedRequest;
    reason?: string | undefined;
  }): Promise<{ id: string; status: string }> {
    const requestId = requestIdOf(params.request);

    const result = await this.tenant.withPlatformAdmin(
      {
        actorUserId: params.actor.userId,
        organizationId: params.organizationId,
        reason: `Organization status change to ${params.to}`,
      },
      async (tx) => {
        const organization = await tx.organization.findUnique({
          where: { id: params.organizationId },
          select: { id: true, status: true },
        });
        if (organization === null) {
          throw new AppError(PalCertErrorCode.ORGANIZATION_NOT_FOUND, {
            message: 'Organization not found.',
          });
        }

        const from = organization.status as OrganizationStatus;
        if (!canTransitionOrganizationStatus(from, params.to)) {
          throw new AppError(PalCertErrorCode.CONFLICT, {
            message: `An organization cannot move from ${from} to ${params.to}.`,
            details: { from, to: params.to },
          });
        }

        const updated = await tx.organization.update({
          where: { id: params.organizationId },
          data: {
            status: params.to,
            suspendedAt: params.to === OrganizationStatus.SUSPENDED ? this.clock.now() : null,
            ...(params.to === OrganizationStatus.SUSPENDED
              ? { suspensionReason: params.reason?.trim() || null }
              : { suspensionReason: null }),
          },
          select: { id: true, status: true },
        });

        return { updated, from };
      },
    );

    const eventType =
      params.to === OrganizationStatus.SUSPENDED
        ? SecurityEventType.ORGANIZATION_SUSPENDED
        : SecurityEventType.ORGANIZATION_REACTIVATED;

    await this.events.record({
      type: eventType,
      actorUserId: params.actor.userId,
      metadata: { organizationId: params.organizationId, from: result.from, to: params.to },
      requestId,
    });
    await this.events.audit({
      action: eventType,
      actorUserId: params.actor.userId,
      targetType: 'Organization',
      targetId: params.organizationId,
      requestId,
      beforeState: { status: result.from },
      afterState: { status: params.to },
    });

    return { id: result.updated.id, status: result.updated.status };
  }
}
