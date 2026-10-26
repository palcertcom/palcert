import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Permission, type UserProfile } from '@palcert/contracts';
import type { AuthenticatedRequest, RequestPrincipal } from '../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../auth/decorators/auth.decorators';
import { UpdateProfileDto } from '../auth/dto/auth.dto';
import { UserProfileDto } from '../auth/dto/auth-response.dto';
import { AuthService } from '../auth/services/auth.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { buildContext } from '../auth/auth.controller';
import { SecurityEventService } from '../auth/services/security-event.service';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly events: SecurityEventService,
  ) {}

  @Get('me')
  @ApiCookieAuth()
  @RequirePermissions(Permission.PROFILE_READ_SELF)
  @ApiOperation({ summary: 'Get the authenticated user' })
  @ApiResponse({ status: 200, type: UserProfileDto })
  async me(@CurrentUser() principal: RequestPrincipal): Promise<UserProfile> {
    return this.auth.buildProfile(principal.userId);
  }

  @Patch('me')
  @ApiCookieAuth()
  @RequirePermissions(Permission.PROFILE_UPDATE_SELF)
  @ApiOperation({
    summary: 'Update your own profile',
    description:
      'Accepts display name and preferred locale only. Roles, permissions, status, email ' +
      'verification, credentials and MFA flags are deliberately not addressable here — the ' +
      'DTO is an explicit allow-list and unknown properties are rejected outright.',
  })
  @ApiResponse({ status: 200, type: UserProfileDto })
  async updateMe(
    @Body() dto: UpdateProfileDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<UserProfile> {
    const before = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: { displayName: true, preferredLocale: true },
    });

    await this.prisma.user.update({
      where: { id: principal.userId },
      data: {
        ...(dto.displayName !== undefined ? { displayName: dto.displayName.trim() || null } : {}),
        ...(dto.preferredLocale !== undefined ? { preferredLocale: dto.preferredLocale } : {}),
      },
    });

    await this.events.audit({
      action: 'PROFILE_UPDATED',
      actorUserId: principal.userId,
      targetType: 'User',
      targetId: principal.userId,
      requestId: buildContext(request).requestId,
      ipAddress: buildContext(request).ipAddress,
      beforeState: before,
      afterState: {
        displayName: dto.displayName ?? before.displayName,
        preferredLocale: dto.preferredLocale ?? before.preferredLocale,
      },
    });

    return this.auth.buildProfile(principal.userId);
  }
}
