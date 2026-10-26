import { Injectable } from '@nestjs/common';
import {
  AppError,
  NOTIFICATION_TYPES,
  PalCertErrorCode,
  buildPage,
  decodeCursor,
  encodeCursor,
  isMandatoryEmailType,
  isNotificationType,
  defaultEmailEnabled,
  resolveLimit,
  type NotificationPreferenceView,
  type NotificationType,
  type Page,
  type UnreadNotificationCountView,
  type UserNotificationView,
} from '@palcert/contracts';
import type { UserNotification } from '@palcert/database';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';

/**
 * A person's own inbox and their own email choices (§105–§113).
 *
 * Every query here runs in the caller's own scope, so row-level security is
 * the floor rather than the only wall: even a `where` clause that forgot its
 * owner filter would return nothing belonging to anybody else. That matters
 * more for notifications than for most tables, because an organization owner
 * has a plausible-sounding reason to want to see what their reviewers were
 * told, and the answer is still no.
 */
@Injectable()
export class NotificationInboxService {
  constructor(private readonly tenant: TenantPrismaService) {}

  /**
   * The inbox, newest first.
   *
   * Cursor-paginated on `(created_at, id)`, because an inbox is append-heavy
   * and offset pagination would skip or repeat a notification whenever one
   * arrived between pages.
   */
  async list(
    userId: string,
    params: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
  ): Promise<Page<UserNotificationView>> {
    const limit = resolveLimit(params.limit);

    let before: { createdAt: Date; id: string } | null = null;
    if (params.cursor !== undefined) {
      const decoded = decodeCursor(params.cursor);
      const createdAt = decoded === null ? null : new Date(decoded.sortValue);
      if (decoded === null || createdAt === null || Number.isNaN(createdAt.getTime())) {
        // §26 of the pagination convention: never a silent reset to page one,
        // which hides a client bug and can loop a client forever.
        throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
          message: 'That page cursor is not valid.',
        });
      }
      before = { createdAt, id: decoded.id };
    }

    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.userNotification.findMany({
        where: {
          recipientUserId: userId,
          ...(before === null
            ? {}
            : {
                OR: [
                  { createdAt: { lt: before.createdAt } },
                  { createdAt: before.createdAt, id: { lt: before.id } },
                ],
              }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
    );

    return buildPage(rows.map(notificationView), limit, (row) =>
      encodeCursor(row.createdAt, row.id),
    );
  }

  /** The badge. One number, and nothing that would identify what is in it. */
  async unreadCount(userId: string): Promise<UnreadNotificationCountView> {
    const unread = await this.tenant.withUser(userId, (tx) =>
      tx.userNotification.count({ where: { recipientUserId: userId, readAt: null } }),
    );
    return { unread };
  }

  /**
   * Mark one as read.
   *
   * Idempotent, and deliberately not a toggle: `read_at` is the first time
   * somebody saw it, and a second call keeps the first answer rather than
   * moving it. The guard trigger underneath allows no other column to change,
   * so this cannot become a way to rewrite what a notification said.
   */
  async markRead(userId: string, notificationId: string): Promise<UserNotificationView> {
    return this.tenant.withUser(userId, async (tx) => {
      const existing = await tx.userNotification.findFirst({
        where: { id: notificationId, recipientUserId: userId },
      });
      // Somebody else's notification id is not found, never forbidden: the
      // difference would confirm that it exists.
      if (existing === null) {
        throw new AppError(PalCertErrorCode.NOTIFICATION_NOT_FOUND, {
          message: 'That notification does not exist.',
        });
      }
      if (existing.readAt !== null) return notificationView(existing);

      const updated = await tx.userNotification.update({
        where: { id: existing.id },
        data: { readAt: new Date() },
      });
      return notificationView(updated);
    });
  }

  /** Mark everything currently unread as read. Returns how many changed. */
  async markAllRead(userId: string): Promise<{ readonly marked: number }> {
    const result = await this.tenant.withUser(userId, (tx) =>
      tx.userNotification.updateMany({
        where: { recipientUserId: userId, readAt: null },
        data: { readAt: new Date() },
      }),
    );
    return { marked: result.count };
  }

  /**
   * Every type, with the person's choice or the product default (§74).
   *
   * All nine rows always, including the ones they have never touched. A screen
   * that listed only stored preferences would show a new user an empty page
   * and imply PalCert sends them nothing.
   */
  async preferences(userId: string): Promise<NotificationPreferenceView[]> {
    const stored = await this.tenant.withUser(userId, (tx) =>
      tx.notificationPreference.findMany({ where: { userId } }),
    );
    const chosen = new Map(stored.map((row) => [row.notificationType, row.emailEnabled]));

    return NOTIFICATION_TYPES.map((notificationType) => ({
      notificationType,
      emailEnabled: isMandatoryEmailType(notificationType)
        ? true
        : (chosen.get(notificationType) ?? defaultEmailEnabled(notificationType)),
      // Why one row has no switch, so the screen can explain rather than
      // simply refuse.
      mandatory: isMandatoryEmailType(notificationType),
    }));
  }

  /**
   * Change one choice.
   *
   * A mandatory type is refused with its own error code rather than silently
   * ignored, because a screen that accepted the change and kept sending would
   * be lying to the person about what PalCert does on their behalf. The
   * database refuses the row too; this is the readable half of the same rule.
   */
  async setPreference(
    userId: string,
    notificationType: string,
    emailEnabled: boolean,
  ): Promise<NotificationPreferenceView> {
    if (!isNotificationType(notificationType)) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'That is not a notification type.',
      });
    }
    if (!emailEnabled && isMandatoryEmailType(notificationType)) {
      throw new AppError(PalCertErrorCode.NOTIFICATION_TYPE_MANDATORY, {
        message:
          'PalCert always emails you when a certificate of yours is revoked. ' +
          'That one cannot be switched off.',
      });
    }

    await this.tenant.withUser(userId, (tx) =>
      tx.notificationPreference.upsert({
        where: { userId_notificationType: { userId, notificationType } },
        create: { userId, notificationType, emailEnabled },
        update: { emailEnabled },
      }),
    );

    return {
      notificationType,
      emailEnabled,
      mandatory: isMandatoryEmailType(notificationType),
    };
  }
}

function notificationView(row: UserNotification): UserNotificationView {
  return {
    id: row.id,
    // The database enum and the contract are the same closed list, kept so by
    // the migration that created the type.
    notificationType: row.notificationType as NotificationType,
    title: row.title,
    body: row.body,
    locale: row.locale,
    deepLink: row.deepLink,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}
