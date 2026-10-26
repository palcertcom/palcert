import { Injectable } from '@nestjs/common';
import {
  AppError,
  CreditClass,
  LedgerEntryType,
  LedgerReasonCode,
  LedgerReferenceType,
  MANUAL_TOPUP_LIMITS,
  MANUAL_TOPUP_REJECTION_REASONS,
  ManualTopUpActorSide,
  ManualTopUpEventType,
  ManualTopUpRejectionReason,
  ManualTopUpStatus,
  PalCertErrorCode,
  money,
  parseMinorUnits,
  ManualTopUpReviewerRouting,
  maskEmailAddress,
  type AdminManualTopUpQueueView,
  type AdminManualTopUpRequestView,
  type DownloadAuthorizationView,
  type ManualTopUpNotificationReportView,
} from '@palcert/contracts';
import type { Prisma } from '@palcert/database';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { CreditLedgerService } from '../../finance/services/credit-ledger.service';
import { DomainEventService } from '../../notifications/services/domain-event.service';
import { ManualTopUpFiles } from '../manual-topup-files';
import {
  REQUEST_INCLUDE,
  alreadyDecided,
  clampLimit,
  cleanText,
  eventView,
  ownerRequestView,
  requestNotFound,
  transitionInvalid,
  type RequestContext,
  type RequestRow,
} from '../manual-topup-support';

const DECIDED: readonly ManualTopUpStatus[] = [
  ManualTopUpStatus.APPROVED,
  ManualTopUpStatus.REJECTED,
  ManualTopUpStatus.CANCELLED,
];

/** The audit actions the fan-out records when it routes a submission alert. */
const REVIEWER_ROUTING_ACTIONS = [
  'MANUAL_TOPUP_REVIEWERS_RESOLVED',
  'MANUAL_TOPUP_REVIEWER_FALLBACK',
  'MANUAL_TOPUP_NO_REVIEWER_AVAILABLE',
] as const;

/** The queue a reviewer works from. Drafts are a person's private work and never appear. */
export interface QueueFilter {
  readonly status?: ManualTopUpStatus | undefined;
  readonly paymentMethodId?: string | undefined;
  readonly currency?: string | undefined;
  /** A transfer reference, matched in its normalized form. */
  readonly reference?: string | undefined;
  readonly ownerUserId?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/**
 * PalCert finance's side of a manual top-up: read, open, approve, reject.
 *
 * Approval is the only act in PalCert that turns a reported transfer into
 * credit, and it does so in one transaction that locks the request, proves
 * it is still undecided and uncredited, appends exactly one CASH ledger
 * entry under an idempotency key derived from the request, and records the
 * decision. Two reviewers deciding at once produce one decision: the second
 * finds the row decided under its lock and is told so. A unique index on the
 * ledger makes a second credit impossible even for a caller that bypassed
 * all of this.
 *
 * Every path runs through the audited platform elevation, and nobody may
 * decide a top-up they reported themselves.
 */
@Injectable()
export class ManualTopUpReviewService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly ledger: CreditLedgerService,
    private readonly files: ManualTopUpFiles,
    private readonly domainEvents: DomainEventService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  async queue(actorUserId: string, filter: QueueFilter): Promise<AdminManualTopUpQueueView> {
    const limit = clampLimit(filter.limit, 25);
    const reference =
      filter.reference === undefined
        ? undefined
        : filter.reference
            .normalize('NFKC')
            .toUpperCase()
            .replace(/[\s\-._/\\]+/g, '');

    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read the manual top-up review queue' },
      async (tx) => {
        const where: Prisma.ManualTopUpRequestWhereInput = {
          status:
            filter.status === undefined
              ? { not: ManualTopUpStatus.DRAFT }
              : filter.status === ManualTopUpStatus.DRAFT
                ? { in: [] }
                : filter.status,
          ...(filter.paymentMethodId === undefined
            ? {}
            : { paymentMethodId: filter.paymentMethodId }),
          ...(filter.currency === undefined ? {} : { currency: filter.currency }),
          ...(reference === undefined || reference.length === 0
            ? {}
            : { referenceNormalized: { contains: reference } }),
          ...(filter.ownerUserId === undefined ? {} : { ownerUserId: filter.ownerUserId }),
        };

        const rows = await tx.manualTopUpRequest.findMany({
          where,
          // Oldest waiting first, so nobody's transfer sits at the bottom.
          orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
          take: limit + 1,
          ...(filter.cursor === undefined ? {} : { cursor: { id: filter.cursor }, skip: 1 }),
          include: { receipt: { select: { id: true } } },
        });
        const page = rows.slice(0, limit);
        const owners = await this.owners(
          tx,
          page.map((row) => row.ownerUserId),
        );

        // Pending money per currency. Never summed across currencies: a total
        // of shekels and dollars is not a number anybody can act on.
        const totals = await tx.manualTopUpRequest.groupBy({
          by: ['currency'],
          where: { status: ManualTopUpStatus.PENDING_REVIEW },
          _sum: { amountMinor: true },
          _count: { _all: true },
          orderBy: { currency: 'asc' },
        });

        return {
          items: page.map((row) => {
            const snapshot = row.paymentMethodSnapshot as {
              code?: string;
              nameEn?: string;
              nameAr?: string;
            };
            const owner = owners.get(row.ownerUserId);
            return {
              id: row.id,
              status: row.status as ManualTopUpStatus,
              amount: money(row.currency, row.amountMinor ?? 0n),
              reference: row.referenceOriginal,
              paymentMethodCode: snapshot.code ?? '',
              paymentMethodNameEn: snapshot.nameEn ?? '',
              paymentMethodNameAr: snapshot.nameAr ?? '',
              ownerUserId: row.ownerUserId,
              ownerDisplayName: owner?.displayName ?? null,
              ownerEmail: owner?.email ?? '',
              hasReceipt: row.receipt !== null,
              submittedAt: row.submittedAt?.toISOString() ?? null,
              reviewStartedAt: row.reviewStartedAt?.toISOString() ?? null,
              decidedAt: row.decidedAt?.toISOString() ?? null,
            };
          }),
          nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
          pendingTotals: totals.map((total) => ({
            currency: total.currency,
            count: total._count._all,
            total: money(total.currency, total._sum.amountMinor ?? 0n),
          })),
        };
      },
    );
  }

  async get(actorUserId: string, requestId: string): Promise<AdminManualTopUpRequestView> {
    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read a manual top-up request' },
      (tx) => this.view(tx, requestId),
    );
  }

  /**
   * "No email arrived", answered for one request: who its submission alert
   * was created for, what happened to the in-app copy and the email, why an
   * email was skipped, how the recipients were chosen, and which assigned
   * reviewers could not be alerted. Statuses and masked addresses only —
   * never a provider secret, a message body or the receipt.
   */
  async notificationReport(
    actorUserId: string,
    requestId: string,
  ): Promise<ManualTopUpNotificationReportView> {
    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read a manual top-up notification report' },
      async (tx) => {
        const request = await tx.manualTopUpRequest.findUnique({
          where: { id: requestId },
          select: { id: true, status: true, paymentMethodId: true },
        });
        // A draft is the owner's private work; finance never sees one.
        if (request === null || request.status === ManualTopUpStatus.DRAFT) {
          throw requestNotFound();
        }

        const rows = await tx.$queryRaw<
          Array<{
            recipient_user_id: string;
            display_name: string | null;
            email: string;
            email_verified: boolean;
            account_status: string;
            notified_at: Date;
            read_at: Date | null;
            in_app_status: string | null;
            email_status: string | null;
            email_skip_reason: string | null;
            email_attempts: number | null;
            email_error_code: string | null;
            email_updated_at: Date | null;
          }>
        >`SELECT * FROM app_manual_topup_notification_report(${requestId}::uuid)`;

        const assigned = await tx.$queryRaw<
          Array<{
            user_id: string;
            display_name: string | null;
            email: string;
            email_verified: boolean;
            eligible: boolean;
            created_at: Date;
          }>
        >`
          SELECT mr."user_id", u."display_name", u."email",
                 (u."email_verified_at" IS NOT NULL) AS "email_verified",
                 app_notification_is_platform_reviewer(
                   mr."user_id", 'finance:manual-topup:review') AS "eligible",
                 mr."created_at"
            FROM "manual_payment_method_reviewers" mr
            JOIN "users" u ON u."id" = mr."user_id"
           WHERE mr."payment_method_id" = ${request.paymentMethodId}::uuid
           ORDER BY lower(coalesce(u."display_name", u."email")), mr."user_id"`;

        const recorded = await tx.auditEvent.findFirst({
          where: {
            targetType: 'ManualTopUpRequest',
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
        const routing = (Object.values(ManualTopUpReviewerRouting) as unknown[]).includes(
          routingValue,
        )
          ? (routingValue as ManualTopUpReviewerRouting)
          : null;

        const assignedIds = new Set(assigned.map((row) => row.user_id));
        const notifiedIds = new Set(rows.map((row) => row.recipient_user_id));
        return {
          routing,
          noReviewerAvailable: recorded?.action === 'MANUAL_TOPUP_NO_REVIEWER_AVAILABLE',
          recipients: rows.map((row) => ({
            userId: row.recipient_user_id,
            displayName: row.display_name,
            emailMasked: maskEmailAddress(row.email),
            emailVerified: row.email_verified,
            accountStatus: row.account_status,
            assigned: assignedIds.has(row.recipient_user_id),
            notifiedAt: row.notified_at.toISOString(),
            readAt: row.read_at?.toISOString() ?? null,
            inAppStatus: row.in_app_status,
            emailStatus: row.email_status,
            emailSkipReason: row.email_skip_reason,
            emailAttempts: row.email_attempts,
            emailErrorCode: row.email_error_code,
            emailUpdatedAt: row.email_updated_at?.toISOString() ?? null,
          })),
          assignedReviewers: assigned.map((row) => ({
            userId: row.user_id,
            displayName: row.display_name,
            emailMasked: maskEmailAddress(row.email),
            emailVerified: row.email_verified,
            eligible: row.eligible,
            assignedAt: row.created_at.toISOString(),
            notified: notifiedIds.has(row.user_id),
          })),
        };
      },
    );
  }

  /** Open a request for review. From here on its owner can no longer cancel it. */
  async startReview(
    actorUserId: string,
    requestId: string,
    context: RequestContext,
  ): Promise<AdminManualTopUpRequestView> {
    const { view, started } = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'start reviewing a manual top-up' },
      async (tx) => {
        const current = await this.lock(tx, requestId);
        this.refuseOwnRequest(current.ownerUserId, actorUserId);
        if (current.status !== ManualTopUpStatus.PENDING_REVIEW) {
          throw DECIDED.includes(current.status as ManualTopUpStatus)
            ? alreadyDecided(current.status as ManualTopUpStatus)
            : transitionInvalid(current.status as ManualTopUpStatus, 'reviewed');
        }
        // Idempotent, and the first reviewer to open it stays on record.
        if (current.reviewStartedAt !== null) {
          return { view: await this.view(tx, requestId), started: false };
        }
        const now = this.clock.now();
        await tx.manualTopUpRequest.update({
          where: { id: requestId },
          data: { reviewStartedAt: now, reviewStartedByUserId: actorUserId, updatedAt: now },
        });
        await this.history(
          tx,
          current.id,
          current.ownerUserId,
          ManualTopUpEventType.REVIEW_STARTED,
          actorUserId,
        );
        return { view: await this.view(tx, requestId), started: true };
      },
    );
    if (started) {
      await this.events.audit({
        action: 'MANUAL_TOPUP_REVIEW_STARTED',
        actorUserId,
        targetType: 'ManualTopUpRequest',
        targetId: requestId,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
      });
    }
    return view;
  }

  /**
   * Approve, crediting the customer's CASH balance by exactly the reported
   * amount. The reviewer restates the amount and currency as confirmation;
   * they cannot change it — a transfer that does not match is rejected with
   * AMOUNT_MISMATCH, and the person reports what they actually sent.
   */
  async approve(
    actorUserId: string,
    requestId: string,
    input: { readonly confirmAmountMinorUnits: string; readonly confirmCurrency: string },
    context: RequestContext,
  ): Promise<AdminManualTopUpRequestView> {
    let confirmed: bigint;
    try {
      confirmed = parseMinorUnits(input.confirmAmountMinorUnits);
    } catch {
      confirmed = -1n;
    }

    const result = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'approve a manual top-up' },
      async (tx) => {
        const current = await this.lock(tx, requestId);
        this.refuseOwnRequest(current.ownerUserId, actorUserId);

        if (
          current.status === ManualTopUpStatus.APPROVED &&
          current.approvedByUserId === actorUserId
        ) {
          // The same reviewer's retried approval: one credit, one answer.
          return {
            view: await this.view(tx, requestId),
            approved: false,
            entryId: current.creditEntryId,
          };
        }
        if (DECIDED.includes(current.status as ManualTopUpStatus)) {
          throw alreadyDecided(current.status as ManualTopUpStatus);
        }
        if (current.status !== ManualTopUpStatus.PENDING_REVIEW || current.creditEntryId !== null) {
          throw transitionInvalid(current.status as ManualTopUpStatus, 'approved');
        }
        if (
          current.amountMinor === null ||
          confirmed !== current.amountMinor ||
          input.confirmCurrency !== current.currency
        ) {
          throw new AppError(PalCertErrorCode.MANUAL_TOPUP_CONFIRMATION_REQUIRED, {
            message:
              'Confirm the exact amount and currency being credited. If the transfer you received ' +
              'differs, reject the request with “amount mismatch” instead.',
          });
        }

        const now = this.clock.now();
        const account = await this.ledger.accountFor(tx, {
          ownerUserId: current.ownerUserId,
          currency: current.currency,
          creditClass: CreditClass.CASH,
        });
        const entry = await this.ledger.append(tx, {
          ownerUserId: current.ownerUserId,
          accountId: account.id,
          currency: current.currency,
          creditClass: CreditClass.CASH,
          entryType: LedgerEntryType.MANUAL_TOPUP_CREDIT,
          amountMinorSigned: current.amountMinor,
          referenceType: LedgerReferenceType.MANUAL_TOPUP_REQUEST,
          referenceId: current.id,
          reasonCode: LedgerReasonCode.MANUAL_TOPUP_APPROVED,
          idempotencyKey: `manual-topup:${current.id}:credit`,
          createdByUserId: actorUserId,
        });

        await tx.manualTopUpRequest.update({
          where: { id: requestId },
          data: {
            status: ManualTopUpStatus.APPROVED,
            decidedAt: now,
            approvedByUserId: actorUserId,
            creditEntryId: entry.id,
            ...(current.reviewStartedAt === null
              ? { reviewStartedAt: now, reviewStartedByUserId: actorUserId }
              : {}),
            updatedAt: now,
          },
        });
        const historyId = await this.history(
          tx,
          current.id,
          current.ownerUserId,
          ManualTopUpEventType.APPROVED,
          actorUserId,
        );
        await this.domainEvents.emitManualTopUp(tx, historyId);

        // Inside the transaction: an approval whose record failed to write is
        // an approval that did not happen.
        await this.events.auditWithin(tx, {
          action: 'MANUAL_TOPUP_APPROVED',
          actorUserId,
          targetType: 'ManualTopUpRequest',
          targetId: requestId,
          requestId: context.requestId,
          ipAddress: context.ipAddress,
          afterState: {
            ownerUserId: current.ownerUserId,
            currency: current.currency,
            amountMinor: current.amountMinor.toString(),
            ledgerEntryId: entry.id,
          },
        });
        return { view: await this.view(tx, requestId), approved: true, entryId: entry.id };
      },
    );

    if (result.approved) {
      await this.events.audit({
        action: 'MANUAL_TOPUP_CREDIT_CREATED',
        actorUserId,
        targetType: 'CreditLedgerEntry',
        targetId: result.entryId,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: { manualTopUpRequestId: requestId },
      });
    }
    return result.view;
  }

  /** Decline, with a reason the person is told. Moves no money. */
  async reject(
    actorUserId: string,
    requestId: string,
    input: { readonly reason: string; readonly note?: string | null | undefined },
    context: RequestContext,
  ): Promise<AdminManualTopUpRequestView> {
    if (!(MANUAL_TOPUP_REJECTION_REASONS as readonly string[]).includes(input.reason)) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'Choose a reason for rejecting this top-up.',
        details: { field: 'reason' },
      });
    }
    const reason = input.reason as ManualTopUpRejectionReason;
    const note = cleanText(input.note ?? null);
    if (note !== null && note.length > MANUAL_TOPUP_LIMITS.rejectionNote) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: `A note may be at most ${MANUAL_TOPUP_LIMITS.rejectionNote} characters.`,
        details: { field: 'note' },
      });
    }
    if (reason === ManualTopUpRejectionReason.OTHER && note === null) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'Explain the reason when you choose “other”.',
        details: { field: 'note' },
      });
    }

    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'reject a manual top-up' },
      async (tx) => {
        const current = await this.lock(tx, requestId);
        this.refuseOwnRequest(current.ownerUserId, actorUserId);

        if (
          current.status === ManualTopUpStatus.REJECTED &&
          current.rejectedByUserId === actorUserId
        ) {
          return this.view(tx, requestId);
        }
        if (DECIDED.includes(current.status as ManualTopUpStatus)) {
          throw alreadyDecided(current.status as ManualTopUpStatus);
        }
        if (current.status !== ManualTopUpStatus.PENDING_REVIEW) {
          throw transitionInvalid(current.status as ManualTopUpStatus, 'rejected');
        }

        const now = this.clock.now();
        await tx.manualTopUpRequest.update({
          where: { id: requestId },
          data: {
            status: ManualTopUpStatus.REJECTED,
            decidedAt: now,
            rejectedByUserId: actorUserId,
            rejectionReason: reason,
            rejectionNote: note,
            ...(current.reviewStartedAt === null
              ? { reviewStartedAt: now, reviewStartedByUserId: actorUserId }
              : {}),
            updatedAt: now,
          },
        });
        const historyId = await this.history(
          tx,
          current.id,
          current.ownerUserId,
          ManualTopUpEventType.REJECTED,
          actorUserId,
        );
        await this.domainEvents.emitManualTopUp(tx, historyId);
        await this.events.auditWithin(tx, {
          action: 'MANUAL_TOPUP_REJECTED',
          actorUserId,
          targetType: 'ManualTopUpRequest',
          targetId: requestId,
          requestId: context.requestId,
          ipAddress: context.ipAddress,
          afterState: { reason },
        });
        return this.view(tx, requestId);
      },
    );
  }

  /**
   * The receipt, inline, by a short-lived signed URL — and every viewing is
   * recorded, because a receipt can carry a person's bank details.
   */
  async receiptDownload(
    actorUserId: string,
    requestId: string,
    context: RequestContext,
  ): Promise<DownloadAuthorizationView> {
    const receipt = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'view a manual top-up receipt' },
      async (tx) => {
        const request = await tx.manualTopUpRequest.findUnique({
          where: { id: requestId },
          include: { receipt: true },
        });
        if (request === null || request.status === ManualTopUpStatus.DRAFT) throw requestNotFound();
        if (request.receipt === null) {
          throw new AppError(PalCertErrorCode.MANUAL_TOPUP_FILE_NOT_FOUND, {
            message: 'This top-up has no receipt.',
          });
        }
        return request.receipt;
      },
    );
    const grant = await this.files.download(receipt, 'inline');
    await this.events.audit({
      action: 'MANUAL_TOPUP_RECEIPT_VIEWED',
      actorUserId,
      targetType: 'ManualTopUpReceipt',
      targetId: receipt.id,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      afterState: { manualTopUpRequestId: requestId },
    });
    return grant;
  }

  // -------------------------------------------------------------------------

  /** Separation of duties: a person cannot verify their own payment. */
  private refuseOwnRequest(ownerUserId: string, actorUserId: string): void {
    if (ownerUserId === actorUserId) {
      throw new AppError(PalCertErrorCode.FORBIDDEN, {
        message: 'You cannot review a top-up you reported yourself.',
      });
    }
  }

  /** Lock the request row. Concurrent decisions serialize here. */
  private async lock(tx: TenantClient, requestId: string) {
    await tx.$queryRaw`SELECT "id" FROM "manual_topup_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
    const row = await tx.manualTopUpRequest.findUnique({ where: { id: requestId } });
    // A draft is the person's private work, not yet anything finance can see.
    if (row === null || row.status === ManualTopUpStatus.DRAFT) throw requestNotFound();
    return row;
  }

  private async view(tx: TenantClient, requestId: string): Promise<AdminManualTopUpRequestView> {
    const row: RequestRow | null = await tx.manualTopUpRequest.findUnique({
      where: { id: requestId },
      include: REQUEST_INCLUDE,
    });
    if (row === null || row.status === ManualTopUpStatus.DRAFT) throw requestNotFound();

    const people = await this.owners(tx, [
      row.ownerUserId,
      ...(row.events ?? [])
        .map((event) => event.actorUserId)
        .filter((id): id is string => id !== null),
    ]);
    const owner = people.get(row.ownerUserId);
    const { cancellable: _cancellable, events: _events, ...base } = ownerRequestView(row);
    return {
      ...base,
      ownerUserId: row.ownerUserId,
      ownerDisplayName: owner?.displayName ?? null,
      ownerEmail: owner?.email ?? '',
      referenceNormalized: row.referenceNormalized,
      reviewStartedByUserId: row.reviewStartedByUserId,
      decidedByUserId: row.approvedByUserId ?? row.rejectedByUserId,
      creditEntryId: row.creditEntryId,
      events: (row.events ?? []).map((event) => ({
        ...eventView(event),
        actorUserId: event.actorUserId,
        actorDisplayName:
          event.actorUserId === null ? null : (people.get(event.actorUserId)?.displayName ?? null),
      })),
    };
  }

  private async owners(
    tx: TenantClient,
    ids: readonly string[],
  ): Promise<Map<string, { email: string; displayName: string | null }>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await tx.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, email: true, displayName: true },
    });
    return new Map(
      users.map((user) => [user.id, { email: user.email, displayName: user.displayName }]),
    );
  }

  private async history(
    tx: TenantClient,
    requestId: string,
    ownerUserId: string,
    eventType: ManualTopUpEventType,
    actorUserId: string,
  ): Promise<string> {
    const row = await tx.manualTopUpRequestEvent.create({
      data: {
        requestId,
        ownerUserId,
        eventType,
        actorSide: ManualTopUpActorSide.FINANCE,
        actorUserId,
      },
      select: { id: true },
    });
    return row.id;
  }
}
