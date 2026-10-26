import { currencyExponent, type MoneyView } from './money.js';

/**
 * Manual top-ups: a person pays PalCert by bank or wallet transfer outside
 * PalCert, says so, and a finance reviewer credits the balance after matching
 * the transfer against the receiving account.
 *
 * Nothing in this module moves money. The only thing that ever turns a request
 * into credit is a finance approval, which appends exactly one
 * `MANUAL_TOPUP_CREDIT` entry to the same ledger every other balance change
 * goes through. There is no second wallet and no balance column.
 *
 * Browser-safe: imports nothing that reaches `node:` modules, so the web app
 * can use the vocabularies and validators below at runtime through the
 * `@palcert/contracts/finance/manual-topups` subpath.
 */

// ---------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------

/** How a method receives money. Decides which destination fields it requires. */
export const ManualPaymentMethodType = {
  /** A mobile wallet such as Jawwal Pay or PalPay: a phone number and a name. */
  MOBILE_WALLET: 'MOBILE_WALLET',
  /** A bank account such as Bank of Palestine: an IBAN or account number and a bank. */
  BANK_ACCOUNT: 'BANK_ACCOUNT',
  /** Anything else; the instructions carry the destination. */
  OTHER: 'OTHER',
} as const;

export type ManualPaymentMethodType =
  (typeof ManualPaymentMethodType)[keyof typeof ManualPaymentMethodType];

export const MANUAL_PAYMENT_METHOD_TYPES: readonly ManualPaymentMethodType[] =
  Object.values(ManualPaymentMethodType);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * The life of one request.
 *
 * `PENDING_REVIEW` covers both "waiting" and "a reviewer has opened it"; the
 * second is recorded by `reviewStartedAt`, which is what ends the owner's
 * right to cancel. Three states are terminal and never change again.
 */
export const ManualTopUpStatus = {
  DRAFT: 'DRAFT',
  PENDING_REVIEW: 'PENDING_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;

export type ManualTopUpStatus = (typeof ManualTopUpStatus)[keyof typeof ManualTopUpStatus];

export const MANUAL_TOPUP_STATUSES: readonly ManualTopUpStatus[] = Object.values(ManualTopUpStatus);

export const TERMINAL_MANUAL_TOPUP_STATUSES: readonly ManualTopUpStatus[] = [
  ManualTopUpStatus.APPROVED,
  ManualTopUpStatus.REJECTED,
  ManualTopUpStatus.CANCELLED,
];

export function isTerminalManualTopUpStatus(status: ManualTopUpStatus): boolean {
  return TERMINAL_MANUAL_TOPUP_STATUSES.includes(status);
}

/**
 * The transitions the state machine allows, by who may make them.
 *
 * The database enforces the same table in a trigger; this copy exists so the
 * API can refuse with a readable error before it gets there.
 */
export const MANUAL_TOPUP_TRANSITIONS: Readonly<
  Record<ManualTopUpStatus, readonly ManualTopUpStatus[]>
> = {
  DRAFT: [ManualTopUpStatus.PENDING_REVIEW, ManualTopUpStatus.CANCELLED],
  PENDING_REVIEW: [
    ManualTopUpStatus.APPROVED,
    ManualTopUpStatus.REJECTED,
    ManualTopUpStatus.CANCELLED,
  ],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function canTransitionManualTopUp(from: ManualTopUpStatus, to: ManualTopUpStatus): boolean {
  return MANUAL_TOPUP_TRANSITIONS[from].includes(to);
}

/** Why finance declined a request. A closed list, so it can be reported and translated. */
export const ManualTopUpRejectionReason = {
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  DUPLICATE_REFERENCE: 'DUPLICATE_REFERENCE',
  RECEIPT_UNCLEAR: 'RECEIPT_UNCLEAR',
  PAYMENT_NOT_RECEIVED: 'PAYMENT_NOT_RECEIVED',
  INVALID_PAYMENT_METHOD: 'INVALID_PAYMENT_METHOD',
  OTHER: 'OTHER',
} as const;

export type ManualTopUpRejectionReason =
  (typeof ManualTopUpRejectionReason)[keyof typeof ManualTopUpRejectionReason];

export const MANUAL_TOPUP_REJECTION_REASONS: readonly ManualTopUpRejectionReason[] = Object.values(
  ManualTopUpRejectionReason,
);

/** One entry in a request's append-only history. */
export const ManualTopUpEventType = {
  CREATED: 'CREATED',
  UPDATED: 'UPDATED',
  RECEIPT_ATTACHED: 'RECEIPT_ATTACHED',
  SUBMITTED: 'SUBMITTED',
  REVIEW_STARTED: 'REVIEW_STARTED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;

export type ManualTopUpEventType = (typeof ManualTopUpEventType)[keyof typeof ManualTopUpEventType];

/** The events an owner may write about their own request. Everything else is finance's. */
export const OWNER_MANUAL_TOPUP_EVENTS: readonly ManualTopUpEventType[] = [
  ManualTopUpEventType.CREATED,
  ManualTopUpEventType.UPDATED,
  ManualTopUpEventType.RECEIPT_ATTACHED,
  ManualTopUpEventType.SUBMITTED,
  ManualTopUpEventType.CANCELLED,
];

export const ManualTopUpActorSide = {
  OWNER: 'OWNER',
  FINANCE: 'FINANCE',
} as const;

export type ManualTopUpActorSide = (typeof ManualTopUpActorSide)[keyof typeof ManualTopUpActorSide];

// ---------------------------------------------------------------------------
// Files: receipts and method logos
// ---------------------------------------------------------------------------

/** The upload pipeline's states, shared by receipts and logos. */
export const ManualTopUpFileStatus = {
  AWAITING_UPLOAD: 'AWAITING_UPLOAD',
  UPLOADED: 'UPLOADED',
  VALIDATING: 'VALIDATING',
  SCANNING: 'SCANNING',
  READY: 'READY',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  UPLOAD_EXPIRED: 'UPLOAD_EXPIRED',
} as const;

export type ManualTopUpFileStatus =
  (typeof ManualTopUpFileStatus)[keyof typeof ManualTopUpFileStatus];

/** Formats the shared artifact ingest accepts. The same spellings the attestation path uses. */
export const ManualTopUpFileFormat = {
  PDF: 'PDF',
  PNG: 'PNG',
  JPEG: 'JPEG',
  WEBP: 'WEBP',
} as const;

export type ManualTopUpFileFormat =
  (typeof ManualTopUpFileFormat)[keyof typeof ManualTopUpFileFormat];

export const MANUAL_TOPUP_FILE_MIME_TYPES: Readonly<Record<ManualTopUpFileFormat, string>> = {
  PDF: 'application/pdf',
  PNG: 'image/png',
  JPEG: 'image/jpeg',
  WEBP: 'image/webp',
};

const FILE_EXTENSIONS: Readonly<Record<string, ManualTopUpFileFormat>> = {
  '.pdf': ManualTopUpFileFormat.PDF,
  '.png': ManualTopUpFileFormat.PNG,
  '.jpg': ManualTopUpFileFormat.JPEG,
  '.jpeg': ManualTopUpFileFormat.JPEG,
  '.webp': ManualTopUpFileFormat.WEBP,
};

/** A receipt may be a PDF or a picture of one. */
export const RECEIPT_FORMATS: readonly ManualTopUpFileFormat[] = [
  ManualTopUpFileFormat.PDF,
  ManualTopUpFileFormat.PNG,
  ManualTopUpFileFormat.JPEG,
  ManualTopUpFileFormat.WEBP,
];

/**
 * A logo is a raster image and nothing else. SVG is refused: it is a document
 * that can carry script, and PalCert has no sanitizer it trusts for it.
 */
export const LOGO_FORMATS: readonly ManualTopUpFileFormat[] = [
  ManualTopUpFileFormat.PNG,
  ManualTopUpFileFormat.JPEG,
  ManualTopUpFileFormat.WEBP,
];

export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
export const LOGO_MAX_BYTES = 1024 * 1024;

/** The format a filename claims to be, if it is one of `allowed`. The bytes still decide. */
export function manualTopUpFormatForFilename(
  filename: string,
  allowed: readonly ManualTopUpFileFormat[],
): ManualTopUpFileFormat | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  const format = FILE_EXTENSIONS[filename.slice(dot).toLowerCase()];
  return format !== undefined && allowed.includes(format) ? format : null;
}

// ---------------------------------------------------------------------------
// Limits and normalization
// ---------------------------------------------------------------------------

export const MANUAL_TOPUP_LIMITS = {
  code: 40,
  name: 120,
  description: 500,
  instructions: 2000,
  recipientName: 140,
  bankName: 140,
  branchName: 140,
  accountNumber: 40,
  referenceOriginal: 100,
  customerNote: 500,
  rejectionNote: 1000,
  /** Open requests one person may have at once (DRAFT or PENDING_REVIEW). */
  maxOpenRequests: 5,
  /** A display order a person can still reason about. */
  maxDisplayOrder: 9999,
} as const;

export const MANUAL_PAYMENT_METHOD_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

/** The normalized shape of a transfer reference. */
export const TRANSFER_REFERENCE_PATTERN = /^[A-Z0-9]{4,64}$/;

/** Arabic-Indic and Eastern Arabic-Indic digits, which people type from Arabic keyboards. */
function asciiDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0x0660 + 48))
    .replace(/[۰-۹]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0x06f0 + 48));
}

/**
 * The form a transfer reference is compared in.
 *
 * Two people typing the same bank reference must produce the same string, or
 * the duplicate check means nothing: so width and case are folded, Arabic
 * digits become ASCII, and the separators people add for readability
 * (spaces, hyphens, dots, slashes, underscores) are removed. Anything left
 * that is not a letter or digit makes the reference invalid rather than being
 * silently dropped. Returns null for an invalid reference.
 */
export function normalizeTransferReference(input: string): string | null {
  if (input.length > MANUAL_TOPUP_LIMITS.referenceOriginal) return null;
  const folded = asciiDigits(input.normalize('NFKC'))
    .toUpperCase()
    .replace(/[\s\-._/\\]+/g, '');
  return TRANSFER_REFERENCE_PATTERN.test(folded) ? folded : null;
}

/** An IBAN without spaces, uppercase. Returns null when the shape or checksum is wrong. */
export function normalizeIban(input: string): string | null {
  const compact = asciiDigits(input.normalize('NFKC')).replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(compact)) return null;
  // ISO 13616 mod-97, computed piecewise so no intermediate exceeds a small
  // integer: move the first four characters to the end, letters to numbers.
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const code = character.charCodeAt(0);
    const chunk = code >= 65 ? String(code - 55) : character;
    for (const digit of chunk) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1 ? compact : null;
}

/** A phone number as digits with an optional leading `+`. Returns null when it is not one. */
export function normalizeMobileNumber(input: string): string | null {
  const compact = asciiDigits(input.normalize('NFKC')).replace(/[\s\-().]+/g, '');
  return /^\+?[0-9]{7,15}$/.test(compact) ? compact : null;
}

/**
 * Whether `amountMinor` is a whole-unit-or-finer amount PalCert can credit in
 * `currency` within a method's limits. Exact integer comparison only.
 */
export function isWithinManualTopUpLimits(
  amountMinor: bigint,
  limits: { readonly minAmountMinor: bigint; readonly maxAmountMinor: bigint },
): boolean {
  return amountMinor >= limits.minAmountMinor && amountMinor <= limits.maxAmountMinor;
}

/** Throws for an unknown currency, as every money helper does. */
export function assertManualTopUpCurrency(currency: string): void {
  currencyExponent(currency);
}

// ---------------------------------------------------------------------------
// The payment-method snapshot
// ---------------------------------------------------------------------------

export const MANUAL_PAYMENT_METHOD_SNAPSHOT_VERSION = 1;

/**
 * Where the person was told to send the money, frozen when the request was
 * created.
 *
 * A method's details can change afterwards — a new account, a new phone
 * number — and the reviewer must still see the destination this person
 * actually paid to. Typed and closed: no field here is free-form beyond the
 * administrator's own text, and nothing about the customer is in it.
 */
export interface ManualPaymentMethodSnapshot {
  readonly snapshotVersion: typeof MANUAL_PAYMENT_METHOD_SNAPSHOT_VERSION;
  readonly methodId: string;
  readonly methodVersion: number;
  readonly code: string;
  readonly type: ManualPaymentMethodType;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly currency: string;
  readonly recipientName: string | null;
  readonly mobileNumber: string | null;
  readonly iban: string | null;
  readonly bankName: string | null;
  readonly accountNumber: string | null;
  readonly branchName: string | null;
  readonly instructionsEn: string | null;
  readonly instructionsAr: string | null;
  readonly minAmountMinor: string;
  readonly maxAmountMinor: string;
  readonly capturedAt: string;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** What a person sees of a method while choosing one. */
export interface ManualPaymentMethodView {
  readonly id: string;
  readonly code: string;
  readonly type: ManualPaymentMethodType;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly currency: string;
  readonly recipientName: string | null;
  readonly mobileNumber: string | null;
  readonly iban: string | null;
  readonly bankName: string | null;
  readonly accountNumber: string | null;
  readonly branchName: string | null;
  readonly instructionsEn: string | null;
  readonly instructionsAr: string | null;
  readonly minAmount: MoneyView;
  readonly maxAmount: MoneyView;
  /** A short-lived signed URL for the logo, or null when the method has none. */
  readonly logoUrl: string | null;
}

export interface ManualPaymentMethodLogoView {
  readonly id: string;
  readonly status: ManualTopUpFileStatus;
  readonly format: ManualTopUpFileFormat | null;
  readonly sizeBytes: number | null;
  readonly rejectionCode: string | null;
}

/** The administrator's view, with lifecycle and authorship. */
export interface AdminManualPaymentMethodView extends ManualPaymentMethodView {
  readonly enabled: boolean;
  readonly displayOrder: number;
  readonly version: number;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdByUserId: string | null;
  readonly updatedByUserId: string | null;
  readonly logo: ManualPaymentMethodLogoView | null;
  /** Whether any request names this method, which is what forbids hard deletion. */
  readonly referenced: boolean;
  /**
   * The finance staff assigned to review top-ups sent through this method.
   * Empty means "every PalCert finance reviewer", which is how methods
   * created before assignment existed keep working.
   */
  readonly reviewers: readonly ManualPaymentMethodReviewerView[];
}

// ---------------------------------------------------------------------------
// Reviewer assignment (ADR-0148)
// ---------------------------------------------------------------------------

/** The most reviewers one method may name. */
export const MAX_MANUAL_PAYMENT_METHOD_REVIEWERS = 20;

/**
 * A PalCert user an administrator may assign: ACTIVE and holding
 * finance:manual-topup:review through a GLOBAL role. Nobody else is listed.
 */
export interface ManualTopUpReviewerCandidateView {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string;
  readonly emailVerified: boolean;
  /** The platform roles through which they hold the review permission. */
  readonly roles: readonly string[];
}

/** One assigned reviewer, with whether the assignment can still take effect. */
export interface ManualPaymentMethodReviewerView {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string;
  readonly emailVerified: boolean;
  /**
   * Still ACTIVE and still holding finance:manual-topup:review through a
   * platform role. Assignment grants nothing; an ineligible assignee is
   * skipped, and if every assignee is, the alert falls back to all finance
   * reviewers.
   */
  readonly eligible: boolean;
  readonly assignedAt: string;
}

/** How a submission's alert recipients were chosen. */
export const ManualTopUpReviewerRouting = {
  /** The method's assigned reviewers who still qualify. */
  METHOD_REVIEWERS: 'METHOD_REVIEWERS',
  /** Reviewers were assigned but none still qualified: every finance reviewer, recorded. */
  FALLBACK_NO_ELIGIBLE: 'FALLBACK_NO_ELIGIBLE',
  /** Nobody assigned: every finance reviewer, as before assignment existed. */
  GLOBAL_NOT_CONFIGURED: 'GLOBAL_NOT_CONFIGURED',
} as const;
export type ManualTopUpReviewerRouting =
  (typeof ManualTopUpReviewerRouting)[keyof typeof ManualTopUpReviewerRouting];
export const MANUAL_TOPUP_REVIEWER_ROUTINGS: readonly ManualTopUpReviewerRouting[] = Object.values(
  ManualTopUpReviewerRouting,
);

/** One person a submission alert was created for, and what became of it. */
export interface ManualTopUpNotificationRecipientView {
  readonly userId: string;
  readonly displayName: string | null;
  /** First character and domain only: enough to recognise, not to copy. */
  readonly emailMasked: string;
  readonly emailVerified: boolean;
  readonly accountStatus: string;
  /** Whether they are assigned to the method now. */
  readonly assigned: boolean;
  readonly notifiedAt: string;
  readonly readAt: string | null;
  readonly inAppStatus: string | null;
  readonly emailStatus: string | null;
  readonly emailSkipReason: string | null;
  readonly emailAttempts: number | null;
  readonly emailErrorCode: string | null;
  readonly emailUpdatedAt: string | null;
}

/** "No email arrived", answered: the admin-only delivery report for one request. */
export interface ManualTopUpNotificationReportView {
  /** Recorded when the alert was fanned out; null before then. */
  readonly routing: ManualTopUpReviewerRouting | null;
  /** True when the fan-out found nobody at all to alert. */
  readonly noReviewerAvailable: boolean;
  readonly recipients: readonly ManualTopUpNotificationRecipientView[];
  /** The method's assignees as they stand now, eligible or not. */
  readonly assignedReviewers: readonly (Omit<ManualPaymentMethodReviewerView, 'email'> & {
    readonly emailMasked: string;
    readonly notified: boolean;
  })[];
}

/** First character and domain of an address, for the diagnostics panel. */
export function maskEmailAddress(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

export interface ManualTopUpReceiptView {
  readonly id: string;
  readonly status: ManualTopUpFileStatus;
  readonly originalFilename: string;
  readonly format: ManualTopUpFileFormat | null;
  readonly sizeBytes: number | null;
  readonly rejectionCode: string | null;
  readonly createdAt: string;
}

export interface ManualTopUpUploadAuthorizationView {
  readonly method: 'PUT';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

export interface ManualTopUpReceiptUploadResponse {
  readonly receipt: ManualTopUpReceiptView;
  readonly upload: ManualTopUpUploadAuthorizationView;
}

export interface ManualPaymentMethodLogoUploadResponse {
  readonly logo: ManualPaymentMethodLogoView;
  readonly upload: ManualTopUpUploadAuthorizationView;
}

export interface ManualTopUpEventView {
  readonly id: string;
  readonly eventType: ManualTopUpEventType;
  readonly actorSide: ManualTopUpActorSide;
  readonly createdAt: string;
}

/** A person's own request. */
export interface ManualTopUpRequestView {
  readonly id: string;
  readonly status: ManualTopUpStatus;
  readonly amount: MoneyView;
  readonly reference: string | null;
  readonly customerNote: string | null;
  readonly paymentMethod: ManualPaymentMethodSnapshot;
  readonly receipt: ManualTopUpReceiptView | null;
  readonly rejectionReason: ManualTopUpRejectionReason | null;
  readonly rejectionNote: string | null;
  /** Whether the owner may still cancel: submitted, and no reviewer has opened it. */
  readonly cancellable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submittedAt: string | null;
  readonly reviewStartedAt: string | null;
  readonly decidedAt: string | null;
  readonly cancelledAt: string | null;
  readonly events: readonly ManualTopUpEventView[];
}

/** One row of the finance queue. */
export interface AdminManualTopUpListItemView {
  readonly id: string;
  readonly status: ManualTopUpStatus;
  readonly amount: MoneyView;
  readonly reference: string | null;
  readonly paymentMethodCode: string;
  readonly paymentMethodNameEn: string;
  readonly paymentMethodNameAr: string;
  readonly ownerUserId: string;
  readonly ownerDisplayName: string | null;
  readonly ownerEmail: string;
  readonly hasReceipt: boolean;
  readonly submittedAt: string | null;
  readonly reviewStartedAt: string | null;
  readonly decidedAt: string | null;
}

export interface ManualTopUpCurrencyTotalView {
  readonly currency: string;
  readonly count: number;
  readonly total: MoneyView;
}

export interface AdminManualTopUpQueueView {
  readonly items: readonly AdminManualTopUpListItemView[];
  readonly nextCursor: string | null;
  /** Pending totals per currency — never summed across currencies. */
  readonly pendingTotals: readonly ManualTopUpCurrencyTotalView[];
}

export interface AdminManualTopUpEventView extends ManualTopUpEventView {
  readonly actorUserId: string | null;
  readonly actorDisplayName: string | null;
}

/** Everything a reviewer needs to decide, and nothing that moves money by itself. */
export interface AdminManualTopUpRequestView extends Omit<
  ManualTopUpRequestView,
  'events' | 'cancellable'
> {
  readonly ownerUserId: string;
  readonly ownerDisplayName: string | null;
  readonly ownerEmail: string;
  readonly referenceNormalized: string | null;
  readonly reviewStartedByUserId: string | null;
  readonly decidedByUserId: string | null;
  /** The ledger entry an approval wrote. Present exactly when APPROVED. */
  readonly creditEntryId: string | null;
  readonly events: readonly AdminManualTopUpEventView[];
}

/** Formatting a minor-unit string for display without floating point. */
export function manualTopUpAmountLabel(amount: MoneyView): string {
  const exponent = currencyExponent(amount.currency);
  const negative = amount.minorUnits.startsWith('-');
  const digits = (negative ? amount.minorUnits.slice(1) : amount.minorUnits).padStart(
    exponent + 1,
    '0',
  );
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction} ${amount.currency}`;
}
