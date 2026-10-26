import { describe, expect, it } from 'vitest';
import { AI_BILLING_MESSAGES } from './ai-billing-messages';
import { LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;

function flatten(value: object, prefix = ''): [string, string][] {
  return Object.entries(value).flatMap(([key, inner]) =>
    typeof inner === 'string'
      ? [[`${prefix}${key}`, inner] as [string, string]]
      : flatten(inner as object, `${prefix}${key}.`),
  );
}

describe('AI billing message catalogue (ADR-0149)', () => {
  it('defines every label in every locale', () => {
    const reference = flatten(AI_BILLING_MESSAGES.en)
      .map(([key]) => key)
      .sort();
    for (const locale of LOCALES) {
      expect(
        flatten(AI_BILLING_MESSAGES[locale])
          .map(([key]) => key)
          .sort(),
      ).toEqual(reference);
    }
  });

  it('writes Arabic in Arabic', () => {
    for (const [key, value] of flatten(AI_BILLING_MESSAGES.ar)) {
      expect([key, ARABIC_SCRIPT.test(value)]).toEqual([key, true]);
    }
  });

  it('uses the agreed customer wording', () => {
    expect(AI_BILLING_MESSAGES.en.feeTitle).toBe('AI service fee');
    expect(AI_BILLING_MESSAGES.ar.feeTitle).toBe('رسوم خدمة الذكاء الاصطناعي');
    expect(AI_BILLING_MESSAGES.en.chargedOnSuccess).toBe(
      'Your balance will be charged when the AI service completes successfully.',
    );
    expect(AI_BILLING_MESSAGES.ar.chargedOnSuccess).toBe(
      'سيتم خصم الرسوم من رصيدك عند اكتمال خدمة الذكاء الاصطناعي بنجاح.',
    );
    expect(AI_BILLING_MESSAGES.en.insufficient).toBe('Insufficient balance');
    expect(AI_BILLING_MESSAGES.ar.insufficient).toBe('الرصيد غير كافٍ');
    expect(AI_BILLING_MESSAGES.en.organizationNotice).toBe(
      'This AI service is billed to your PalCert Balance, even when used for an organization.',
    );
    expect(AI_BILLING_MESSAGES.ar.organizationNotice).toBe(
      'يتم احتساب رسوم خدمة الذكاء الاصطناعي من رصيدك في PalCert حتى عند استخدامها لصالح مؤسسة.',
    );
    expect(AI_BILLING_MESSAGES.en.unavailable).toBe(
      'This AI service is not currently available in your balance currency.',
    );
    expect(AI_BILLING_MESSAGES.ar.unavailable).toBe(
      'خدمة الذكاء الاصطناعي هذه غير متاحة حالياً بعملة رصيدك.',
    );
  });

  it('never shows a raw product code to a customer', () => {
    for (const locale of LOCALES) {
      for (const [code, label] of Object.entries(AI_BILLING_MESSAGES[locale].products)) {
        expect([code, label === code || /^[A-Z_]+$/.test(label)]).toEqual([code, false]);
      }
    }
  });

  it('never speaks of wallets or tokens', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(AI_BILLING_MESSAGES[locale])) {
        expect([key, /\bwallet\b|\btokens?\b|محفظة/i.test(value)]).toEqual([key, false]);
      }
    }
  });
});
