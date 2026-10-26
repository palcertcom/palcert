/**
 * Pricing (§24–§33).
 *
 * Prices belong to PalCert, globally. An organization publishes a standard;
 * it does not decide what PalCert charges someone to be checked against it,
 * and there is no code path through which it could (§107).
 *
 * The other half of the design is that a price is **versioned and immutable
 * once active**. A charge from last March must still be explainable by a row
 * that says what the price was in March, not by a row someone has since edited.
 */

export const ServiceProductCode = {
  /** A single compliance check of one document against one standard. */
  DOCUMENT_CHECK: 'DOCUMENT_CHECK',
  /** Automated correction. Catalogued now, no workflow until Phase 12 (§25). */
  SMARTFIX: 'SMARTFIX',
  /** Human-assisted correction. Catalogued only. */
  EXPERTFIX: 'EXPERTFIX',
  /** An AI review of one delivered check report (ADR-0149). */
  AI_REVIEW: 'AI_REVIEW',
  /** AI extraction of proposed rules from guideline sources (ADR-0149). */
  AI_RULE_EXTRACTION: 'AI_RULE_EXTRACTION',
} as const;

export type ServiceProductCode = (typeof ServiceProductCode)[keyof typeof ServiceProductCode];

export const SERVICE_PRODUCT_CODES: readonly ServiceProductCode[] =
  Object.values(ServiceProductCode);

/**
 * The product codes a deployment may actually transact.
 *
 * A product is quotable only once the workflow behind it exists: quoting one
 * that does not would sell somebody a service PalCert cannot perform.
 * ExpertFix is still a catalogue entry for exactly that reason — the pricing
 * shape is proven, the workflow is not built.
 */
export const ACTIVE_SERVICE_PRODUCT_CODES: readonly ServiceProductCode[] = [
  ServiceProductCode.DOCUMENT_CHECK,
  // Phase 12.
  ServiceProductCode.SMARTFIX,
  // ADR-0149: every customer-initiated AI service is sold, never given away.
  // Quotable only once PalCert Admin activates a price; there is no default.
  ServiceProductCode.AI_REVIEW,
  ServiceProductCode.AI_RULE_EXTRACTION,
];

/** The products whose delivery calls an external AI provider (ADR-0149). */
export const AI_SERVICE_PRODUCT_CODES: readonly ServiceProductCode[] = [
  ServiceProductCode.AI_REVIEW,
  ServiceProductCode.AI_RULE_EXTRACTION,
];

export function isAIServiceProduct(code: string): boolean {
  return (AI_SERVICE_PRODUCT_CODES as readonly string[]).includes(code);
}

export const PriceVersionStatus = {
  /** Being prepared. Not quotable. Financial fields still editable. */
  DRAFT: 'DRAFT',
  /** In force. Financial fields frozen (§28). */
  ACTIVE: 'ACTIVE',
  /** Superseded. Still referenced by historical quotes and charges. */
  RETIRED: 'RETIRED',
} as const;

export type PriceVersionStatus = (typeof PriceVersionStatus)[keyof typeof PriceVersionStatus];

export const PRICE_VERSION_STATUSES: readonly PriceVersionStatus[] =
  Object.values(PriceVersionStatus);

const PRICE_TRANSITIONS: Readonly<Record<PriceVersionStatus, readonly PriceVersionStatus[]>> = {
  DRAFT: [PriceVersionStatus.ACTIVE],
  // Retiring is lifecycle metadata, not a price change: the amount stays
  // exactly what it was (§130).
  ACTIVE: [PriceVersionStatus.RETIRED],
  RETIRED: [],
};

export function canTransitionPrice(from: PriceVersionStatus, to: PriceVersionStatus): boolean {
  return PRICE_TRANSITIONS[from].includes(to);
}

export function isPriceQuotable(status: PriceVersionStatus): boolean {
  return status === PriceVersionStatus.ACTIVE;
}

/**
 * How long a quote stands.
 *
 * Long enough that a customer can read the amount, think, and pay; short
 * enough that a price change reaches everyone within the hour. A quote that
 * has not expired keeps its captured amount even if the price has since
 * changed — PalCert honours what it quoted (§32).
 */
export const DEFAULT_QUOTE_TTL_SECONDS = 30 * 60;
export const MAX_QUOTE_TTL_SECONDS = 24 * 60 * 60;

/**
 * The future market dimension (§33).
 *
 * Phase 10 prices one market. The column exists with a single value so a
 * second one is a row rather than a migration of every historical price, and
 * it is never inferred from an IP address: where someone happens to be
 * connecting from is not a statement about which price list governs them.
 */
export const DEFAULT_MARKET_CODE = 'GLOBAL';
export const MARKET_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,15}$/;
