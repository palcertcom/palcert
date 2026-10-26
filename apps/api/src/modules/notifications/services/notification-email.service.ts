import { Injectable } from '@nestjs/common';
import {
  EMAIL_MAX_ATTEMPTS,
  EmailFailureCode,
  NotificationAttemptOutcome,
  NotificationDeliveryStatus,
  NotificationEmailError,
  type NotificationEmailProviderPort,
  NotificationSkipReason,
  NOTIFICATION_AUDIENCE,
  REVIEWER_AUDIENCE_PERMISSION,
  type NotificationType,
  UserStatus,
  isMandatoryEmailType,
  isNotificationType,
  isPermanentEmailFailure,
  isPlatformAudience,
  isManualTopUpNotificationType,
  isWithdrawalNotificationType,
  nextEmailRetryDelayMs,
} from '@palcert/contracts';
import type { NotificationDelivery } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { NotificationEmailRouter } from '../../../infrastructure/email/notification-email-router';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { renderNotification } from '../templates/notification-templates';
import { readManualTopUpFacts } from './manual-topup-facts';
import { readWithdrawalFacts } from './withdrawal-facts';

/** A delivery that will not be attempted, and the reason it will not. */
class Skip {
  constructor(readonly reason: NotificationSkipReason) {}
}

/**
 * Sending one notification email (§24–§27, §55–§60).
 *
 * Every eligibility question is asked here, at delivery time, rather than at
 * fan-out. The window between an event and its email is exactly where the
 * interesting cases live: an address verified in the meantime, a preference
 * turned off, a reviewer who left the organization. Asking now means the
 * answer is about the moment the mail would arrive.
 *
 * The order of the checks is deliberate (hardening §5): account status is read
 * before the verified-address flag, so an account that is not ACTIVE is
 * ineligible whatever its `email_verified_at` column says. A row that is
 * PENDING_VERIFICATION with a verification timestamp is a contradiction, and
 * the safe reading of a contradiction is "do not send".
 */
@Injectable()
export class NotificationEmailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
    private readonly router: NotificationEmailRouter,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationEmailService.name);
  }

  /**
   * Attempt one delivery.
   *
   * Returns normally when there is nothing more to do — delivered, skipped, or
   * permanently failed. Throws on a retryable failure, so the job ladder tries
   * again rather than the delivery being recorded as finished. Recording a
   * "retryable" state and returning would make it the one state nothing ever
   * retries.
   *
   * **`SENDING` is recoverable, and this is the only place that may recover
   * it.** A worker that died between claiming a delivery and hearing back from
   * the relay leaves a row that is neither finished nor waiting. Refusing to
   * touch it — which is what this method used to do — meant the job was
   * reported successful and the delivery stayed `SENDING` for ever, which no
   * sweep would ever pick up.
   *
   * What makes recovery safe is not a timer. Reaching this method at all means
   * `WorkerService` already claimed the delivery's `ProcessingJob` through
   * `ProcessingJobService.start`, which moves it to RUNNING under a lease and
   * refuses a job another worker holds a live lease on. So a second worker
   * cannot be inside this method for the same delivery while the first is
   * still alive: it would have to claim the job first, and the claim is what
   * it cannot get. The lease is the ownership signal, and it is stronger than
   * any "SENDING for more than N minutes" guess would be.
   */
  async send(deliveryId: string): Promise<void> {
    let delivery = await this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
    });
    if (delivery === null) return;

    if (delivery.status === NotificationDeliveryStatus.SENDING) {
      delivery = await this.recoverInterrupted(delivery);
    }

    // Idempotent: a duplicate delivery of an already-settled row does nothing.
    if (
      delivery.status !== NotificationDeliveryStatus.PENDING &&
      delivery.status !== NotificationDeliveryStatus.FAILED_RETRYABLE
    ) {
      return;
    }

    // The worker has a delivery id and nothing else, and `user_notifications`
    // is row-level-secured on the recipient — so an unscoped read finds
    // nothing. The narrow doorway answers for one delivery with routing
    // metadata only; everything after it happens inside the recipient's own
    // scope, where row-level security is doing its ordinary job.
    const rows = await this.prisma.$queryRaw<
      Array<{
        notification_id: string;
        recipient_user_id: string;
        organization_id: string | null;
        notification_type: string;
        locale: string;
        deep_link: string;
      }>
    >`SELECT * FROM app_notification_delivery_context(${deliveryId}::uuid)`;

    const routing = rows[0];
    if (routing === undefined || !isNotificationType(routing.notification_type)) return;

    const notification = {
      id: routing.notification_id,
      recipientUserId: routing.recipient_user_id,
      notificationType: routing.notification_type,
      locale: routing.locale,
      deepLink: routing.deep_link,
    };

    // Which provider sends this one: the admin-managed one when an
    // administrator has enabled it, otherwise the environment-configured
    // provider exactly as before (ADR-0146). Resolved per send, so a change
    // in the dashboard applies to the next delivery without a restart.
    const provider = await this.router.resolve({
      notificationDeliveryId: delivery.id,
      notificationType: notification.notificationType,
    });

    try {
      const message = await this.compose(provider, delivery, notification);
      await this.attempt(provider, delivery, message);
    } catch (error) {
      if (error instanceof Skip) {
        await this.skip(provider, delivery, error.reason);
        return;
      }
      throw error;
    }
  }

  /**
   * The Message-ID for one logical delivery, identical on every attempt.
   *
   * The domain comes from the deployment's own configured sender, never from
   * event or user data: a Message-ID is a header, and the right-hand side is
   * the one part of it that must be a domain PalCert actually controls.
   */
  private messageIdFor(deliveryId: string): string {
    return `<notification-delivery-${deliveryId}@${this.config.notificationEmailSenderDomain}>`;
  }

  /**
   * Close out an attempt whose worker never came back.
   *
   * Recorded as `WORKER_INTERRUPTED` rather than `PROVIDER_UNAVAILABLE`,
   * because those are different facts: the relay refusing us and PalCert never
   * finishing the question. An operator reading the attempt history should be
   * able to tell them apart.
   *
   * The relay may have accepted the message before the crash, in which case
   * the retry this enables duplicates it. That is the at-least-once limitation
   * this phase accepts: the alternative is somebody never being told, and a
   * second copy of "your certificate was revoked" is a smaller harm than no
   * copy at all. The stable per-delivery Message-ID gives a relay or a client
   * the chance to recognise the two transmissions as one logical message.
   */
  private async recoverInterrupted(delivery: NotificationDelivery): Promise<NotificationDelivery> {
    await this.closeOpenAttempt(delivery.id);

    this.logger.warn(
      { deliveryId: delivery.id, attemptNumber: delivery.attemptCount },
      'recovering a notification delivery whose worker did not finish',
    );

    return this.prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: NotificationDeliveryStatus.FAILED_RETRYABLE,
        lastErrorCode: EmailFailureCode.WORKER_INTERRUPTED,
      },
    });
  }

  private async compose(
    provider: NotificationEmailProviderPort,
    delivery: NotificationDelivery,
    notification: {
      readonly id: string;
      readonly recipientUserId: string;
      readonly notificationType: NotificationType;
      readonly locale: string;
      readonly deepLink: string;
    },
  ): Promise<{ to: string; subject: string; text: string; html: string; messageId: string }> {
    if (!provider.enabled) throw new Skip(NotificationSkipReason.CHANNEL_DISABLED);
    if (!isNotificationType(notification.notificationType)) {
      throw new Error(`notification ${notification.id} has an unknown type`);
    }

    const recipient = await this.prisma.user.findUnique({
      where: { id: notification.recipientUserId },
      select: { email: true, status: true, emailVerifiedAt: true },
    });
    if (recipient === null) throw new Skip(NotificationSkipReason.ACCOUNT_INELIGIBLE);

    // Status first. See the class comment: a contradictory row is read as
    // ineligible, not as verified.
    if (recipient.status !== UserStatus.ACTIVE) {
      throw new Skip(NotificationSkipReason.ACCOUNT_INELIGIBLE);
    }
    if (recipient.emailVerifiedAt === null) {
      throw new Skip(NotificationSkipReason.NO_VERIFIED_EMAIL);
    }

    // §70: a revocation is a material change to the validity of something the
    // holder may already have shown an employer. It is not switchable, and the
    // database refuses a stored row that says otherwise.
    if (!isMandatoryEmailType(notification.notificationType)) {
      // In the recipient's own scope: the preference is theirs, and reading it
      // with an unscoped client would be reading past the policy that makes it
      // theirs.
      const preference = await this.tenant.withUser(notification.recipientUserId, (tx) =>
        tx.notificationPreference.findUnique({
          where: {
            userId_notificationType: {
              userId: notification.recipientUserId,
              notificationType: notification.notificationType,
            },
          },
        }),
      );
      if (preference !== null && !preference.emailEnabled) {
        throw new Skip(NotificationSkipReason.PREFERENCE_DISABLED);
      }
    }

    // §22, §65: the reviewer audience is re-checked against authority as it
    // stands now. Somebody who left the organization between the event and the
    // send does not get its mail.
    const audience = NOTIFICATION_AUDIENCE[notification.notificationType];
    const reviewerPermission = REVIEWER_AUDIENCE_PERMISSION[audience];
    if (reviewerPermission !== undefined) {
      const stillAuthorized = await this.isStillAReviewer(
        notification.id,
        notification.recipientUserId,
        reviewerPermission,
        isPlatformAudience(audience),
      );
      if (!stillAuthorized) throw new Skip(NotificationSkipReason.AUTHORIZATION_REVOKED);
    }

    // A manual top-up's facts are read in the recipient's own scope, through
    // a doorway that answers only to that recipient. Never the receipt, an
    // IBAN, a phone number or anybody's address — the type cannot carry them.
    let manualTopUp;
    if (isManualTopUpNotificationType(notification.notificationType)) {
      manualTopUp = await this.tenant.withUser(notification.recipientUserId, async (tx) => {
        const own = await tx.userNotification.findUnique({
          where: { id: notification.id },
          select: { sourceEventId: true },
        });
        return own === null
          ? null
          : readManualTopUpFacts(tx, own.sourceEventId, notification.recipientUserId);
      });
      if (manualTopUp === null) {
        throw new Error(`notification ${notification.id} names a top-up with no reported facts`);
      }
    }

    // A withdrawal's facts, by the same recipient-only doorway. No destination
    // detail exists in them at all, masked or otherwise, and no proof is ever
    // attached (ADR-0150).
    let withdrawal;
    if (isWithdrawalNotificationType(notification.notificationType)) {
      withdrawal = await this.tenant.withUser(notification.recipientUserId, async (tx) => {
        const own = await tx.userNotification.findUnique({
          where: { id: notification.id },
          select: { sourceEventId: true },
        });
        return own === null
          ? null
          : readWithdrawalFacts(tx, own.sourceEventId, notification.recipientUserId);
      });
      if (withdrawal === null) {
        throw new Error(`notification ${notification.id} names a withdrawal with no facts`);
      }
    }

    const rendered = renderNotification({
      type: notification.notificationType,
      locale: notification.locale,
      deepLink: notification.deepLink,
      appOrigin: this.config.publicWebUrl,
      manualTopUp,
      withdrawal,
    });

    return {
      // The exact verified address, bare. Never `Display Name <address>`.
      to: recipient.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      // One identity for the *logical* delivery, not for this attempt.
      //
      // When the relay accepted a message and the worker died before the
      // commit, PalCert cannot know it was accepted and will send again. A
      // per-attempt id would present those two transmissions as two unrelated
      // messages; a stable one gives a relay or a client the chance to
      // recognise them as one. It guarantees nothing — deduplication is not
      // ours to promise — but it is the difference between a reader who might
      // see one copy and one who certainly sees two.
      messageId: this.messageIdFor(delivery.id),
    };
  }

  private async isStillAReviewer(
    notificationId: string,
    userId: string,
    permission: string,
    platform: boolean,
  ): Promise<boolean> {
    if (platform) {
      // PalCert staff hold platform authority through GLOBAL roles, which no
      // organization membership grants or removes. The same SQL function the
      // fan-out used decides, so the two checks cannot drift apart.
      const rows = await this.tenant.withUser(
        userId,
        (tx) =>
          tx.$queryRaw<Array<{ authorized: boolean }>>`
        SELECT app_notification_is_platform_reviewer(${userId}::uuid, ${permission}) AS authorized`,
      );
      return rows[0]?.authorized === true;
    }
    const rows = await this.tenant.withUser(
      userId,
      (tx) =>
        tx.$queryRaw<Array<{ authorized: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM "user_notifications" n
        JOIN "organization_memberships" m
          ON m."organization_id" = n."organization_id" AND m."user_id" = n."recipient_user_id"
        JOIN "user_roles" ur
          ON ur."user_id" = m."user_id" AND ur."organization_id" = m."organization_id"
        JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
        JOIN "permissions" perm
          ON perm."id" = rp."permission_id" AND perm."code" = ${permission}
        WHERE n."id" = ${notificationId}::uuid
          AND n."recipient_user_id" = ${userId}::uuid
          AND m."status" = 'ACTIVE'
      ) AS authorized`,
    );
    return rows[0]?.authorized === true;
  }

  private async attempt(
    provider: NotificationEmailProviderPort,
    delivery: NotificationDelivery,
    message: { to: string; subject: string; text: string; html: string; messageId: string },
  ): Promise<void> {
    const attemptNumber = delivery.attemptCount + 1;
    const startedAt = this.clock.now();

    const attempt = await this.prisma.notificationDeliveryAttempt.upsert({
      where: { deliveryId_attemptNumber: { deliveryId: delivery.id, attemptNumber } },
      create: { deliveryId: delivery.id, attemptNumber, startedAt },
      update: {},
    });

    await this.prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: NotificationDeliveryStatus.SENDING,
        attemptCount: attemptNumber,
        nextAttemptAt: null,
        provider: provider.provider,
      },
    });

    try {
      const result = await provider.send({
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId: message.messageId,
      });

      const deliveredAt = this.clock.now();
      await this.prisma.notificationDeliveryAttempt.update({
        where: { id: attempt.id },
        data: {
          finishedAt: deliveredAt,
          outcome: NotificationAttemptOutcome.SUCCEEDED,
          providerMessageId: result.providerMessageId,
        },
      });
      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: NotificationDeliveryStatus.DELIVERED,
          deliveredAt,
          providerMessageId: result.providerMessageId,
          lastErrorCode: null,
        },
      });
      return;
    } catch (error) {
      const code =
        error instanceof NotificationEmailError
          ? error.code
          : EmailFailureCode.PROVIDER_UNAVAILABLE;
      const permanent = isPermanentEmailFailure(code);

      await this.prisma.notificationDeliveryAttempt.update({
        where: { id: attempt.id },
        data: {
          finishedAt: this.clock.now(),
          outcome: permanent
            ? NotificationAttemptOutcome.FAILED_PERMANENT
            : NotificationAttemptOutcome.FAILED_RETRYABLE,
          errorCode: code,
        },
      });

      if (permanent) {
        await this.prisma.notificationDelivery.update({
          where: { id: delivery.id },
          data: { status: NotificationDeliveryStatus.FAILED_PERMANENT, lastErrorCode: code },
        });
        this.logger.warn(
          { deliveryId: delivery.id, failureCode: code },
          'notification email permanently failed',
        );
        return;
      }

      // Retryable: hand it back to the job ladder rather than recording a
      // state nothing would ever pick up again.
      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: { status: NotificationDeliveryStatus.FAILED_RETRYABLE, lastErrorCode: code },
      });
      throw error;
    }
  }

  private async skip(
    provider: NotificationEmailProviderPort,
    delivery: NotificationDelivery,
    reason: NotificationSkipReason,
  ): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: NotificationDeliveryStatus.SKIPPED,
        skipReason: reason,
        nextAttemptAt: null,
        provider: provider.provider,
      },
    });
  }

  /**
   * The job ladder is spent.
   *
   * A transport outage measured in hours should not turn into a permanently
   * failed notification, so the delivery goes back to FAILED_RETRYABLE with a
   * time on it and the sweeper picks it up — until the email ladder itself is
   * exhausted, at which point there is a dead letter an operator can inspect
   * rather than a loop.
   */
  async failExhausted(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
    });
    if (delivery === null) return;
    if (
      delivery.status !== NotificationDeliveryStatus.FAILED_RETRYABLE &&
      delivery.status !== NotificationDeliveryStatus.SENDING &&
      delivery.status !== NotificationDeliveryStatus.PENDING
    ) {
      return;
    }

    // A delivery that was still SENDING when the ladder ran out was
    // interrupted, not refused: nothing came back from the relay because
    // nobody was left to hear it. `send()` is the usual place that gets
    // closed out, but this path never reaches `send()` again, so the open
    // attempt would otherwise stay open for ever.
    const interrupted = delivery.status === NotificationDeliveryStatus.SENDING;
    if (interrupted) await this.closeOpenAttempt(delivery.id);

    const failureCode =
      delivery.lastErrorCode ??
      (interrupted ? EmailFailureCode.WORKER_INTERRUPTED : EmailFailureCode.PROVIDER_UNAVAILABLE);

    const delayMs = nextEmailRetryDelayMs(delivery.attemptCount);
    if (delayMs === null || delivery.attemptCount >= EMAIL_MAX_ATTEMPTS) {
      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: NotificationDeliveryStatus.FAILED_PERMANENT,
          nextAttemptAt: null,
          lastErrorCode: failureCode,
        },
      });
      return;
    }

    await this.prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: NotificationDeliveryStatus.FAILED_RETRYABLE,
        nextAttemptAt: new Date(this.clock.now().getTime() + delayMs),
        lastErrorCode: failureCode,
      },
    });
  }

  /**
   * Finish an attempt whose worker never did, honestly.
   *
   * Shared by the two ways an interrupted attempt is discovered: the next
   * worker picking the delivery up, and the job ladder giving up on it.
   */
  private async closeOpenAttempt(deliveryId: string): Promise<void> {
    const openAttempt = await this.prisma.notificationDeliveryAttempt.findFirst({
      where: { deliveryId, outcome: null },
      orderBy: { attemptNumber: 'desc' },
    });
    if (openAttempt === null) return;

    await this.prisma.notificationDeliveryAttempt.update({
      where: { id: openAttempt.id },
      data: {
        finishedAt: this.clock.now(),
        outcome: NotificationAttemptOutcome.FAILED_RETRYABLE,
        errorCode: EmailFailureCode.WORKER_INTERRUPTED,
      },
    });
  }
}
