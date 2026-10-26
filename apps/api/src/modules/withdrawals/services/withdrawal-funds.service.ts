import { Injectable } from '@nestjs/common';
import {
  CreditClass,
  CreditHoldPurpose,
  CreditHoldStatus,
  WithdrawalReservationStatus,
  WithdrawalScope,
  computeOrganizationAvailable,
  computePlatformAvailable,
  computeUserWithdrawable,
  money,
  type OrganizationEarningsView,
  type PayoutFundsRowView,
  type PlatformFundsRowView,
  type PlatformFundsView,
  type UserWithdrawableView,
} from '@palcert/contracts';
import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { WithdrawalPolicyService, type PolicyNow } from './withdrawal-policy.service';

const DAY_MS = 86_400_000;

/** The figures behind one user's withdrawable amount in one currency. */
export interface UserFunds {
  readonly currency: string;
  readonly cashAccountId: string | null;
  readonly clearedEligibleInflowsMinor: bigint;
  readonly clearingInflowsMinor: bigint;
  readonly cashOutflowsMinor: bigint;
  readonly cashLedgerBalanceMinor: bigint;
  readonly activeCashHoldsMinor: bigint;
  readonly activeWithdrawalHoldsMinor: bigint;
  readonly promotionalBalanceMinor: bigint;
  readonly promotionalHoldsMinor: bigint;
  readonly eligibleMinor: bigint;
  readonly spendableMinor: bigint;
  readonly withdrawableMinor: bigint;
}

export interface OrganizationFunds {
  readonly currency: string;
  readonly clearedNetMinor: bigint;
  readonly clearingNetMinor: bigint;
  readonly paidOutMinor: bigint;
  readonly reservedMinor: bigint;
  readonly realizedMinor: bigint;
  readonly availableMinor: bigint;
}

export interface PlatformFunds {
  readonly currency: string;
  readonly cashServiceRevenueMinor: bigint;
  readonly attestationCommissionMinor: bigint;
  readonly serviceRefundsMinor: bigint;
  readonly unrecoveredChargebackLossMinor: bigint;
  readonly paidOutMinor: bigint;
  readonly reservedMinor: bigint;
  readonly realizedMinor: bigint;
  readonly availableMinor: bigint;
}

function sum(value: bigint | null | undefined): bigint {
  return value ?? 0n;
}

/**
 * What may leave PalCert, for each of the three beneficiaries (ADR-0150).
 *
 * Always derived from the authoritative records — the ledger for a user,
 * settled attestation revenue for an organization, captured purchases and
 * settled commission for PalCert — less what earlier payouts settled and
 * what open ones reserve. Nothing here is stored, so nothing here can drift.
 *
 * Every method takes the caller's transaction, so a submission can lock,
 * compute and reserve in one serialized step: the figure that admits a
 * request is the figure at the moment it reserves, never a stale read.
 */
@Injectable()
export class WithdrawalFundsService {
  constructor(
    private readonly policy: WithdrawalPolicyService,
    private readonly clock: ClockPort,
  ) {}

  // -------------------------------------------------------------------------
  // USER — D1, D2, D3
  // -------------------------------------------------------------------------

  /**
   * One user's withdrawable amount in one currency.
   *
   * Eligible inflows are verified manual top-ups past their clearing period,
   * counted from the approval that credited them, and nothing else: card
   * top-ups are refunded to their card instead (D2), and admin credits,
   * chargeback reversals and promotional credit never become cash out. Every
   * CASH outflow, paid withdrawals included, is assumed to have consumed
   * eligible money first (D1) — the deliberately conservative reading of a
   * pooled balance whose debits are not linked to the credits they spent.
   */
  async user(
    tx: TenantClient,
    userId: string,
    currency: string,
    policy?: PolicyNow,
  ): Promise<UserFunds> {
    const now = this.clock.now();
    const rules = policy ?? (await this.policy.current(tx));
    const cutoff = new Date(now.getTime() - rules.userManualTopUpClearingDays * DAY_MS);

    const accounts = await tx.customerCreditAccount.findMany({
      where: { ownerUserId: userId, currency },
      select: { id: true, creditClass: true },
    });
    const cash = accounts.find((account) => account.creditClass === CreditClass.CASH) ?? null;
    const promotional =
      accounts.find((account) => account.creditClass === CreditClass.PROMOTIONAL) ?? null;

    let cleared = 0n;
    let clearing = 0n;
    let outflows = 0n;
    let balance = 0n;
    let holds = 0n;
    let withdrawalHolds = 0n;
    if (cash !== null) {
      // Cleared from the approval that credited it (D3) — the request's own
      // decision time — never from when the row happened to be written. A
      // credit with no approval on record is treated as still clearing.
      const manual = await tx.$queryRaw<Array<{ cleared: bigint | null; clearing: bigint | null }>>`
        SELECT sum(CASE WHEN r."decided_at" IS NOT NULL AND r."decided_at" <= ${cutoff}
                        THEN e."amount_minor_signed" ELSE 0 END)::bigint AS "cleared",
               sum(CASE WHEN r."decided_at" IS NULL OR r."decided_at" > ${cutoff}
                        THEN e."amount_minor_signed" ELSE 0 END)::bigint AS "clearing"
          FROM "credit_ledger_entries" e
          LEFT JOIN "manual_topup_requests" r ON r."credit_entry_id" = e."id"
         WHERE e."account_id" = ${cash.id}::uuid
           AND e."entry_type" = 'MANUAL_TOPUP_CREDIT'`;
      const [outflowAgg, balanceAgg, holdAgg, withdrawalAgg] = await Promise.all([
        tx.creditLedgerEntry.aggregate({
          where: { accountId: cash.id, amountMinorSigned: { lt: 0n } },
          _sum: { amountMinorSigned: true },
        }),
        tx.creditLedgerEntry.aggregate({
          where: { accountId: cash.id },
          _sum: { amountMinorSigned: true },
        }),
        tx.creditHold.aggregate({
          where: { accountId: cash.id, status: CreditHoldStatus.ACTIVE },
          _sum: { amountMinor: true },
        }),
        tx.creditHold.aggregate({
          where: {
            accountId: cash.id,
            status: CreditHoldStatus.ACTIVE,
            purpose: CreditHoldPurpose.WITHDRAWAL,
          },
          _sum: { amountMinor: true },
        }),
      ]);
      cleared = sum(manual[0]?.cleared);
      clearing = sum(manual[0]?.clearing);
      outflows = -sum(outflowAgg._sum.amountMinorSigned);
      balance = sum(balanceAgg._sum.amountMinorSigned);
      holds = sum(holdAgg._sum.amountMinor);
      withdrawalHolds = sum(withdrawalAgg._sum.amountMinor);
    }

    let promotionalBalance = 0n;
    let promotionalHolds = 0n;
    if (promotional !== null) {
      const [balanceAgg, holdAgg] = await Promise.all([
        tx.creditLedgerEntry.aggregate({
          where: { accountId: promotional.id },
          _sum: { amountMinorSigned: true },
        }),
        tx.creditHold.aggregate({
          where: { accountId: promotional.id, status: CreditHoldStatus.ACTIVE },
          _sum: { amountMinor: true },
        }),
      ]);
      promotionalBalance = sum(balanceAgg._sum.amountMinorSigned);
      promotionalHolds = sum(holdAgg._sum.amountMinor);
    }

    const computed = computeUserWithdrawable({
      clearedEligibleInflowsMinor: cleared,
      cashOutflowsMinor: outflows,
      activeWithdrawalReservationsMinor: withdrawalHolds,
      cashLedgerBalanceMinor: balance,
      activeCashHoldsMinor: holds,
    });

    return {
      currency,
      cashAccountId: cash?.id ?? null,
      clearedEligibleInflowsMinor: cleared,
      clearingInflowsMinor: clearing,
      cashOutflowsMinor: outflows,
      cashLedgerBalanceMinor: balance,
      activeCashHoldsMinor: holds,
      activeWithdrawalHoldsMinor: withdrawalHolds,
      promotionalBalanceMinor: promotionalBalance,
      promotionalHoldsMinor: promotionalHolds,
      ...computed,
    };
  }

  /** The breakdown a person sees: why their balance and their withdrawable amount differ. */
  async userView(
    tx: TenantClient,
    userId: string,
    currency: string,
  ): Promise<UserWithdrawableView> {
    const rules = await this.policy.current(tx);
    const funds = await this.user(tx, userId, currency, rules);
    const limit = await this.policy.limitFor(tx, currency);
    const otherReservations =
      funds.activeCashHoldsMinor - funds.activeWithdrawalHoldsMinor + funds.promotionalHoldsMinor;
    // Inside the clearing period, and still there to be withdrawn later.
    const clearingShown = min(
      funds.clearingInflowsMinor,
      funds.spendableMinor - funds.withdrawableMinor,
    );
    const notWithdrawable = nonNegative(
      funds.spendableMinor - funds.withdrawableMinor - nonNegative(clearingShown),
    );
    return {
      currency,
      cashBalance: money(currency, funds.cashLedgerBalanceMinor),
      promotionalBalance: money(currency, funds.promotionalBalanceMinor),
      reserved: money(currency, otherReservations),
      reservedForWithdrawal: money(currency, funds.activeWithdrawalHoldsMinor),
      clearing: money(currency, nonNegative(clearingShown)),
      notWithdrawable: money(currency, notWithdrawable),
      withdrawable: money(currency, funds.withdrawableMinor),
      clearingDays: rules.userManualTopUpClearingDays,
      ...this.policy.limitViews(currency, limit),
    };
  }

  // -------------------------------------------------------------------------
  // ORGANIZATION — D4
  // -------------------------------------------------------------------------

  /**
   * An organization's payout funds, per currency. Only the settled
   * INSTITUTION net share counts — never the gross fee, never PalCert's
   * commission, never a fee that has not settled — and it becomes available
   * once its clearing period has passed since settlement.
   */
  async organization(
    tx: TenantClient,
    organizationId: string,
    policy?: PolicyNow,
  ): Promise<readonly OrganizationFunds[]> {
    const rules = policy ?? (await this.policy.current(tx));
    const cutoff = new Date(this.clock.now().getTime() - rules.organizationClearingDays * DAY_MS);

    const earned = await tx.$queryRaw<
      Array<{ currency: string; cleared: bigint | null; clearing: bigint | null }>
    >`
      SELECT e."currency"::text AS "currency",
             sum(CASE WHEN s."settled_at" <= ${cutoff} THEN e."amount_minor" ELSE 0 END)::bigint AS "cleared",
             sum(CASE WHEN s."settled_at" > ${cutoff} THEN e."amount_minor" ELSE 0 END)::bigint AS "clearing"
        FROM "attestation_revenue_entries" e
        JOIN "attestation_settlements" s ON s."id" = e."settlement_id"
       WHERE e."organization_id" = ${organizationId}::uuid
         AND s."organization_id" = ${organizationId}::uuid
         AND e."account" = 'INSTITUTION'
       GROUP BY e."currency"`;
    const paid = await tx.withdrawalSettlement.groupBy({
      by: ['currency'],
      where: { scope: WithdrawalScope.ORGANIZATION, organizationId },
      _sum: { amountMinor: true },
    });
    const reserved = await tx.withdrawalReservation.groupBy({
      by: ['currency'],
      where: {
        scope: WithdrawalScope.ORGANIZATION,
        organizationId,
        status: WithdrawalReservationStatus.ACTIVE,
      },
      _sum: { amountMinor: true },
    });

    const currencies = new Set<string>([
      ...earned.map((row) => row.currency),
      ...paid.map((row) => row.currency),
      ...reserved.map((row) => row.currency),
    ]);
    return [...currencies].sort().map((currency) => {
      const row = earned.find((entry) => entry.currency === currency);
      const clearedNetMinor = sum(row?.cleared);
      const clearingNetMinor = sum(row?.clearing);
      const paidOutMinor = sum(paid.find((entry) => entry.currency === currency)?._sum.amountMinor);
      const reservedMinor = sum(
        reserved.find((entry) => entry.currency === currency)?._sum.amountMinor,
      );
      return {
        currency,
        clearedNetMinor,
        clearingNetMinor,
        paidOutMinor,
        reservedMinor,
        ...computeOrganizationAvailable({
          clearedNetMinor,
          clearingNetMinor,
          paidOutMinor,
          reservedMinor,
        }),
      };
    });
  }

  async organizationView(
    tx: TenantClient,
    organizationId: string,
  ): Promise<OrganizationEarningsView> {
    const rules = await this.policy.current(tx);
    const funds = await this.organization(tx, organizationId, rules);
    const rows: PayoutFundsRowView[] = [];
    for (const row of funds) {
      const limit = await this.policy.limitFor(tx, row.currency);
      rows.push({
        currency: row.currency,
        realized: money(row.currency, row.realizedMinor),
        clearing: money(row.currency, row.clearingNetMinor),
        reserved: money(row.currency, row.reservedMinor),
        paidOut: money(row.currency, row.paidOutMinor),
        available: money(row.currency, row.availableMinor),
        ...this.policy.limitViews(row.currency, limit),
      });
    }
    return { organizationId, clearingDays: rules.organizationClearingDays, rows };
  }

  // -------------------------------------------------------------------------
  // PLATFORM — D5
  // -------------------------------------------------------------------------

  /**
   * PalCert's realized revenue, per currency, and what of it may be paid out.
   *
   * Included: the CASH-funded part of captured service purchases (document
   * checks, SmartFix, AI review, rule extraction) and settled attestation
   * commission. Excluded: promotional-funded parts, reservations, released or
   * failed purchases, and unsettled fees. Subtracted: service refunds paid
   * back as cash, unrecovered chargeback losses, paid platform payouts and
   * open platform reservations.
   *
   * An unrecovered chargeback loss is measured as every CASH account's
   * deficit — a chargeback that took back more than the customer still held.
   * That is the money PalCert has already lost, whatever it was spent on, so
   * it is held back in full rather than apportioned (fail conservatively).
   */
  async platform(tx: TenantClient): Promise<readonly PlatformFunds[]> {
    const services = await tx.$queryRaw<Array<{ currency: string; amount: bigint | null }>>`
      SELECT a."currency"::text AS "currency", sum(a."amount_minor")::bigint AS "amount"
        FROM "service_purchase_allocations" a
        JOIN "credit_holds" h ON h."id" = a."hold_id"
        JOIN "service_purchases" p ON p."id" = a."purchase_id"
       WHERE a."credit_class" = 'CASH'
         AND h."status" = 'CAPTURED'
         AND p."status" IN ('DELIVERED', 'REFUNDED')
       GROUP BY a."currency"`;
    const commission = await tx.$queryRaw<Array<{ currency: string; amount: bigint | null }>>`
      SELECT e."currency"::text AS "currency", sum(e."amount_minor")::bigint AS "amount"
        FROM "attestation_revenue_entries" e
        JOIN "attestation_settlements" s ON s."id" = e."settlement_id"
       WHERE e."account" = 'PLATFORM_COMMISSION'
       GROUP BY e."currency"`;
    const refunds = await tx.$queryRaw<Array<{ currency: string; amount: bigint | null }>>`
      SELECT "currency"::text AS "currency", sum("amount_minor_signed")::bigint AS "amount"
        FROM "credit_ledger_entries"
       WHERE "entry_type" = 'SERVICE_REFUND' AND "credit_class" = 'CASH'
       GROUP BY "currency"`;
    const deficits = await tx.$queryRaw<Array<{ currency: string; amount: bigint | null }>>`
      SELECT b."currency"::text AS "currency", sum(-b."balance")::bigint AS "amount"
        FROM (
          SELECT "account_id", "currency", sum("amount_minor_signed") AS "balance"
            FROM "credit_ledger_entries"
           WHERE "credit_class" = 'CASH'
           GROUP BY "account_id", "currency"
        ) b
       WHERE b."balance" < 0
       GROUP BY b."currency"`;
    const paid = await tx.withdrawalSettlement.groupBy({
      by: ['currency'],
      where: { scope: WithdrawalScope.PLATFORM },
      _sum: { amountMinor: true },
    });
    const reserved = await tx.withdrawalReservation.groupBy({
      by: ['currency'],
      where: { scope: WithdrawalScope.PLATFORM, status: WithdrawalReservationStatus.ACTIVE },
      _sum: { amountMinor: true },
    });

    const pick = (rows: Array<{ currency: string; amount: bigint | null }>, currency: string) =>
      sum(rows.find((row) => row.currency === currency)?.amount);
    const currencies = new Set<string>([
      ...services.map((row) => row.currency),
      ...commission.map((row) => row.currency),
      ...refunds.map((row) => row.currency),
      ...deficits.map((row) => row.currency),
      ...paid.map((row) => row.currency),
      ...reserved.map((row) => row.currency),
    ]);
    return [...currencies].sort().map((currency) => {
      const figures = {
        cashServiceRevenueMinor: pick(services, currency),
        attestationCommissionMinor: pick(commission, currency),
        serviceRefundsMinor: pick(refunds, currency),
        unrecoveredChargebackLossMinor: pick(deficits, currency),
        paidOutMinor: sum(paid.find((row) => row.currency === currency)?._sum.amountMinor),
        reservedMinor: sum(reserved.find((row) => row.currency === currency)?._sum.amountMinor),
      };
      return { currency, ...figures, ...computePlatformAvailable(figures) };
    });
  }

  async platformView(tx: TenantClient): Promise<PlatformFundsView> {
    const funds = await this.platform(tx);
    const rows: PlatformFundsRowView[] = [];
    for (const row of funds) {
      const limit = await this.policy.limitFor(tx, row.currency);
      const m = (value: bigint) => money(row.currency, value);
      rows.push({
        currency: row.currency,
        realized: m(row.realizedMinor),
        clearing: m(0n),
        reserved: m(row.reservedMinor),
        paidOut: m(row.paidOutMinor),
        available: m(row.availableMinor),
        cashServiceRevenue: m(row.cashServiceRevenueMinor),
        attestationCommission: m(row.attestationCommissionMinor),
        serviceRefunds: m(row.serviceRefundsMinor),
        unrecoveredChargebackLoss: m(row.unrecoveredChargebackLossMinor),
        ...this.policy.limitViews(row.currency, limit),
      });
    }
    return { rows };
  }
}

function nonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
