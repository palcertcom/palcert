/**
 * Money (§4, §5, §126).
 *
 * Every monetary amount in PalCert is an **integer count of minor units**
 * together with an ISO 4217 currency. There is no floating-point money
 * anywhere in the system, and no `amount * 100` scattered through the code:
 * the exponent lives in one registry and every conversion goes through it.
 *
 * The reason is not fastidiousness. `0.1 + 0.2 !== 0.3` in IEEE 754, and a
 * balance that drifts by a thousandth of a cent per transaction is a balance
 * nobody can reconcile. Integers in the smallest unit a currency has cannot
 * drift.
 *
 * Across the wire the amount is a **string**, not a JSON number. A JavaScript
 * number is exact only below 2^53, and while no realistic balance approaches
 * that, "realistic" is not a property a financial contract should depend on.
 * A string costs one parse and removes the question entirely.
 */

/** A currency's decimal exponent: 2 for USD, 0 for JPY, 3 for KWD. */
export type CurrencyExponent = 0 | 2 | 3;

export interface CurrencyDefinition {
  /** ISO 4217 alphabetic code, uppercase. */
  readonly code: string;
  readonly exponent: CurrencyExponent;
  /** Whether this deployment may transact in it. */
  readonly enabled: boolean;
  readonly nameEn: string;
  readonly nameAr: string;
}

/**
 * The canonical currency registry (§5).
 *
 * Every adapter, every formatter and every validator reads exponents from
 * here. A currency that is defined but not enabled can be parsed and displayed
 * — historical records must stay readable — but cannot be transacted in.
 *
 * `enabled` here is the *code's* default; a deployment narrows it further
 * through `PALCERT_ENABLED_CURRENCIES`, and the intersection is what the API
 * accepts. Adding a currency later is a registry entry and a configuration
 * value, not a redesign (§7).
 */
export const CURRENCY_REGISTRY: readonly CurrencyDefinition[] = [
  { code: 'USD', exponent: 2, enabled: true, nameEn: 'US dollar', nameAr: 'دولار أمريكي' },
  { code: 'EUR', exponent: 2, enabled: true, nameEn: 'Euro', nameAr: 'يورو' },
  { code: 'ILS', exponent: 2, enabled: true, nameEn: 'Israeli new shekel', nameAr: 'شيكل جديد' },
  { code: 'JOD', exponent: 3, enabled: true, nameEn: 'Jordanian dinar', nameAr: 'دينار أردني' },
  // Zero-decimal, and present from the start so the exponent-0 path is
  // exercised by the registry rather than discovered in production (§126).
  { code: 'JPY', exponent: 0, enabled: false, nameEn: 'Japanese yen', nameAr: 'ين ياباني' },
] as const;

const BY_CODE = new Map(CURRENCY_REGISTRY.map((entry) => [entry.code, entry]));

export const CURRENCY_CODES: readonly string[] = CURRENCY_REGISTRY.map((entry) => entry.code);

export function findCurrency(code: string): CurrencyDefinition | undefined {
  return BY_CODE.get(code);
}

export function isKnownCurrency(code: string): boolean {
  return BY_CODE.has(code);
}

/** The exponent, or a thrown error: guessing 2 would be a silent 100× bug. */
export function currencyExponent(code: string): CurrencyExponent {
  const definition = BY_CODE.get(code);
  if (definition === undefined) {
    throw new Error(`Unknown currency ${code}; it is not in the PalCert currency registry.`);
  }
  return definition.exponent;
}

/**
 * An amount as it crosses a boundary.
 *
 * `minorUnits` is a decimal string of a signed integer. Signed, because a
 * ledger entry may legitimately be negative and a shape that could not express
 * that would push the sign somewhere else.
 */
export interface MoneyView {
  readonly currency: string;
  readonly minorUnits: string;
}

export const MINOR_UNITS_PATTERN = /^-?(0|[1-9]\d{0,18})$/;

export function isMinorUnitsString(value: string): boolean {
  return MINOR_UNITS_PATTERN.test(value);
}

/** A `MoneyView` from a bigint. The only sanctioned way to build one. */
export function money(currency: string, minorUnits: bigint): MoneyView {
  // Throws for an unknown currency, so an amount can never carry a code the
  // registry does not define.
  currencyExponent(currency);
  return { currency, minorUnits: minorUnits.toString() };
}

/**
 * Parse a minor-unit string back to a bigint.
 *
 * Rejects anything that is not a plain signed integer — no decimal point, no
 * exponent, no whitespace, no leading zeros. A caller that meant `10.25` and
 * wrote `"10.25"` gets an error rather than a silently truncated 10.
 */
export function parseMinorUnits(value: string): bigint {
  if (!MINOR_UNITS_PATTERN.test(value)) {
    throw new Error(`"${value}" is not an integer minor-unit amount.`);
  }
  return BigInt(value);
}

/**
 * A decimal string for display, e.g. 1025 USD → "10.25", 500 JPY → "500".
 *
 * Presentation only, and exact: it is built by slicing the digits, never by
 * dividing. Locale formatting happens in the UI (§114); this is the neutral
 * form an API or a log line can carry without inventing a locale.
 */
export function formatMinorUnits(minorUnits: bigint, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = minorUnits < 0n;
  const digits = (negative ? -minorUnits : minorUnits).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * The smallest and largest amounts PalCert will represent.
 *
 * Well inside PostgreSQL's BIGINT range, so no sum of ledger entries can
 * overflow it even after a very long history, and comfortably above any
 * realistic balance.
 */
export const MAX_MINOR_UNITS = 1_000_000_000_000_000n;
export const MIN_MINOR_UNITS = -MAX_MINOR_UNITS;

export function isRepresentableAmount(minorUnits: bigint): boolean {
  return minorUnits >= MIN_MINOR_UNITS && minorUnits <= MAX_MINOR_UNITS;
}
