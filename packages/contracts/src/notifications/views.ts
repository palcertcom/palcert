import type {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationSkipReason,
  NotificationType,
} from './notification.js';

/**
 * What a person's own inbox returns (§111, §112).
 *
 * Note what is absent, and deliberately so: the event payload, the recipient's
 * email address, provider status text, SMTP diagnostics and every delivery
 * internal. A notification UI needs a sentence, a time, a read flag and a
 * link; everything else it could be given is something it would then have to
 * be trusted not to show.
 */
export interface UserNotificationView {
  readonly id: string;
  readonly notificationType: NotificationType;
  readonly title: string;
  readonly body: string;
  readonly locale: string;
  /** An application route. Never a bearer link, never a storage URL (§33–§35). */
  readonly deepLink: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface UnreadNotificationCountView {
  readonly unread: number;
}

/**
 * One row of the preference screen (§106, §113).
 *
 * `emailEnabled` is what the user chose, or the product default when they have
 * never chosen. `mandatory` tells the UI why one row has no switch, so the
 * screen can explain rather than simply refuse.
 */
export interface NotificationPreferenceView {
  readonly notificationType: NotificationType;
  readonly emailEnabled: boolean;
  readonly mandatory: boolean;
}

/** The internal view of one delivery. Never returned to an ordinary user (§135). */
export interface NotificationDeliveryView {
  readonly id: string;
  readonly notificationId: string;
  readonly channel: NotificationChannel;
  readonly status: NotificationDeliveryStatus;
  readonly skipReason: NotificationSkipReason | null;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}
