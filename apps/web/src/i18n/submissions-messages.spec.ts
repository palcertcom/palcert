import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES } from './locales';
import {
  SUBMISSIONS_MESSAGES,
  getSubmissionsMessages,
  type SubmissionsMessages,
} from './submissions-messages';

const ARABIC_SCRIPT = /[؀-ۿ]/;

const NESTED_MAPS = [
  'sharedItems',
  'notSharedItems',
  'displayStatuses',
  'processingStatuses',
  'processingHints',
  'failureCodes',
  'reasonCodes',
  'errors',
] as const;

/** PalCert's own plumbing, which neither a student nor a registrar should meet. */
const INTERNAL_TERMS =
  /\bRLS\b|\brow[- ]level security\b|\bSECURITY DEFINER\b|\bs3\b|\bbucket\b|\bobject key\b|\bsnapshot key\b|\bidempotency\b|\bprisma\b/i;

/** Phase 10's vocabulary guard, still in force. */
const FORBIDDEN_FINANCIAL_VOCABULARY =
  /\bwallet\b|\bcrypto|\bblockchain\b|\bcoin\b|محفظة|عملة رقمية/i;

/** Phase 14 promises no certificate. Saying otherwise here would be a lie. */
const CERTIFICATE_VOCABULARY = /\bcertificate\b|\bcertified\b|\bverif(y|ied|ication) code\b|شهادة/i;

describe('Official submission message catalogue', () => {
  it('defines every key in every locale', () => {
    const reference = Object.keys(SUBMISSIONS_MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(SUBMISSIONS_MESSAGES[locale]).sort()).toEqual(reference);
    }
  });

  it('defines every nested label in every locale', () => {
    for (const map of NESTED_MAPS) {
      const reference = Object.keys(SUBMISSIONS_MESSAGES[DEFAULT_LOCALE][map]).sort();
      for (const locale of LOCALES) {
        expect([locale, map, Object.keys(SUBMISSIONS_MESSAGES[locale][map]).sort()]).toEqual([
          locale,
          map,
          reference,
        ]);
      }
    }
  });

  it('writes Arabic in Arabic', () => {
    for (const [key, value] of flatten(SUBMISSIONS_MESSAGES.ar)) {
      expect([key, ARABIC_SCRIPT.test(value)]).toEqual([key, true]);
    }
  });

  it('never merges the technical result with the institution’s decision', () => {
    // §2, §3, §82: the single most important wording rule in this phase. A
    // person who reads "approved" and understands "compliant" has been told
    // something PalCert did not say, and vice versa.
    for (const locale of LOCALES) {
      const messages = SUBMISSIONS_MESSAGES[locale];

      // Every decision label is distinct from every other, so no two states
      // collapse into one word.
      const labels = Object.values(messages.displayStatuses);
      expect(new Set(labels).size).toBe(labels.length);

      // And the processing vocabulary shares nothing with the decision
      // vocabulary: "Delivered" is not "Approved", "Could not be prepared" is
      // not "Rejected".
      for (const processing of Object.values(messages.processingStatuses)) {
        expect([locale, processing, labels.includes(processing)]).toEqual([
          locale,
          processing,
          false,
        ]);
      }
    }
  });

  it('says a preparation failure is not a decision', () => {
    // §5, §35: the state most likely to be misread. Somebody whose copy failed
    // must not think a university turned them down.
    expect(SUBMISSIONS_MESSAGES.en.processingHints.FAILED).toContain('not a decision');
    expect(SUBMISSIONS_MESSAGES.ar.processingHints.FAILED).toContain('ليس قرارًا');
    for (const locale of LOCALES) {
      expect(SUBMISSIONS_MESSAGES[locale].processingHints.PREPARING).not.toBe('');
    }
  });

  it('states what is not shared, not only what is', () => {
    // §21, §86: a list a person can check, rather than a promise they cannot.
    for (const locale of LOCALES) {
      const messages = SUBMISSIONS_MESSAGES[locale];
      for (const key of [
        'AI_REVIEW',
        'SMARTFIX_PLAN_AND_MANIFEST',
        'BALANCE_AND_PAYMENTS',
        'OTHER_DOCUMENT_VERSIONS',
        'OTHER_CHECKS',
      ]) {
        expect([locale, key, messages.notSharedItems[key]]).not.toEqual([locale, key, undefined]);
      }
    }
  });

  it('tells a reviewer their decision is theirs and the result is not', () => {
    for (const locale of LOCALES) {
      expect(SUBMISSIONS_MESSAGES[locale].reviewSeparation.length).toBeGreaterThan(40);
    }
    expect(SUBMISSIONS_MESSAGES.en.reviewSeparation).toContain('non-compliant');
    expect(SUBMISSIONS_MESSAGES.ar.reviewSeparation).toContain('غير مطابق');
  });

  it('promises no certificate, because Phase 14 issues none', () => {
    for (const [key, value] of [
      ...flatten(SUBMISSIONS_MESSAGES.en),
      ...flatten(SUBMISSIONS_MESSAGES.ar),
    ]) {
      expect([key, CERTIFICATE_VOCABULARY.test(value)]).toEqual([key, false]);
    }
  });

  it('keeps PalCert’s plumbing and finance vocabulary out of both languages', () => {
    for (const [key, value] of [
      ...flatten(SUBMISSIONS_MESSAGES.en),
      ...flatten(SUBMISSIONS_MESSAGES.ar),
    ]) {
      expect([key, INTERNAL_TERMS.test(value)]).toEqual([key, false]);
      expect([key, FORBIDDEN_FINANCIAL_VOCABULARY.test(value)]).toEqual([key, false]);
    }
  });

  it('pluralizes counts in both languages', () => {
    for (const locale of LOCALES) {
      const messages = SUBMISSIONS_MESSAGES[locale];
      expect(messages.revisionCount(1)).not.toBe(messages.revisionCount(4));
      expect(messages.revisionCount(4)).toContain('4');
      expect(messages.revisionLabel(2)).toContain('2');
    }
  });

  it('falls back to English for an unknown locale', () => {
    expect(getSubmissionsMessages('fr' as never)).toBe(SUBMISSIONS_MESSAGES.en);
    expect(getSubmissionsMessages('ar')).toBe(SUBMISSIONS_MESSAGES.ar);
  });
});

function flatten(messages: SubmissionsMessages): [string, string][] {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === 'string') entries.push([key, value]);
    else if (typeof value === 'function') entries.push([key, String(value(2))]);
    else if (value !== null && typeof value === 'object') {
      for (const [inner, text] of Object.entries(value as Record<string, string>)) {
        entries.push([`${key}.${inner}`, text]);
      }
    }
  }
  return entries;
}
