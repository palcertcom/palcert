/**
 * Money in the browser (§4, §114).
 *
 * Two rules. Amounts are **never** parsed into a JavaScript number and never
 * divided: the decimal string is built by slicing digits, so a large or
 * unusual amount cannot drift. And formatting is **presentation only** — the
 * minor units are the truth, and rounding them would be rounding money.
 */

/** Decimal exponents, mirroring the server's canonical registry. */
const EXPONENTS: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  ILS: 2,
  JOD: 3,
  JPY: 0,
};

export function currencyExponent(currency: string): number {
  // Two is the overwhelmingly common case, and a currency the browser has not
  // heard of still displays sensibly rather than throwing at a customer.
  return EXPONENTS[currency] ?? 2;
}

/**
 * An exact decimal string: 1025 USD → "10.25", 500 JPY → "500".
 *
 * Built by slicing, never by `/ 100`.
 */
export function toDecimalString(minorUnits: string, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = minorUnits.startsWith('-');
  const digits = (negative ? minorUnits.slice(1) : minorUnits).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * A locale-aware amount for display.
 *
 * `Intl.NumberFormat` is given the already-exact decimal string, and is told
 * exactly how many fraction digits the currency has, so it formats rather than
 * rounds. If the platform cannot format the currency, the exact decimal string
 * is shown — wrong-looking is better than wrong.
 */
export function formatMoney(
  amount: { currency: string; minorUnits: string },
  locale: string,
): string {
  const exact = toDecimalString(amount.minorUnits, amount.currency);
  const exponent = currencyExponent(amount.currency);
  try {
    return new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en', {
      style: 'currency',
      currency: amount.currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(Number(exact));
  } catch {
    return `${exact} ${amount.currency}`;
  }
}

/** Whether an amount is negative, without parsing it. */
export function isNegative(minorUnits: string): boolean {
  return minorUnits.startsWith('-');
}

export function isZero(minorUnits: string): boolean {
  return /^-?0+$/.test(minorUnits);
}

/**
 * A whole-currency-unit input ("20", "20.5") as minor units.
 *
 * Returns null for anything that is not a plain non-negative decimal with at
 * most the currency's own precision — so "20.999" in USD is rejected rather
 * than silently truncated to 20.99.
 */
export function toMinorUnits(input: string, currency: string): string | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;

  const exponent = currencyExponent(currency);
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > exponent) return null;

  const digits = `${whole}${fraction.padEnd(exponent, '0')}`.replace(/^0+(?=\d)/, '');
  return digits === '' ? '0' : digits;
}
