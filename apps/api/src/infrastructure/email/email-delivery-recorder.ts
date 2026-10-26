import { Injectable } from '@nestjs/common';
import {
  EmailDeliveryCategory,
  EmailDeliveryStatus,
  emailStatusAdvances,
  outboundFailureSummary,
  type EmailSkipReason,
  type OutboundEmailFailure,
} from '@palcert/contracts';
import type { EmailDelivery } from '@palcert/database';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The only writer of `email_deliveries` (ADR-0146).
 *
 * Every method takes metadata and nothing else. There is no parameter through
 * which a subject, a body, a link or a credential could reach the table, and
 * failure text is always PalCert's own fixed sentence for the category.
 */
export interface NewEmailDelivery {
  readonly category: EmailDeliveryCategory;
  readonly template: string;
  readonly provider: string;
  readonly recipient: string;
  readonly notificationDeliveryId?: string | null;
  readonly requestedByUserId?: string | null;
}

@Injectable()
export class EmailDeliveryRecorder {
  constructor(private readonly prisma: PrismaService) {}

  async queued(input: NewEmailDelivery): Promise<EmailDelivery> {
    return this.prisma.emailDelivery.create({
      data: {
        category: input.category,
        template: input.template,
        provider: input.provider,
        recipient: input.recipient.slice(0, 254),
        status: EmailDeliveryStatus.QUEUED,
        notificationDeliveryId: input.notificationDeliveryId ?? null,
        requestedByUserId: input.requestedByUserId ?? null,
      },
    });
  }

  async skipped(input: NewEmailDelivery, reason: EmailSkipReason): Promise<EmailDelivery> {
    return this.prisma.emailDelivery.create({
      data: {
        category: input.category,
        template: input.template,
        provider: input.provider,
        recipient: input.recipient.slice(0, 254),
        status: EmailDeliveryStatus.SKIPPED,
        skipReason: reason,
        notificationDeliveryId: input.notificationDeliveryId ?? null,
        requestedByUserId: input.requestedByUserId ?? null,
      },
    });
  }

  /**
   * The workflow mirror: one row per Phase 16 delivery, however many attempts
   * the notification pipeline makes. Created on the first attempt, reused on
   * every retry.
   */
  async workflowAttempt(
    input: NewEmailDelivery & { notificationDeliveryId: string },
  ): Promise<EmailDelivery> {
    return this.prisma.emailDelivery.upsert({
      where: { notificationDeliveryId: input.notificationDeliveryId },
      create: {
        category: EmailDeliveryCategory.WORKFLOW,
        template: input.template,
        provider: input.provider,
        recipient: input.recipient.slice(0, 254),
        status: EmailDeliveryStatus.QUEUED,
        notificationDeliveryId: input.notificationDeliveryId,
      },
      update: {},
    });
  }

  async attemptStarted(id: string): Promise<void> {
    await this.prisma.emailDelivery.update({
      where: { id },
      data: { attemptCount: { increment: 1 } },
    });
  }

  async accepted(id: string, providerMessageId: string | null, at: Date): Promise<void> {
    await this.prisma.emailDelivery.update({
      where: { id },
      data: {
        status: EmailDeliveryStatus.ACCEPTED,
        providerMessageId,
        acceptedAt: at,
        failureCode: null,
        failureSummary: null,
      },
    });
  }

  /**
   * A failed attempt. `final` marks the delivery FAILED; otherwise it stays
   * QUEUED with the latest failure recorded, because another attempt follows.
   */
  async failed(id: string, failure: OutboundEmailFailure, final: boolean, at: Date): Promise<void> {
    await this.prisma.emailDelivery.update({
      where: { id },
      data: {
        status: final ? EmailDeliveryStatus.FAILED : EmailDeliveryStatus.QUEUED,
        failureCode: failure,
        failureSummary: outboundFailureSummary(failure),
        failedAt: final ? at : null,
      },
    });
  }

  /**
   * Apply a provider event, never moving a delivery backwards.
   *
   * Conditional on the status read, so two events racing for the same row
   * cannot both apply: the loser's update matches nothing and is reported as
   * stale.
   */
  async applyProviderStatus(params: {
    readonly provider: string;
    readonly providerMessageId: string;
    readonly next: EmailDeliveryStatus;
    readonly failure: OutboundEmailFailure | null;
    readonly at: Date;
  }): Promise<'APPLIED' | 'STALE' | 'UNMATCHED'> {
    const row = await this.prisma.emailDelivery.findFirst({
      where: { provider: params.provider, providerMessageId: params.providerMessageId },
    });
    if (row === null) return 'UNMATCHED';
    const current = row.status as EmailDeliveryStatus;
    if (!emailStatusAdvances(current, params.next)) {
      await this.prisma.emailDelivery.updateMany({
        where: { id: row.id },
        data: { lastEventAt: params.at },
      });
      return 'STALE';
    }

    const terminalFailure =
      params.next === EmailDeliveryStatus.BOUNCED ||
      params.next === EmailDeliveryStatus.FAILED ||
      params.next === EmailDeliveryStatus.COMPLAINED;
    const result = await this.prisma.emailDelivery.updateMany({
      where: { id: row.id, status: current },
      data: {
        status: params.next,
        lastEventAt: params.at,
        ...(params.next === EmailDeliveryStatus.DELIVERED ? { deliveredAt: params.at } : {}),
        ...(terminalFailure && params.next !== EmailDeliveryStatus.COMPLAINED
          ? { failedAt: params.at }
          : {}),
        ...(params.failure !== null
          ? { failureCode: params.failure, failureSummary: outboundFailureSummary(params.failure) }
          : {}),
      },
    });
    return result.count === 1 ? 'APPLIED' : 'STALE';
  }
}
