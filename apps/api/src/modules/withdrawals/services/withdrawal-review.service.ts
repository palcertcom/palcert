import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AppError,
  CreditHoldStatus,
  ManualTopUpFileStatus,
  PalCertErrorCode,
  Permission,
  ProcessingJobType,
  RECEIPT_FORMATS,
  RECEIPT_MAX_BYTES,
  WITHDRAWAL_LIMITS,
  WITHDRAWAL_REJECTION_REASONS,
  WithdrawalAction,
  WithdrawalActorSide,
  WithdrawalAttemptOutcome,
  WithdrawalEventType,
  WithdrawalRejectionReason,
  WithdrawalReservationStatus,
  WithdrawalReviewerRouting,
  WithdrawalScope,
  WithdrawalStatus,
  maskEmailAddress,
  money,
  parseMinorUnits,
  withdrawalReference,
  withdrawalSettlementKey,
  type AdminWithdrawalRequestView,
  type DownloadAuthorizationView,
  type ManualTopUpUploadAuthorizationView,
  type PayoutDestinationType,
  type WithdrawalAttemptView,
  type WithdrawalDestinationRevealView,
  type WithdrawalNotificationReportView,
  type WithdrawalProofUploadResponse,
  type WithdrawalQueueView,
} from '@palcert/contracts';
import type { Prisma, WithdrawalProof } from '@palcert/database';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { quarantineWithdrawalProofKey } from '../../../infrastructure/storage/storage-keys';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { CreditHoldService } from '../../finance/services/credit-hold.service';
import { DomainEventService } from '../../notifications/services/domain-event.service';
import { ManualTopUpFiles } from '../../manual-topups/manual-topup-files';
import { PayoutDestinationKeyring, PayoutSealPurpose } from '../payout-destination-keyring';
import {
  REQUEST_INCLUDE,
  alreadyDecided,
  boundedText,
  clampLimit,
  eventView,
  invalid,
  readSummary,
  requestSealedOf,
  requestView,
  separationOfDuties,
  staleVersion,
  transitionInvalid,
  withdrawalNotFound,
  type RequestContext,
  type RequestRow,
} from '../withdrawal-support';
import { proofView, readyProofOf } from './withdrawal-proofs';
import { WithdrawalRequestService } from './withdrawal-request.service';

/** The audit actions the fan-out records when it routes a submission alert. */
const REVIEWER_ROUTING_ACTIONS = [
  'WITHDRAWAL_REVIEWERS_RESOLVED',
  'WITHDRAWAL_REVIEWER_FALLBACK',
  'WITHDRAWAL_NO_REVIEWER_AVAILABLE',
] as const;

/** States a finance user may still act on, and from which a proof may be attached. */
const PROOF_STATES: readonly WithdrawalStatus[] = [
  WithdrawalStatus.PROCESSING,
  WithdrawalStatus.PAID,
];

/** Who is acting, with what authority, from which session. */
export interface FinanceActor {
  readonly userId: string;
  readonly permissions: ReadonlySet<string>;
  readonly sessionId: string;
}

export interface QueueFilter {
  readonly status?: WithdrawalStatus | undefined;
  readonly scope?: WithdrawalScope | undefined;
  readonly currency?: string | undefined;
  readonly organizationId?: string | undefined;
  readonly requesterUserId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

type Row = Awaited<ReturnType<TenantClient['withdrawalRequest']['findUniqueOrThrow']>>;

/**
 * PalCert finance's side of every withdrawal: review, approve or reject,
 * record the external payout, settle exactly once (spec §21–§27, D8, D9).
 *
 * Approval authorizes a payout; it moves no money and keeps the reservation.
 * The money leaves PalCert's books only when an executor records the external
 * transfer with its mandatory reference: one transaction locks the request,
 * proves it is PROCESSING, captures the user's hold (or consumes the
 * organization's or PalCert's reservation), writes the one settlement keyed
 * `withdrawal:<id>:settle`, closes the attempt and marks the request PAID. A
 * double click, a retry or a second executor finds the request already PAID
 * under its lock and gets the same answer; the unique keys make a second
 * settlement impossible even for a caller that bypassed all of this.
 *
 * Separation of duties is checked here and again by the database: nobody
 * acts on their own request; PalCert's own money needs three different
 * people to request, approve and execute; and when one finance user both
 * approves and executes a user or organization payout, the execution needs
 * a re-authentication made after the approval.
 *
 * A failed transfer keeps its reservation. Finance retries it — a new,
 * append-only attempt — or releases it with a stated reason. Nothing is
 * released or retried automatically (D9).
 */
@Injectable()
export class WithdrawalReviewService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly prisma: PrismaService,
    private readonly holds: CreditHoldService,
    private readonly requests: WithdrawalRequestService,
    private readonly keyring: PayoutDestinationKeyring,
    private readonly files: ManualTopUpFiles,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly domainEvents: DomainEventService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async queue(actorUserId: string, filter: QueueFilter): Promise<WithdrawalQueueView> {
    const limit = clampLimit(filter.limit, 25);
    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read the withdrawal review queue' },
      async (tx) => {
        const where: Prisma.WithdrawalRequestWhereInput = {
          status:
            filter.status === undefined || filter.status === WithdrawalStatus.DRAFT
              ? { not: WithdrawalStatus.DRAFT }
              : filter.status,
          ...(filter.scope === undefined ? {} : { scope: filter.scope }),
          ...(filter.currency === undefined ? {} : { currency: filter.currency }),
          ...(filter.organizationId === undefined ? {} : { organizationId: filter.organizationId }),
          ...(filter.requesterUserId === undefined
            ? {}
            : { requesterUserId: filter.requesterUserId }),
          ...(filter.from === undefined && filter.to === undefined
            ? {}
            : {
                submittedAt: {
                  ...(filter.from === undefined ? {} : { gte: filter.from }),
                  ...(filter.to === undefined ? {} : { lt: filter.to }),
                },
              }),
        };
        const rows = await tx.withdrawalRequest.findMany({
          where,
          // Oldest waiting first, so nobody's payout sits at the bottom.
          orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
          take: limit + 1,
          ...(filter.cursor === undefined ? {} : { cursor: { id: filter.cursor }, skip: 1 }),
        });
        const page = rows.slice(0, limit);
        const people = await this.people(
          tx,
          page.map((row) => row.requesterUserId),
        );
        const orgs = await this.organizations(
          tx,
          page.map((row) => row.organizationId),
        );

        // Open money per status and currency. Never summed across currencies.
        const totals = await tx.withdrawalRequest.groupBy({
          by: ['status', 'currency'],
          where: {
            status: {
              in: [
                WithdrawalStatus.PENDING_REVIEW,
                WithdrawalStatus.APPROVED,
                WithdrawalStatus.PROCESSING,
                WithdrawalStatus.FAILED,
              ],
            },
          },
          _sum: { amountMinor: true },
          _count: { _all: true },
          orderBy: [{ status: 'asc' }, { currency: 'asc' }],
        });

        return {
          items: page.map((row) => {
            const snapshot = readSummary(row.destinationSnapshot);
            const person = people.get(row.requesterUserId);
            return {
              id: row.id,
              reference: withdrawalReference(row.id),
              scope: row.scope as WithdrawalScope,
              status: row.status as WithdrawalStatus,
              amount: money(row.currency, row.amountMinor),
              requesterDisplayName: person?.displayName ?? null,
              requesterEmail: person?.email ?? '',
              organizationId: row.organizationId,
              organizationName:
                row.organizationId === null ? null : (orgs.get(row.organizationId) ?? null),
              beneficiaryName: snapshot.beneficiaryName,
              destinationType: snapshot.type as PayoutDestinationType,
              submittedAt: row.submittedAt?.toISOString() ?? null,
              executedAt: row.executedAt?.toISOString() ?? null,
            };
          }),
          nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
          totals: totals.map((total) => ({
            status: total.status as WithdrawalStatus,
            currency: total.currency,
            count: total._count?._all ?? 0,
            total: money(total.currency, total._sum?.amountMinor ?? 0n),
          })),
        };
      },
    );
  }

  async get(actor: FinanceActor, requestId: string): Promise<AdminWithdrawalRequestView> {
    return this.tenant.withPlatformAdmin(
      { actorUserId: actor.userId, reason: 'read a withdrawal request' },
      (tx) => this.view(tx, requestId, actor),
    );
  }

  /**
   * The full payout instructions, for the finance user about to send the
   * money. Opened from the request's own frozen copy — never from the saved
   * destination, which may have changed since — and recorded every time.
   */
  async revealDestination(
    actor: FinanceActor,
    requestId: string,
    context: RequestContext,
  ): Promise<WithdrawalDestinationRevealView> {
    const row = await this.tenant.withPlatformAdmin(
      { actorUserId: actor.userId, reason: 'reveal a withdrawal destination' },
      async (tx) => {
        const found = await tx.withdrawalRequest.findUnique({ where: { id: requestId } });
        if (found === null || found.status === WithdrawalStatus.DRAFT) throw withdrawalNotFound();
        return found;
      },
    );
    const details = this.keyring.open(requestSealedOf(row), {
      purpose: PayoutSealPurpose.REQUEST_SNAPSHOT,
      recordId: row.id,
    });
    await this.events.audit({
      action: 'WITHDRAWAL_DESTINATION_REVEALED',
      actorUserId: actor.userId,
      targetType: 'WithdrawalRequest',
      targetId: requestId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      afterState: { scope: row.scope },
    });
    return {
      ...readSummary(row.destinationSnapshot),
      iban: details.iban,
      accountNumber: details.accountNumber,
      branch: details.branch,
      mobileNumber: details.mobileNumber,
      instructions: details.instructions,
    };
  }

  /**
   * "No email arrived", answered for one request: who was told, whether the
   * in-app copy and the email went out, why an email was skipped, and how the
   * reviewers were chosen. Statuses and masked addresses only.
   */
  async notificationReport(
    actorUserId: string,
    requestId: string,
  ): Promise<WithdrawalNotificationReportView> {
    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read a withdrawal notification report' },
      async (tx) => {
        const request = await tx.withdrawalRequest.findUnique({
          where: { id: requestId },
          select: { status: true },
        });
        if (request === null || request.status === WithdrawalStatus.DRAFT) {
          throw withdrawalNotFound();
        }
        const rows = await tx.$queryRaw<
          Array<{
            recipient_user_id: string;
            display_name: string | null;
            email: string;
            email_verified: boolean;
            notification_type: string;
            notified_at: Date;
            in_app_status: string | null;
            email_status: string | null;
            email_skip_reason: string | null;
            email_attempts: number | null;
          }>
        >`SELECT * FROM app_withdrawal_notification_report(${requestId}::uuid)`;
        const recorded = await tx.auditEvent.findFirst({
          where: {
            targetType: 'WithdrawalRequest',
            targetId: requestId,
            action: { in: [...REVIEWER_ROUTING_ACTIONS] },
          },
          orderBy: { createdAt: 'desc' },
          select: { action: true, afterState: true },
        });
        const routingValue =
          recorded === null
            ? null
            : ((recorded.afterState as { routing?: unknown } | null)?.routing ?? null);
        const routing = (Object.values(WithdrawalReviewerRouting) as unknown[]).includes(
          routingValue,
        )
          ? (routingValue as WithdrawalReviewerRouting)
          : null;
        return {
          routing,
          noReviewerAvailable: recorded?.action === 'WITHDRAWAL_NO_REVIEWER_AVAILABLE',
          recipients: rows.map((row) => ({
            userId: row.recipient_user_id,
            displayName: row.display_name,
            emailMasked: maskEmailAddress(row.email),
            emailVerified: row.email_verified,
            notificationType: row.notification_type,
            notifiedAt: row.notified_at.toISOString(),
            inAppStatus: row.in_app_status,
            emailStatus: row.email_status,
            emailSkipReason: row.email_skip_reason,
            emailAttempts: row.email_attempts,
          })),
        };
      },
    );
  }

  // -------------------------------------------------------------------------
  // Review and decision
  // -------------------------------------------------------------------------

  /** Open a request for review. Idempotent; the first reviewer stays on record. */
  async startReview(
    actor: FinanceActor,
    requestId: string,
    context: RequestContext,
  ): Promise<AdminWithdrawalRequestView> {
    const { view, started } = await this.finance(
      actor,
      'start reviewing a withdrawal',
      async (tx) => {
        const current = await this.lock(tx, requestId);
        this.refuseOwnRequest(current, actor.userId, 'review');
        const status = current.status as WithdrawalStatus;
        if (status !== WithdrawalStatus.PENDING_REVIEW) {
          throw isDecided(status) ? alreadyDecided(status) : transitionInvalid(status, 'reviewed');
        }
        if (current.reviewStartedAt !== null) {
          return { view: await this.view(tx, requestId, actor), started: false };
        }
        const now = this.clock.now();
        await tx.withdrawalRequest.update({
          where: { id: requestId },
          data: {
            reviewStartedAt: now,
            reviewedByUserId: actor.userId,
            version: current.version + 1,
            updatedAt: now,
          },
        });
        await this.history(tx, current, WithdrawalEventType.REVIEW_STARTED, actor.userId);
        return { view: await this.view(tx, requestId, actor), started: true };
      },
    );
    if (started) await this.audit('WITHDRAWAL_REVIEW_STARTED', actor.userId, requestId, context);
    return view;
  }

  /**
   * Authorize the payout. Moves no money and keeps the reservation; the
   * reviewer restates amount and currency as confirmation and cannot change
   * them.
   */
  async approve(
    actor: FinanceActor,
    requestId: string,
    input: {
      readonly expectedVersion: number;
      readonly confirmAmountMinorUnits: string;
      readonly confirmCurrency: string;
    },
    context: RequestContext,
  ): Promise<AdminWithdrawalRequestView> {
    const confirmed = parseOrNegative(input.confirmAmountMinorUnits);
    const { view, approved } = await this.finance(actor, 'approve a withdrawal', async (tx) => {
      const current = await this.lock(tx, requestId);
      this.refuseOwnRequest(current, actor.userId, 'approve');
      const status = current.status as WithdrawalStatus;
      if (status === WithdrawalStatus.APPROVED && current.approvedByUserId === actor.userId) {
        return { view: await this.view(tx, requestId, actor), approved: false };
      }
      if (status !== WithdrawalStatus.PENDING_REVIEW) {
        throw isDecided(status) ? alreadyDecided(status) : transitionInvalid(status, 'approved');
      }
      if (current.version !== input.expectedVersion) throw staleVersion(current.version);
      this.confirm(current, confirmed, input.confirmCurrency);
      await this.requireLiveReservation(tx, current);

      const now = this.clock.now();
      await tx.withdrawalRequest.update({
        where: { id: requestId },
        data: {
          status: WithdrawalStatus.APPROVED,
          approvedAt: now,
          approvedByUserId: actor.userId,
          ...(current.reviewStartedAt === null
            ? { reviewStartedAt: now, reviewedByUserId: actor.userId }
            : {}),
          version: current.version + 1,
          updatedAt: now,
        },
      });
      const historyId = await this.history(tx, current, WithdrawalEventType.APPROVED, actor.userId);
      await this.domainEvents.emitWithdrawal(tx, historyId);
      await this.events.auditWithin(tx, {
        action: 'WITHDRAWAL_APPROVED',
        actorUserId: actor.userId,
        targetType: 'WithdrawalRequest',
        targetId: requestId,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: {
          scope: current.scope,
          currency: current.currency,
          amountMinor: current.amountMinor.toString(),
        },
      });
      return { view: await this.view(tx, requestId, actor), approved: true };
    });
    void approved;
    return view;
  }

  /** Decline, with a reason the requester is told. Releases the reservation. */
  async reject(
    actor: FinanceActor,
    requestId: string,
    input: {
      readonly expectedVersion: number;
      readonly reason: string;
      readonly note?: string | null;
    },
    context: RequestContext,
  ): Promise<AdminWithdrawalRequestView> {
    if (!(WITHDRAWAL_REJECTION_REASONS as readonly string[]).includes(input.reason)) {
      throw invalid('reason', 'Choose a reason for rejecting this withdrawal.');
    }
    const reason = input.reason as WithdrawalRejectionReason;
    const note = boundedText(input.note, WITHDRAWAL_LIMITS.rejectionNote, 'note');
    if (reason === WithdrawalRejectionReason.OTHER && note === null) {
      throw invalid('note', 'Explain the reason when you choose “other”.');
    }

    const { view, rejected } = await this.finance(actor, 'reject a withdrawal', async (tx) => {
      const current = await this.lock(tx, requestId);
      this.refuseOwnRequest(current, actor.userId, 'reject');
      const status = current.status as WithdrawalStatus;
      if (status === WithdrawalStatus.REJECTED && current.rejectedByUserId === actor.userId) {
        return { view: await this.view(tx, requestId, actor), rejected: false };
      }
      if (status !== WithdrawalStatus.PENDING_REVIEW) {
        throw isDecided(status) ? alreadyDecided(status) : transitionInvalid(status, 'rejected');
      }
      if (current.version !== input.expectedVersion) throw staleVersion(current.version);

      await this.requests.releaseReservation(tx, current);
      const now = this.clock.now();
      await tx.withdrawalRequest.update({
        where: { id: requestId },
        data: {
          status: WithdrawalStatus.REJECTED,
          rejectedAt: now,
          rejectedByUserId: actor.userId,
          rejectionReason: reason,
          rejectionNote: note,
          ...(current.reviewStartedAt === null
            ? { reviewStartedAt: now, reviewedByUserId: actor.userId }
            : {}),
          version: current.version + 1,
          updatedAt: now,
        },
      });
      const historyId = await this.history(
        tx,
        current,
        WithdrawalEventType.REJECTED,
        actor.userId,
        note,
      );
      await this.history(tx, current, WithdrawalEventType.RESERVATION_RELEASED, actor.userId);
      await this.domainEvents.emitWithdrawal(tx, historyId);
      await this.events.auditWithin(tx, {
        action: 'WITHDRAWAL_REJECTED',
        actorUserId: actor.userId,
        targetType: 'WithdrawalRequest',
        targetId: requestId,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: { reason },
      });
      return { view: await this.view(tx, requestId, actor), rejected: true };
    });
    if (rejected) {
      await this.audit('WITHDRAWAL_RESERVATION_RELEASED', actor.userId, requestId, context, {
        by: 'REJECTION',
      });
    }
    return view;
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Record that a finance user is now sending the money outside PalCert —
   * the first attempt from APPROVED, or a retry from FAILED. Each is a new,
   * append-only attempt row; nothing here talks to a bank or a wallet.
   */
  async startExecution(
    actor: FinanceActor,
    requestId: string,
    input: { readonly expectedVersion: number },
    context: RequestContext,
  ): Promise<AdminWithdrawalRequestView> {
    const authenticatedAt = await this.authenticatedAt(actor.sessionId);
    const { view, retry } = await this.finance(actor, 'start a withdrawal payout', async (tx) => {
      const current = await this.lock(tx, requestId);
      this.refuseExecutor(current, actor.userId, authenticatedAt);
      const status = current.status as WithdrawalStatus;
      if (status === WithdrawalStatus.PROCESSING) {
        // A double click by the person who opened the attempt is answered with
        // it. Anyone else is told it is taken: two people must never both
        // believe they are the one sending the money.
        const open = await tx.withdrawalExecutionAttempt.findFirst({
          where: { requestId, outcome: 'IN_PROGRESS' },
          select: { startedByUserId: true },
        });
        if (open?.startedByUserId === actor.userId) {
          return { view: await this.view(tx, requestId, actor), retry: null };
        }
        throw transitionInvalid(status, 'paid out');
      }
      if (status !== WithdrawalStatus.APPROVED && status !== WithdrawalStatus.FAILED) {
        throw transitionInvalid(status, 'paid out');
      }
      if (current.version !== input.expectedVersion) throw staleVersion(current.version);
      await this.requireLiveReservation(tx, current);

      const isRetry = status === WithdrawalStatus.FAILED;
      const last = await tx.withdrawalExecutionAttempt.findFirst({
        where: { requestId },
        orderBy: { attemptNumber: 'desc' },
        select: { attemptNumber: true },
      });
      const now = this.clock.now();
      await tx.withdrawalExecutionAttempt.create({
        data: {
          requestId,
          attemptNumber: (last?.attemptNumber ?? 0) + 1,
          startedByUserId: actor.userId,
          startedAt: now,
        },
      });
      await tx.withdrawalRequest.update({
        where: { id: requestId },
        data: { status: WithdrawalStatus.PROCESSING, version: current.version + 1, updatedAt: now },
      });
      await this.history(
        tx,
        current,
        isRetry ? WithdrawalEventType.RETRY_STARTED : WithdrawalEventType.EXECUTION_STARTED,
        actor.userId,
      );
      return { view: await this.view(tx, requestId, actor), retry: isRetry };
    });
    if (retry !== null) {
      await this.audit(
        retry ? 'WITHDRAWAL_RETRY_STARTED' : 'WITHDRAWAL_EXECUTION_STARTED',
        actor.userId,
        requestId,
        context,
      );
    }
    return view;
  }

  /**
   * Record the external transfer and settle, exactly once (§24, §25).
   *
   * The transfer reference is mandatory and the executor restates amount and
   * currency. Settlement, the attempt's close and the PAID status are one
   * transaction under the request's row lock.
   */
  async markPaid(
    actor: FinanceActor,
    requestId: string,
    input: {
      readonly expectedVersion: number;
      readonly externalTransferReference: string;
      readonly note?: string | null;
      readonly confirmAmountMinorUnits: string;
      readonly confirmCurrency: string;
    },
    context: RequestContext,
  ): Promise<AdminWithdrawalRequestView> {
    const reference = boundedText(
      input.externalTransferReference,
      WITHDRAWAL_LIMITS.externalReference,
      'externalTransferReference',
    );
    if (reference === null) {
      throw new AppError(PalCertErrorCode.WITHDRAWAL_REFERENCE_REQUIRED, {
        message: 'Enter the transfer reference from the bank or wallet before marking this paid.',
        details: { field: 'externalTransferReference' },
      });
    }
    const note = boundedText(input.note, WITHDRAWAL_LIMITS.executionNote, 'note');
    const confirmed = parseOrNegative(input.confirmAmountMinorUnits);
    const authenticatedAt = await this.authenticatedAt(actor.sessionId);

    const result = await this.finance(actor, 'settle a withdrawal payout', async (tx) => {
      const current = await this.lock(tx, requestId);
      this.refuseExecutor(current, actor.userId, authenticatedAt);
      const status = current.status as WithdrawalStatus;
      if (status === WithdrawalStatus.PAID) {
        // The same payout recorded twice — a double click, a retry, a second
        // executor. One settlement, one answer; a different reference is a
        // conflict to look at, never a second debit.
        if (current.externalTransferReference === reference) {
          return { view: await this.view(tx, requestId, actor), settled: null };
        }
        throw alreadyDecided(status);
      }
      if (status !== WithdrawalStatus.PROCESSING) throw transitionInvalid(status, 'marked paid');
      if (current.version !== input.expectedVersion) throw staleVersion(current.version);
      this.confirm(current, confirmed, input.confirmCurrency);

      const now = this.clock.now();
      const settlement = await this.settle(tx, current, reference, actor.userId);
      await tx.withdrawalExecutionAttempt.updateMany({
        where: { requestId, outcome: WithdrawalAttemptOutcome.IN_PROGRESS },
        data: {
          outcome: WithdrawalAttemptOutcome.SUCCEEDED,
          finishedAt: now,
          finishedByUserId: actor.userId,
          externalReference: reference,
          note,
        },
      });
      await tx.withdrawalRequest.update({
        where: { id: requestId },
        data: {
          status: WithdrawalStatus.PAID,
          executedAt: now,
          executedByUserId: actor.userId,
          externalTransferReference: reference,
          executionNote: note,
          version: current.version + 1,
          updatedAt: now,
        },
      });
      const historyId = await this.history(tx, current, WithdrawalEventType.PAID, actor.userId);
      await this.domainEvents.emitWithdrawal(tx, historyId);
      await this.events.auditWithin(tx, {
        action: 'WITHDRAWAL_PAID',
        actorUserId: actor.userId,
        targetType: 'WithdrawalRequest',
        targetId: requestId,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: {
          scope: current.scope,
          currency: current.currency,
          amountMinor: current.amountMinor.toString(),
          settlementId: settlement.id,
          ledgerEntryId: settlement.ledgerEntryId,
          idempotencyKey: withdrawalSettlementKey(requestId),
        },
      });
      return { view: await this.view(tx, requestId, actor), settled: settlement };
    });
    return result.view;
  }

  /**
   * The irreversible movement. For a user, capture the request's own hold as
   * one WITHDRAWAL_DEBIT; for an organization or PalCert, consume its own
   * reservation. Then the one settlement row the database checks against both.
   */
  private async settle(
    tx: TenantClient,
    current: Row,
    reference: string,
    actorUserId: string,
  ): Promise<{ id: string; ledgerEntryId: string | null }> {
    const key = withdrawalSettlementKey(current.id);
    const existing = await tx.withdrawalSettlement.findUnique({ where: { idempotencyKey: key } });
    if (existing !== null) return { id: existing.id, ledgerEntryId: existing.ledgerEntryId };

    let ledgerEntryId: string | null = null;
    if (current.scope === WithdrawalScope.USER) {
      if (current.holdId === null) throw this.reservationMissing(current.id);
      const capture = await this.holds.capture(tx, current.holdId);
      ledgerEntryId = capture.entryId;
    } else {
      if (current.reservationId === null) throw this.reservationMissing(current.id);
      const consumed = await tx.withdrawalReservation.updateMany({
        where: { id: current.reservationId, status: WithdrawalReservationStatus.ACTIVE },
        data: { status: WithdrawalReservationStatus.CONSUMED, consumedAt: this.clock.now() },
      });
      if (consumed.count !== 1) throw this.reservationMissing(current.id);
    }

    const row = await tx.withdrawalSettlement.create({
      data: {
        requestId: current.id,
        scope: current.scope,
        beneficiaryUserId: current.beneficiaryUserId,
        organizationId: current.organizationId,
        currency: current.currency,
        amountMinor: current.amountMinor,
        ledgerEntryId,
        reservationId: current.scope === WithdrawalScope.USER ? null : current.reservationId,
        idempotencyKey: key,
        externalTransferReference: reference,
        settledByUserId: actorUserId,
      },
      select: { id: true, ledgerEntryId: true },
    });
    return row;
  }

  /** The transfer did not go through. The reservation stays (D9). */
  async markFailed(
    actor: FinanceActor,
    requestId: string,
    input: {
      readonly expectedVersion: number;
      readonly note: string;
      readonly externalReference?: string | null;
    },
    context: RequestContext,
  ): Promise<AdminWithdrawalRequestView> {
    const note = boundedText(input.note, WITHDRAWAL_LIMITS.executionNote, 'note');
    if (note === null) throw invalid('note', 'Say what happened to the transfer.');
    const reference = boundedText(
      input.externalReference,
      WITHDRAWAL_LIMITS.externalReference,
      'externalReference',
    );
    const authenticatedAt = await this.authenticatedAt(actor.sessionId);

    const { view, failed } = await this.finance(
      actor,
      'record a failed withdrawal payout',
      async (tx) => {
        const current = await this.lock(tx, requestId);
        this.refuseExecutor(current, actor.userId, authenticatedAt);
        const status = current.status as WithdrawalStatus;
        if (status === WithdrawalStatus.FAILED) {
          return { view: await this.view(tx, requestId, actor), failed: false };
        }
        if (status !== WithdrawalStatus.PROCESSING)
          throw transitionInvalid(status, 'marked failed');
        if (current.version !== input.expectedVersion) throw staleVersion(current.version);
        const now = this.clock.now();
        await tx.withdrawalExecutionAttempt.updateMany({
          where: { requestId, outcome: WithdrawalAttemptOutcome.IN_PROGRESS },
          data: {
            outcome: WithdrawalAttemptOutcome.FAILED,
            finishedAt: now,
            finishedByUserId: actor.userId,
            externalReference: reference,
            note,
          },
        });
        await tx.withdrawalRequest.update({
          where: { id: requestId },
          data: { status: WithdrawalStatus.FAILED, version: current.version + 1, updatedAt: now },
        });
        const historyId = await this.history(
          tx,
          current,
          WithdrawalEventType.FAILED,
          actor.userId,
          note,
        );
        await this.domainEvents.emitWithdrawal(tx, historyId);
        return { view: await this.view(tx, requestId, actor), failed: true };
      },
    );
    if (failed) await this.audit('WITHDRAWAL_FAILED', actor.userId, requestId, context);
    return view;
  }

  /**
   * Decide not to pay an approved or failed request, with a stated reason,
   * and release its reservation. Never automatic (D9).
   */
  async release(
    actor: FinanceActor,
    requestId: string,
    input: { readonly expectedVersion: number; readonly note: string },
    context: RequestContext,
  ): Promise<AdminWithdrawalRequestView> {
    const note = boundedText(input.note, WITHDRAWAL_LIMITS.releaseNote, 'note');
    if (note === null) throw invalid('note', 'Give the reason for releasing this withdrawal.');

    const { view, released } = await this.finance(actor, 'release a withdrawal', async (tx) => {
      const current = await this.lock(tx, requestId);
      this.refuseOwnRequest(current, actor.userId, 'release');
      const status = current.status as WithdrawalStatus;
      if (status === WithdrawalStatus.CANCELLED && current.cancelledByUserId === actor.userId) {
        return { view: await this.view(tx, requestId, actor), released: false };
      }
      if (status !== WithdrawalStatus.APPROVED && status !== WithdrawalStatus.FAILED) {
        throw isDecided(status) ? alreadyDecided(status) : transitionInvalid(status, 'released');
      }
      if (current.version !== input.expectedVersion) throw staleVersion(current.version);

      await this.requests.releaseReservation(tx, current);
      const now = this.clock.now();
      await tx.withdrawalRequest.update({
        where: { id: requestId },
        data: {
          status: WithdrawalStatus.CANCELLED,
          cancelledAt: now,
          cancelledByUserId: actor.userId,
          releaseNote: note,
          version: current.version + 1,
          updatedAt: now,
        },
      });
      await this.history(tx, current, WithdrawalEventType.CANCELLED, actor.userId, note);
      await this.history(tx, current, WithdrawalEventType.RESERVATION_RELEASED, actor.userId);
      return { view: await this.view(tx, requestId, actor), released: true };
    });
    if (released) {
      await this.audit('WITHDRAWAL_CANCELLED', actor.userId, requestId, context, { by: 'FINANCE' });
      await this.audit('WITHDRAWAL_RESERVATION_RELEASED', actor.userId, requestId, context, {
        by: 'FINANCE',
      });
    }
    return view;
  }

  // -------------------------------------------------------------------------
  // Proof of payout
  // -------------------------------------------------------------------------

  async createProofUpload(
    actor: FinanceActor,
    requestId: string,
    input: {
      readonly originalFilename: string;
      readonly declaredMimeType?: string | undefined;
      readonly sizeBytes: number;
      readonly sha256?: string | undefined;
    },
    idempotencyKey: string | undefined,
    context: RequestContext,
  ): Promise<WithdrawalProofUploadResponse> {
    const upload = this.files.validate(
      input,
      RECEIPT_FORMATS,
      RECEIPT_MAX_BYTES,
      'A payout proof must be a PDF, PNG, JPEG or WebP file.',
    );
    const proof = await this.finance(actor, 'attach a withdrawal payout proof', async (tx) => {
      if (idempotencyKey !== undefined) {
        const existing = await tx.withdrawalProof.findFirst({
          where: { uploadedByUserId: actor.userId, idempotencyKey, requestId },
        });
        if (existing !== null) return existing;
      }
      const current = await this.lock(tx, requestId);
      if (!PROOF_STATES.includes(current.status as WithdrawalStatus)) {
        throw transitionInvalid(current.status as WithdrawalStatus, 'given a payout proof');
      }
      const proofId = randomUUID();
      return tx.withdrawalProof.create({
        data: {
          id: proofId,
          requestId,
          requesterUserId: current.requesterUserId,
          organizationId: current.organizationId,
          uploadedByUserId: actor.userId,
          originalFilename: upload.originalFilename,
          declaredMimeType: upload.declaredMimeType,
          expectedFormat: upload.expectedFormat,
          declaredSizeBytes: upload.sizeBytes,
          maxFileBytes: RECEIPT_MAX_BYTES,
          clientSha256: upload.clientSha256,
          quarantineObjectKey: quarantineWithdrawalProofKey({ requestId, proofId }),
          idempotencyKey: idempotencyKey ?? null,
          uploadExpiresAt: upload.uploadExpiresAt,
        },
      });
    });
    if (proof.status !== ManualTopUpFileStatus.AWAITING_UPLOAD) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'This proof has already been uploaded.',
      });
    }
    await this.audit('WITHDRAWAL_PROOF_UPLOAD_STARTED', actor.userId, requestId, context, {
      proofId: proof.id,
    });
    return { proof: proofView(proof), upload: await this.files.authorizeUpload(proof) };
  }

  async reauthorizeProof(
    actor: FinanceActor,
    requestId: string,
    proofId: string,
  ): Promise<ManualTopUpUploadAuthorizationView> {
    const proof = await this.finance(actor, 'reauthorize a withdrawal proof upload', (tx) =>
      this.proofOf(tx, requestId, proofId),
    );
    if (proof.status !== ManualTopUpFileStatus.AWAITING_UPLOAD) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'This proof has already been uploaded.',
      });
    }
    return this.files.authorizeUpload(proof);
  }

  /** Pin the uploaded proof and queue its scan. */
  async finalizeProof(
    actor: FinanceActor,
    requestId: string,
    proofId: string,
    context: RequestContext,
  ): Promise<AdminWithdrawalRequestView> {
    const proof = await this.finance(actor, 'finalize a withdrawal proof upload', (tx) =>
      this.proofOf(tx, requestId, proofId),
    );
    if (proof.status !== ManualTopUpFileStatus.AWAITING_UPLOAD) return this.get(actor, requestId);
    if (proof.uploadedByUserId !== actor.userId) {
      throw new AppError(PalCertErrorCode.FORBIDDEN, {
        message: 'Only the person who started this upload can finish it.',
      });
    }

    let staged: { versionId: string | null; etag: string | null };
    try {
      staged = await this.files.staged(proof);
    } catch (error) {
      if (error instanceof AppError && error.code === PalCertErrorCode.UPLOAD_SESSION_EXPIRED) {
        await this.finance(actor, 'expire a withdrawal proof upload', (tx) =>
          tx.withdrawalProof.updateMany({
            where: { id: proofId, status: ManualTopUpFileStatus.AWAITING_UPLOAD },
            data: { status: ManualTopUpFileStatus.UPLOAD_EXPIRED, updatedAt: this.clock.now() },
          }),
        );
      }
      throw error;
    }

    const now = this.clock.now();
    const job = await this.finance(actor, 'queue a withdrawal proof scan', async (tx) => {
      const current = await this.lock(tx, requestId);
      const claimed = await tx.withdrawalProof.updateMany({
        where: { id: proofId, status: ManualTopUpFileStatus.AWAITING_UPLOAD },
        data: {
          status: ManualTopUpFileStatus.UPLOADED,
          uploadedAt: now,
          quarantineObjectVersionId: staged.versionId,
          quarantineObjectEtag: staged.etag,
          updatedAt: now,
        },
      });
      if (claimed.count !== 1) return null;
      await this.history(tx, current, WithdrawalEventType.PROOF_ATTACHED, actor.userId);
      return this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.WITHDRAWAL_PROOF_INGEST,
        resourceType: 'WITHDRAWAL_PROOF',
        resourceId: proofId,
        ownerUserId: actor.userId,
      });
    });
    if (job !== null) {
      await this.dispatcher.dispatchNow(job.id);
      await this.audit('WITHDRAWAL_PROOF_UPLOADED', actor.userId, requestId, context, { proofId });
    }
    return this.get(actor, requestId);
  }

  /** A proof, inline, by a short-lived signed URL. Every viewing is recorded. */
  async proofDownload(
    actor: FinanceActor,
    requestId: string,
    context: RequestContext,
  ): Promise<DownloadAuthorizationView> {
    const proof = await this.finance(actor, 'view a withdrawal payout proof', (tx) =>
      readyProofOf(tx, requestId),
    );
    const grant = await this.files.download(proof, 'inline');
    await this.audit('WITHDRAWAL_PROOF_VIEWED', actor.userId, requestId, context, {
      proofId: proof.id,
    });
    return grant;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private finance<T>(
    actor: FinanceActor,
    reason: string,
    work: (tx: TenantClient) => Promise<T>,
  ): Promise<T> {
    return this.tenant.withPlatformAdmin({ actorUserId: actor.userId, reason }, work);
  }

  /** Lock the request row. Concurrent decisions serialize here. */
  private async lock(tx: TenantClient, requestId: string): Promise<Row> {
    await tx.$queryRaw`SELECT "id" FROM "withdrawal_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
    const row = await tx.withdrawalRequest.findUnique({ where: { id: requestId } });
    if (row === null || row.status === WithdrawalStatus.DRAFT) throw withdrawalNotFound();
    return row;
  }

  /** Nobody reviews, approves, rejects or releases their own request (D8). */
  private refuseOwnRequest(row: Row, actorUserId: string, verb: string): void {
    if (row.requesterUserId === actorUserId) {
      throw separationOfDuties(`You cannot ${verb} a withdrawal you requested yourself.`);
    }
  }

  /**
   * Who may record a payout (D8): never the requester; for PalCert's money,
   * never the approver either; and when one finance user approved a user's
   * or organization's payout and now executes it, only after re-authenticating
   * since the approval.
   */
  private refuseExecutor(row: Row, actorUserId: string, authenticatedAt: Date | null): void {
    if (row.requesterUserId === actorUserId) {
      throw separationOfDuties('You cannot pay out a withdrawal you requested yourself.');
    }
    if (row.approvedByUserId !== actorUserId) return;
    if (row.scope === WithdrawalScope.PLATFORM) {
      throw separationOfDuties(
        'A PalCert payout must be executed by somebody other than the person who approved it.',
      );
    }
    if (authenticatedAt === null || row.approvedAt === null || authenticatedAt <= row.approvedAt) {
      throw new AppError(PalCertErrorCode.REAUTHENTICATION_REQUIRED, {
        message:
          'You approved this withdrawal. Confirm your password again before recording its payout.',
      });
    }
  }

  /** When this session last proved who is using it. */
  private async authenticatedAt(sessionId: string): Promise<Date | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { mfaCompletedAt: true, createdAt: true },
    });
    return session === null ? null : (session.mfaCompletedAt ?? session.createdAt);
  }

  private confirm(row: Row, confirmed: bigint, currency: string): void {
    if (confirmed !== row.amountMinor || currency !== row.currency) {
      throw new AppError(PalCertErrorCode.WITHDRAWAL_CONFIRMATION_REQUIRED, {
        message: 'Confirm the exact amount and currency of this withdrawal.',
      });
    }
  }

  /** The money the request holds must still be held, as its scope holds it. */
  private async requireLiveReservation(tx: TenantClient, row: Row): Promise<void> {
    if (!(await this.reservationActive(tx, row))) throw this.reservationMissing(row.id);
  }

  private async reservationActive(tx: TenantClient, row: Row): Promise<boolean> {
    if (row.holdId !== null) {
      const hold = await tx.creditHold.findUnique({
        where: { id: row.holdId },
        select: { status: true },
      });
      return hold?.status === CreditHoldStatus.ACTIVE;
    }
    if (row.reservationId !== null) {
      const reservation = await tx.withdrawalReservation.findUnique({
        where: { id: row.reservationId },
        select: { status: true },
      });
      return reservation?.status === WithdrawalReservationStatus.ACTIVE;
    }
    return false;
  }

  private reservationMissing(requestId: string): AppError {
    return new AppError(PalCertErrorCode.INTERNAL_ERROR, {
      message: 'An unexpected error occurred.',
      internalContext: { reason: 'withdrawal reservation is not active', requestId },
    });
  }

  private async proofOf(
    tx: TenantClient,
    requestId: string,
    proofId: string,
  ): Promise<WithdrawalProof> {
    const proof = await tx.withdrawalProof.findFirst({ where: { id: proofId, requestId } });
    if (proof === null) {
      throw new AppError(PalCertErrorCode.WITHDRAWAL_PROOF_NOT_FOUND, {
        message: 'That payout proof could not be found.',
      });
    }
    return proof;
  }

  private async view(
    tx: TenantClient,
    requestId: string,
    actor: FinanceActor,
  ): Promise<AdminWithdrawalRequestView> {
    const row: RequestRow | null = await tx.withdrawalRequest.findUnique({
      where: { id: requestId },
      include: REQUEST_INCLUDE,
    });
    if (row === null || row.status === WithdrawalStatus.DRAFT) throw withdrawalNotFound();
    const attempts = await tx.withdrawalExecutionAttempt.findMany({
      where: { requestId },
      orderBy: { attemptNumber: 'asc' },
    });
    const people = await this.people(tx, [
      row.requesterUserId,
      ...(row.events ?? []).map((event) => event.actorUserId),
      ...attempts.flatMap((attempt) => [attempt.startedByUserId, attempt.finishedByUserId]),
    ]);
    const orgs = await this.organizations(tx, [row.organizationId]);
    const base = requestView(row, {
      organizationName: row.organizationId === null ? null : (orgs.get(row.organizationId) ?? null),
      names: people,
    });
    const requester = people.get(row.requesterUserId);
    const reservationActive = await this.reservationActive(tx, row);
    return {
      ...base,
      // Finance sees every note, its own included.
      events: (row.events ?? []).map((event) => eventView(event, people, true)),
      requesterUserId: row.requesterUserId,
      requesterDisplayName: requester?.displayName ?? null,
      requesterEmail: requester?.email ?? '',
      beneficiaryUserId: row.beneficiaryUserId,
      availableBeforeRequest: money(row.currency, row.availableBeforeMinor ?? 0n),
      reviewStartedAt: row.reviewStartedAt?.toISOString() ?? null,
      reviewedByUserId: row.reviewedByUserId,
      approvedByUserId: row.approvedByUserId,
      rejectedByUserId: row.rejectedByUserId,
      executedByUserId: row.executedByUserId,
      releaseNote: row.releaseNote,
      attempts: attempts.map((attempt): WithdrawalAttemptView => ({
        attemptNumber: attempt.attemptNumber,
        outcome: attempt.outcome as WithdrawalAttemptOutcome,
        startedByDisplayName: people.get(attempt.startedByUserId)?.displayName ?? null,
        startedAt: attempt.startedAt.toISOString(),
        finishedByDisplayName:
          attempt.finishedByUserId === null
            ? null
            : (people.get(attempt.finishedByUserId)?.displayName ?? null),
        finishedAt: attempt.finishedAt?.toISOString() ?? null,
        externalReference: attempt.externalReference,
        note: attempt.note,
      })),
      reservationActive,
      allowedActions: allowedActions(row, actor),
    };
  }

  private async people(
    tx: TenantClient,
    ids: readonly (string | null)[],
  ): Promise<Map<string, { email: string; displayName: string | null }>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    if (unique.length === 0) return new Map();
    const users = await tx.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, email: true, displayName: true },
    });
    return new Map(
      users.map((user) => [user.id, { email: user.email, displayName: user.displayName }]),
    );
  }

  private async organizations(
    tx: TenantClient,
    ids: readonly (string | null)[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    if (unique.length === 0) return new Map();
    const rows = await tx.organization.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    });
    return new Map(rows.map((row) => [row.id, row.displayName]));
  }

  private async history(
    tx: TenantClient,
    row: Row,
    eventType: WithdrawalEventType,
    actorUserId: string,
    note: string | null = null,
  ): Promise<string> {
    const created = await tx.withdrawalRequestEvent.create({
      data: {
        requestId: row.id,
        requesterUserId: row.requesterUserId,
        organizationId: row.organizationId,
        eventType,
        actorSide: WithdrawalActorSide.FINANCE,
        actorUserId,
        note,
      },
      select: { id: true },
    });
    return created.id;
  }

  private async audit(
    action: string,
    actorUserId: string,
    requestId: string,
    context: RequestContext,
    afterState: Record<string, unknown> | null = null,
  ): Promise<void> {
    await this.events.audit({
      action,
      actorUserId,
      targetType: 'WithdrawalRequest',
      targetId: requestId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      afterState,
    });
  }
}

function isDecided(status: WithdrawalStatus): boolean {
  return status !== WithdrawalStatus.DRAFT && status !== WithdrawalStatus.PENDING_REVIEW;
}

function parseOrNegative(value: string): bigint {
  try {
    return parseMinorUnits(value);
  } catch {
    return -1n;
  }
}

/**
 * What this finance user may do next — the same rules the service enforces,
 * so the page never offers a button the server will refuse. The re-auth
 * condition for an approver who executes is left to the server: it depends on
 * the moment of the click, not on what is drawn.
 */
export function allowedActions(row: RequestRow, actor: FinanceActor): WithdrawalAction[] {
  const status = row.status as WithdrawalStatus;
  const has = (permission: string) => actor.permissions.has(permission);
  const own = row.requesterUserId === actor.userId;
  if (own) return [];
  const actions: WithdrawalAction[] = [];
  const canExecute =
    has(Permission.FINANCE_WITHDRAWAL_EXECUTE) &&
    !(row.scope === WithdrawalScope.PLATFORM && row.approvedByUserId === actor.userId);

  if (status === WithdrawalStatus.PENDING_REVIEW) {
    if (row.reviewStartedAt === null && has(Permission.FINANCE_WITHDRAWAL_REVIEW)) {
      actions.push(WithdrawalAction.START_REVIEW);
    }
    if (has(Permission.FINANCE_WITHDRAWAL_APPROVE)) actions.push(WithdrawalAction.APPROVE);
    if (has(Permission.FINANCE_WITHDRAWAL_REVIEW)) actions.push(WithdrawalAction.REJECT);
  }
  if (status === WithdrawalStatus.APPROVED) {
    if (canExecute) actions.push(WithdrawalAction.START_EXECUTION);
    if (has(Permission.FINANCE_WITHDRAWAL_APPROVE)) actions.push(WithdrawalAction.RELEASE);
  }
  if (status === WithdrawalStatus.PROCESSING && canExecute) {
    actions.push(WithdrawalAction.MARK_PAID, WithdrawalAction.MARK_FAILED);
  }
  if (status === WithdrawalStatus.FAILED) {
    if (canExecute) actions.push(WithdrawalAction.RETRY);
    if (has(Permission.FINANCE_WITHDRAWAL_APPROVE)) actions.push(WithdrawalAction.RELEASE);
  }
  return actions;
}
