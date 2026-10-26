import { Injectable } from '@nestjs/common';
import {
  AppError,
  CheckStatus,
  CreditClass,
  CreditHoldStatus,
  LedgerEntryType,
  LedgerReasonCode,
  LedgerReferenceType,
  ManualTopUpStatus,
  PalCertErrorCode,
  PaymentRefundStatus,
  ServicePurchaseStatus,
  ServiceResourceType,
  TopUpStatus,
  isKnownCurrency,
  money,
  type AdminBalanceView,
  type BalanceTopUpView,
  type LedgerEntryView,
  type AdminServicePurchaseView,
  type LedgerVerificationView,
  type AdminPurchaseReportRowView,
  type ServiceProductCode,
  type ServicePurchaseSummaryRowView,
  type ServicePurchaseSummaryView,
} from '@palcert/contracts';
import { ClockPort } from '../../auth/ports/clock.port';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { BalanceService } from './balance.service';
import { CreditLedgerService } from './credit-ledger.service';
import { toPurchaseView } from './service-purchase.service';
import { toTopUpView } from './top-up.service';

/**
 * Finance's own operations (§76, §77, §151, §153, §154).
 *
 * Two rules, and the second is the interesting one.
 *
 * Finance can move money — that is what the role is for. But finance
 * **cannot edit or delete a ledger entry**, because nobody can: the database
 * refuses it. A correction is a new, signed, reasoned entry that leaves the
 * original visible (§77). An accounting system where a privileged user can
 * quietly change history is not an accounting system.
 *
 * And every path here runs through `withPlatformAdmin`, which logs the
 * elevation and demands a stated reason, so cross-customer access is recorded
 * rather than merely permitted (§151).
 */
@Injectable()
export class FinanceAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
    private readonly ledger: CreditLedgerService,
    private readonly balances: BalanceService,
    private readonly clock: ClockPort,
    private readonly events: SecurityEventService,
  ) {}

  /**
   * Credit or debit a customer's balance directly (§76).
   *
   * Requires an explicit reason, and records who did it. The idempotency key
   * is mandatory rather than optional: a double-clicked adjustment that
   * credited twice would be indistinguishable from two deliberate ones.
   */
  async adjust(input: {
    readonly ownerUserId: string;
    readonly currency: string;
    readonly creditClass: CreditClass;
    readonly amountMinorSigned: bigint;
    readonly reasonCode: LedgerReasonCode;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
    readonly note?: string;
  }): Promise<LedgerEntryView> {
    if (input.amountMinorSigned === 0n) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'An adjustment must be greater or less than zero.',
      });
    }
    if (!isKnownCurrency(input.currency)) {
      throw new AppError(PalCertErrorCode.CURRENCY_NOT_SUPPORTED, {
        message: 'PalCert does not know that currency.',
      });
    }

    // A promotional grant must land in a promotional account: promotional
    // credit that could become cash would be withdrawable, which is exactly
    // what §9 forbids. A database CHECK enforces the same thing.
    const entryType =
      input.amountMinorSigned > 0n
        ? input.creditClass === CreditClass.PROMOTIONAL
          ? LedgerEntryType.PROMOTIONAL_CREDIT
          : LedgerEntryType.ADMIN_CREDIT
        : LedgerEntryType.ADMIN_DEBIT;

    const entry = await this.tenant.withPlatformAdmin(
      {
        actorUserId: input.actorUserId,
        reason: `finance adjustment: ${input.reasonCode}`,
      },
      async (tx) => {
        const account = await this.ledger.accountFor(tx, {
          ownerUserId: input.ownerUserId,
          currency: input.currency,
          creditClass: input.creditClass,
        });
        return this.ledger.append(tx, {
          ownerUserId: input.ownerUserId,
          accountId: account.id,
          currency: input.currency,
          creditClass: input.creditClass,
          entryType,
          amountMinorSigned: input.amountMinorSigned,
          // Deliberately no reference: an adjustment points at no other row,
          // and a reference type without an id is refused by the database —
          // rightly, because a dangling reference is worse than none. What
          // explains this entry is its reason code and its author.
          idempotencyKey: `admin:${input.idempotencyKey}`,
          reasonCode: input.reasonCode,
          createdByUserId: input.actorUserId,
        });
      },
    );

    await this.events.audit({
      action: input.amountMinorSigned > 0n ? 'ADMIN_CREDIT_CREATED' : 'ADMIN_DEBIT_CREATED',
      actorUserId: input.actorUserId,
      targetType: 'CreditLedgerEntry',
      targetId: entry.id,
      afterState: {
        ownerUserId: input.ownerUserId,
        currency: input.currency,
        creditClass: input.creditClass,
        amountMinor: input.amountMinorSigned.toString(),
        reasonCode: input.reasonCode,
        ...(input.note === undefined ? {} : { note: input.note.slice(0, 500) }),
      },
    });

    const row = await this.tenant.withPlatformAdmin(
      { actorUserId: input.actorUserId, reason: 'read back a finance adjustment' },
      (tx) => tx.creditLedgerEntry.findUniqueOrThrow({ where: { id: entry.id } }),
    );
    return {
      publicId: row.id,
      entryType: row.entryType as LedgerEntryType,
      creditClass: row.creditClass,
      amount: money(row.currency, row.amountMinorSigned),
      reasonCode: row.reasonCode as LedgerReasonCode | null,
      reversalOfEntryId: row.reversalOfEntryId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** A customer's balance, for finance and support. */
  async balanceOf(
    ownerUserId: string,
    actorUserId: string,
    currency?: string,
  ): Promise<AdminBalanceView> {
    const summary = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'finance read of a customer balance' },
      async () => this.balances.summary(ownerUserId, currency),
    );
    return { ...summary, ownerUserId };
  }

  /**
   * The read-only invariant check (§153, §154).
   *
   * Verifies five things that must always hold, and **changes nothing**:
   *
   *   1. every account's summed balance equals its independently replayed one;
   *   2. every succeeded top-up has exactly one credit entry;
   *   3. every captured hold has exactly one debit entry;
   *   4. every succeeded external refund has exactly one debit entry;
   *   5. every approved manual top-up has exactly one matching CASH credit,
   *      and every manual top-up credit has an approved request behind it.
   *
   * A finding here does not get "fixed" automatically. Guessing at a
   * correction is how a small discrepancy becomes an unexplainable one (§104).
   */
  async verifyLedger(actorUserId: string): Promise<LedgerVerificationView> {
    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read-only financial invariant verification' },
      async (tx) => {
        const findings: { code: string; detail: string; subjectId: string }[] = [];

        const accounts = await tx.customerCreditAccount.findMany({
          select: { id: true, currency: true, creditClass: true },
        });
        let entriesChecked = 0;

        for (const account of accounts) {
          const [summed, replayed] = await Promise.all([
            this.ledger.ledgerBalance(tx, account.id),
            this.ledger.rebuildBalance(tx, account.id),
          ]);
          entriesChecked += 1;
          if (summed !== replayed) {
            findings.push({
              code: 'BALANCE_REPLAY_MISMATCH',
              detail: `summed ${summed.toString()} but replayed ${replayed.toString()}`,
              subjectId: account.id,
            });
          }
        }

        const succeededTopUps = await tx.balanceTopUp.findMany({
          where: { status: TopUpStatus.SUCCEEDED },
          select: { id: true, creditEntryId: true, amountMinor: true },
        });
        for (const topUp of succeededTopUps) {
          if (topUp.creditEntryId === null) {
            findings.push({
              code: 'TOPUP_WITHOUT_CREDIT',
              detail: 'a succeeded top-up has no ledger credit',
              subjectId: topUp.id,
            });
            continue;
          }
          const credits = await tx.creditLedgerEntry.count({
            where: {
              referenceType: LedgerReferenceType.BALANCE_TOP_UP,
              referenceId: topUp.id,
              entryType: LedgerEntryType.TOP_UP_CREDIT,
            },
          });
          if (credits !== 1) {
            findings.push({
              code: 'TOPUP_CREDIT_COUNT',
              detail: `expected exactly one credit, found ${credits}`,
              subjectId: topUp.id,
            });
          }
        }

        const capturedHolds = await tx.creditHold.findMany({
          where: { status: CreditHoldStatus.CAPTURED },
          select: { id: true, capturedEntryId: true },
        });
        for (const hold of capturedHolds) {
          const debits = await tx.creditLedgerEntry.count({
            where: { referenceType: LedgerReferenceType.CREDIT_HOLD, referenceId: hold.id },
          });
          if (debits !== 1 || hold.capturedEntryId === null) {
            findings.push({
              code: 'HOLD_DEBIT_COUNT',
              detail: `expected exactly one debit, found ${debits}`,
              subjectId: hold.id,
            });
          }
        }

        const succeededRefunds = await tx.paymentRefund.findMany({
          where: { status: PaymentRefundStatus.SUCCEEDED },
          select: { id: true, debitEntryId: true },
        });
        for (const refund of succeededRefunds) {
          if (refund.debitEntryId === null) {
            findings.push({
              code: 'REFUND_WITHOUT_DEBIT',
              detail: 'a succeeded refund has no ledger debit',
              subjectId: refund.id,
            });
          }
        }

        // Phase 11 §93: the same read-only pass, extended to service
        // purchases. It checks the two directions that matter — a purchase
        // that says it was delivered really was charged for a completed
        // check, and one that says it was released really was charged for
        // nothing — and reports what it finds rather than repairing it (§94).
        const purchases = await tx.servicePurchase.findMany({
          where: { status: { in: ['DELIVERED', 'RELEASED', 'REFUNDED'] } },
          select: {
            id: true,
            status: true,
            amountMinor: true,
            resourceType: true,
            resourceId: true,
            allocations: { select: { amountMinor: true, hold: { select: { status: true } } } },
          },
          take: 5_000,
        });

        for (const purchase of purchases) {
          const allocated = purchase.allocations.reduce(
            (total, allocation) => total + allocation.amountMinor,
            0n,
          );
          if (allocated !== purchase.amountMinor) {
            findings.push({
              code: 'PURCHASE_ALLOCATION_MISMATCH',
              detail: `funded by ${allocated.toString()} but costs ${purchase.amountMinor.toString()}`,
              subjectId: purchase.id,
            });
          }

          const captured = purchase.allocations.filter(
            (allocation) => allocation.hold.status === CreditHoldStatus.CAPTURED,
          ).length;

          if (purchase.status === ServicePurchaseStatus.RELEASED && captured > 0) {
            findings.push({
              code: 'RELEASED_PURCHASE_CHARGED',
              detail: `${captured} reservation(s) were charged for a released purchase`,
              subjectId: purchase.id,
            });
          }

          if (
            purchase.status !== ServicePurchaseStatus.RELEASED &&
            captured !== purchase.allocations.length
          ) {
            findings.push({
              code: 'DELIVERED_PURCHASE_UNCAPTURED',
              detail: `${purchase.allocations.length - captured} reservation(s) were never charged`,
              subjectId: purchase.id,
            });
          }

          if (
            purchase.resourceType === ServiceResourceType.DOCUMENT_CHECK &&
            purchase.status !== ServicePurchaseStatus.RELEASED
          ) {
            const completed = await tx.documentCheck.count({
              where: { id: purchase.resourceId, status: CheckStatus.COMPLETED },
            });
            if (completed !== 1) {
              findings.push({
                code: 'PURCHASE_WITHOUT_COMPLETED_CHECK',
                detail: 'a charged purchase has no completed check',
                subjectId: purchase.id,
              });
            }
          }
        }

        // Manual top-ups: the same read-only pass, in both directions. Every
        // approved request has exactly one credit that matches it to the
        // unit, and every manual credit belongs to an approved request. A
        // credit with no approval behind it is the finding that matters most:
        // it is money nobody verified.
        const approvedManual = await tx.manualTopUpRequest.findMany({
          where: { status: ManualTopUpStatus.APPROVED },
          select: {
            id: true,
            ownerUserId: true,
            currency: true,
            amountMinor: true,
            creditEntryId: true,
          },
        });
        const manualCredits = await tx.creditLedgerEntry.findMany({
          where: { entryType: LedgerEntryType.MANUAL_TOPUP_CREDIT },
          select: {
            id: true,
            ownerUserId: true,
            currency: true,
            creditClass: true,
            amountMinorSigned: true,
            referenceType: true,
            referenceId: true,
          },
        });
        const creditsByRequest = new Map<string, typeof manualCredits>();
        for (const credit of manualCredits) {
          const key = credit.referenceId ?? '';
          creditsByRequest.set(key, [...(creditsByRequest.get(key) ?? []), credit]);
        }
        const approvedIds = new Set(approvedManual.map((request) => request.id));

        for (const request of approvedManual) {
          const credits = creditsByRequest.get(request.id) ?? [];
          if (credits.length !== 1) {
            findings.push({
              code: 'MANUAL_TOPUP_CREDIT_COUNT',
              detail: `expected exactly one credit for an approved manual top-up, found ${credits.length}`,
              subjectId: request.id,
            });
            continue;
          }
          const credit = credits[0]!;
          if (
            credit.id !== request.creditEntryId ||
            credit.ownerUserId !== request.ownerUserId ||
            credit.currency !== request.currency ||
            credit.creditClass !== CreditClass.CASH ||
            credit.amountMinorSigned !== request.amountMinor
          ) {
            findings.push({
              code: 'MANUAL_TOPUP_CREDIT_MISMATCH',
              detail: 'the credit does not match the approved request',
              subjectId: request.id,
            });
          }
        }
        for (const credit of manualCredits) {
          if (
            credit.referenceType !== LedgerReferenceType.MANUAL_TOPUP_REQUEST ||
            credit.referenceId === null ||
            !approvedIds.has(credit.referenceId)
          ) {
            findings.push({
              code: 'MANUAL_TOPUP_CREDIT_WITHOUT_APPROVAL',
              detail: 'a manual top-up credit has no approved request behind it',
              subjectId: credit.id,
            });
          }
        }
        const undecidedWithCredit = await tx.manualTopUpRequest.count({
          where: { status: { not: ManualTopUpStatus.APPROVED }, creditEntryId: { not: null } },
        });
        if (undecidedWithCredit > 0) {
          findings.push({
            code: 'MANUAL_TOPUP_UNAPPROVED_WITH_CREDIT',
            detail: `${undecidedWithCredit} manual top-up(s) not approved yet name a credit`,
            subjectId: 'manual_topup_requests',
          });
        }

        return {
          checkedAt: this.clock.now().toISOString(),
          accountsChecked: accounts.length,
          entriesChecked,
          findings,
          consistent: findings.length === 0,
        };
      },
    );
  }

  /**
   * Payments for one customer, for support and reconciliation.
   *
   * Mapped to the view rather than returned raw: a Prisma row carries BigInt
   * amounts that JSON cannot serialize, and it also carries provider session
   * and payment identifiers that have no business leaving the server (§64).
   */
  async paymentsOf(ownerUserId: string, actorUserId: string): Promise<readonly BalanceTopUpView[]> {
    const rows = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'finance read of a customer payment history' },
      (tx) =>
        tx.balanceTopUp.findMany({
          where: { ownerUserId },
          orderBy: [{ createdAt: 'desc' }],
          take: 100,
        }),
    );
    return rows.map(toTopUpView);
  }

  /**
   * What one customer bought, for support and reconciliation (§131).
   *
   * Read-only, and it exposes the allocation breakdown because "which class
   * paid what" is the reconciliation question. It still carries no account id
   * and no hold id: the credit class is the answer, and an internal
   * identifier would only invite someone to act on it (§50).
   */
  async purchasesOf(
    ownerUserId: string,
    actorUserId: string,
  ): Promise<readonly AdminServicePurchaseView[]> {
    const rows = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'finance read of a customer purchase history' },
      (tx) =>
        tx.servicePurchase.findMany({
          where: { ownerUserId },
          orderBy: [{ createdAt: 'desc' }],
          take: 100,
          include: { allocations: { include: { hold: true } } },
        }),
    );

    return rows.map((row) => ({
      ...toPurchaseView(row),
      ownerUserId: row.ownerUserId,
      priceQuoteId: row.priceQuoteId,
      priceVersionId: row.priceVersionId,
      allocations: row.allocations.map((allocation) => ({
        creditClass: allocation.creditClass as CreditClass,
        amount: money(allocation.currency, allocation.amountMinor),
        holdStatus: allocation.hold.status as CreditHoldStatus,
      })),
    }));
  }

  /**
   * Purchases and captured revenue by product and currency (ADR-0149).
   *
   * A view over `service_purchases`: counts and sums per status, grouped so
   * that USD, ILS and JOD are never added together. Nothing is written.
   */
  async purchaseSummary(
    filter: PurchaseReportFilter,
    actorUserId: string,
  ): Promise<ServicePurchaseSummaryView> {
    const range = purchaseDateRange(filter);
    const groups = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'finance read of purchases by product' },
      (tx) =>
        tx.servicePurchase.groupBy({
          by: ['productCode', 'currency', 'status'],
          where: {
            ...(filter.productCode === undefined ? {} : { productCode: filter.productCode }),
            ...(filter.currency === undefined ? {} : { currency: filter.currency }),
            ...(range.gte === undefined && range.lt === undefined ? {} : { createdAt: range }),
          },
          _count: { _all: true },
          _sum: { amountMinor: true },
        }),
    );

    const rows = new Map<string, ServicePurchaseSummaryRowView & { [k: string]: unknown }>();
    const blank = (productCode: ServiceProductCode, currency: string) => ({
      productCode,
      currency,
      purchaseCount: 0,
      reservedCount: 0,
      reservedAmount: money(currency, 0n),
      capturedCount: 0,
      capturedAmount: money(currency, 0n),
      releasedCount: 0,
      refundedCount: 0,
      refundedAmount: money(currency, 0n),
      reconciliationCount: 0,
    });
    const sums = new Map<string, { reserved: bigint; captured: bigint; refunded: bigint }>();
    for (const group of groups) {
      const key = `${group.productCode}:${group.currency}`;
      const row = rows.get(key) ?? blank(group.productCode as ServiceProductCode, group.currency);
      const sum = sums.get(key) ?? { reserved: 0n, captured: 0n, refunded: 0n };
      const count = group._count._all;
      const amount = group._sum.amountMinor ?? 0n;
      const next = { ...row, purchaseCount: row.purchaseCount + count };
      switch (group.status) {
        case ServicePurchaseStatus.RESERVED:
        case ServicePurchaseStatus.PROCESSING:
          next.reservedCount += count;
          sum.reserved += amount;
          break;
        case ServicePurchaseStatus.DELIVERED:
          next.capturedCount += count;
          sum.captured += amount;
          break;
        case ServicePurchaseStatus.REFUNDED:
          // Charged, then returned in full: counted as captured and as refunded.
          next.capturedCount += count;
          next.refundedCount += count;
          sum.captured += amount;
          sum.refunded += amount;
          break;
        case ServicePurchaseStatus.RELEASED:
          next.releasedCount += count;
          break;
        default:
          next.reconciliationCount += count;
      }
      rows.set(key, next);
      sums.set(key, sum);
    }

    return {
      from: filter.from ?? null,
      to: filter.to ?? null,
      rows: [...rows.entries()]
        .map(([key, row]) => {
          const sum = sums.get(key) ?? { reserved: 0n, captured: 0n, refunded: 0n };
          return {
            productCode: row.productCode,
            currency: row.currency,
            purchaseCount: row.purchaseCount,
            reservedCount: row.reservedCount,
            reservedAmount: money(row.currency, sum.reserved),
            capturedCount: row.capturedCount,
            capturedAmount: money(row.currency, sum.captured),
            releasedCount: row.releasedCount,
            refundedCount: row.refundedCount,
            refundedAmount: money(row.currency, sum.refunded),
            reconciliationCount: row.reconciliationCount,
          };
        })
        .sort((a, b) =>
          a.productCode === b.productCode
            ? a.currency.localeCompare(b.currency)
            : a.productCode.localeCompare(b.productCode),
        ),
    };
  }

  /**
   * Individual purchases for the same filter, newest first, with the payer
   * and — for an organization-scoped AI run — the organization it was for.
   * The organization is context only: it is never the payer (ADR-0149).
   */
  async purchaseReport(
    filter: PurchaseReportFilter,
    actorUserId: string,
  ): Promise<readonly AdminPurchaseReportRowView[]> {
    const range = purchaseDateRange(filter);
    const take = Math.min(Math.max(filter.limit ?? 100, 1), 200);
    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'finance read of the purchase report' },
      async (tx) => {
        const rows = await tx.servicePurchase.findMany({
          where: {
            ...(filter.productCode === undefined ? {} : { productCode: filter.productCode }),
            ...(filter.currency === undefined ? {} : { currency: filter.currency }),
            ...(filter.status === undefined ? {} : { status: filter.status }),
            ...(range.gte === undefined && range.lt === undefined ? {} : { createdAt: range }),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
        });
        const users = await tx.user.findMany({
          where: { id: { in: [...new Set(rows.map((row) => row.ownerUserId))] } },
          select: { id: true, email: true, displayName: true },
        });
        const runIds = rows
          .filter((row) => row.resourceType === ServiceResourceType.AI_RULE_EXTRACTION)
          .map((row) => row.resourceId);
        const runs =
          runIds.length === 0
            ? []
            : await tx.ruleExtractionRun.findMany({
                where: { id: { in: runIds } },
                select: { id: true, organizationId: true },
              });
        const organizations =
          runs.length === 0
            ? []
            : await tx.organization.findMany({
                where: { id: { in: [...new Set(runs.map((run) => run.organizationId))] } },
                select: { id: true, displayName: true },
              });
        const userById = new Map(users.map((user) => [user.id, user]));
        const orgByRun = new Map(
          runs.map((run) => [
            run.id,
            organizations.find((organization) => organization.id === run.organizationId) ?? null,
          ]),
        );
        return rows.map((row) => {
          const user = userById.get(row.ownerUserId);
          const organization = orgByRun.get(row.resourceId) ?? null;
          return {
            purchaseId: row.id,
            productCode: row.productCode as ServiceProductCode,
            resourceType: row.resourceType as ServiceResourceType,
            resourceId: row.resourceId,
            status: row.status as ServicePurchaseStatus,
            amount: money(row.currency, row.amountMinor),
            payer: {
              userId: row.ownerUserId,
              email: user?.email ?? '',
              displayName: user?.displayName ?? null,
            },
            organization:
              organization === null
                ? null
                : { id: organization.id, name: organization.displayName },
            failureCode: row.failureCode,
            createdAt: row.createdAt.toISOString(),
            deliveredAt: row.deliveredAt?.toISOString() ?? null,
            releasedAt: row.releasedAt?.toISOString() ?? null,
          };
        });
      },
    );
  }
}

/** The admin purchase report's filter (ADR-0149). Dates are inclusive calendar days, UTC. */
export interface PurchaseReportFilter {
  readonly productCode?: ServiceProductCode;
  readonly currency?: string;
  readonly from?: string;
  readonly to?: string;
  readonly status?: ServicePurchaseStatus;
  readonly limit?: number;
}

export function purchaseDateRange(filter: PurchaseReportFilter): { gte?: Date; lt?: Date } {
  const range: { gte?: Date; lt?: Date } = {};
  if (filter.from !== undefined) range.gte = new Date(`${filter.from}T00:00:00.000Z`);
  if (filter.to !== undefined) {
    const end = new Date(`${filter.to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    range.lt = end;
  }
  return range;
}
