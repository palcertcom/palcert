import { describe, expect, it } from 'vitest';
import {
  REVIEW_CONSOLE_MESSAGES,
  formatMessage,
  type ReviewConsoleMessages,
} from './review-console-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;
/** The extraction catalogue's rules: counts, never scores or percentages (§34, §147). */
const CONFIDENCE_CLAIM = /\bconfidence\b|\bconfident\b|\bprobabilit|\bscore\b|%|نسبة الثقة|احتمال/i;
const AUTHORITY_CLAIM = /automatically (accept|publish|approve)|يقبل تلقائياً|ينشر تلقائياً/i;

function strings(value: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof value === 'string') out.push([path, value]);
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) strings(child, `${path}.${key}`, out);
  }
  return out;
}

describe('review console message catalogue', () => {
  it('defines every key, nested ones included, in every locale', () => {
    const shape = (messages: ReviewConsoleMessages) =>
      strings(messages, '')
        .map(([path]) => path)
        .sort();
    const reference = shape(REVIEW_CONSOLE_MESSAGES[DEFAULT_LOCALE]);
    for (const locale of LOCALES) {
      expect(shape(REVIEW_CONSOLE_MESSAGES[locale]), locale).toEqual(reference);
    }
  });

  it('keeps the same placeholders in every translation', () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    const en = new Map(strings(REVIEW_CONSOLE_MESSAGES.en, ''));
    for (const [path, text] of strings(REVIEW_CONSOLE_MESSAGES.ar, '')) {
      expect(placeholders(text), `ar${path}`).toEqual(placeholders(en.get(path)!));
    }
  });

  it('writes Arabic in Arabic', () => {
    for (const [path, text] of strings(REVIEW_CONSOLE_MESSAGES.ar, '')) {
      // A bare template such as "{from}–{to} of {total}" still carries a word.
      if (text.replace(/\{\w+\}|[\s–·()]/g, '') === '') continue;
      expect(ARABIC_SCRIPT.test(text), `ar${path}`).toBe(true);
    }
  });

  it('claims no confidence, percentage or automatic decision', () => {
    for (const locale of LOCALES) {
      for (const [path, text] of strings(REVIEW_CONSOLE_MESSAGES[locale], '')) {
        expect(text, `${locale}${path}`).not.toMatch(CONFIDENCE_CLAIM);
        expect(text, `${locale}${path}`).not.toMatch(AUTHORITY_CLAIM);
      }
    }
  });

  it('asks the confirmation questions with the exact count', () => {
    expect(formatMessage(REVIEW_CONSOLE_MESSAGES.en.confirmRejectTitle, { count: 111 })).toBe(
      'Reject 111 pending proposals?',
    );
    expect(formatMessage(REVIEW_CONSOLE_MESSAGES.en.confirmAcceptTitle, { count: 98 })).toBe(
      'Accept 98 valid proposals into this draft?',
    );
    expect(formatMessage('{a} and {missing}', { a: 1 })).toBe('1 and {missing}');
  });
});
