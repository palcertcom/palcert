import { describe, expect, it } from 'vitest';
import {
  currencyExponent,
  formatMoney,
  isNegative,
  isZero,
  toDecimalString,
  toMinorUnits,
} from './money';

/**
 * Money in the browser (§4, §114, §126).
 *
 * The server is authoritative, but the browser is where a customer reads their
 * balance — and a UI that rounded $10.255 to $10.26 would be showing them a
 * number PalCert does not hold.
 */
describe('formatting money', () => {
  it('renders exactly, by slicing digits rather than dividing', () => {
    expect(toDecimalString('1', 'USD')).toBe('0.01');
    expect(toDecimalString('10', 'USD')).toBe('0.10');
    expect(toDecimalString('100', 'USD')).toBe('1.00');
    expect(toDecimalString('1025', 'USD')).toBe('10.25');
    expect(toDecimalString('2000', 'USD')).toBe('20.00');
    expect(toDecimalString('-300', 'USD')).toBe('-3.00');
    expect(toDecimalString('0', 'USD')).toBe('0.00');
  });

  it('respects a zero-decimal currency', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(toDecimalString('500', 'JPY')).toBe('500');
  });

  it('respects a three-decimal currency', () => {
    expect(currencyExponent('JOD')).toBe(3);
    expect(toDecimalString('1025', 'JOD')).toBe('1.025');
    expect(toDecimalString('5', 'JOD')).toBe('0.005');
  });

  it('carries a large amount without losing a unit', () => {
    // Beyond Number.MAX_SAFE_INTEGER: the string path keeps every digit.
    expect(toDecimalString('9007199254740993', 'USD')).toBe('90071992547409.93');
  });

  it('does no floating-point arithmetic at all', () => {
    const source = toDecimalString.toString() + toMinorUnits.toString();
    expect(source).not.toMatch(/\/\s*100|Math\.|parseFloat|toFixed/);
  });

  it('formats for a reader’s locale without changing the amount', () => {
    // §114: presentation only. Both locales show the same money.
    const amount = { currency: 'USD', minorUnits: '2000' };
    const english = formatMoney(amount, 'en');
    const arabic = formatMoney(amount, 'ar');

    expect(english).toContain('20');
    expect(arabic).toMatch(/٢٠|20/);
    expect(toDecimalString(amount.minorUnits, amount.currency)).toBe('20.00');
  });

  it('still shows the exact amount for a currency the platform does not know', () => {
    // A structurally valid but unknown code: Intl renders it with the code as
    // the symbol, and the digits are still exact.
    expect(formatMoney({ currency: 'ZZZ', minorUnits: '1025' }, 'en')).toContain('10.25');
  });

  it('falls back to a plain exact string rather than throwing at a customer', () => {
    // A malformed code makes Intl throw. A balance page must still render.
    expect(formatMoney({ currency: 'QQ', minorUnits: '1025' }, 'en')).toBe('10.25 QQ');
  });

  it('recognizes a negative or zero amount without parsing it', () => {
    expect(isNegative('-300')).toBe(true);
    expect(isNegative('300')).toBe(false);
    expect(isZero('0')).toBe(true);
    expect(isZero('-0')).toBe(true);
    expect(isZero('1')).toBe(false);
  });
});

describe('reading an amount a customer typed', () => {
  it('converts whole and decimal input to minor units', () => {
    expect(toMinorUnits('20', 'USD')).toBe('2000');
    expect(toMinorUnits('20.5', 'USD')).toBe('2050');
    expect(toMinorUnits('20.25', 'USD')).toBe('2025');
    expect(toMinorUnits('0.01', 'USD')).toBe('1');
    expect(toMinorUnits('500', 'JPY')).toBe('500');
  });

  it('refuses more precision than the currency has', () => {
    // Silently truncating "20.999" to 20.99 would take money from a customer
    // without telling them.
    expect(toMinorUnits('20.999', 'USD')).toBeNull();
    expect(toMinorUnits('20.5', 'JPY')).toBeNull();
    expect(toMinorUnits('1.0255', 'JOD')).toBeNull();
  });

  it('refuses anything that is not a plain amount', () => {
    for (const bad of ['', 'abc', '-20', '1e3', '20,00', ' ', '.5']) {
      expect(toMinorUnits(bad, 'USD'), bad).toBeNull();
    }
  });
});
