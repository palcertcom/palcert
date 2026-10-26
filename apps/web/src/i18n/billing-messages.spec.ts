import { describe, expect, it } from 'vitest';
import { BILLING_MESSAGES, getBillingMessages, type BillingMessages } from './billing-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;

const NESTED_MAPS = ['statuses', 'failureCodes', 'errors'] as const;

/** Phase 10's vocabulary guard, still in force (§135). */
const FORBIDDEN_FINANCIAL_VOCABULARY =
  /\bwallet\b|\bcrypto|\bblockchain\b|\btoken balance\b|\bcoin\b|محفظة|عملة رقمية/i;

/** PalCert's own plumbing, which a customer should never meet. */
const INTERNAL_TERMS =
  /\bhold\b|\ballocation\b|\bledger\b|\bpurchase id\b|\bcapture\b|\bstripe\b|CREDIT_HOLD|SERVICE_CHARGE/i;

describe('billing message catalogue', () => {
  it('defines every key in every locale', () => {
    const reference = Object.keys(BILLING_MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(BILLING_MESSAGES[locale]).sort()).toEqual(reference);
    }
  });

  it('defines every nested label in every locale', () => {
    for (const map of NESTED_MAPS) {
      const reference = Object.keys(BILLING_MESSAGES[DEFAULT_LOCALE][map]).sort();
      for (const locale of LOCALES) {
        expect([locale, map, Object.keys(BILLING_MESSAGES[locale][map]).sort()]).toEqual([
          locale,
          map,
          reference,
        ]);
      }
    }
  });

  it('writes Arabic in Arabic', () => {
    for (const [key, value] of flatten(BILLING_MESSAGES.ar)) {
      expect([key, ARABIC_SCRIPT.test(value)]).toEqual([key, true]);
    }
  });

  it('names every purchase status a check can be in', () => {
    expect(Object.keys(BILLING_MESSAGES.en.statuses).sort()).toEqual(
      [
        'DELIVERED',
        'PROCESSING',
        'RECONCILIATION_REQUIRED',
        'RELEASED',
        'RESERVED',
        'REFUNDED',
      ].sort(),
    );
  });

  it('never calls a released reservation a refund', () => {
    // §60, §133, §134: the single most important wording rule in the phase.
    // Nothing was taken, so there is nothing to refund, and saying otherwise
    // would tell a customer money had moved when it never did.
    expect(BILLING_MESSAGES.en.statuses.RELEASED).toBe('Reservation released');
    expect(BILLING_MESSAGES.en.statuses.RELEASED).not.toMatch(/refund/i);
    expect(BILLING_MESSAGES.en.releasedNow).not.toMatch(/refund/i);
    expect(BILLING_MESSAGES.en.reservationReturned).not.toMatch(/refund/i);

    // And in Arabic, where أُعيد المبلغ would carry exactly the wrong meaning.
    expect(BILLING_MESSAGES.ar.statuses.RELEASED).toBe('أُلغي الحجز');
    expect(BILLING_MESSAGES.ar.statuses.RELEASED).not.toMatch(/استرداد|أُعيد المبلغ/);
    expect(BILLING_MESSAGES.ar.releasedNow).not.toMatch(/استرداد|أُعيد المبلغ/);
  });

  it('keeps reserved, charged, released and refunded four different things', () => {
    for (const locale of LOCALES) {
      const messages = BILLING_MESSAGES[locale];
      const words = [
        messages.reservedNow,
        messages.chargedNow,
        messages.releasedNow,
        messages.refundedNow,
      ];
      expect(new Set(words).size).toBe(4);
    }
    // Refunded is the one that means a charge was reversed, and only that one.
    expect(BILLING_MESSAGES.en.statuses.REFUNDED).toMatch(/refund/i);
    expect(BILLING_MESSAGES.ar.statuses.REFUNDED).toMatch(/أُعيد/);
  });

  it('says all three things about what a reservation means', () => {
    // §54: a price shown without "you are only charged on success" and
    // "otherwise it is released" is an honest number in a misleading place.
    for (const locale of LOCALES) {
      const messages = BILLING_MESSAGES[locale];
      expect(messages.willReserve('$3.00')).toContain('$3.00');
      expect(messages.chargedOnDelivery.length).toBeGreaterThan(20);
      expect(messages.releasedIfIncomplete.length).toBeGreaterThan(20);
    }
    expect(BILLING_MESSAGES.en.chargedOnDelivery).toMatch(
      /only be charged when the technical report is successfully completed/i,
    );
    expect(BILLING_MESSAGES.en.releasedIfIncomplete).toMatch(/reservation will be released/i);
  });

  it('gives a short balance all three numbers', () => {
    // §55: "not enough" without a number is not actionable.
    for (const locale of LOCALES) {
      const messages = BILLING_MESSAGES[locale];
      expect(messages.required.length).toBeGreaterThan(0);
      expect(messages.available.length).toBeGreaterThan(0);
      expect(messages.shortfall.length).toBeGreaterThan(0);
      expect(messages.addCredit.length).toBeGreaterThan(0);
    }
  });

  it('labels a service charge as the check it paid for', () => {
    // §64: "PalCert Document Check", never "credit hold capture".
    expect(BILLING_MESSAGES.en.transactionLabel).toBe('PalCert Document Check');
    expect(BILLING_MESSAGES.ar.transactionLabel).toMatch(/فحص مستند/);
  });

  it('uses no internal vocabulary and nothing crypto', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(BILLING_MESSAGES[locale])) {
        expect([`${locale}.${key}`, INTERNAL_TERMS.test(value)]).toEqual([
          `${locale}.${key}`,
          false,
        ]);
        expect([`${locale}.${key}`, FORBIDDEN_FINANCIAL_VOCABULARY.test(value)]).toEqual([
          `${locale}.${key}`,
          false,
        ]);
      }
    }
  });

  it('never suggests the institution receives the money', () => {
    // §2, §59: all document-check revenue is PalCert's, and a customer must
    // not be left thinking their university was paid.
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(BILLING_MESSAGES[locale])) {
        expect([
          `${locale}.${key}`,
          /university|institution|organization|الجامعة|المؤسسة/i.test(value),
        ]).toEqual([`${locale}.${key}`, false]);
      }
    }
  });

  it('tells a customer a failed check cost them nothing', () => {
    expect(BILLING_MESSAGES.en.noChargeMade).toBe('No charge was made.');
    expect(BILLING_MESSAGES.ar.noChargeMade).toBe('لم يُخصم أي مبلغ.');
    expect(BILLING_MESSAGES.en.failureCodes.SERVICE_FAILED).toMatch(/could not complete/i);
  });

  it('falls back to English for an unknown locale', () => {
    expect(getBillingMessages('fr' as never)).toBe(BILLING_MESSAGES.en);
  });
});

/** Every reader-facing string, including the nested maps, as key/value pairs. */
function flatten(messages: BillingMessages): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === 'string') {
      pairs.push([key, value]);
      continue;
    }
    if (typeof value === 'function') {
      // The one interpolated string, rendered with a sample amount so its
      // wording is checked like every other.
      pairs.push([key, (value as (amount: string) => string)('$1.00')]);
      continue;
    }
    for (const [nested, text] of Object.entries(value as Record<string, string>)) {
      pairs.push([`${key}.${nested}`, text]);
    }
  }
  return pairs;
}
