/**
 * Top-ups, refunds and provider events (§41–§61, §65–§75, §83–§88).
 *
 * The rule that shapes all of it: **the browser is not evidence**. A customer
 * arriving back at `/balance/payment-return` proves only that a redirect
 * happened. Credit appears when PalCert has verified provider state through a
 * signed webhook or a direct retrieval, and not one moment earlier (§40).
 */

export const TopUpStatus = {
  /** The record exists; no provider session yet. */
  CREATED: 'CREATED',
  /** A provider checkout session exists and the customer may be paying. */
  PENDING: 'PENDING',
  /** Verified paid, and credited exactly once. */
  SUCCEEDED: 'SUCCEEDED',
  /** The provider reported a terminal failure. No credit; nothing to reverse. */
  FAILED: 'FAILED',
  /** The customer abandoned it. */
  CANCELLED: 'CANCELLED',
  /** The provider session lapsed unpaid. */
  EXPIRED: 'EXPIRED',
  /**
   * Provider state and PalCert state disagree (§104).
   *
   * Deliberately terminal-but-not-final: PalCert stops rather than guessing,
   * because the two ways of guessing are "credit money that was not paid" and
   * "keep money that was". A person looks at it.
   */
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
} as const;

export type TopUpStatus = (typeof TopUpStatus)[keyof typeof TopUpStatus];

export const TOP_UP_STATUSES: readonly TopUpStatus[] = Object.values(TopUpStatus);

const TOP_UP_TRANSITIONS: Readonly<Record<TopUpStatus, readonly TopUpStatus[]>> = {
  CREATED: [
    TopUpStatus.PENDING,
    TopUpStatus.FAILED,
    TopUpStatus.CANCELLED,
    TopUpStatus.EXPIRED,
    TopUpStatus.RECONCILIATION_REQUIRED,
  ],
  PENDING: [
    TopUpStatus.SUCCEEDED,
    TopUpStatus.FAILED,
    TopUpStatus.CANCELLED,
    TopUpStatus.EXPIRED,
    TopUpStatus.RECONCILIATION_REQUIRED,
  ],
  // Terminal, and the most important one: once credit exists, a late "failed"
  // event must not take it away (§125). A genuine reversal is a chargeback,
  // which is a new ledger entry rather than a status change.
  SUCCEEDED: [],
  FAILED: [TopUpStatus.RECONCILIATION_REQUIRED],
  CANCELLED: [TopUpStatus.RECONCILIATION_REQUIRED],
  EXPIRED: [TopUpStatus.RECONCILIATION_REQUIRED],
  RECONCILIATION_REQUIRED: [],
};

export function canTransitionTopUp(from: TopUpStatus, to: TopUpStatus): boolean {
  return TOP_UP_TRANSITIONS[from].includes(to);
}

export function isTopUpTerminal(status: TopUpStatus): boolean {
  return TOP_UP_TRANSITIONS[status].length === 0;
}

/** Statuses where a provider may still move the payment, so reconciliation looks. */
export function isTopUpOpen(status: TopUpStatus): boolean {
  return status === TopUpStatus.CREATED || status === TopUpStatus.PENDING;
}

/** Why a top-up did not complete. Stable codes; never provider prose (§56, §57). */
export const TopUpFailureCode = {
  PROVIDER_DECLINED: 'PROVIDER_DECLINED',
  PROVIDER_SESSION_EXPIRED: 'PROVIDER_SESSION_EXPIRED',
  PAYMENT_AMOUNT_MISMATCH: 'PAYMENT_AMOUNT_MISMATCH',
  PAYMENT_CURRENCY_MISMATCH: 'PAYMENT_CURRENCY_MISMATCH',
  PAYMENT_OBJECT_MISMATCH: 'PAYMENT_OBJECT_MISMATCH',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  CANCELLED_BY_CUSTOMER: 'CANCELLED_BY_CUSTOMER',
} as const;

export type TopUpFailureCode = (typeof TopUpFailureCode)[keyof typeof TopUpFailureCode];

export const TOP_UP_FAILURE_CODES: readonly TopUpFailureCode[] = Object.values(TopUpFailureCode);

// ---------------------------------------------------------------------------
// External refunds
// ---------------------------------------------------------------------------

export const PaymentRefundStatus = {
  /** Recorded, credit reserved, not yet sent to the provider. */
  REQUESTED: 'REQUESTED',
  /** The provider accepted it and is settling. */
  PENDING: 'PENDING',
  /** Verified refunded. Credit debited exactly once. */
  SUCCEEDED: 'SUCCEEDED',
  /** The provider refused it permanently. Reservation released; no debit (§73). */
  FAILED: 'FAILED',
  /** State disagreement. A person looks at it. */
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
} as const;

export type PaymentRefundStatus = (typeof PaymentRefundStatus)[keyof typeof PaymentRefundStatus];

export const PAYMENT_REFUND_STATUSES: readonly PaymentRefundStatus[] =
  Object.values(PaymentRefundStatus);

const REFUND_TRANSITIONS: Readonly<Record<PaymentRefundStatus, readonly PaymentRefundStatus[]>> = {
  REQUESTED: [
    PaymentRefundStatus.PENDING,
    PaymentRefundStatus.SUCCEEDED,
    PaymentRefundStatus.FAILED,
    PaymentRefundStatus.RECONCILIATION_REQUIRED,
  ],
  PENDING: [
    PaymentRefundStatus.SUCCEEDED,
    PaymentRefundStatus.FAILED,
    PaymentRefundStatus.RECONCILIATION_REQUIRED,
  ],
  SUCCEEDED: [],
  FAILED: [PaymentRefundStatus.RECONCILIATION_REQUIRED],
  RECONCILIATION_REQUIRED: [],
};

export function canTransitionRefund(from: PaymentRefundStatus, to: PaymentRefundStatus): boolean {
  return REFUND_TRANSITIONS[from].includes(to);
}

export function isRefundTerminal(status: PaymentRefundStatus): boolean {
  return REFUND_TRANSITIONS[status].length === 0;
}

/** Why finance is sending money back. Mapped to the provider's own vocabulary by the adapter. */
export const PaymentRefundReason = {
  REQUESTED_BY_CUSTOMER: 'REQUESTED_BY_CUSTOMER',
  DUPLICATE: 'DUPLICATE',
  FRAUDULENT: 'FRAUDULENT',
  SERVICE_NOT_DELIVERED: 'SERVICE_NOT_DELIVERED',
  GOODWILL: 'GOODWILL',
} as const;

export type PaymentRefundReason = (typeof PaymentRefundReason)[keyof typeof PaymentRefundReason];

export const PAYMENT_REFUND_REASONS: readonly PaymentRefundReason[] =
  Object.values(PaymentRefundReason);

// ---------------------------------------------------------------------------
// Provider events
// ---------------------------------------------------------------------------

/**
 * PalCert's own event vocabulary (§87).
 *
 * The adapter translates; core finance never sees `checkout.session.completed`
 * or any other provider spelling. That is what makes a second provider an
 * adapter rather than a rewrite (§35).
 */
export const PaymentEventKind = {
  PAYMENT_SUCCEEDED: 'PAYMENT_SUCCEEDED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_CANCELLED: 'PAYMENT_CANCELLED',
  PAYMENT_EXPIRED: 'PAYMENT_EXPIRED',
  REFUND_SUCCEEDED: 'REFUND_SUCCEEDED',
  REFUND_FAILED: 'REFUND_FAILED',
  PAYMENT_DISPUTED: 'PAYMENT_DISPUTED',
  DISPUTE_REVERSED: 'DISPUTE_REVERSED',
  /** Valid, signed, and of no interest to PalCert. Recorded, then ignored (§123). */
  UNSUPPORTED: 'UNSUPPORTED',
} as const;

export type PaymentEventKind = (typeof PaymentEventKind)[keyof typeof PaymentEventKind];

export const PAYMENT_EVENT_KINDS: readonly PaymentEventKind[] = Object.values(PaymentEventKind);

export const ProviderEventStatus = {
  RECEIVED: 'RECEIVED',
  PROCESSED: 'PROCESSED',
  IGNORED: 'IGNORED',
  FAILED: 'FAILED',
} as const;

export type ProviderEventStatus = (typeof ProviderEventStatus)[keyof typeof ProviderEventStatus];

export const PROVIDER_EVENT_STATUSES: readonly ProviderEventStatus[] =
  Object.values(ProviderEventStatus);

/** What a provider event is about, so processing can find the PalCert record (§150). */
export const PaymentObjectKind = {
  TOP_UP: 'TOP_UP',
  REFUND: 'REFUND',
  DISPUTE: 'DISPUTE',
  UNKNOWN: 'UNKNOWN',
} as const;

export type PaymentObjectKind = (typeof PaymentObjectKind)[keyof typeof PaymentObjectKind];

export const PAYMENT_OBJECT_KINDS: readonly PaymentObjectKind[] = Object.values(PaymentObjectKind);

export const PaymentDisputeStatus = {
  OPEN: 'OPEN',
  LOST: 'LOST',
  WON: 'WON',
} as const;

export type PaymentDisputeStatus = (typeof PaymentDisputeStatus)[keyof typeof PaymentDisputeStatus];

export const PAYMENT_DISPUTE_STATUSES: readonly PaymentDisputeStatus[] =
  Object.values(PaymentDisputeStatus);

/**
 * Provider idempotency keys (§45).
 *
 * Operation-specific and versioned, so a refund can never accidentally reuse
 * the key of a top-up, and so a deliberate change of request shape can be made
 * without colliding with keys the provider has already recorded.
 */
export function providerIdempotencyKey(
  operation: 'topup' | 'refund',
  id: string,
  action: string,
  version = 1,
): string {
  return `${operation}:${id}:${action}:v${version}`;
}
