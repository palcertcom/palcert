import { Injectable } from '@nestjs/common';
import type { ProcessingJob } from '@palcert/database';
import { NotificationEmailService } from '../modules/notifications/services/notification-email.service';
import { NotificationFanoutService } from '../modules/notifications/services/notification-fanout.service';

/**
 * The two notification jobs (§15, §42).
 *
 * Both carry only a row id, and both are idempotent, because both will be
 * delivered more than once: at-least-once is what the queue promises, and a
 * person being told twice about one approval is precisely what this phase
 * exists to prevent. The uniqueness that makes that impossible lives in the
 * database — `domain_events_source_identity`,
 * `user_notifications_logical_identity`,
 * `notification_deliveries_logical_identity` — not in these handlers.
 */
@Injectable()
export class NotificationJobHandler {
  constructor(
    private readonly fanout: NotificationFanoutService,
    private readonly email: NotificationEmailService,
  ) {}

  /** Turn one committed event into one copy per recipient. */
  async fanOut(job: ProcessingJob): Promise<void> {
    await this.fanout.fanOut(job.resourceId);
  }

  /** Send one logical email, or record why it was not sent. */
  async send(job: ProcessingJob): Promise<void> {
    await this.email.send(job.resourceId);
  }

  /**
   * The job ladder is spent on this delivery.
   *
   * Handing it to the email ladder rather than leaving it dead: a relay
   * outage measured in hours is a reason to try again later, not a reason for
   * somebody never to learn their certificate was revoked.
   */
  async failExhausted(job: ProcessingJob): Promise<void> {
    await this.email.failExhausted(job.resourceId);
  }
}
