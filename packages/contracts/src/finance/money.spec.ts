import { describe, expect, it } from 'vitest';
import {
  CURRENCY_REGISTRY,
  MAX_MINOR_UNITS,
  currencyExponent,
  findCurrency,
  formatMinorUnits,
  isRepresentableAmount,
  money,
  parseMinorUnits,
} from './money';
import {
  CreditClass,
  FUNDING_ORDER,
  LEDGER_ENTRY_TYPES,
  LedgerEntryType,
  expectedSign,
  isExternallyRefundable,
  signMatchesType,
} from './ledger';
import { CreditHoldStatus, canTransitionHold, isHoldTerminal } from './holds';
import { PriceVersionStatus, canTransitionPrice } from './pricing';
import { TopUpStatus, canTransitionTopUp, providerIdempotencyKey } from './payments';

/**
 * Money, in the only representation PalCert allows (§4, §126).
 *
 * These tests exist because the failure they prevent is silent. A balance that
 * is wrong by a hundredth of a cent does not throw; it just stops
 * reconciling, months later, in a way nobody can reconstruct.
 */
describe('minor-unit money', () => {
  it('round-trips the amounts §126 names, exactly', () => {
    const cases: [string, bigint, string][] = [
      ['USD', 1n, '0.01'],
      ['USD', 10n, '0.10'],
      ['USD', 100n, '1.00'],
      ['USD', 1025n, '10.25'],
      ['USD', 2000n, '20.00'],
      ['USD', -300n, '-3.00'],
    ];
    for (const [currency, minor, expected] of cases) {
      expect(formatMinorUnits(minor, currency), `${currency} ${minor}`).toBe(expected);
      expect(parseMinorUnits(money(currency, minor).minorUnits)).toBe(minor);
    }
  });

  it('handles a zero-decimal currency without inventing decimals', () => {
    // JPY has exponent 0: 500 yen is 500 minor units, not 5.00 (§5).
    expect(currencyExponent('JPY')).toBe(0);
    expect(formatMinorUnits(500n, 'JPY')).toBe('500');
    expect(formatMinorUnits(0n, 'JPY')).toBe('0');
  });

  it('handles a three-decimal currency', () => {
    // JOD has exponent 3. A codebase that assumed 2 would be out by 10×.
    expect(currencyExponent('JOD')).toBe(3);
    expect(formatMinorUnits(1025n, 'JOD')).toBe('1.025');
    expect(formatMinorUnits(5n, 'JOD')).toBe('0.005');
  });

  it('carries a large amount without losing a unit', () => {
    // Beyond Number.MAX_SAFE_INTEGER, which is exactly why the wire format is
    // a string rather than a JSON number.
    const large = 9_007_199_254_740_993n;
    expect(parseMinorUnits(large.toString())).toBe(large);
    // The same digits through a JavaScript number come back as a different
    // amount. That silent loss is why the wire format is a string.
    expect(BigInt(Number(large.toString()))).not.toBe(large);
    expect(formatMinorUnits(large, 'USD')).toBe('90071992547409.93');
  });

  it('refuses an unknown currency rather than assuming two decimals', () => {
    expect(() => currencyExponent('XYZ')).toThrow(/not in the PalCert currency registry/);
    expect(() => money('XYZ', 100n)).toThrow();
  });

  it('refuses anything that is not an integer minor-unit string', () => {
    // "10.25" is the classic mistake: silently truncating it to 10 would lose
    // 25 cents per call, forever.
    for (const bad of ['10.25', '1e3', ' 100', '100 ', '', 'abc', '007', '+100']) {
      expect(() => parseMinorUnits(bad), bad).toThrow();
    }
    expect(parseMinorUnits('-300')).toBe(-300n);
    expect(parseMinorUnits('0')).toBe(0n);
  });

  it('bounds representable amounts well inside BIGINT', () => {
    expect(isRepresentableAmount(MAX_MINOR_UNITS)).toBe(true);
    expect(isRepresentableAmount(MAX_MINOR_UNITS + 1n)).toBe(false);
    expect(isRepresentableAmount(-MAX_MINOR_UNITS - 1n)).toBe(false);
  });

  it('never uses a floating-point number anywhere in the money path', () => {
    // A guard against the obvious future regression: someone "simplifying"
    // formatMinorUnits into a division.
    const source = formatMinorUnits.toString() + parseMinorUnits.toString() + money.toString();
    expect(source).not.toMatch(/\/\s*100|Math\.|parseFloat|toFixed|Number\(/);
  });

  it('defines an exponent for every registered currency', () => {
    for (const entry of CURRENCY_REGISTRY) {
      expect([0, 2, 3], entry.code).toContain(entry.exponent);
      expect(findCurrency(entry.code)).toBe(entry);
    }
  });
});

describe('ledger semantics', () => {
  it('fixes the sign of every entry type', () => {
    // A positive SERVICE_CHARGE would hand the customer money. The sign is a
    // property of the type, not a decision a caller makes (§11).
    for (const type of LEDGER_ENTRY_TYPES) {
      const sign = expectedSign(type);
      expect(signMatchesType(type, sign === 'POSITIVE' ? 1n : -1n)).toBe(true);
      expect(signMatchesType(type, sign === 'POSITIVE' ? -1n : 1n)).toBe(false);
      // A zero-amount entry says nothing and is refused (§100).
      expect(signMatchesType(type, 0n)).toBe(false);
    }
  });

  it('makes only cash externally refundable', () => {
    // §9, §70: promotional credit is spendable, never withdrawable.
    expect(isExternallyRefundable(CreditClass.CASH)).toBe(true);
    expect(isExternallyRefundable(CreditClass.PROMOTIONAL)).toBe(false);
  });

  it('spends promotional credit before cash', () => {
    // §23: one documented order, declared once, so two services cannot
    // allocate differently.
    expect(FUNDING_ORDER).toEqual([CreditClass.PROMOTIONAL, CreditClass.CASH]);
  });

  it('gives a chargeback a negative sign, so a dispute can go below zero', () => {
    // §84, §85: a negative balance is a financial reality, not something to
    // paper over by inventing credit.
    expect(expectedSign(LedgerEntryType.CHARGEBACK_DEBIT)).toBe('NEGATIVE');
    expect(expectedSign(LedgerEntryType.CHARGEBACK_REVERSAL)).toBe('POSITIVE');
  });
});

describe('lifecycles', () => {
  it('never lets a captured hold be released', () => {
    // §21: the money has moved and the service was delivered. "Releasing" it
    // afterwards would give away both.
    expect(canTransitionHold(CreditHoldStatus.ACTIVE, CreditHoldStatus.CAPTURED)).toBe(true);
    expect(canTransitionHold(CreditHoldStatus.CAPTURED, CreditHoldStatus.RELEASED)).toBe(false);
    expect(canTransitionHold(CreditHoldStatus.RELEASED, CreditHoldStatus.CAPTURED)).toBe(false);
    expect(canTransitionHold(CreditHoldStatus.EXPIRED, CreditHoldStatus.CAPTURED)).toBe(false);
    for (const status of [
      CreditHoldStatus.CAPTURED,
      CreditHoldStatus.RELEASED,
      CreditHoldStatus.EXPIRED,
    ]) {
      expect(isHoldTerminal(status), status).toBe(true);
    }
  });

  it('never lets a late failure undo a succeeded top-up', () => {
    // §125: events arrive out of order. Credit that exists must not vanish
    // because an old "pending" or "failed" turns up afterwards.
    expect(canTransitionTopUp(TopUpStatus.PENDING, TopUpStatus.SUCCEEDED)).toBe(true);
    expect(canTransitionTopUp(TopUpStatus.SUCCEEDED, TopUpStatus.FAILED)).toBe(false);
    expect(canTransitionTopUp(TopUpStatus.SUCCEEDED, TopUpStatus.EXPIRED)).toBe(false);
    expect(canTransitionTopUp(TopUpStatus.SUCCEEDED, TopUpStatus.CANCELLED)).toBe(false);
  });

  it('lets a price retire but never un-retire or reactivate', () => {
    // §28, §130: retiring is lifecycle metadata; the amount never changes.
    expect(canTransitionPrice(PriceVersionStatus.DRAFT, PriceVersionStatus.ACTIVE)).toBe(true);
    expect(canTransitionPrice(PriceVersionStatus.ACTIVE, PriceVersionStatus.RETIRED)).toBe(true);
    expect(canTransitionPrice(PriceVersionStatus.RETIRED, PriceVersionStatus.ACTIVE)).toBe(false);
    expect(canTransitionPrice(PriceVersionStatus.ACTIVE, PriceVersionStatus.DRAFT)).toBe(false);
  });

  it('gives each provider operation its own idempotency key', () => {
    // §45: reusing a top-up's key for a refund would make the provider return
    // the top-up's result for a refund request.
    const topUp = providerIdempotencyKey('topup', 'abc', 'create');
    const refund = providerIdempotencyKey('refund', 'abc', 'create');
    expect(topUp).toBe('topup:abc:create:v1');
    expect(refund).toBe('refund:abc:create:v1');
    expect(topUp).not.toBe(refund);
  });
});
