import { Injectable } from '@nestjs/common';
import {
  AppError,
  CreditClass,
  CreditHoldPurpose,
  CreditHoldStatus,
  LedgerEntryType,
  LedgerReasonCode,
  LedgerReferenceType,
  PalCertErrorCode,
  formatMinorUnits,
} from '@palcert/contracts';
import { ApiConfigService } from '../../../config/api-config.service';
import { ClockPort } from '../../auth/ports/clock.port';
import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';
import { CreditLedgerService } from './credit-ledger.service';

/**
 * Credit holds (§16–§22) and the concurrency invariant behind them (§18).
 *
 * The whole reason holds exist is that "check the balance, then spend it" is
 * two operations, and two requests can interleave between them. With a $5
 * balance and two concurrent $4 requests, a naive implementation lets both
 * read $5, both decide yes, and both write — leaving the customer $3 overdrawn
 * on money PalCert already spent on their behalf.
 *
 * The fix is not application cleverness. It is a row lock: the transaction
 * that reads the balance also holds an exclusive lock on the account row until
 * it commits, so the second request *waits*, then reads the balance the first
 * one left, and correctly refuses. `SELECT … FOR UPDATE` is the whole
 * mechanism, and it is why every path that creates a hold goes through this
 * one method.
 */

export interface CreateHoldInput {
  readonly ownerUserId: string;
  readonly currency: string;
  readonly creditClass: CreditClass;
  readonly amountMinor: bigint;
  readonly purpose: CreditHoldPurpose;
  readonly referenceType?: LedgerReferenceType | undefined;
  readonly referenceId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  /**
   * How long the reservation stands. Omitted, the configured hold TTL.
   *
   * `null` means the hold has no deadline of its own: it stands until the
   * thing it reserves for is decided. Certificate attestation is the one
   * caller — an institution's review takes days, not minutes, and a hold that
   * lapsed mid-review would let the approval find nothing to capture. Such a
   * hold is still released or captured exactly once, by the decision.
   */
  readonly expiresInSeconds?: number | null | undefined;
}

export interface HoldRow {
  readonly id: string;
  readonly ownerUserId: string;
  readonly accountId: string;
  readonly currency: string;
  readonly creditClass: CreditClass;
  readonly amountMinor: bigint;
  readonly status: CreditHoldStatus;
}

/** What capturing a hold writes, by what it was reserved for. */
const CAPTURE_ENTRY_TYPE: Readonly<Record<CreditHoldPurpose, LedgerEntryType>> = {
  [CreditHoldPurpose.SERVICE]: LedgerEntryType.SERVICE_CHARGE,
  [CreditHoldPurpose.EXTERNAL_REFUND]: LedgerEntryType.PAYMENT_REFUND_DEBIT,
  // The one debit a paid withdrawal writes (ADR-0150).
  [CreditHoldPurpose.WITHDRAWAL]: LedgerEntryType.WITHDRAWAL_DEBIT,
};

const CAPTURE_REASON: Readonly<Record<CreditHoldPurpose, LedgerReasonCode>> = {
  [CreditHoldPurpose.SERVICE]: LedgerReasonCode.SERVICE_CAPTURED,
  [CreditHoldPurpose.EXTERNAL_REFUND]: LedgerReasonCode.EXTERNAL_REFUND,
  [CreditHoldPurpose.WITHDRAWAL]: LedgerReasonCode.WITHDRAWAL_PAID,
};

@Injectable()
export class CreditHoldService {
  constructor(
    private readonly ledger: CreditLedgerService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
  ) {}

  /**
   * Reserve credit, or refuse.
   *
   * Must be called inside a transaction. The caller's transaction is what
   * holds the lock, so a hold created here and a job enqueued beside it either
   * both happen or neither does.
   */
  async create(tx: TenantClient, input: CreateHoldInput): Promise<HoldRow> {
    if (input.amountMinor <= 0n) {
      throw new AppError(PalCertErrorCode.INTERNAL_ERROR, {
        message: 'An unexpected error occurred.',
        internalContext: { reason: 'a hold must reserve a positive amount' },
      });
    }

    // Idempotency first: a retried request must return the same hold, not
    // reserve a second time (§19).
    if (input.idempotencyKey !== undefined) {
      const existing = await tx.creditHold.findUnique({
        where: {
          ownerUserId_idempotencyKey: {
            ownerUserId: input.ownerUserId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existing !== null) return toHoldRow(existing);
    }

    const account = await this.ledger.accountFor(tx, {
      ownerUserId: input.ownerUserId,
      currency: input.currency,
      creditClass: input.creditClass,
    });

    // The lock. Everything after this line, until the caller's transaction
    // commits, is serialized against any other hold on the same account.
    //
    // Taken on the *account* rather than on the ledger, because the ledger has
    // no single row to lock and the account is exactly the thing whose
    // available balance is being decided.
    await tx.$queryRaw`SELECT "id" FROM "customer_credit_accounts" WHERE "id" = ${account.id}::uuid FOR UPDATE`;

    const position = await this.ledger.position(tx, {
      id: account.id,
      currency: input.currency,
      creditClass: input.creditClass,
    });

    if (position.availableMinor < input.amountMinor) {
      // The message names amounts because a customer needs to know how short
      // they are; it names no internal identifier (§64).
      throw new AppError(PalCertErrorCode.INSUFFICIENT_BALANCE, {
        message: `Your available balance is ${formatMinorUnits(position.availableMinor, input.currency)} ${input.currency}, which is less than the ${formatMinorUnits(input.amountMinor, input.currency)} ${input.currency} required.`,
        details: {
          currency: input.currency,
          availableMinorUnits: position.availableMinor.toString(),
          requiredMinorUnits: input.amountMinor.toString(),
        },
      });
    }

    const ttl =
      input.expiresInSeconds === null
        ? null
        : (input.expiresInSeconds ?? this.config.payments.holdTtlSeconds);
    const created = await tx.creditHold.create({
      data: {
        ownerUserId: input.ownerUserId,
        accountId: account.id,
        currency: input.currency,
        creditClass: input.creditClass,
        purpose: input.purpose,
        amountMinor: input.amountMinor,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        expiresAt: ttl === null ? null : new Date(this.clock.now().getTime() + ttl * 1_000),
      },
    });
    return toHoldRow(created);
  }

  /**
   * Spend a hold (§20).
   *
   * Atomic by construction: the ledger entry and the status change happen in
   * one transaction, so there is no window in which the money is both
   * reserved and spent, or neither.
   *
   * Capturing an already-captured hold is a **no-op returning the same entry**,
   * not a second charge. That matters because a retried delivery of a capture
   * is entirely normal in an at-least-once world.
   */
  async capture(
    tx: TenantClient,
    holdId: string,
    options: { readonly reasonCode?: LedgerReasonCode } = {},
  ): Promise<{ entryId: string; alreadyCaptured: boolean }> {
    const hold = await tx.creditHold.findUnique({ where: { id: holdId } });
    if (hold === null) {
      throw new AppError(PalCertErrorCode.CREDIT_HOLD_NOT_FOUND, {
        message: 'That reservation could not be found.',
      });
    }

    if (hold.status === CreditHoldStatus.CAPTURED) {
      return { entryId: hold.capturedEntryId!, alreadyCaptured: true };
    }
    if (hold.status !== CreditHoldStatus.ACTIVE) {
      throw new AppError(PalCertErrorCode.CREDIT_HOLD_NOT_ACTIVE, {
        message: 'That reservation has already been released and cannot be charged.',
      });
    }

    const entry = await this.ledger.append(tx, {
      ownerUserId: hold.ownerUserId,
      accountId: hold.accountId,
      currency: hold.currency,
      creditClass: hold.creditClass,
      entryType: CAPTURE_ENTRY_TYPE[hold.purpose],
      amountMinorSigned: -hold.amountMinor,
      referenceType: LedgerReferenceType.CREDIT_HOLD,
      referenceId: hold.id,
      // Keyed on the hold, so two racing captures write one entry (§127).
      idempotencyKey: `hold:${hold.id}:capture`,
      // A payout's reason is fixed: the database accepts WITHDRAWAL_PAID on a
      // WITHDRAWAL_DEBIT and on nothing else (ADR-0150).
      reasonCode:
        hold.purpose === CreditHoldPurpose.WITHDRAWAL
          ? LedgerReasonCode.WITHDRAWAL_PAID
          : (options.reasonCode ?? CAPTURE_REASON[hold.purpose]),
    });

    // Conditional on still being ACTIVE: if a concurrent capture won the race,
    // this updates nothing and we read back its result rather than charging
    // twice.
    const updated = await tx.creditHold.updateMany({
      where: { id: hold.id, status: CreditHoldStatus.ACTIVE },
      data: {
        status: CreditHoldStatus.CAPTURED,
        capturedAt: this.clock.now(),
        capturedEntryId: entry.id,
      },
    });
    if (updated.count === 0) {
      const current = await tx.creditHold.findUniqueOrThrow({ where: { id: hold.id } });
      if (current.status === CreditHoldStatus.CAPTURED) {
        return { entryId: current.capturedEntryId!, alreadyCaptured: true };
      }
      throw new AppError(PalCertErrorCode.CREDIT_HOLD_NOT_ACTIVE, {
        message: 'That reservation has already been released and cannot be charged.',
      });
    }

    return { entryId: entry.id, alreadyCaptured: false };
  }

  /**
   * Give a hold back (§21).
   *
   * No ledger entry is written, because nothing was ever spent: the money
   * simply stops being reserved. Releasing twice is a no-op; releasing a
   * captured hold is refused, at this layer and again by a database trigger.
   */
  async release(
    tx: TenantClient,
    holdId: string,
  ): Promise<{ released: boolean; alreadyReleased: boolean }> {
    const hold = await tx.creditHold.findUnique({ where: { id: holdId } });
    if (hold === null) {
      throw new AppError(PalCertErrorCode.CREDIT_HOLD_NOT_FOUND, {
        message: 'That reservation could not be found.',
      });
    }
    if (hold.status === CreditHoldStatus.RELEASED || hold.status === CreditHoldStatus.EXPIRED) {
      return { released: false, alreadyReleased: true };
    }
    if (hold.status === CreditHoldStatus.CAPTURED) {
      throw new AppError(PalCertErrorCode.CREDIT_HOLD_NOT_ACTIVE, {
        message: 'That reservation has already been charged and cannot be released.',
      });
    }

    const updated = await tx.creditHold.updateMany({
      where: { id: hold.id, status: CreditHoldStatus.ACTIVE },
      data: { status: CreditHoldStatus.RELEASED, releasedAt: this.clock.now() },
    });
    return { released: updated.count > 0, alreadyReleased: updated.count === 0 };
  }

  /**
   * Expire holds that outlived their window (§22).
   *
   * Idempotent by construction: it only touches rows that are still ACTIVE and
   * already past their deadline, so running it twice — or running two copies
   * at once — expires each hold once.
   */
  async expireDue(tx: TenantClient, limit = 500): Promise<number> {
    const now = this.clock.now();
    const due = await tx.creditHold.findMany({
      where: { status: CreditHoldStatus.ACTIVE, expiresAt: { lte: now } },
      select: { id: true },
      take: limit,
    });
    if (due.length === 0) return 0;

    const updated = await tx.creditHold.updateMany({
      where: { id: { in: due.map((hold) => hold.id) }, status: CreditHoldStatus.ACTIVE },
      data: { status: CreditHoldStatus.EXPIRED, expiredAt: now },
    });
    return updated.count;
  }
}

function toHoldRow(row: {
  id: string;
  ownerUserId: string;
  accountId: string;
  currency: string;
  creditClass: CreditClass;
  amountMinor: bigint;
  status: CreditHoldStatus;
}): HoldRow {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    accountId: row.accountId,
    currency: row.currency,
    creditClass: row.creditClass,
    amountMinor: row.amountMinor,
    status: row.status,
  };
}
