import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type NotificationPreferenceView,
  type Page,
  type UnreadNotificationCountView,
  type UserNotificationView,
} from '@palcert/contracts';
import type { RequestPrincipal } from '../../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../../auth/decorators/auth.decorators';
import {
  NotificationPageQueryDto,
  NotificationParamDto,
  NotificationTypeParamDto,
  SetNotificationPreferenceDto,
} from '../dto/notification.dto';
import { NotificationInboxService } from '../services/notification-inbox.service';

/**
 * A person's own notifications (§105–§113).
 *
 * Self-scoped in the strictest sense in PalCert: there is no organization
 * counterpart to this controller and no route by which one member reads
 * another's inbox. An organization owner has a plausible-sounding reason to
 * want that — "I need to know my reviewers were told" — and the answer is
 * still no, because a notification is a private copy and the record that the
 * institution was informed is the submission's own history, not somebody's
 * mail.
 *
 * Nothing here creates a notification. A notification follows from an
 * authoritative event; a route that produced one on request would be exactly
 * the inversion this phase forbids.
 */
@ApiTags('notifications')
@ApiCookieAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly inbox: NotificationInboxService) {}

  @Get()
  @RequirePermissions(Permission.NOTIFICATION_READ_SELF)
  @ApiOperation({
    summary: 'Your notifications, newest first',
    description:
      'Cursor-paginated. An inbox is append-heavy, so offset pagination would skip or ' +
      'repeat a notification whenever one arrived between pages.',
  })
  @ApiResponse({ status: 200 })
  list(
    @Query() query: NotificationPageQueryDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<Page<UserNotificationView>> {
    return this.inbox.list(principal.userId, { cursor: query.cursor, limit: query.limit });
  }

  // Declared before ':notificationId' so the literal segment wins the match.
  @Get('unread-count')
  @RequirePermissions(Permission.NOTIFICATION_READ_SELF)
  @ApiOperation({
    summary: 'How many of your notifications are unread',
    description: 'One number. Never anything that would say what is in them.',
  })
  @ApiResponse({ status: 200 })
  unreadCount(@CurrentUser() principal: RequestPrincipal): Promise<UnreadNotificationCountView> {
    return this.inbox.unreadCount(principal.userId);
  }

  @Get('preferences')
  @RequirePermissions(Permission.NOTIFICATION_READ_SELF)
  @ApiOperation({
    summary: 'Which workflow emails PalCert sends you',
    description:
      'Every type, including the ones you have never changed, so the screen shows what ' +
      'PalCert actually does rather than only what you have touched.',
  })
  @ApiResponse({ status: 200 })
  preferences(@CurrentUser() principal: RequestPrincipal): Promise<NotificationPreferenceView[]> {
    return this.inbox.preferences(principal.userId);
  }

  @Put('preferences/:notificationType')
  @RequirePermissions(Permission.NOTIFICATION_PREFERENCE_WRITE_SELF)
  @ApiOperation({
    summary: 'Change one email choice',
    description:
      'Certificate revocation cannot be switched off: a revocation is a material change ' +
      'to something you may already have shown an employer. Asking is refused with ' +
      'NOTIFICATION_TYPE_MANDATORY rather than accepted and ignored.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 422, description: 'NOTIFICATION_TYPE_MANDATORY' })
  setPreference(
    @Param() params: NotificationTypeParamDto,
    @Body() body: SetNotificationPreferenceDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<NotificationPreferenceView> {
    return this.inbox.setPreference(principal.userId, params.notificationType, body.emailEnabled);
  }

  @Post('read-all')
  @RequirePermissions(Permission.NOTIFICATION_WRITE_SELF)
  @ApiOperation({ summary: 'Mark every unread notification of yours as read' })
  @ApiResponse({ status: 201 })
  markAllRead(@CurrentUser() principal: RequestPrincipal): Promise<{ marked: number }> {
    return this.inbox.markAllRead(principal.userId);
  }

  @Post(':notificationId/read')
  @RequirePermissions(Permission.NOTIFICATION_WRITE_SELF)
  @ApiOperation({
    summary: 'Mark one of yours as read',
    description:
      'Idempotent, and not a toggle: read_at is the first time you saw it, and asking ' +
      'again keeps that answer rather than moving it.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 404, description: 'NOTIFICATION_NOT_FOUND' })
  markRead(
    @Param() params: NotificationParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<UserNotificationView> {
    return this.inbox.markRead(principal.userId, params.notificationId);
  }
}
