import {
  MANUAL_TOPUP_REJECTION_REASONS,
  MANUAL_TOPUP_STATUSES,
} from '@palcert/contracts/finance/manual-topups';
import { describe, expect, it } from 'vitest';
import { LOCALES } from './locales';
import { MANUAL_TOPUP_MESSAGES, type ManualTopUpMessages } from './manual-topup-messages';

const ARABIC_SCRIPT = /[؀-ۿ]/;

/** PalCert credit is never a wallet, and a top-up is never anything crypto. */
const FORBIDDEN_FINANCIAL_VOCABULARY =
  /\bwallet\b|\bcrypto|\bblockchain\b|\bcoin\b|\bweb3\b|محفظة|عملة رقمية|بلوك ?تشين|مشفّرة/i;

/** PalCert's plumbing, which nobody topping up should meet. */
const INTERNAL_TERMS =
  /\bledger\b|\bidempotenc|\bminor units?\b|\bsigned url\b|\bquarantine\b|\bprisma\b|\bpostgres|\bRLS\b|\bwebhook\b/i;

/** Every string in a catalogue, keyed by its path; functions are called with samples. */
function flatten(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'function') {
    return [[path, String((value as (...args: string[]) => unknown)('A', 'B', 'C'))]];
  }
  if (Array.isArray(value))
    return value.flatMap((item, index) => flatten(item, `${path}[${index}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      flatten(item, path === '' ? key : `${path}.${key}`),
    );
  }
  return [];
}

function keys(messages: ManualTopUpMessages): string[] {
  return flatten(messages)
    .map(([path]) => path)
    .sort();
}

describe('manual top-up message catalogue', () => {
  it('defines every key in both locales', () => {
    expect(keys(MANUAL_TOPUP_MESSAGES.ar)).toEqual(keys(MANUAL_TOPUP_MESSAGES.en));
  });

  it('labels every status and every rejection reason the API can return', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(MANUAL_TOPUP_MESSAGES[locale].statuses).sort()).toEqual(
        [...MANUAL_TOPUP_STATUSES].sort(),
      );
      expect(Object.keys(MANUAL_TOPUP_MESSAGES[locale].rejectionReasons).sort()).toEqual(
        [...MANUAL_TOPUP_REJECTION_REASONS].sort(),
      );
    }
  });

  it('writes Arabic in Arabic', () => {
    for (const [key, value] of flatten(MANUAL_TOPUP_MESSAGES.ar)) {
      // Codes and examples such as JAWWAL_PAY or "PDF, PNG" are allowed to be
      // Latin inside an Arabic sentence; a string with no Arabic at all is not.
      expect([key, ARABIC_SCRIPT.test(value)]).toEqual([key, true]);
    }
  });

  it('never calls anything a wallet, and never says anything crypto', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(MANUAL_TOPUP_MESSAGES[locale])) {
        expect([`${locale}.${key}`, FORBIDDEN_FINANCIAL_VOCABULARY.test(value)]).toEqual([
          `${locale}.${key}`,
          false,
        ]);
      }
    }
  });

  it('uses no internal machine vocabulary', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(MANUAL_TOPUP_MESSAGES[locale])) {
        expect([`${locale}.${key}`, INTERNAL_TERMS.test(value)]).toEqual([
          `${locale}.${key}`,
          false,
        ]);
      }
    }
  });

  it('never tells a person a transfer was added before finance verified it', () => {
    const en = MANUAL_TOPUP_MESSAGES.en;
    expect(en.wizard.reviewNotice).toMatch(/does not change yet/i);
    expect(en.waiting.submittedBody).toMatch(/only after they verify/i);
    expect(en.statuses['PENDING_REVIEW']).not.toMatch(/added/i);
    expect(MANUAL_TOPUP_MESSAGES.ar.wizard.reviewNotice).toMatch(/لن يتغير رصيدك/);
  });

  it('tells the reviewer that approval credits real money, and that the receipt is private', () => {
    expect(MANUAL_TOPUP_MESSAGES.en.admin.approveBody('A', 'B', 'C')).toMatch(/adds A/);
    expect(MANUAL_TOPUP_MESSAGES.en.wizard.receiptHint).toMatch(/only you and PalCert finance/i);
  });
});
