/**
 * The customer credit ledger (§3, §8–§15, §23).
 *
 * A user's balance is **not a column**. It is the sum of an append-only
 * sequence of signed entries, and that is the whole point: a column can be set
 * to the wrong number by one bad UPDATE and nobody can tell afterwards what it
 * should have been. A ledger can be replayed from zero and checked.
 *
 * Corrections are entries too. Nothing here is ever edited or deleted.
 */

/**
 * What kind of credit an account holds (§9).
 *
 * The distinction is not cosmetic. Cash a customer paid for may, subject to
 * policy, be returned to them through the payment provider. Promotional credit
 * PalCert granted may not — turning a marketing gift into withdrawable money
 * would be a way to launder value out of the platform, and it is blocked at
 * the account level rather than trusted to a check somewhere in a service.
 */
export const CreditClass = {
  /** Paid for, or credited as a cash equivalent. May be externally refundable. */
  CASH: 'CASH',
  /** Granted by PalCert. Spendable, never withdrawable (§9, §70). */
  PROMOTIONAL: 'PROMOTIONAL',
} as const;

export type CreditClass = (typeof CreditClass)[keyof typeof CreditClass];

export const CREDIT_CLASSES: readonly CreditClass[] = Object.values(CreditClass);

export function isExternallyRefundable(creditClass: CreditClass): boolean {
  return creditClass === CreditClass.CASH;
}

/**
 * Ledger entry types (§11).
 *
 * Deliberately generic: Phase 11 charges a document check and Phase 12 a
 * SmartFix through `SERVICE_CHARGE`, without a new entry type or a migration.
 * A type describes *why money moved*, never *what feature asked*.
 */
export const LedgerEntryType = {
  /** A verified provider payment became spendable credit. Always positive. */
  TOP_UP_CREDIT: 'TOP_UP_CREDIT',
  /** A paid service captured a hold. Always negative. */
  SERVICE_CHARGE: 'SERVICE_CHARGE',
  /** PalCert returned a service fee to the balance. Positive; not a provider refund. */
  SERVICE_REFUND: 'SERVICE_REFUND',
  /** Cash left the balance through the payment provider. Always negative. */
  PAYMENT_REFUND_DEBIT: 'PAYMENT_REFUND_DEBIT',
  /** PalCert granted promotional credit. Positive, and never CASH. */
  PROMOTIONAL_CREDIT: 'PROMOTIONAL_CREDIT',
  /** A finance adjustment in the customer's favour. Positive. */
  ADMIN_CREDIT: 'ADMIN_CREDIT',
  /** A finance adjustment against the customer. Negative. */
  ADMIN_DEBIT: 'ADMIN_DEBIT',
  /** A provider dispute pulled a settled payment back. Negative; may go below zero (§84). */
  CHARGEBACK_DEBIT: 'CHARGEBACK_DEBIT',
  /** A dispute resolved in PalCert's favour and the funds returned. Positive. */
  CHARGEBACK_REVERSAL: 'CHARGEBACK_REVERSAL',
  /**
   * A bank or wallet transfer a person reported, credited once PalCert finance
   * matched it against the receiving account. Positive, always CASH, and only
   * ever written by the approval of one manual top-up request.
   */
  MANUAL_TOPUP_CREDIT: 'MANUAL_TOPUP_CREDIT',
  /**
   * An approved withdrawal was paid out externally and recorded with its
   * transfer reference (ADR-0150). Negative, always CASH, written only by
   * capturing the withdrawal's own hold, exactly once.
   */
  WITHDRAWAL_DEBIT: 'WITHDRAWAL_DEBIT',
} as const;

export type LedgerEntryType = (typeof LedgerEntryType)[keyof typeof LedgerEntryType];

export const LEDGER_ENTRY_TYPES: readonly LedgerEntryType[] = Object.values(LedgerEntryType);

/**
 * The sign each entry type must carry.
 *
 * Encoded once here and enforced by a database CHECK, so a service cannot
 * write a positive `SERVICE_CHARGE` and quietly hand someone money.
 */
export const LEDGER_ENTRY_SIGN: Readonly<Record<LedgerEntryType, 'POSITIVE' | 'NEGATIVE'>> = {
  TOP_UP_CREDIT: 'POSITIVE',
  SERVICE_CHARGE: 'NEGATIVE',
  SERVICE_REFUND: 'POSITIVE',
  PAYMENT_REFUND_DEBIT: 'NEGATIVE',
  PROMOTIONAL_CREDIT: 'POSITIVE',
  ADMIN_CREDIT: 'POSITIVE',
  ADMIN_DEBIT: 'NEGATIVE',
  CHARGEBACK_DEBIT: 'NEGATIVE',
  CHARGEBACK_REVERSAL: 'POSITIVE',
  MANUAL_TOPUP_CREDIT: 'POSITIVE',
  WITHDRAWAL_DEBIT: 'NEGATIVE',
};

export function expectedSign(type: LedgerEntryType): 'POSITIVE' | 'NEGATIVE' {
  return LEDGER_ENTRY_SIGN[type];
}

export function signMatchesType(type: LedgerEntryType, amountMinorSigned: bigint): boolean {
  if (amountMinorSigned === 0n) return false;
  return expectedSign(type) === (amountMinorSigned > 0n ? 'POSITIVE' : 'NEGATIVE');
}

/** Entry types that only ever apply to promotional credit. */
export const PROMOTIONAL_ONLY_ENTRY_TYPES: readonly LedgerEntryType[] = [
  LedgerEntryType.PROMOTIONAL_CREDIT,
];

/** What a ledger entry points at, so a row can be traced to its cause. */
export const LedgerReferenceType = {
  BALANCE_TOP_UP: 'BALANCE_TOP_UP',
  CREDIT_HOLD: 'CREDIT_HOLD',
  PAYMENT_REFUND: 'PAYMENT_REFUND',
  LEDGER_ENTRY: 'LEDGER_ENTRY',
  ADMIN_ADJUSTMENT: 'ADMIN_ADJUSTMENT',
  PAYMENT_DISPUTE: 'PAYMENT_DISPUTE',
  /** A customer buying a deliverable service, such as a document check. */
  SERVICE_PURCHASE: 'SERVICE_PURCHASE',
  /** A certificate attestation request's fee (reserve, capture, release). */
  ATTESTATION_REQUEST: 'ATTESTATION_REQUEST',
  /** A manual top-up request a finance reviewer approved. */
  MANUAL_TOPUP_REQUEST: 'MANUAL_TOPUP_REQUEST',
  /** A withdrawal request whose payout was recorded (ADR-0150). */
  WITHDRAWAL_REQUEST: 'WITHDRAWAL_REQUEST',
} as const;

export type LedgerReferenceType = (typeof LedgerReferenceType)[keyof typeof LedgerReferenceType];

export const LEDGER_REFERENCE_TYPES: readonly LedgerReferenceType[] =
  Object.values(LedgerReferenceType);

/**
 * Why an entry exists, in words a person can act on.
 *
 * Kept as a closed enumeration rather than free text so a finance report can
 * group by it and a reviewer cannot bury a reason in prose.
 */
export const LedgerReasonCode = {
  TOP_UP_VERIFIED: 'TOP_UP_VERIFIED',
  SERVICE_CAPTURED: 'SERVICE_CAPTURED',
  SERVICE_FAILED: 'SERVICE_FAILED',
  SERVICE_CANCELLED: 'SERVICE_CANCELLED',
  CUSTOMER_REQUEST: 'CUSTOMER_REQUEST',
  GOODWILL: 'GOODWILL',
  PROMOTION: 'PROMOTION',
  BILLING_CORRECTION: 'BILLING_CORRECTION',
  PROVIDER_DISPUTE: 'PROVIDER_DISPUTE',
  PROVIDER_DISPUTE_WON: 'PROVIDER_DISPUTE_WON',
  EXTERNAL_REFUND: 'EXTERNAL_REFUND',
  /** An institution's attestation fee, captured when it approved the request. */
  ATTESTATION_FEE: 'ATTESTATION_FEE',
  /** Finance verified a reported transfer and approved the manual top-up. */
  MANUAL_TOPUP_APPROVED: 'MANUAL_TOPUP_APPROVED',
  /** Finance recorded the external transfer of an approved withdrawal. */
  WITHDRAWAL_PAID: 'WITHDRAWAL_PAID',
} as const;

export type LedgerReasonCode = (typeof LedgerReasonCode)[keyof typeof LedgerReasonCode];

export const LEDGER_REASON_CODES: readonly LedgerReasonCode[] = Object.values(LedgerReasonCode);

/**
 * Reasons a direct finance adjustment may carry.
 *
 * Every code except the ones that belong to a workflow with its own audit
 * trail. A manual top-up is credited only by approving its request, so an
 * adjustment that claimed to be one would be a second, unreviewed door to the
 * same money.
 */
export const ADJUSTMENT_REASON_CODES: readonly LedgerReasonCode[] = LEDGER_REASON_CODES.filter(
  (code) =>
    code !== LedgerReasonCode.MANUAL_TOPUP_APPROVED && code !== LedgerReasonCode.WITHDRAWAL_PAID,
);

/**
 * Funding order for a future mixed-class spend (§23).
 *
 * Promotional credit is spent first, deliberately: it is the credit the
 * customer cannot get back, so spending it while it exists is the outcome that
 * leaves them best off. Declared here, in one place, so Phase 11 and Phase 12
 * cannot each invent their own order.
 *
 * Phase 10 does not yet create a hold that spans two classes — a hold names
 * one account — so this constant documents the committed policy rather than
 * driving an allocator that does not exist yet.
 */
export const FUNDING_ORDER: readonly CreditClass[] = [CreditClass.PROMOTIONAL, CreditClass.CASH];
