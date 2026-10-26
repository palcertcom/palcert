import { describe, expect, it } from 'vitest';
import { SMARTFIX_MESSAGES, getSmartFixMessages, type SmartFixMessages } from './smartfix-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;

const NESTED_MAPS = [
  'fixability',
  'reasons',
  'refusals',
  'statuses',
  'statusHints',
  'failureCodes',
  'errors',
] as const;

/** PalCert's own plumbing, which a customer should never meet. */
const INTERNAL_TERMS =
  /\bOOXML\b|\bw:sz\b|\brPr\b|\bnode id\b|\bXPath\b|\btwips?\b|\bmutator\b|\bcapability registry\b|\bplan hash\b|\bSHA-?256\b/i;

/** Phase 10's vocabulary guard, still in force. */
const FORBIDDEN_FINANCIAL_VOCABULARY =
  /\bwallet\b|\bcrypto|\bblockchain\b|\bcoin\b|محفظة|عملة رقمية/i;

describe('SmartFix message catalogue', () => {
  it('defines every key in every locale', () => {
    const reference = Object.keys(SMARTFIX_MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(SMARTFIX_MESSAGES[locale]).sort()).toEqual(reference);
    }
  });

  it('defines every nested label in every locale', () => {
    for (const map of NESTED_MAPS) {
      const reference = Object.keys(SMARTFIX_MESSAGES[DEFAULT_LOCALE][map]).sort();
      for (const locale of LOCALES) {
        expect([locale, map, Object.keys(SMARTFIX_MESSAGES[locale][map]).sort()]).toEqual([
          locale,
          map,
          reference,
        ]);
      }
    }
  });

  it('writes Arabic in Arabic', () => {
    for (const [key, value] of flatten(SMARTFIX_MESSAGES.ar)) {
      expect([key, ARABIC_SCRIPT.test(value)]).toEqual([key, true]);
    }
  });

  it('never says a correction is finished before it is delivered', () => {
    // §189: the single most important wording rule in the phase. A person
    // reading "Fixed" while PalCert is still working would believe their
    // document is ready to submit.
    const inFlight = ['RESERVED', 'PROCESSING', 'RECHECKING', 'VALIDATING'] as const;
    for (const locale of LOCALES) {
      const messages = SMARTFIX_MESSAGES[locale];
      for (const status of inFlight) {
        // Not the delivered label, and nothing that reads as finished.
        expect([locale, status, messages.statuses[status]]).not.toEqual([
          locale,
          status,
          messages.statuses.DELIVERED,
        ]);
        expect([
          locale,
          status,
          /\bfixed\b|\bready\b|\bdone\b|\bcomplete\b|تم التصحيح|جاهز/i.test(
            messages.statuses[status]!,
          ),
        ]).toEqual([locale, status, false]);
      }
    }
    expect(SMARTFIX_MESSAGES.en.statuses.DELIVERED).toBe('Corrected');
    expect(SMARTFIX_MESSAGES.ar.statuses.DELIVERED).toBe('تم التصحيح');
  });

  it('never claims the document now complies', () => {
    // §190: SmartFix corrects formatting. Rules it could not correct are still
    // failing, and the user was told so before they paid.
    for (const [key, value] of [
      ...flatten(SMARTFIX_MESSAGES.en),
      ...flatten(SMARTFIX_MESSAGES.ar),
    ]) {
      expect([
        key,
        /now complies|fully compliant|meets all|مطابق تمامًا|يستوفي كل/i.test(value),
      ]).toEqual([key, false]);
    }
    // And it says so out loud where it matters most.
    expect(SMARTFIX_MESSAGES.en.stillFailing).toMatch(/does not mean/i);
    expect(SMARTFIX_MESSAGES.ar.stillFailing).toMatch(/لا يعني/);
  });

  it('promises the original is untouched, in both languages', () => {
    // §186: the first thing anybody wants to know before letting software
    // edit their thesis.
    expect(SMARTFIX_MESSAGES.en.originalSafe).toMatch(/never changed/i);
    expect(SMARTFIX_MESSAGES.ar.originalSafe).toMatch(/لا يُعدَّل/);
  });

  it('says planning is free and correcting is not', () => {
    expect(SMARTFIX_MESSAGES.en.planFree).toBe('Free');
    expect(SMARTFIX_MESSAGES.en.planIntro).toMatch(/nothing is charged/i);
    expect(SMARTFIX_MESSAGES.ar.planIntro).toMatch(/لا يُخصم/);
  });

  it('reuses the finance vocabulary exactly', () => {
    // §188: reserved / charged / reservation released mean the same things
    // here as on the balance screen, in both languages.
    expect(SMARTFIX_MESSAGES.ar.statusHints.RESERVED).toMatch(/محجوز/);
    expect(SMARTFIX_MESSAGES.ar.statusHints.DELIVERED).toMatch(/تم خصم/);
    expect(SMARTFIX_MESSAGES.ar.statusHints.FAILED).toMatch(/أُعيد المبلغ المحجوز/);
    expect(SMARTFIX_MESSAGES.en.statusHints.FAILED).toMatch(/no charge was made/i);
  });

  it('explains every reason a rule is left alone', () => {
    for (const locale of LOCALES) {
      for (const [code, text] of Object.entries(SMARTFIX_MESSAGES[locale].reasons)) {
        // A code the user can see and not understand is not an explanation.
        expect([code, text.length > 25]).toEqual([code, true]);
        // A code the user can see and not understand is not an explanation.
        expect([code, text.includes(code)]).toEqual([code, false]);
      }
    }
  });

  it('tells a user what to do about a refusal', () => {
    // A refused document is the one case where the user can act immediately,
    // so the message says how (§187).
    expect(SMARTFIX_MESSAGES.en.refusals.SMARTFIX_TRACKED_CHANGES_UNSUPPORTED).toMatch(
      /accept or reject/i,
    );
    expect(SMARTFIX_MESSAGES.en.refusals.SMARTFIX_DOCUMENT_PROTECTED).toMatch(
      /remove the protection/i,
    );
    expect(SMARTFIX_MESSAGES.ar.refusals.SMARTFIX_TRACKED_CHANGES_UNSUPPORTED).toMatch(/قبولها/);
  });

  it('says nothing was charged when nothing was delivered', () => {
    for (const locale of LOCALES) {
      const messages = SMARTFIX_MESSAGES[locale];
      for (const code of ['SMARTFIX_TARGETS_NOT_RESOLVED', 'SMARTFIX_REGRESSION_DETECTED']) {
        const text = messages.failureCodes[code]!;
        expect([locale, code, /nothing was charged|لم يُخصم/i.test(text)]).toEqual([
          locale,
          code,
          true,
        ]);
      }
    }
  });

  it('uses no internal vocabulary and nothing crypto', () => {
    for (const [key, value] of [
      ...flatten(SMARTFIX_MESSAGES.en),
      ...flatten(SMARTFIX_MESSAGES.ar),
    ]) {
      expect([key, INTERNAL_TERMS.test(value)]).toEqual([key, false]);
      expect([key, FORBIDDEN_FINANCIAL_VOCABULARY.test(value)]).toEqual([key, false]);
    }
  });

  it('pluralizes counts in both languages', () => {
    for (const locale of LOCALES) {
      const messages = SMARTFIX_MESSAGES[locale];
      expect(messages.willFix(1)).not.toBe(messages.willFix(4));
      expect(messages.changeCount(1)).not.toBe(messages.changeCount(7));
      expect(messages.changeCount(7)).toContain('7');
    }
  });

  it('falls back to English for an unknown locale', () => {
    expect(getSmartFixMessages('fr' as never)).toBe(SMARTFIX_MESSAGES.en);
    expect(getSmartFixMessages('ar')).toBe(SMARTFIX_MESSAGES.ar);
  });
});

function flatten(messages: SmartFixMessages): [string, string][] {
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
