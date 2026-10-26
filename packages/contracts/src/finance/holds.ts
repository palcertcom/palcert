/**
 * Credit holds (§16–§22).
 *
 * A hold reserves credit without spending it. Phase 11 will reserve a check
 * fee before running a check and capture it only if the check succeeds; if the
 * check fails for a reason that is PalCert's fault, the hold is released and
 * the customer was never charged.
 *
 * The invariant that matters is §18: two concurrent requests against a $5
 * balance, each wanting $4, must not both succeed. That is enforced by taking
 * a row lock on the account inside the transaction that reads the balance and
 * writes the hold — never by reading, deciding, and then writing.
 */

export const CreditHoldStatus = {
  /** Reserved. Reduces available balance; has created no ledger entry. */
  ACTIVE: 'ACTIVE',
  /** Spent. A negative ledger entry exists and the money is gone. */
  CAPTURED: 'CAPTURED',
  /** Given back. No ledger entry was ever created. */
  RELEASED: 'RELEASED',
  /** Timed out unspent, by the sweeper. Equivalent to released. */
  EXPIRED: 'EXPIRED',
} as const;

export type CreditHoldStatus = (typeof CreditHoldStatus)[keyof typeof CreditHoldStatus];

export const CREDIT_HOLD_STATUSES: readonly CreditHoldStatus[] = Object.values(CreditHoldStatus);

const HOLD_TRANSITIONS: Readonly<Record<CreditHoldStatus, readonly CreditHoldStatus[]>> = {
  ACTIVE: [CreditHoldStatus.CAPTURED, CreditHoldStatus.RELEASED, CreditHoldStatus.EXPIRED],
  // Terminal. A captured hold is money that has moved; "releasing" it later
  // would hand the customer the service and the money (§21).
  CAPTURED: [],
  RELEASED: [],
  EXPIRED: [],
};

export function canTransitionHold(from: CreditHoldStatus, to: CreditHoldStatus): boolean {
  return HOLD_TRANSITIONS[from].includes(to);
}

export function isHoldTerminal(status: CreditHoldStatus): boolean {
  return HOLD_TRANSITIONS[status].length === 0;
}

/** A hold that still reserves money. Only ACTIVE holds reduce availability. */
export function holdReservesCredit(status: CreditHoldStatus): boolean {
  return status === CreditHoldStatus.ACTIVE;
}

/**
 * What a hold is being taken for.
 *
 * `SERVICE` is Phase 11's check fee. `EXTERNAL_REFUND` is Phase 10's own use
 * (§71): money being sent back to a card must stop being spendable the moment
 * the refund is requested, or a customer could request a refund and spend the
 * same balance before the provider confirms.
 */
export const CreditHoldPurpose = {
  SERVICE: 'SERVICE',
  EXTERNAL_REFUND: 'EXTERNAL_REFUND',
  /**
   * A submitted withdrawal (ADR-0150). Reserves CASH only, and only within the
   * user's withdrawable amount; captured as WITHDRAWAL_DEBIT when the payout
   * is recorded, released when it is rejected or cancelled.
   */
  WITHDRAWAL: 'WITHDRAWAL',
} as const;

export type CreditHoldPurpose = (typeof CreditHoldPurpose)[keyof typeof CreditHoldPurpose];

export const CREDIT_HOLD_PURPOSES: readonly CreditHoldPurpose[] = Object.values(CreditHoldPurpose);

/** Default lifetime of a hold when a caller names none. Phase 11 will set its own. */
export const DEFAULT_HOLD_TTL_SECONDS = 15 * 60;
export const MAX_HOLD_TTL_SECONDS = 24 * 60 * 60;
