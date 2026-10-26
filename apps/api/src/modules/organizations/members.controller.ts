import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  MembershipStatus,
  Permission,
  type InvitationPreview,
  type OrganizationInvitationSummary,
  type OrganizationMember,
  type Page,
} from '@palcert/contracts';
import {
  CurrentUser,
  Public,
  RequirePermissions,
  RequireRecentAuthentication,
} from '../auth/decorators/auth.decorators';
import {
  requestIdOf,
  type AuthenticatedRequest,
  type RequestPrincipal,
} from '../auth/authenticated-request';
import {
  OrganizationScoped,
  RequireOrganizationPermissions,
  Tenant,
} from './decorators/tenant.decorators';
import {
  AcceptInvitationDto,
  AssignOrganizationRoleDto,
  InvitationParamDto,
  InviteMemberDto,
  MembershipParamDto,
  MembershipRoleParamDto,
  OrganizationIdParamDto,
  PageQueryDto,
  TransferOwnershipDto,
  UpdateMemberDto,
} from './dto/organization.dto';
import {
  AcceptInvitationResultDto,
  InvitationPageDto,
  InvitationPreviewDto,
  MemberPageDto,
  OrganizationInvitationDto,
  OrganizationMemberDto,
  OwnershipTransferResultDto,
} from './dto/organization-response.dto';
import { InvitationService } from './services/invitation.service';
import { MembershipService } from './services/membership.service';
import type { TenantContext } from './tenant-context';

@ApiTags('organization-team')
@ApiCookieAuth()
@Controller('organizations/:organizationId')
@OrganizationScoped()
export class OrganizationTeamController {
  constructor(
    private readonly members: MembershipService,
    private readonly invitations: InvitationService,
  ) {}

  // --- Members ---------------------------------------------------------------

  @Get('members')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_MEMBER_READ)
  @ApiOperation({ summary: 'List organization members' })
  @ApiResponse({ status: 200, type: MemberPageDto })
  async listMembers(
    @Param() _params: OrganizationIdParamDto,
    @Query() query: PageQueryDto,
    @Tenant() tenant: TenantContext,
  ): Promise<Page<OrganizationMember>> {
    return this.members.list(tenant, { cursor: query.cursor, limit: query.limit });
  }

  @Patch('members/:membershipId')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_MEMBER_UPDATE)
  @ApiOperation({
    summary: 'Suspend or reactivate a member',
    description:
      'Strictly organization-local: it never affects the person’s PalCert account or their ' +
      'standing in any other organization.',
  })
  @ApiResponse({ status: 200, type: OrganizationMemberDto })
  @ApiResponse({ status: 409, description: 'LAST_OWNER_REQUIRED' })
  async updateMember(
    @Param() params: MembershipParamDto,
    @Body() dto: UpdateMemberDto,
    @Tenant() tenant: TenantContext,
  ): Promise<OrganizationMember> {
    return this.members.changeStatus(tenant, params.membershipId, dto.status as MembershipStatus);
  }

  @Delete('members/:membershipId')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_MEMBER_REMOVE)
  @ApiOperation({
    summary: 'Remove a member',
    description: 'Also removes their organization roles, so a re-invite starts from nothing.',
  })
  @ApiResponse({ status: 200, type: OrganizationMemberDto })
  @ApiResponse({ status: 409, description: 'LAST_OWNER_REQUIRED' })
  async removeMember(
    @Param() params: MembershipParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<OrganizationMember> {
    return this.members.changeStatus(tenant, params.membershipId, MembershipStatus.REMOVED);
  }

  // --- Organization roles ----------------------------------------------------

  @Post('members/:membershipId/roles')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_ROLE_ASSIGN)
  @ApiOperation({
    summary: 'Grant an organization role',
    description:
      'Organization roles only. A platform role code is rejected with ROLE_SCOPE_INVALID, and ' +
      'the database independently refuses a mis-scoped assignment.',
  })
  @ApiResponse({ status: 200, description: 'The member’s roles after the change.', type: [String] })
  @ApiResponse({ status: 400, description: 'ROLE_SCOPE_INVALID' })
  async assignRole(
    @Param() params: MembershipParamDto,
    @Body() dto: AssignOrganizationRoleDto,
    @Tenant() tenant: TenantContext,
  ): Promise<{ roles: string[] }> {
    return { roles: await this.members.assignRole(tenant, params.membershipId, dto.roleCode) };
  }

  @Delete('members/:membershipId/roles/:roleCode')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_ROLE_REMOVE)
  @ApiOperation({ summary: 'Remove an organization role' })
  @ApiResponse({ status: 200, description: 'The member’s roles after the change.', type: [String] })
  @ApiResponse({ status: 409, description: 'LAST_OWNER_REQUIRED' })
  async removeRole(
    @Param() params: MembershipRoleParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<{ roles: string[] }> {
    return { roles: await this.members.removeRole(tenant, params.membershipId, params.roleCode) };
  }

  @Post('ownership-transfer')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_OWNERSHIP_TRANSFER)
  @RequireRecentAuthentication()
  @ApiOperation({
    summary: 'Transfer organization ownership',
    description:
      'Requires a recently authenticated session. The new owner is granted before the previous ' +
      'owner steps down, so the organization is never without an owner.',
  })
  @ApiResponse({ status: 200, type: OwnershipTransferResultDto })
  @ApiResponse({ status: 401, description: 'REAUTHENTICATION_REQUIRED' })
  async transferOwnership(
    @Param() _params: OrganizationIdParamDto,
    @Body() dto: TransferOwnershipDto,
    @Tenant() tenant: TenantContext,
  ): Promise<{ newOwnerUserId: string; previousOwnerRetainedOwnership: boolean }> {
    return this.members.transferOwnership(tenant, {
      toMembershipId: dto.toMembershipId,
      stepDown: dto.stepDown ?? true,
    });
  }

  // --- Invitations -----------------------------------------------------------

  @Get('invitations')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_MEMBER_READ)
  @ApiOperation({ summary: 'List invitations' })
  @ApiResponse({ status: 200, type: InvitationPageDto })
  async listInvitations(
    @Param() _params: OrganizationIdParamDto,
    @Query() query: PageQueryDto,
    @Tenant() tenant: TenantContext,
  ): Promise<Page<OrganizationInvitationSummary>> {
    return this.invitations.list(tenant, { cursor: query.cursor, limit: query.limit });
  }

  @Post('invitations')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_MEMBER_INVITE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Invite someone to the organization',
    description:
      'The organization and role are stored on the invitation and read from there at ' +
      'acceptance, so neither can be altered by a client payload.',
  })
  @ApiResponse({ status: 201, type: OrganizationInvitationDto })
  @ApiResponse({
    status: 409,
    description: 'MEMBERSHIP_ALREADY_EXISTS / INVITATION_ALREADY_PENDING',
  })
  async invite(
    @Param() _params: OrganizationIdParamDto,
    @Body() dto: InviteMemberDto,
    @Tenant() tenant: TenantContext,
  ): Promise<OrganizationInvitationSummary> {
    return this.invitations.invite(tenant, { email: dto.email, roleCode: dto.roleCode });
  }

  @Delete('invitations/:invitationId')
  @RequireOrganizationPermissions(Permission.ORGANIZATION_MEMBER_INVITE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an outstanding invitation' })
  @ApiResponse({ status: 204, description: 'Invitation revoked.' })
  @ApiResponse({
    status: 404,
    description: 'INVITATION_NOT_FOUND — including an invitation id belonging to another tenant.',
  })
  async revokeInvitation(
    @Param() params: InvitationParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<void> {
    await this.invitations.revoke(tenant, params.invitationId);
  }
}

/**
 * Invitation acceptance lives outside the organization path on purpose: the
 * recipient is not yet a member, so no tenant context can be resolved from a
 * route parameter. The stored invitation — located by its token digest — is the
 * only thing that decides which organization and role are involved.
 */
@ApiTags('invitations')
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationService) {}

  @Post('preview')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Describe an invitation before accepting it',
    description:
      'Public, because the recipient may not have a PalCert account yet. Returns the ' +
      'organization name, role and expiry only — never its members or internal state, so a ' +
      'guessed token discloses nothing useful.',
  })
  @ApiResponse({ status: 200, type: InvitationPreviewDto })
  @ApiResponse({ status: 404, description: 'INVITATION_NOT_FOUND' })
  @ApiResponse({
    status: 410,
    description: 'INVITATION_EXPIRED / INVITATION_REVOKED / INVITATION_ALREADY_USED',
  })
  async preview(@Body() dto: AcceptInvitationDto): Promise<InvitationPreview> {
    return this.invitations.preview(dto.token);
  }

  @Post('accept')
  @ApiCookieAuth()
  @RequirePermissions(Permission.PROFILE_READ_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept an invitation',
    description:
      'Requires being signed in as the invited address — otherwise anyone who intercepted the ' +
      'link could join with an account of their choosing. The organization and role come from ' +
      'the stored invitation, never from this request.',
  })
  @ApiResponse({ status: 200, type: AcceptInvitationResultDto })
  @ApiResponse({ status: 403, description: 'INVITATION_EMAIL_MISMATCH' })
  @ApiResponse({
    status: 410,
    description: 'INVITATION_EXPIRED / INVITATION_REVOKED / INVITATION_ALREADY_USED',
  })
  async accept(
    @Body() dto: AcceptInvitationDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ organizationId: string; roleCode: string }> {
    return this.invitations.accept({
      rawToken: dto.token,
      userId: principal.userId,
      requestId: requestIdOf(request),
    });
  }
}
