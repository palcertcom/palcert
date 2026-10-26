/**
 * Service purchases (§5–§10, §76, §77).
 *
 * A **ServicePurchase** is one customer buying one deliverable service. Phase
 * 11 sells exactly one thing — a document check — but the domain is
 * deliberately general, because the same shape is what a later phase would
 * need to sell anything else without reinventing reservation, capture, release
 * and refund.
 *
 * Two ideas carry the whole design.
 *
 * The first is that **a purchase is not a payment**. It reserves credit at the
 * start and is charged only when the service is actually delivered. Everything
 * in between — a queue wait, an analysis, an evaluation, a report — is work
 * PalCert does at its own risk.
 *
 * The second is that **a purchase may be funded from more than one account**.
 * A customer with $2 of promotional credit and $10 of cash buys a $5 check
 * with $2 + $3, which is two reservations and two eventual charges against two
 * accounts. The purchase is what makes that one thing to the customer while
 * remaining two things in the ledger (§65).
 */

/** What is being sold. */
export const ServiceResourceType = {
  DOCUMENT_CHECK: 'DOCUMENT_CHECK',
  /** Phase 12: one deterministic correction of one document. */
  SMARTFIX: 'SMARTFIX',
  /** ADR-0149: one AI review (`ai_reviews.id`). */
  AI_REVIEW: 'AI_REVIEW',
  /** ADR-0149: one rule extraction run (`rule_extraction_runs.id`). */
  AI_RULE_EXTRACTION: 'AI_RULE_EXTRACTION',
} as const;

export type ServiceResourceType = (typeof ServiceResourceType)[keyof typeof ServiceResourceType];

export const SERVICE_RESOURCE_TYPES: readonly ServiceResourceType[] =
  Object.values(ServiceResourceType);

/**
 * Where a purchase is in its commercial life.
 *
 * Deliberately a different axis from `CheckStatus` and from
 * `ComplianceDetermination` (§7). A check can be EVALUATING while its purchase
 * is PROCESSING, and a NON_COMPLIANT determination sits on a DELIVERED
 * purchase — because the customer bought the analysis, not a passing result.
 */
export const ServicePurchaseStatus = {
  /** Credit is reserved. Nothing has been charged and no work has started. */
  RESERVED: 'RESERVED',
  /** PalCert is producing the service. Still nothing charged. */
  PROCESSING: 'PROCESSING',
  /** The service was delivered and every reservation was charged. */
  DELIVERED: 'DELIVERED',
  /** Nothing was delivered; every reservation was given back. No charge exists. */
  RELEASED: 'RELEASED',
  /** A delivered purchase later returned in full, as compensating entries. */
  REFUNDED: 'REFUNDED',
  /** The financial state does not add up. A person looks; nothing is guessed (§94). */
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
} as const;

export type ServicePurchaseStatus =
  (typeof ServicePurchaseStatus)[keyof typeof ServicePurchaseStatus];

export const SERVICE_PURCHASE_STATUSES: readonly ServicePurchaseStatus[] =
  Object.values(ServicePurchaseStatus);

/**
 * The permitted moves (§76).
 *
 * There is no way back. A RELEASED purchase does not become RESERVED again
 * when the customer retries — a retry is a new purchase, so that the billing
 * history of the first attempt survives exactly as it happened (§48).
 */
const PURCHASE_TRANSITIONS: Readonly<
  Record<ServicePurchaseStatus, readonly ServicePurchaseStatus[]>
> = {
  RESERVED: [
    ServicePurchaseStatus.PROCESSING,
    ServicePurchaseStatus.RELEASED,
    ServicePurchaseStatus.RECONCILIATION_REQUIRED,
  ],
  PROCESSING: [
    ServicePurchaseStatus.DELIVERED,
    ServicePurchaseStatus.RELEASED,
    ServicePurchaseStatus.RECONCILIATION_REQUIRED,
  ],
  DELIVERED: [ServicePurchaseStatus.REFUNDED, ServicePurchaseStatus.RECONCILIATION_REQUIRED],
  RELEASED: [ServicePurchaseStatus.RECONCILIATION_REQUIRED],
  REFUNDED: [ServicePurchaseStatus.RECONCILIATION_REQUIRED],
  // Deliberately terminal. Getting out of it is a human decision recorded as
  // compensating entries, not a state change a worker can make.
  RECONCILIATION_REQUIRED: [],
};

export function canTransitionPurchase(
  from: ServicePurchaseStatus,
  to: ServicePurchaseStatus,
): boolean {
  return PURCHASE_TRANSITIONS[from].includes(to);
}

/** Whether a purchase is still holding the customer's credit rather than having settled it. */
export function purchaseReservesCredit(status: ServicePurchaseStatus): boolean {
  return status === ServicePurchaseStatus.RESERVED || status === ServicePurchaseStatus.PROCESSING;
}

/** Whether the customer has actually been charged for this purchase. */
export function purchaseWasCharged(status: ServicePurchaseStatus): boolean {
  return status === ServicePurchaseStatus.DELIVERED || status === ServicePurchaseStatus.REFUNDED;
}

/**
 * Why a purchase ended without delivery.
 *
 * Every one of these is PalCert's failure or the customer's own choice, and
 * none of them is a charge. A document that fails its rules is not here,
 * because a failing document is a successfully delivered service (§31, §96).
 */
export const PurchaseFailureCode = {
  /** The customer stopped it before delivery. */
  CANCELLED_BY_CUSTOMER: 'CANCELLED_BY_CUSTOMER',
  /** PalCert could not produce the report. */
  SERVICE_FAILED: 'SERVICE_FAILED',
  /** The reservation timed out before the work finished (§26). */
  RESERVATION_EXPIRED: 'RESERVATION_EXPIRED',
  /** A correction after delivery, made as compensating entries (§95). */
  POST_DELIVERY_CORRECTION: 'POST_DELIVERY_CORRECTION',
} as const;

export type PurchaseFailureCode = (typeof PurchaseFailureCode)[keyof typeof PurchaseFailureCode];

/**
 * The canonical order in which financial rows are locked (§12, §81).
 *
 * Every path that settles money — create, complete, fail, cancel, reconcile —
 * takes its locks in this order and no other. Two concurrent purchases that
 * touch the same accounts therefore queue rather than deadlock.
 *
 *   1. `document_checks`        — the thing being bought
 *   2. `service_purchases`      — the commercial record
 *   3. `credit_holds`           — through the purchase's allocations
 *   4. `customer_credit_accounts` — in `FUNDING_ORDER`: PROMOTIONAL, then CASH
 *
 * It is written down here, next to the funding order it ends with, because a
 * lock order that lives only in comments in four files is not an order.
 */
export const FINANCIAL_LOCK_ORDER = [
  'document_checks',
  'service_purchases',
  'credit_holds',
  'customer_credit_accounts',
] as const;

/**
 * A purchase's own idempotency key for a hold, derived rather than random.
 *
 * Two deliveries of the same reservation must produce the same hold, and the
 * key has to be reconstructible without reading anything.
 */
export function purchaseHoldIdempotencyKey(purchaseId: string, creditClass: string): string {
  return `purchase:${purchaseId}:${creditClass}`;
}
