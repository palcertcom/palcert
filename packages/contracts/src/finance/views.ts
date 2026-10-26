import type { CreditClass, LedgerEntryType, LedgerReasonCode } from './ledger.js';
import type { CreditHoldPurpose, CreditHoldStatus } from './holds.js';
import type { MoneyView } from './money.js';
import type {
  PaymentRefundReason,
  PaymentRefundStatus,
  TopUpFailureCode,
  TopUpStatus,
} from './payments.js';
import type { PriceVersionStatus, ServiceProductCode } from './pricing.js';
import type {
  PurchaseFailureCode,
  ServicePurchaseStatus,
  ServiceResourceType,
} from './purchases.js';

/**
 * What Phase 10 returns over HTTP (§62, §64, §158).
 *
 * Two things are deliberately absent from every shape here: internal
 * accounting identifiers, and anything the payment provider told PalCert in
 * confidence. A customer sees their money and where it went. They do not see
 * PalCert's ledger account ids, a provider session, or a secret.
 */

/** A single account's position: what is there, and what is already spoken for. */
export interface CreditBalanceView {
  readonly currency: string;
  readonly creditClass: CreditClass;
  /** Everything the ledger says, including money reserved by an active hold. */
  readonly ledgerBalance: MoneyView;
  /** Reserved by active holds. Not spendable, not yet spent. */
  readonly reserved: MoneyView;
  /** `ledgerBalance - reserved`. What a new hold may draw on (§17). */
  readonly available: MoneyView;
}

/** The balance page's whole answer, per currency (§62). */
export interface BalanceSummaryView {
  readonly currency: string;
  readonly available: MoneyView;
  readonly reserved: MoneyView;
  readonly cash: MoneyView;
  readonly promotional: MoneyView;
  readonly accounts: readonly CreditBalanceView[];
}

/**
 * One line of transaction history (§63).
 *
 * `publicId` is the ledger entry's own id, which is safe to show: it names a
 * row the customer owns. What is *not* here is the internal account id — the
 * currency and credit class say everything a person needs (§64).
 */
export interface LedgerEntryView {
  readonly publicId: string;
  readonly entryType: LedgerEntryType;
  readonly creditClass: CreditClass;
  readonly amount: MoneyView;
  readonly reasonCode: LedgerReasonCode | null;
  /** Set when this entry corrects an earlier one (§13). */
  readonly reversalOfEntryId: string | null;
  /**
   * The service a charge paid for, when it paid for one — so history can say
   * "AI review" instead of a generic "service completed" (ADR-0149). Derived
   * from the entry's hold and purchase; never stored on the entry itself.
   */
  readonly serviceProductCode?: ServiceProductCode | null;
  readonly createdAt: string;
}

export interface CreditHoldView {
  readonly id: string;
  readonly status: CreditHoldStatus;
  readonly purpose: CreditHoldPurpose;
  readonly amount: MoneyView;
  readonly creditClass: CreditClass;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly capturedAt: string | null;
  readonly releasedAt: string | null;
  readonly expiredAt: string | null;
}

export interface BalanceTopUpView {
  readonly id: string;
  readonly status: TopUpStatus;
  readonly amount: MoneyView;
  /** Which company processed it. Not a session, not a payment id (§64). */
  readonly provider: string;
  readonly failureCode: TopUpFailureCode | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly succeededAt: string | null;
  readonly failedAt: string | null;
  readonly cancelledAt: string | null;
}

/**
 * A newly created top-up plus where to send the customer.
 *
 * The checkout URL is returned once, to the authenticated customer who asked
 * for it, and is never stored or logged (§92).
 */
export interface CreateTopUpResponseView {
  readonly topUp: BalanceTopUpView;
  readonly checkoutUrl: string;
  readonly expiresAt: string;
}

export interface PaymentRefundView {
  readonly id: string;
  readonly topUpId: string;
  readonly status: PaymentRefundStatus;
  readonly amount: MoneyView;
  readonly reason: PaymentRefundReason | null;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly succeededAt: string | null;
  readonly failedAt: string | null;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface ServiceProductView {
  readonly productCode: ServiceProductCode;
  readonly active: boolean;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
}

export interface PriceVersionView {
  readonly id: string;
  readonly productCode: ServiceProductCode;
  readonly marketCode: string;
  readonly amount: MoneyView;
  readonly status: PriceVersionStatus;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly createdAt: string;
  readonly activatedAt: string | null;
}

/**
 * A quote (§30, §31, §32).
 *
 * The amount is captured at creation. A price change afterwards does not reach
 * back and alter it: PalCert honours what it quoted until the quote expires.
 */
export interface PriceQuoteView {
  readonly id: string;
  readonly productCode: ServiceProductCode;
  readonly amount: MoneyView;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly expired: boolean;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** What finance sees of a customer's position. Same shape, different route. */
export interface AdminBalanceView extends BalanceSummaryView {
  readonly ownerUserId: string;
}

/** The read-only invariant check (§153, §154). */
export interface LedgerVerificationView {
  readonly checkedAt: string;
  readonly accountsChecked: number;
  readonly entriesChecked: number;
  readonly findings: readonly {
    readonly code: string;
    readonly detail: string;
    readonly subjectId: string;
  }[];
  readonly consistent: boolean;
}

// ---------------------------------------------------------------------------
// Paid services (Phase 11)
// ---------------------------------------------------------------------------

/**
 * What a customer is told about the money behind one service (§50, §88).
 *
 * Three amounts rather than one, because "reserved" and "charged" are
 * genuinely different states and a customer who is shown only a price cannot
 * tell which one they are in. `reserved` is money set aside and still theirs;
 * `charged` is money that has gone.
 *
 * No hold id, no account id, no ledger entry id. The purchase's own id is the
 * only handle, and it is the one PalCert would quote back in support.
 */
export interface ServiceBillingView {
  readonly purchaseId: string;
  readonly productCode: ServiceProductCode;
  readonly status: ServicePurchaseStatus;
  /** The purchase price, frozen from the quote. */
  readonly amount: MoneyView;
  /** Still reserved and still the customer's: zero once settled either way. */
  readonly reserved: MoneyView;
  /** Actually taken. Zero until delivery, and zero for ever if it never happens. */
  readonly charged: MoneyView;
  /** Why it ended without delivery, when it did. */
  readonly failureCode: PurchaseFailureCode | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly releasedAt: string | null;
  readonly refundedAt: string | null;
}

/** One purchase, for the customer's own history. */
export interface ServicePurchaseView extends ServiceBillingView {
  readonly resourceType: ServiceResourceType;
  readonly resourceId: string;
  readonly currency: string;
}

/**
 * What finance sees of a purchase (§131).
 *
 * It adds the allocation breakdown, because a reconciliation question is
 * almost always "which class paid what". It still carries no ledger account
 * id: the credit class is the answer to that question.
 */
export interface AdminServicePurchaseView extends ServicePurchaseView {
  readonly ownerUserId: string;
  readonly priceQuoteId: string;
  readonly priceVersionId: string;
  readonly allocations: readonly {
    readonly creditClass: CreditClass;
    readonly amount: MoneyView;
    readonly holdStatus: CreditHoldStatus;
  }[];
}

/**
 * Purchases and revenue by product (ADR-0149).
 *
 * One row per product **and currency**: amounts in different currencies are
 * never added together. Read from the purchases themselves — the purchase,
 * its holds and the ledger remain the financial authority; this is a view of
 * them, not a second ledger.
 */
export interface ServicePurchaseSummaryRowView {
  readonly productCode: ServiceProductCode;
  readonly currency: string;
  readonly purchaseCount: number;
  /** Still holding credit: RESERVED or PROCESSING. */
  readonly reservedCount: number;
  readonly reservedAmount: MoneyView;
  /** Delivered and charged (including any later refunded). */
  readonly capturedCount: number;
  readonly capturedAmount: MoneyView;
  /** Ended without delivery; nothing was charged. */
  readonly releasedCount: number;
  readonly refundedCount: number;
  readonly refundedAmount: MoneyView;
  readonly reconciliationCount: number;
}

export interface ServicePurchaseSummaryView {
  readonly from: string | null;
  readonly to: string | null;
  readonly rows: readonly ServicePurchaseSummaryRowView[];
}

/** One purchase in the admin report, with the context finance may see. */
export interface AdminPurchaseReportRowView {
  readonly purchaseId: string;
  readonly productCode: ServiceProductCode;
  readonly resourceType: ServiceResourceType;
  readonly resourceId: string;
  readonly status: ServicePurchaseStatus;
  readonly amount: MoneyView;
  readonly payer: { readonly userId: string; readonly email: string; readonly displayName: string | null };
  /** The organization an organization-scoped AI run belonged to; it did not pay. */
  readonly organization: { readonly id: string; readonly name: string } | null;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly releasedAt: string | null;
}
