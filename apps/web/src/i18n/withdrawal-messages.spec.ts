import {
  WITHDRAWAL_EVENT_TYPES,
  WITHDRAWAL_REJECTION_REASONS,
  WITHDRAWAL_STATUSES,
} from '@palcert/contracts/finance/withdrawals';
import { describe, expect, it } from 'vitest';
import { LOCALES } from './locales';
import { WITHDRAWAL_MESSAGES, type WithdrawalMessages } from './withdrawal-messages';

const ARABIC_SCRIPT = /[؀-ۿ]/;

/** PalCert credit is never a wallet, and nothing here is crypto. */
const FORBIDDEN_FINANCIAL_VOCABULARY =
  /\bwallet\b|\bcrypto|\bblockchain\b|\bcoin\b|\bweb3\b|محفظة|عملة رقمية|بلوك ?تشين|عملة مشفّرة/i;

/** PalCert's plumbing, which nobody withdrawing money should meet. */
const INTERNAL_TERMS =
  /\bledger\b|\bidempotenc|\bminor units?\b|\bsigned url\b|\bquarantine\b|\bprisma\b|\bpostgres|\bRLS\b|\bhold\b|\bsettlement key\b/i;

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

const keys = (messages: WithdrawalMessages) =>
  flatten(messages)
    .map(([path]) => path)
    .sort();

describe('withdrawal message catalogue', () => {
  it('defines every key in both locales', () => {
    expect(keys(WITHDRAWAL_MESSAGES.ar)).toEqual(keys(WITHDRAWAL_MESSAGES.en));
  });

  it('labels every status, rejection reason and history event the API can return', () => {
    for (const locale of LOCALES) {
      const messages = WITHDRAWAL_MESSAGES[locale];
      expect(Object.keys(messages.statuses).sort()).toEqual([...WITHDRAWAL_STATUSES].sort());
      expect(Object.keys(messages.rejectionReasons).sort()).toEqual(
        [...WITHDRAWAL_REJECTION_REASONS].sort(),
      );
      expect(Object.keys(messages.events).sort()).toEqual([...WITHDRAWAL_EVENT_TYPES].sort());
    }
  });

  it('writes Arabic in Arabic', () => {
    for (const [key, value] of flatten(WITHDRAWAL_MESSAGES.ar)) {
      if (value === '—' || /^#?[A-Z0-9_ ]+$/.test(value)) continue;
      expect([key, ARABIC_SCRIPT.test(value)]).toEqual([key, true]);
    }
  });

  it('uses the agreed Arabic terms', () => {
    const ar = WITHDRAWAL_MESSAGES.ar;
    expect(ar.nav.withdraw).toBe('سحب الأموال');
    expect(ar.form.title).toBe('طلب سحب الأموال');
    expect(ar.breakdown.withdrawable).toBe('قابل للسحب');
    expect(ar.breakdown.reservedForWithdrawal).toBe('محجوز للسحب');
    expect(ar.form.destination).toBe('جهة استلام الأموال');
    expect(ar.statuses['PENDING_REVIEW']).toBe('بانتظار المراجعة');
    expect(ar.statuses['APPROVED']).toBe('معتمد');
    expect(ar.statuses['PAID']).toBe('تم التحويل');
    expect(ar.statuses['REJECTED']).toBe('مرفوض');
    expect(ar.detail.transferReference).toBe('الرقم المرجعي للتحويل');
  });

  it('never calls PalCert Balance a wallet and never exposes internal terms', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(WITHDRAWAL_MESSAGES[locale])) {
        expect([key, FORBIDDEN_FINANCIAL_VOCABULARY.test(value)]).toEqual([key, false]);
        expect([key, INTERNAL_TERMS.test(value)]).toEqual([key, false]);
      }
    }
  });

  it('keeps card refunds and withdrawals apart (policy 4)', () => {
    expect(WITHDRAWAL_MESSAGES.en.balanceCard.refundTitle).toBe('Refund card payment');
    expect(WITHDRAWAL_MESSAGES.en.balanceCard.refundBody).toMatch(/card/);
    expect(WITHDRAWAL_MESSAGES.en.breakdown.notWithdrawableHint).toMatch(/Card top-ups/);
  });
});
