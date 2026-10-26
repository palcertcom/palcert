import { Injectable } from '@nestjs/common';
import {
  AppError,
  CreditClass,
  CreditHoldStatus,
  LedgerEntryType,
  PalCertErrorCode,
  isRepresentableAmount,
  signMatchesType,
  type LedgerReasonCode,
  type LedgerReferenceType,
} from '@palcert/contracts';
import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';

/**
 * Appending to the credit ledger, and deriving a balance from it (§3, §14).
 *
 * Every service that moves money comes through here, so there is exactly one
 * place that knows how an entry is written and exactly one place that knows
 * how a balance is computed. There is deliberately no `update` and no `delete`
 * — not because they are unimplemented, but because the database would refuse
 * them anyway (§12).
 *
 * Balances are computed by summing, every time. No cached balance column
 * exists: §15 says to prefer none unless measurements justify one, and none
 * do at this scale. A sum over an indexed account is cheap, and a cache is a
 * second source of truth that can disagree with the first.
 */

export interface AppendEntryInput {
  readonly ownerUserId: string;
  readonly accountId: string;
  readonly currency: string;
  readonly creditClass: CreditClass;
  readonly entryType: LedgerEntryType;
  /** Signed minor units. The sign must match the entry type. */
  readonly amountMinorSigned: bigint;
  readonly referenceType?: LedgerReferenceType | undefined;
  readonly referenceId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly reversalOfEntryId?: string | undefined;
  readonly reasonCode?: LedgerReasonCode | undefined;
  readonly createdByUserId?: string | undefined;
}

export interface AccountPosition {
  readonly accountId: string;
  readonly currency: string;
  readonly creditClass: CreditClass;
  readonly ledgerBalanceMinor: bigint;
  readonly reservedMinor: bigint;
  readonly availableMinor: bigint;
}

@Injectable()
export class CreditLedgerService {
  /**
   * The account for one owner, currency and class, creating it if needed.
   *
   * An account is a grouping, not a balance: creating one grants nothing and
   * costs nothing, so it is safe to do lazily on the first entry or hold.
   */
  async accountFor(
    tx: TenantClient,
    params: {
      readonly ownerUserId: string;
      readonly currency: string;
      readonly creditClass: CreditClass;
    },
  ): Promise<{ id: string }> {
    const existing = await tx.customerCreditAccount.findUnique({
      where: {
        ownerUserId_currency_creditClass: {
          ownerUserId: params.ownerUserId,
          currency: params.currency,
          creditClass: params.creditClass,
        },
      },
      select: { id: true },
    });
    if (existing !== null) return existing;

    // Two concurrent first-spends would both miss above. `ON CONFLICT DO
    // NOTHING` lets the loser continue: catching the unique violation instead
    // would be too late, because inside a transaction a failed statement
    // aborts everything after it and the "read the winner's row" fallback
    // would fail too. Phase 11 made this reachable — two checks bought at the
    // same moment both create the promotional account on their first spend.
    await tx.customerCreditAccount.createMany({
      data: [
        {
          ownerUserId: params.ownerUserId,
          currency: params.currency,
          creditClass: params.creditClass,
        },
      ],
      skipDuplicates: true,
    });

    return tx.customerCreditAccount.findUniqueOrThrow({
      where: {
        ownerUserId_currency_creditClass: {
          ownerUserId: params.ownerUserId,
          currency: params.currency,
          creditClass: params.creditClass,
        },
      },
      select: { id: true },
    });
  }

  /**
   * Append one entry.
   *
   * The sign check here duplicates a database CHECK on purpose: the constraint
   * is the guarantee, and this is the error message a developer actually reads.
   */
  async append(tx: TenantClient, input: AppendEntryInput): Promise<{ id: string }> {
    if (!signMatchesType(input.entryType, input.amountMinorSigned)) {
      throw new AppError(PalCertErrorCode.INTERNAL_ERROR, {
        message: 'An unexpected error occurred.',
        internalContext: {
          reason: `${input.entryType} cannot carry amount ${input.amountMinorSigned.toString()}`,
        },
      });
    }
    if (!isRepresentableAmount(input.amountMinorSigned)) {
      throw new AppError(PalCertErrorCode.INTERNAL_ERROR, {
        message: 'An unexpected error occurred.',
        internalContext: { reason: 'ledger amount outside the representable range' },
      });
    }

    // An idempotent append returns the entry that already exists rather than
    // writing a second one — the difference between a retry and a double
    // charge (§61).
    if (input.idempotencyKey !== undefined) {
      const existing = await tx.creditLedgerEntry.findUnique({
        where: {
          ownerUserId_idempotencyKey: {
            ownerUserId: input.ownerUserId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: { id: true },
      });
      if (existing !== null) return existing;
    }

    return tx.creditLedgerEntry.create({
      data: {
        ownerUserId: input.ownerUserId,
        accountId: input.accountId,
        currency: input.currency,
        creditClass: input.creditClass,
        entryType: input.entryType,
        amountMinorSigned: input.amountMinorSigned,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        reversalOfEntryId: input.reversalOfEntryId ?? null,
        reasonCode: input.reasonCode ?? null,
        createdByUserId: input.createdByUserId ?? null,
      },
      select: { id: true },
    });
  }

  /**
   * The ledger balance of one account: the sum of its entries, and nothing
   * else. This is the definition of a balance in PalCert (§14).
   */
  async ledgerBalance(tx: TenantClient, accountId: string): Promise<bigint> {
    const result = await tx.creditLedgerEntry.aggregate({
      where: { accountId },
      _sum: { amountMinorSigned: true },
    });
    return result._sum.amountMinorSigned ?? 0n;
  }

  /** Minor units currently reserved by active holds on one account. */
  async reserved(tx: TenantClient, accountId: string): Promise<bigint> {
    const result = await tx.creditHold.aggregate({
      where: { accountId, status: CreditHoldStatus.ACTIVE },
      _sum: { amountMinor: true },
    });
    return result._sum.amountMinor ?? 0n;
  }

  /**
   * What a new hold may draw on: `ledgerBalance - activeHolds` (§17).
   *
   * A negative available balance is a legitimate state after a chargeback and
   * is returned as it is — clamping it to zero would hide the deficit (§85).
   */
  async position(
    tx: TenantClient,
    account: {
      readonly id: string;
      readonly currency: string;
      readonly creditClass: CreditClass;
    },
  ): Promise<AccountPosition> {
    const [ledgerBalanceMinor, reservedMinor] = await Promise.all([
      this.ledgerBalance(tx, account.id),
      this.reserved(tx, account.id),
    ]);
    return {
      accountId: account.id,
      currency: account.currency,
      creditClass: account.creditClass,
      ledgerBalanceMinor,
      reservedMinor,
      availableMinor: ledgerBalanceMinor - reservedMinor,
    };
  }

  /** Every account a person holds, with its position. */
  async positions(tx: TenantClient, ownerUserId: string): Promise<readonly AccountPosition[]> {
    const accounts = await tx.customerCreditAccount.findMany({
      where: { ownerUserId },
      select: { id: true, currency: true, creditClass: true },
      orderBy: [{ currency: 'asc' }, { creditClass: 'asc' }],
    });
    return Promise.all(accounts.map((account) => this.position(tx, account)));
  }

  /**
   * Rebuild an account's balance from its entries alone (§128, §153).
   *
   * Identical in result to {@link ledgerBalance}, but computed by walking the
   * rows in order rather than by asking the database to sum them. That is the
   * point: it is an independent second opinion, and the reconciliation check
   * compares the two. If they ever disagree, something is very wrong.
   */
  async rebuildBalance(tx: TenantClient, accountId: string): Promise<bigint> {
    const entries = await tx.creditLedgerEntry.findMany({
      where: { accountId },
      select: { amountMinorSigned: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let total = 0n;
    for (const entry of entries) {
      total += entry.amountMinorSigned;
    }
    return total;
  }
}
