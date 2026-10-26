import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  DOMAIN_EVENT_SCHEMA_VERSION,
  NOTIFICATION_AUDIENCE,
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationEmailProviderPort,
  NotificationType,
  ProcessingJobType,
  isNotificationType,
  isManualTopUpNotificationType,
  isWithdrawalNotificationType,
  isReviewerAudience,
} from '@palcert/contracts';
import type { DomainEvent } from '@palcert/database';
import { ApiConfigService } from '../../../config/api-config.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import {
  notificationDeepLink,
  renderNotification,
  resolveNotificationLocale,
} from '../templates/notification-templates';
import { readManualTopUpFacts } from './manual-topup-facts';
import { readWithdrawalFacts } from './withdrawal-facts';

/**
 * Turning one committed event into one copy per recipient (§18–§23).
 *
 * Two decisions shape everything here.
 *
 * **Authority is resolved now, not at the event.** A reviewer who has left the
 * organization since the submission arrived is not told about it. That is why
 * the recipient list is a query against current permissions rather than a
 * list captured when the event was written — a captured list would be a
 * standing grant that outlives the grant it came from.
 *
 * **Each recipient is its own transaction.** An organization with ten thousand
 * reviewers would otherwise be one transaction holding ten thousand row locks,
 * and a failure at recipient 9,999 would discard the 9,998 people already
 * told. Every write here is idempotent, so a re-run finishes the list instead
 * of starting it again.
 */
/**
 * An event this build does not know how to interpret.
 *
 * Its own class so the worker's failure classification can see it for what it
 * is: not a transport problem, not a bad row, but a deployment being asked to
 * read a payload written by a later one.
 */
export class UnsupportedEventSchemaError extends Error {
  constructor(
    readonly eventId: string,
    readonly eventSchemaVersion: number,
  ) {
    super(
      `domain event ${eventId} is schema version ${eventSchemaVersion}, ` +
        `and this build understands version ${DOMAIN_EVENT_SCHEMA_VERSION}`,
    );
    this.name = 'UnsupportedEventSchemaError';
  }
}

interface ManualTopUpRouting {
  readonly routing: string;
  readonly paymentMethodId: string | null;
  readonly configured: number;
  readonly eligible: number;
  readonly global: number;
}

interface WithdrawalRouting {
  readonly routing: string;
  readonly configured: number;
  readonly eligible: number;
  readonly global: number;
}

@Injectable()
export class NotificationFanoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: ProcessingJobService,
    private readonly email: NotificationEmailProviderPort,
    private readonly config: ApiConfigService,
  ) {}

  async fanOut(eventId: string): Promise<void> {
    const event = await this.prisma.domainEvent.findUnique({ where: { id: eventId } });
    if (event === null) return;

    if (!isNotificationType(event.eventType)) {
      throw new Error(`domain event ${event.id} has an unknown type`);
    }

    // §12: a consumer fails explicitly on a version it does not understand
    // rather than guessing at a shape. `event_schema_version >= 1` is all the
    // database requires, so a version 2 event can exist the moment a later
    // phase writes one — and interpreting it with version 1's rules would
    // deliver a confidently wrong notification. Throwing leaves no
    // notification and no delivery, and hands the job to the ordinary failure
    // ladder, where a dead letter is something an operator can see.
    if (event.eventSchemaVersion !== DOMAIN_EVENT_SCHEMA_VERSION) {
      throw new UnsupportedEventSchemaError(event.id, event.eventSchemaVersion);
    }

    // A manual top-up alert goes to its method's assigned reviewers when any
    // still qualify, and otherwise to every finance reviewer. Which of those
    // happened is read before the alert goes out and recorded after it, so a
    // fallback — or a submission nobody could be told about — is never silent.
    const routing =
      event.eventType === NotificationType.MANUAL_TOPUP_SUBMITTED
        ? await this.manualTopUpRouting(event.id)
        : null;
    // The same for a withdrawal alert: its assigned reviewers while any still
    // qualify, otherwise every global finance reviewer, recorded either way.
    const withdrawalRouting =
      event.eventType === NotificationType.WITHDRAWAL_PENDING_REVIEW
        ? await this.withdrawalRouting(event.id)
        : null;

    let notified = 0;
    for await (const recipientId of this.recipients(event)) {
      await this.notify(event, recipientId);
      notified += 1;
    }

    if (routing !== null) await this.recordManualTopUpRouting(event, routing, notified);
    if (withdrawalRouting !== null) {
      await this.recordWithdrawalRouting(event, withdrawalRouting, notified);
    }
  }

  private async withdrawalRouting(eventId: string): Promise<WithdrawalRouting | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        routing: string;
        configured_count: number;
        eligible_count: number;
        global_count: number;
      }>
    >`SELECT * FROM app_withdrawal_reviewer_routing(${eventId}::uuid)`;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      routing: row.routing,
      configured: row.configured_count,
      eligible: row.eligible_count,
      global: row.global_count,
    };
  }

  /** One audit row per withdrawal alert, as for manual top-ups. Never silent. */
  private async recordWithdrawalRouting(
    event: DomainEvent,
    routing: WithdrawalRouting,
    notified: number,
  ): Promise<void> {
    const action =
      notified === 0
        ? 'WITHDRAWAL_NO_REVIEWER_AVAILABLE'
        : routing.routing === 'FALLBACK_NO_ELIGIBLE'
          ? 'WITHDRAWAL_REVIEWER_FALLBACK'
          : 'WITHDRAWAL_REVIEWERS_RESOLVED';
    const requestId = event.aggregateId;
    const already = await this.prisma.auditEvent.findFirst({
      where: { targetType: 'WithdrawalRequest', targetId: requestId, action },
      select: { id: true },
    });
    if (already !== null) return;
    await this.prisma.auditEvent.create({
      data: {
        action,
        actorType: 'SYSTEM',
        targetType: 'WithdrawalRequest',
        targetId: requestId,
        afterState: {
          routing: routing.routing,
          assignedReviewers: routing.configured,
          eligibleAssignedReviewers: routing.eligible,
          platformFinanceReviewers: routing.global,
          notified,
          domainEventId: event.id,
        },
      },
    });
  }

  private async manualTopUpRouting(eventId: string): Promise<ManualTopUpRouting | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        routing: string;
        payment_method_id: string | null;
        configured_count: number;
        eligible_count: number;
        global_count: number;
      }>
    >`SELECT * FROM app_manual_topup_reviewer_routing(${eventId}::uuid)`;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      routing: row.routing,
      paymentMethodId: row.payment_method_id,
      configured: row.configured_count,
      eligible: row.eligible_count,
      global: row.global_count,
    };
  }

  /**
   * One audit row per submission alert, written once even if the fan-out is
   * replayed. The action says what an operator needs to look at:
   * REVIEWERS_RESOLVED is routine, REVIEWER_FALLBACK means every assigned
   * reviewer lost the permission, NO_REVIEWER_AVAILABLE means nobody in
   * PalCert could be told about this transfer at all.
   */
  private async recordManualTopUpRouting(
    event: DomainEvent,
    routing: ManualTopUpRouting,
    notified: number,
  ): Promise<void> {
    const action =
      notified === 0
        ? 'MANUAL_TOPUP_NO_REVIEWER_AVAILABLE'
        : routing.routing === 'FALLBACK_NO_ELIGIBLE'
          ? 'MANUAL_TOPUP_REVIEWER_FALLBACK'
          : 'MANUAL_TOPUP_REVIEWERS_RESOLVED';
    const requestId = event.aggregateId;
    const already = await this.prisma.auditEvent.findFirst({
      where: { targetType: 'ManualTopUpRequest', targetId: requestId, action },
      select: { id: true },
    });
    if (already !== null) return;
    await this.prisma.auditEvent.create({
      data: {
        action,
        actorType: 'SYSTEM',
        targetType: 'ManualTopUpRequest',
        targetId: requestId,
        afterState: {
          routing: routing.routing,
          paymentMethodId: routing.paymentMethodId,
          assignedReviewers: routing.configured,
          eligibleAssignedReviewers: routing.eligible,
          platformFinanceReviewers: routing.global,
          notified,
          domainEventId: event.id,
        },
      },
    });
  }

  /**
   * Who this event is for, one bounded page at a time.
   *
   * A generator rather than an array, and that is the point rather than a
   * style preference: an earlier version paged the database correctly and then
   * accumulated every page into one list before notifying anybody, which meant
   * an organization with ten thousand reviewers still put ten thousand ids in
   * memory. SQL pagination that feeds an unbounded array is not pagination.
   *
   * Here a page is read, consumed and discarded before the next is asked for,
   * so the largest thing this method ever holds is one page — and the
   * structure makes whole-list accumulation impossible rather than merely
   * unlikely.
   *
   * The owner audiences come off the event itself, so they are the
   * authoritative owner of the source row and never anything a client sent.
   */
  private async *recipients(event: DomainEvent): AsyncGenerator<string> {
    if (!isReviewerAudience(NOTIFICATION_AUDIENCE[event.eventType])) {
      yield event.ownerUserId;
      return;
    }

    // A withdrawal's requester is never its reviewer: they can neither approve
    // nor execute their own request, so the review alert would only mislead.
    // (A PalCert payout is requested by finance staff, who are reviewers too.)
    // The event's owner is the request's requester; they get their receipt.
    const excluded =
      event.eventType === NotificationType.WITHDRAWAL_PENDING_REVIEW ? event.ownerUserId : null;

    const pageSize = this.config.notificationFanoutPageSize;
    let after: string | null = null;

    // Keyset pagination, because an organization's reviewer list is unbounded
    // in principle and OFFSET would re-scan what it has already read.
    for (;;) {
      // No tenant scope: fan-out is PalCert's own work, and the resolver
      // refuses a caller that has one. The worker used to open this as
      // `withUser(event.ownerUserId)` purely to satisfy a party check, which
      // was the system borrowing a customer's identity as its authority.
      const page: Array<{ user_id: string }> = await this.prisma.$queryRaw`
        SELECT "user_id" FROM app_notification_submission_reviewers(
          ${event.id}::uuid, ${pageSize}::integer, ${after}::uuid)`;

      if (page.length === 0) return;
      for (const row of page) if (row.user_id !== excluded) yield row.user_id;
      if (page.length < pageSize) return;

      after = page[page.length - 1]?.user_id ?? null;
      if (after === null) return;
    }
  }

  /**
   * One recipient's copy, plus the email delivery that will carry it.
   *
   * The email row is created PENDING whatever the recipient's preference
   * says. Eligibility is a delivery-time question (§25, §72): a person who
   * turns a type off between the event and the send should not get the mail,
   * and a person whose address is verified in that window should. Recording
   * the intention and then resolving it at send time is also what lets a skip
   * carry its reason, so "no email arrived" has an answer that does not
   * require reading anybody's mail.
   */
  private async notify(event: DomainEvent, recipientUserId: string): Promise<void> {
    const recipient = await this.prisma.user.findUnique({
      where: { id: recipientUserId },
      select: { id: true, preferredLocale: true },
    });
    if (recipient === null) return;

    const locale = resolveNotificationLocale(recipient.preferredLocale);
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    // A withdrawal's copy names its amount, scope and beneficiary, and its
    // owner's link depends on whose money it is; all of it is read from the
    // request now, never carried on the event.
    let withdrawal;
    if (isWithdrawalNotificationType(event.eventType)) {
      withdrawal = await readWithdrawalFacts(this.prisma, event.id, recipientUserId);
      if (withdrawal === null) {
        throw new Error(`domain event ${event.id} names a withdrawal with no facts`);
      }
    }

    const deepLink = notificationDeepLink({
      audience: NOTIFICATION_AUDIENCE[event.eventType],
      locale,
      organizationId: event.organizationId,
      submissionId: typeof payload.submissionId === 'string' ? payload.submissionId : undefined,
      certificateId: typeof payload.certificateId === 'string' ? payload.certificateId : undefined,
      attestationRequestId:
        typeof payload.attestationRequestId === 'string' ? payload.attestationRequestId : undefined,
      manualTopUpRequestId:
        typeof payload.manualTopUpRequestId === 'string' ? payload.manualTopUpRequestId : undefined,
      withdrawal:
        withdrawal === undefined
          ? undefined
          : {
              requestId: withdrawal.requestId,
              scope: withdrawal.scope,
              organizationId: withdrawal.organizationId,
            },
    });

    // A manual top-up's copy names its amount, method and reference. They are
    // read from the request now, by the database's own doorway, rather than
    // carried on the event — the durable event log never holds money.
    let manualTopUp;
    if (isManualTopUpNotificationType(event.eventType)) {
      manualTopUp = await readManualTopUpFacts(this.prisma, event.id, recipientUserId);
      if (manualTopUp === null) {
        throw new Error(`domain event ${event.id} names a top-up with no reported facts`);
      }
    }

    const rendered = renderNotification({
      type: event.eventType,
      locale,
      deepLink,
      appOrigin: this.config.publicWebUrl,
      manualTopUp,
      withdrawal,
    });

    // Again with no tenant scope. `app_notification_create` requires system
    // context *and* checks the recipient against the event's own audience, so
    // a valid event plus an arbitrary user id is refused by the database
    // rather than trusted to this method having picked correctly.
    await this.prisma.$transaction(async (tx) => {
      const created: Array<{ id: string }> = await tx.$queryRaw`
        SELECT app_notification_create(
          ${randomUUID()}::uuid,
          ${event.id}::uuid,
          ${recipientUserId}::uuid,
          ${rendered.templateVersion},
          ${rendered.locale},
          ${rendered.title},
          ${rendered.body},
          ${deepLink}
        ) AS id`;

      const notificationId = created[0]?.id;
      if (notificationId === undefined) return;

      // Unique per (notification, channel), so a replayed fan-out finds the
      // delivery it made last time rather than scheduling a second email.
      const delivery = await tx.notificationDelivery.upsert({
        where: {
          notificationId_channel: {
            notificationId,
            channel: NotificationChannel.EMAIL,
          },
        },
        create: {
          notificationId,
          channel: NotificationChannel.EMAIL,
          status: NotificationDeliveryStatus.PENDING,
          // The transport this deployment would use. The send worker rewrites
          // it if configuration changed between scheduling and sending, so the
          // row always names whoever actually carried the message.
          provider: this.email.provider,
        },
        update: {},
      });

      await this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.NOTIFICATION_EMAIL_SEND,
        resourceType: 'NOTIFICATION_DELIVERY',
        resourceId: delivery.id,
      });
    });
  }
}
