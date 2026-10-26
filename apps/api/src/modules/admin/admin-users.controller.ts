import { Body, Controller, Delete, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  AppError,
  PalCertErrorCode,
  Permission,
  PRIVILEGED_ROLES,
  RoleScope,
  SecurityEventType,
  UserStatus,
  canTransitionStatus,
  getRoleDefinition,
  type UserProfile,
} from '@palcert/contracts';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import type { AuthenticatedRequest, RequestPrincipal } from '../auth/authenticated-request';
import { buildContext } from '../auth/auth.controller';
import { CurrentUser, RequirePermissions } from '../auth/decorators/auth.decorators';
import { AssignRoleDto, SuspendUserDto } from '../auth/dto/auth.dto';
import { UserProfileDto } from '../auth/dto/auth-response.dto';
import { AuthService } from '../auth/services/auth.service';
import { SecurityEventService } from '../auth/services/security-event.service';
import { SessionService } from '../auth/services/session.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';

class UserIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;
}

class ListUsersQueryDto {
  @ApiProperty({ required: false, description: 'Cursor: the id of the last user seen.' })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiProperty({
    required: false,
    description: 'Part of an email address or display name, case-insensitive.',
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

/**
 * PalCert staff administration.
 *
 * Mounted under `/admin` and gated entirely by permissions. Note which
 * permission each route demands: reading users is available to support, but
 * suspension and role assignment are not — support must never be a stepping
 * stone to administrator (§20).
 */
@ApiTags('admin')
@ApiCookieAuth()
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly events: SecurityEventService,
  ) {}

  @Get()
  @RequirePermissions(Permission.ADMIN_USER_READ)
  @ApiOperation({ summary: 'List users' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiResponse({ status: 200, type: [UserProfileDto] })
  async list(@Query() query: ListUsersQueryDto): Promise<Array<Record<string, unknown>>> {
    const search = query.q?.trim() ?? '';
    const users = await this.prisma.user.findMany({
      take: 50,
      ...(search.length === 0
        ? {}
        : {
            where: {
              OR: [
                { normalizedEmail: { contains: search.toLowerCase() } },
                { displayName: { contains: search, mode: 'insensitive' as const } },
              ],
            },
          }),
      ...(query.cursor !== undefined ? { skip: 1, cursor: { id: query.cursor } } : {}),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
        emailVerifiedAt: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });

    // Explicit projection: the password hash is never selected, so it cannot
    // reach a response even if this shape is reused later.
    return users.map((user) => ({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      emailVerified: user.emailVerifiedAt !== null,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    }));
  }

  @Get(':id')
  @RequirePermissions(Permission.ADMIN_USER_READ)
  @ApiOperation({ summary: 'Read one user' })
  @ApiResponse({ status: 200, type: UserProfileDto })
  async read(@Param() params: UserIdParamDto): Promise<UserProfile> {
    return this.auth.buildProfile(params.id);
  }

  @Post(':id/suspend')
  @RequirePermissions(Permission.ADMIN_USER_SUSPEND)
  @ApiOperation({
    summary: 'Suspend a user',
    description: 'Revokes every session the user holds, immediately.',
  })
  @ApiResponse({ status: 200, type: UserProfileDto })
  async suspend(
    @Param() params: UserIdParamDto,
    @Body() dto: SuspendUserDto,
    @CurrentUser() actor: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<UserProfile> {
    return this.transitionStatus({
      targetUserId: params.id,
      to: UserStatus.SUSPENDED,
      actor,
      request,
      eventType: SecurityEventType.ACCOUNT_SUSPENDED,
      ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
    });
  }

  @Post(':id/reactivate')
  @RequirePermissions(Permission.ADMIN_USER_REACTIVATE)
  @ApiOperation({ summary: 'Reinstate a suspended user' })
  @ApiResponse({ status: 200, type: UserProfileDto })
  async reactivate(
    @Param() params: UserIdParamDto,
    @CurrentUser() actor: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<UserProfile> {
    return this.transitionStatus({
      targetUserId: params.id,
      to: UserStatus.ACTIVE,
      actor,
      request,
      eventType: SecurityEventType.ACCOUNT_REACTIVATED,
    });
  }

  @Post(':id/roles')
  @RequirePermissions(Permission.ADMIN_ROLE_ASSIGN)
  @ApiOperation({
    summary: 'Grant a global role',
    description:
      'Only global roles can be granted here. Organization-scoped roles are rejected, and the ' +
      'database independently enforces the same rule.',
  })
  @ApiResponse({ status: 200, type: UserProfileDto })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — unknown or non-global role' })
  async assignRole(
    @Param() params: UserIdParamDto,
    @Body() dto: AssignRoleDto,
    @CurrentUser() actor: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<UserProfile> {
    const definition = getRoleDefinition(dto.roleCode);
    if (definition === undefined || definition.scope !== RoleScope.GLOBAL) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'Only global roles can be granted here.',
        details: { roleCode: dto.roleCode },
      });
    }

    // Granting a privileged role is the highest-risk action in the system, so
    // it additionally requires a recently authenticated session.
    if (PRIVILEGED_ROLES.includes(definition.code) && !actor.recentlyAuthenticated) {
      throw new AppError(PalCertErrorCode.REAUTHENTICATION_REQUIRED, {
        message: 'Please sign in again before granting a privileged role.',
      });
    }

    await this.prisma.user.findUniqueOrThrow({ where: { id: params.id } });
    await this.rbac.assignGlobalRole({
      userId: params.id,
      roleCode: dto.roleCode,
      grantedByUserId: actor.userId,
    });

    const context = buildContext(request);
    await this.events.record({
      type: SecurityEventType.ROLE_ASSIGNED,
      userId: params.id,
      actorUserId: actor.userId,
      metadata: { role: dto.roleCode },
      ...context,
    });
    await this.events.audit({
      action: 'ROLE_ASSIGNED',
      actorUserId: actor.userId,
      targetType: 'User',
      targetId: params.id,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      afterState: { role: dto.roleCode },
    });

    return this.auth.buildProfile(params.id);
  }

  @Delete(':id/roles/:roleCode')
  @RequirePermissions(Permission.ADMIN_ROLE_REMOVE)
  @ApiOperation({ summary: 'Remove a global role' })
  @ApiResponse({ status: 200, type: UserProfileDto })
  async removeRole(
    @Param('id') id: string,
    @Param('roleCode') roleCode: string,
    @CurrentUser() actor: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<UserProfile> {
    const removed = await this.rbac.removeGlobalRole(id, roleCode);
    if (!removed) {
      throw new AppError(PalCertErrorCode.NOT_FOUND, { message: 'Role assignment not found.' });
    }

    const context = buildContext(request);
    await this.events.record({
      type: SecurityEventType.ROLE_REMOVED,
      userId: id,
      actorUserId: actor.userId,
      metadata: { role: roleCode },
      ...context,
    });
    await this.events.audit({
      action: 'ROLE_REMOVED',
      actorUserId: actor.userId,
      targetType: 'User',
      targetId: id,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      beforeState: { role: roleCode },
    });

    return this.auth.buildProfile(id);
  }

  private async transitionStatus(params: {
    targetUserId: string;
    to: UserStatus;
    actor: RequestPrincipal;
    request: AuthenticatedRequest;
    eventType: SecurityEventType;
    reason?: string;
  }): Promise<UserProfile> {
    const user = await this.prisma.user.findUnique({ where: { id: params.targetUserId } });
    if (user === null) {
      throw new AppError(PalCertErrorCode.NOT_FOUND, { message: 'User not found.' });
    }

    // An administrator must not be able to lock themselves out by accident, and
    // self-suspension would leave the platform with no way back in.
    if (user.id === params.actor.userId) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'You cannot change your own account status.',
      });
    }

    const from = user.status as UserStatus;
    if (!canTransitionStatus(from, params.to)) {
      throw new AppError(PalCertErrorCode.CONFLICT, {
        message: `An account cannot move from ${from} to ${params.to}.`,
        details: { from, to: params.to },
      });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { status: params.to },
    });

    // Losing ACTIVE means losing every session, at once.
    if (params.to !== UserStatus.ACTIVE) {
      await this.sessions.revokeAllForUser(
        user.id,
        params.to === UserStatus.DISABLED ? 'ACCOUNT_DISABLED' : 'ACCOUNT_SUSPENDED',
      );
    }

    const context = buildContext(params.request);
    await this.events.record({
      type: params.eventType,
      userId: user.id,
      actorUserId: params.actor.userId,
      metadata: { from, to: params.to, ...(params.reason ? { reason: params.reason } : {}) },
      ...context,
    });
    await this.events.audit({
      action: params.eventType,
      actorUserId: params.actor.userId,
      targetType: 'User',
      targetId: user.id,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      beforeState: { status: from },
      afterState: { status: params.to },
    });

    return this.auth.buildProfile(user.id);
  }
}
