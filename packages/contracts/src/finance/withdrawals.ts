import {
  normalizeIban,
  normalizeMobileNumber,
  type ManualTopUpFileFormat,
  type ManualTopUpFileStatus,
  type ManualTopUpUploadAuthorizationView,
} from './manual-topups.js';
import { CURRENCY_CODES, currencyExponent, type MoneyView } from './money.js';

/**
 * Withdrawals and payouts (ADR-0150).
 *
 * One controlled workflow pays money out of PalCert at three scopes: a user's
 * own eligible real money, an organization's settled attestation earnings,
 * and PalCert's own realized revenue. Every request is reserved the moment it
 * is submitted, reviewed and approved by PalCert finance, paid outside
 * PalCert by a person, and recorded with the external transfer reference —
 * at which point, and only then, the financial movement is finalized, exactly
 * once.
 *
 * Nothing here moves money. This module is the shared vocabulary, the
 * validators and the withdrawability formulas. The formulas are pure so the
 * accounting policy can be tested on its own, and so a future engineer who
 * wants to "simplify" them has to change a function with a test beside it.
 *
 * Browser-safe: no `node:` imports. The web app uses it through the
 * `@palcert/contracts/finance/withdrawals` subpath.
 */

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Whose money a withdrawal pays out. Exactly one per request.
 *
 * Organizations and PalCert are never represented as users: an organization
 * request names an organization, a platform request names nobody but PalCert.
 */
export const WithdrawalScope = {
  /** A person's own eligible real money from their PalCert Balance. */
  USER: 'USER',
  /** An organization's settled attestation earnings (its net share only). */
  ORGANIZATION: 'ORGANIZATION',
  /** PalCert's own realized platform revenue. */
  PLATFORM: 'PLATFORM',
} as const;

export type WithdrawalScope = (typeof WithdrawalScope)[keyof typeof WithdrawalScope];

export const WITHDRAWAL_SCOPES: readonly WithdrawalScope[] = Object.values(WithdrawalScope);

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The life of one withdrawal.
 *
 *   DRAFT          -> PENDING_REVIEW   submitted; the amount is reserved
 *   DRAFT          -> CANCELLED
 *   PENDING_REVIEW -> APPROVED         finance authorizes the payout
 *   PENDING_REVIEW -> REJECTED         finance refuses; reservation released
 *   PENDING_REVIEW -> CANCELLED        requester withdraws; reservation released
 *   APPROVED       -> PROCESSING       an executor starts the external transfer
 *   APPROVED       -> CANCELLED        requester or finance; reservation released
 *   PROCESSING     -> PAID             transfer reference recorded; settled once
 *   PROCESSING     -> FAILED           the attempt failed; reservation KEPT
 *   FAILED         -> PROCESSING       finance retries (a new attempt)
 *   FAILED         -> CANCELLED        finance releases deliberately, with a reason
 *
 * PAID, REJECTED and CANCELLED are terminal. A correction after PAID is a new
 * compensating operation, never an edit of payout history. FAILED is not
 * terminal and never releases anything by itself: an external transfer that
 * "failed" may still settle later.
 */
export const WithdrawalStatus = {
  DRAFT: 'DRAFT',
  PENDING_REVIEW: 'PENDING_REVIEW',
  APPROVED: 'APPROVED',
  PROCESSING: 'PROCESSING',
  PAID: 'PAID',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
} as const;

export type WithdrawalStatus = (typeof WithdrawalStatus)[keyof typeof WithdrawalStatus];

export const WITHDRAWAL_STATUSES: readonly WithdrawalStatus[] = Object.values(WithdrawalStatus);

export const TERMINAL_WITHDRAWAL_STATUSES: readonly WithdrawalStatus[] = [
  WithdrawalStatus.PAID,
  WithdrawalStatus.REJECTED,
  WithdrawalStatus.CANCELLED,
];

export function isTerminalWithdrawalStatus(status: WithdrawalStatus): boolean {
  return TERMINAL_WITHDRAWAL_STATUSES.includes(status);
}

/** States in which the requested amount is reserved and unavailable elsewhere. */
export const RESERVING_WITHDRAWAL_STATUSES: readonly WithdrawalStatus[] = [
  WithdrawalStatus.PENDING_REVIEW,
  WithdrawalStatus.APPROVED,
  WithdrawalStatus.PROCESSING,
  WithdrawalStatus.FAILED,
];

/** The transitions the state machine allows. The database enforces the same table. */
export const WITHDRAWAL_TRANSITIONS: Readonly<
  Record<WithdrawalStatus, readonly WithdrawalStatus[]>
> = {
  DRAFT: [WithdrawalStatus.PENDING_REVIEW, WithdrawalStatus.CANCELLED],
  PENDING_REVIEW: [
    WithdrawalStatus.APPROVED,
    WithdrawalStatus.REJECTED,
    WithdrawalStatus.CANCELLED,
  ],
  APPROVED: [WithdrawalStatus.PROCESSING, WithdrawalStatus.CANCELLED],
  PROCESSING: [WithdrawalStatus.PAID, WithdrawalStatus.FAILED],
  FAILED: [WithdrawalStatus.PROCESSING, WithdrawalStatus.CANCELLED],
  PAID: [],
  REJECTED: [],
  CANCELLED: [],
};

export function canTransitionWithdrawal(from: WithdrawalStatus, to: WithdrawalStatus): boolean {
  return WITHDRAWAL_TRANSITIONS[from].includes(to);
}

/** Why finance refused a withdrawal. The requester is told the reason. */
export const WithdrawalRejectionReason = {
  DESTINATION_INVALID: 'DESTINATION_INVALID',
  BENEFICIARY_MISMATCH: 'BENEFICIARY_MISMATCH',
  VERIFICATION_REQUIRED: 'VERIFICATION_REQUIRED',
  POLICY_VIOLATION: 'POLICY_VIOLATION',
  SUSPECTED_FRAUD: 'SUSPECTED_FRAUD',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  OTHER: 'OTHER',
} as const;

export type WithdrawalRejectionReason =
  (typeof WithdrawalRejectionReason)[keyof typeof WithdrawalRejectionReason];

export const WITHDRAWAL_REJECTION_REASONS: readonly WithdrawalRejectionReason[] =
  Object.values(WithdrawalRejectionReason);

/** One entry in a request's append-only timeline. */
export const WithdrawalEventType = {
  CREATED: 'CREATED',
  SUBMITTED: 'SUBMITTED',
  RESERVED: 'RESERVED',
  REVIEW_STARTED: 'REVIEW_STARTED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  EXECUTION_STARTED: 'EXECUTION_STARTED',
  PAID: 'PAID',
  FAILED: 'FAILED',
  RETRY_STARTED: 'RETRY_STARTED',
  RESERVATION_RELEASED: 'RESERVATION_RELEASED',
  PROOF_ATTACHED: 'PROOF_ATTACHED',
} as const;

export type WithdrawalEventType = (typeof WithdrawalEventType)[keyof typeof WithdrawalEventType];

export const WITHDRAWAL_EVENT_TYPES: readonly WithdrawalEventType[] =
  Object.values(WithdrawalEventType);

/** Who wrote a timeline entry. */
export const WithdrawalActorSide = {
  REQUESTER: 'REQUESTER',
  FINANCE: 'FINANCE',
} as const;

export type WithdrawalActorSide = (typeof WithdrawalActorSide)[keyof typeof WithdrawalActorSide];

/** The outcome of one external transfer attempt. */
export const WithdrawalAttemptOutcome = {
  IN_PROGRESS: 'IN_PROGRESS',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;

export type WithdrawalAttemptOutcome =
  (typeof WithdrawalAttemptOutcome)[keyof typeof WithdrawalAttemptOutcome];

/** An organization or platform reservation against derived entitlement. */
export const WithdrawalReservationStatus = {
  ACTIVE: 'ACTIVE',
  CONSUMED: 'CONSUMED',
  RELEASED: 'RELEASED',
} as const;

export type WithdrawalReservationStatus =
  (typeof WithdrawalReservationStatus)[keyof typeof WithdrawalReservationStatus];

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Configurable policy and its bounds. A withdrawal fee does not exist in v1:
 * if one is ever introduced it will be an explicit, versioned policy here,
 * never a hidden deduction.
 */
export const WITHDRAWAL_POLICY_BOUNDS = {
  /** Days a verified manual top-up waits before it is withdrawable. */
  userManualTopUpClearingDays: { min: 0, max: 90, default: 14 },
  /** Days settled organization earnings wait before they are withdrawable. */
  organizationClearingDays: { min: 0, max: 180, default: 30 },
} as const;

export const WITHDRAWAL_FEE_MINOR = 0n;

/**
 * The currencies a payout can be in — every currency PalCert supports.
 * Re-exported here so the browser can import it from this module, which
 * pulls in nothing server-only.
 */
export const WITHDRAWAL_CURRENCIES: readonly string[] = CURRENCY_CODES;

export const WITHDRAWAL_LIMITS = {
  requesterNote: 500,
  rejectionNote: 1000,
  executionNote: 1000,
  externalReference: 120,
  releaseNote: 1000,
  /** Open (reserving) withdrawals one beneficiary may hold at once, per scope. */
  maxOpenPerBeneficiary: 5,
} as const;

/** The deterministic key that makes a payout's settlement exactly-once. */
export function withdrawalSettlementKey(requestId: string): string {
  return `withdrawal:${requestId}:settle`;
}

/** The key that makes a user withdrawal's reservation exactly-once. */
export function withdrawalReservationKey(requestId: string): string {
  return `withdrawal:${requestId}:reserve`;
}

// ---------------------------------------------------------------------------
// Withdrawability formulas — the accounting policy, as pure functions
// ---------------------------------------------------------------------------

function nonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * A user's withdrawable amount in one currency (ADR-0150 §User).
 *
 * DELIBERATELY CONSERVATIVE. PalCert's CASH account is one pooled balance:
 * a ledger debit is not linked to the credit it consumed, and CASH is also
 * written by finance adjustments (ADMIN_CREDIT) and by card top-ups. Exact
 * real-money provenance therefore cannot be recovered from history, so the
 * formula assumes every CASH outflow consumed eligible real money FIRST:
 *
 *   eligible = cleared eligible inflows − every CASH outflow (incl. paid
 *              withdrawals) − active withdrawal reservations
 *   withdrawable = min(eligible, spendable CASH after all active holds)
 *
 * never below zero. Eligible inflows are verified manual top-ups past their
 * clearing period — nothing else. Card top-ups (v1: refund to source
 * instead), admin credits, chargeback reversals and promotional credit never
 * contribute. A user may be under-counted; non-real-money credit can never
 * leave PalCert as cash.
 *
 * Do NOT replace this with "withdrawable = CASH balance". That would let an
 * ADMIN_CREDIT, or a stolen card's top-up, be paid out to a bank account.
 */
export function computeUserWithdrawable(input: {
  /** Σ verified manual top-up credits whose clearing period has ended. */
  readonly clearedEligibleInflowsMinor: bigint;
  /** Σ |every negative CASH entry|, including paid withdrawals. */
  readonly cashOutflowsMinor: bigint;
  /** Σ ACTIVE withdrawal holds (pending, approved, processing, failed). */
  readonly activeWithdrawalReservationsMinor: bigint;
  /** CASH ledger balance (may be negative after a chargeback). */
  readonly cashLedgerBalanceMinor: bigint;
  /** Σ every ACTIVE CASH hold, withdrawal holds included. */
  readonly activeCashHoldsMinor: bigint;
}): { eligibleMinor: bigint; spendableMinor: bigint; withdrawableMinor: bigint } {
  const eligibleMinor = nonNegative(
    input.clearedEligibleInflowsMinor -
      input.cashOutflowsMinor -
      input.activeWithdrawalReservationsMinor,
  );
  const spendableMinor = nonNegative(input.cashLedgerBalanceMinor - input.activeCashHoldsMinor);
  return { eligibleMinor, spendableMinor, withdrawableMinor: min(eligibleMinor, spendableMinor) };
}

/**
 * An organization's payout availability in one currency (ADR-0150 §Organization).
 *
 * Only the settled INSTITUTION net share is the organization's money — never
 * the gross fee, never PalCert's commission, never an unsettled fee — and it
 * becomes withdrawable once its clearing period has ended.
 */
export function computeOrganizationAvailable(input: {
  /** Σ INSTITUTION revenue settled before the clearing cutoff. */
  readonly clearedNetMinor: bigint;
  /** Σ INSTITUTION revenue still inside the clearing period. */
  readonly clearingNetMinor: bigint;
  /** Σ PAID organization withdrawals. */
  readonly paidOutMinor: bigint;
  /** Σ ACTIVE organization reservations. */
  readonly reservedMinor: bigint;
}): { realizedMinor: bigint; availableMinor: bigint } {
  return {
    realizedMinor: input.clearedNetMinor + input.clearingNetMinor,
    availableMinor: nonNegative(input.clearedNetMinor - input.paidOutMinor - input.reservedMinor),
  };
}

/**
 * PalCert's payout availability in one currency (ADR-0150 §Platform).
 *
 * Realized economic revenue only: the CASH-funded part of captured services
 * plus settled attestation commission, less service refunds, unrecovered
 * chargeback losses, paid platform payouts and active platform reservations.
 * Promotional-funded captures are excluded — PalCert received no money for
 * them. When a source cannot be reconciled exactly, the caller passes the
 * conservative figure, so availability is understated rather than overstated.
 */
export function computePlatformAvailable(input: {
  readonly cashServiceRevenueMinor: bigint;
  readonly attestationCommissionMinor: bigint;
  readonly serviceRefundsMinor: bigint;
  readonly unrecoveredChargebackLossMinor: bigint;
  readonly paidOutMinor: bigint;
  readonly reservedMinor: bigint;
}): { realizedMinor: bigint; availableMinor: bigint } {
  const realizedMinor = nonNegative(
    input.cashServiceRevenueMinor +
      input.attestationCommissionMinor -
      input.serviceRefundsMinor -
      input.unrecoveredChargebackLossMinor,
  );
  return {
    realizedMinor,
    availableMinor: nonNegative(realizedMinor - input.paidOutMinor - input.reservedMinor),
  };
}

// ---------------------------------------------------------------------------
// Payout destinations
// ---------------------------------------------------------------------------

/** How a payout is received. Decides which fields a destination requires. */
export const PayoutDestinationType = {
  BANK_ACCOUNT: 'BANK_ACCOUNT',
  MOBILE_WALLET: 'MOBILE_WALLET',
  OTHER: 'OTHER',
} as const;

export type PayoutDestinationType =
  (typeof PayoutDestinationType)[keyof typeof PayoutDestinationType];

export const PAYOUT_DESTINATION_TYPES: readonly PayoutDestinationType[] =
  Object.values(PayoutDestinationType);

export const PAYOUT_DESTINATION_LIMITS = {
  label: 80,
  beneficiaryName: 140,
  bankName: 120,
  iban: 34,
  accountNumber: 40,
  branch: 120,
  mobileNumber: 32,
  instructions: 500,
} as const;

/** The sensitive part of a destination, sealed at rest and never emailed. */
export interface PayoutDestinationDetails {
  readonly bankName: string | null;
  readonly iban: string | null;
  readonly accountNumber: string | null;
  readonly branch: string | null;
  readonly mobileNumber: string | null;
  readonly instructions: string | null;
}

export interface PayoutDestinationInput extends PayoutDestinationDetails {
  readonly type: PayoutDestinationType;
  readonly label: string;
  readonly beneficiaryName: string;
  readonly currency: string | null;
}

export interface PayoutDestinationValidationIssue {
  readonly field: string;
  readonly code: 'REQUIRED' | 'TOO_LONG' | 'INVALID';
}

function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Normalize and validate a destination. Irrelevant fields are dropped rather
 * than stored: a mobile wallet keeps no IBAN, a bank account no phone number.
 */
export function normalizePayoutDestination(input: PayoutDestinationInput): {
  readonly value: PayoutDestinationInput;
  readonly issues: readonly PayoutDestinationValidationIssue[];
} {
  const issues: PayoutDestinationValidationIssue[] = [];
  const limit = (field: keyof typeof PAYOUT_DESTINATION_LIMITS, value: string | null) => {
    if (value !== null && value.length > PAYOUT_DESTINATION_LIMITS[field]) {
      issues.push({ field, code: 'TOO_LONG' });
    }
  };

  const type = (PAYOUT_DESTINATION_TYPES as readonly string[]).includes(input.type)
    ? input.type
    : null;
  if (type === null) issues.push({ field: 'type', code: 'INVALID' });

  const label = clean(input.label);
  const beneficiaryName = clean(input.beneficiaryName);
  if (label === null) issues.push({ field: 'label', code: 'REQUIRED' });
  if (beneficiaryName === null) issues.push({ field: 'beneficiaryName', code: 'REQUIRED' });
  limit('label', label);
  limit('beneficiaryName', beneficiaryName);

  const currency = clean(input.currency);
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    issues.push({ field: 'currency', code: 'INVALID' });
  }

  let bankName = clean(input.bankName);
  const rawIban = clean(input.iban);
  let iban = rawIban === null ? null : normalizeIban(rawIban);
  let accountNumber = clean(input.accountNumber)?.replace(/\s/g, '') ?? null;
  let branch = clean(input.branch);
  const rawMobile = clean(input.mobileNumber);
  let mobileNumber = rawMobile === null ? null : normalizeMobileNumber(rawMobile);
  const instructions = clean(input.instructions);
  limit('instructions', instructions);

  if (type === PayoutDestinationType.BANK_ACCOUNT) {
    mobileNumber = null;
    if (rawIban !== null && iban === null) issues.push({ field: 'iban', code: 'INVALID' });
    if (rawIban === null && accountNumber === null) {
      issues.push({ field: 'iban', code: 'REQUIRED' });
    }
    if (accountNumber !== null && !/^[A-Za-z0-9-]{4,40}$/.test(accountNumber)) {
      issues.push({ field: 'accountNumber', code: 'INVALID' });
    }
    if (iban === null && bankName === null) issues.push({ field: 'bankName', code: 'REQUIRED' });
  } else if (type === PayoutDestinationType.MOBILE_WALLET) {
    iban = null;
    accountNumber = null;
    branch = null;
    if (rawMobile === null) issues.push({ field: 'mobileNumber', code: 'REQUIRED' });
    else if (mobileNumber === null) issues.push({ field: 'mobileNumber', code: 'INVALID' });
  } else if (type === PayoutDestinationType.OTHER) {
    if (instructions === null) issues.push({ field: 'instructions', code: 'REQUIRED' });
  }
  limit('bankName', bankName);
  limit('accountNumber', accountNumber);
  limit('branch', branch);
  if (bankName !== null && bankName.length === 0) bankName = null;

  return {
    value: {
      type: (type ?? PayoutDestinationType.OTHER) as PayoutDestinationType,
      label: label ?? '',
      beneficiaryName: beneficiaryName ?? '',
      currency,
      bankName,
      iban,
      accountNumber,
      branch,
      mobileNumber,
      instructions,
    },
    issues,
  };
}

/** The last four characters, everything before them hidden: `•••• 3456`. */
export function maskTail(value: string | null | undefined, visible = 4): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  const tail = value.slice(-visible);
  return `•••• ${tail}`;
}

/**
 * The non-sensitive description of a destination, safe to show a requester,
 * a list and an auditor, and to store in a snapshot in the clear. Account
 * identifiers appear only as their last four characters.
 */
export interface PayoutDestinationSummary {
  readonly type: PayoutDestinationType;
  readonly label: string;
  readonly beneficiaryName: string;
  readonly bankName: string | null;
  readonly ibanMasked: string | null;
  readonly accountNumberMasked: string | null;
  readonly mobileNumberMasked: string | null;
  readonly currency: string | null;
}

export function summarizePayoutDestination(
  value: PayoutDestinationInput,
): PayoutDestinationSummary {
  return {
    type: value.type,
    label: value.label,
    beneficiaryName: value.beneficiaryName,
    bankName: value.bankName,
    ibanMasked: maskTail(value.iban),
    accountNumberMasked: maskTail(value.accountNumber),
    mobileNumberMasked: maskTail(value.mobileNumber, 3),
    currency: value.currency,
  };
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/** Whole minor units from a decimal string, or null if it has too many decimals. */
export function withdrawalAmountToMinor(value: string, currency: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const exponent = currencyExponent(currency);
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > exponent) return null;
  return BigInt(`${whole}${fraction.padEnd(exponent, '0')}`);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface PayoutDestinationView extends PayoutDestinationSummary {
  readonly id: string;
  readonly scope: WithdrawalScope;
  readonly organizationId: string | null;
  readonly version: number;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A user's withdrawable breakdown for one currency, in plain terms. */
export interface UserWithdrawableView {
  readonly currency: string;
  /** Cash balance (ledger), which may include card and adjustment credit. */
  readonly cashBalance: MoneyView;
  readonly promotionalBalance: MoneyView;
  /** Reserved by services, refunds and withdrawals. */
  readonly reserved: MoneyView;
  readonly reservedForWithdrawal: MoneyView;
  /** Verified manual top-ups still inside their clearing period. */
  readonly clearing: MoneyView;
  /** Cash that is spendable but not withdrawable (card top-ups, adjustments). */
  readonly notWithdrawable: MoneyView;
  readonly withdrawable: MoneyView;
  readonly clearingDays: number;
  readonly minimum: MoneyView | null;
  readonly maximum: MoneyView | null;
}

/** Organization or platform funds for one currency. Never summed across currencies. */
export interface PayoutFundsRowView {
  readonly currency: string;
  readonly realized: MoneyView;
  readonly clearing: MoneyView;
  readonly reserved: MoneyView;
  readonly paidOut: MoneyView;
  readonly available: MoneyView;
  readonly minimum: MoneyView | null;
  readonly maximum: MoneyView | null;
}

export interface OrganizationEarningsView {
  readonly organizationId: string;
  readonly clearingDays: number;
  readonly rows: readonly PayoutFundsRowView[];
}

/** PalCert's platform funds, with the sources behind the realized figure. */
export interface PlatformFundsRowView extends PayoutFundsRowView {
  readonly cashServiceRevenue: MoneyView;
  readonly attestationCommission: MoneyView;
  readonly serviceRefunds: MoneyView;
  readonly unrecoveredChargebackLoss: MoneyView;
}

export interface PlatformFundsView {
  readonly rows: readonly PlatformFundsRowView[];
}

export interface WithdrawalEventView {
  readonly id: string;
  readonly eventType: WithdrawalEventType;
  readonly actorSide: WithdrawalActorSide;
  readonly actorDisplayName: string | null;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface WithdrawalAttemptView {
  readonly attemptNumber: number;
  readonly outcome: WithdrawalAttemptOutcome;
  readonly startedByDisplayName: string | null;
  readonly startedAt: string;
  readonly finishedByDisplayName: string | null;
  readonly finishedAt: string | null;
  readonly externalReference: string | null;
  readonly note: string | null;
}

/** What a requester sees about their own request. */
export interface WithdrawalRequestView {
  readonly id: string;
  /** A short human reference, the first eight characters of the id, upper case. */
  readonly reference: string;
  readonly scope: WithdrawalScope;
  readonly status: WithdrawalStatus;
  readonly amount: MoneyView;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly beneficiaryName: string;
  readonly destination: PayoutDestinationSummary;
  readonly requesterNote: string | null;
  readonly rejectionReason: WithdrawalRejectionReason | null;
  readonly rejectionNote: string | null;
  readonly externalTransferReference: string | null;
  readonly hasProof: boolean;
  readonly cancellable: boolean;
  readonly submittedAt: string | null;
  readonly approvedAt: string | null;
  readonly rejectedAt: string | null;
  readonly cancelledAt: string | null;
  readonly executedAt: string | null;
  readonly createdAt: string;
  readonly version: number;
  readonly events: readonly WithdrawalEventView[];
}

/** What PalCert finance sees. The full destination is a separate, audited read. */
export interface AdminWithdrawalRequestView extends WithdrawalRequestView {
  readonly requesterUserId: string;
  readonly requesterDisplayName: string | null;
  readonly requesterEmail: string;
  readonly beneficiaryUserId: string | null;
  readonly availableBeforeRequest: MoneyView;
  readonly reviewStartedAt: string | null;
  readonly reviewedByUserId: string | null;
  readonly approvedByUserId: string | null;
  readonly rejectedByUserId: string | null;
  readonly executedByUserId: string | null;
  readonly releaseNote: string | null;
  readonly attempts: readonly WithdrawalAttemptView[];
  /** Whether the reservation the request holds still exists as it should. */
  readonly reservationActive: boolean;
  /** What the acting user may do next, given separation of duties. */
  readonly allowedActions: readonly WithdrawalAction[];
}

export const WithdrawalAction = {
  START_REVIEW: 'START_REVIEW',
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  START_EXECUTION: 'START_EXECUTION',
  MARK_PAID: 'MARK_PAID',
  MARK_FAILED: 'MARK_FAILED',
  RETRY: 'RETRY',
  RELEASE: 'RELEASE',
} as const;

export type WithdrawalAction = (typeof WithdrawalAction)[keyof typeof WithdrawalAction];

export interface WithdrawalQueueItemView {
  readonly id: string;
  readonly reference: string;
  readonly scope: WithdrawalScope;
  readonly status: WithdrawalStatus;
  readonly amount: MoneyView;
  readonly requesterDisplayName: string | null;
  readonly requesterEmail: string;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly beneficiaryName: string;
  readonly destinationType: PayoutDestinationType;
  readonly submittedAt: string | null;
  readonly executedAt: string | null;
}

export interface WithdrawalQueueView {
  readonly items: readonly WithdrawalQueueItemView[];
  readonly nextCursor: string | null;
  /** Open amounts per status and currency. Never summed across currencies. */
  readonly totals: readonly {
    readonly status: WithdrawalStatus;
    readonly currency: string;
    readonly count: number;
    readonly total: MoneyView;
  }[];
}

/** The full payout instructions, for authorized finance only. Audited on every read. */
export interface WithdrawalDestinationRevealView extends PayoutDestinationSummary {
  readonly iban: string | null;
  readonly accountNumber: string | null;
  readonly branch: string | null;
  readonly mobileNumber: string | null;
  readonly instructions: string | null;
}

export interface WithdrawalPolicyView {
  readonly userManualTopUpClearingDays: number;
  readonly organizationClearingDays: number;
  readonly limits: readonly {
    readonly currency: string;
    readonly minimum: MoneyView | null;
    readonly maximum: MoneyView | null;
  }[];
  readonly feeMinorUnits: '0';
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface WithdrawalReviewerView {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string;
  readonly eligible: boolean;
  readonly assignedAt: string;
}

export interface WithdrawalReviewerCandidateView {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string;
}

/** How a submission alert was routed. */
export const WithdrawalReviewerRouting = {
  ASSIGNED_REVIEWERS: 'ASSIGNED_REVIEWERS',
  FALLBACK_NO_ELIGIBLE: 'FALLBACK_NO_ELIGIBLE',
  GLOBAL_NOT_CONFIGURED: 'GLOBAL_NOT_CONFIGURED',
} as const;

export type WithdrawalReviewerRouting =
  (typeof WithdrawalReviewerRouting)[keyof typeof WithdrawalReviewerRouting];

export interface WithdrawalNotificationReportView {
  readonly routing: WithdrawalReviewerRouting | null;
  readonly noReviewerAvailable: boolean;
  readonly recipients: readonly {
    readonly userId: string;
    readonly displayName: string | null;
    readonly emailMasked: string;
    readonly emailVerified: boolean;
    readonly notificationType: string;
    readonly notifiedAt: string;
    readonly inAppStatus: string | null;
    readonly emailStatus: string | null;
    readonly emailSkipReason: string | null;
    readonly emailAttempts: number | null;
  }[];
}

export interface WithdrawalReconciliationView {
  readonly checkedAt: string;
  readonly requestsChecked: number;
  readonly consistent: boolean;
  readonly findings: readonly {
    readonly code: string;
    readonly detail: string;
    readonly subjectId: string;
  }[];
}

/** A short, human-readable reference for a request id. */
export function withdrawalReference(id: string): string {
  return `W-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/** A payout proof as finance and the requester see it. Never public, never emailed. */
export interface WithdrawalProofView {
  readonly id: string;
  readonly status: ManualTopUpFileStatus;
  readonly originalFilename: string;
  readonly format: ManualTopUpFileFormat | null;
  readonly sizeBytes: number | null;
  readonly rejectionCode: string | null;
  readonly createdAt: string;
}

export interface WithdrawalProofUploadResponse {
  readonly proof: WithdrawalProofView;
  readonly upload: ManualTopUpUploadAuthorizationView;
}
