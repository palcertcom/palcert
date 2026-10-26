import { describe, expect, it } from 'vitest';
import { PDF_MESSAGES, getPdfMessages, type PdfMessages } from './pdf-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;

const NESTED_MAPS = [
  'textLayers',
  'textLayerHints',
  'coverageLevels',
  'supportLevels',
  'errors',
] as const;

/** PalCert's own plumbing, which a customer should never meet. */
const INTERNAL_TERMS =
  /\bMediaBox\b|\bCropBox\b|\bXObject\b|\bPDFium\b|\bpikepdf\b|\bqpdf\b|\bToUnicode\b|\bnode id\b|\bSHA-?256\b|\bmarked[- ]content\b|\bglyph\b/i;

/** Phase 10's vocabulary guard, still in force. */
const FORBIDDEN_FINANCIAL_VOCABULARY =
  /\bwallet\b|\bcrypto|\bblockchain\b|\bcoin\b|محفظة|عملة رقمية/i;

describe('PDF message catalogue', () => {
  it('defines every key in every locale', () => {
    const reference = Object.keys(PDF_MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(PDF_MESSAGES[locale]).sort()).toEqual(reference);
    }
  });

  it('defines every nested label in every locale', () => {
    for (const map of NESTED_MAPS) {
      const reference = Object.keys(PDF_MESSAGES[DEFAULT_LOCALE][map]).sort();
      for (const locale of LOCALES) {
        expect([locale, map, Object.keys(PDF_MESSAGES[locale][map]).sort()]).toEqual([
          locale,
          map,
          reference,
        ]);
      }
    }
  });

  it('writes Arabic in Arabic', () => {
    // `formatPdf` is the format's name, which stays "PDF" in Arabic prose the
    // same way it does in speech. Everything a person actually reads is
    // translated.
    const NOT_TRANSLATED = new Set(['formatPdf']);
    for (const [key, value] of flatten(PDF_MESSAGES.ar)) {
      if (NOT_TRANSLATED.has(key)) continue;
      expect([key, ARABIC_SCRIPT.test(value)]).toEqual([key, true]);
    }
  });

  it('never promises a PDF correction', () => {
    // ADR-0092: PalCert does not edit PDFs, and an empty panel reads as a
    // feature that has not shipped yet rather than one that will not.
    expect(PDF_MESSAGES.en.smartFixUnavailable).toMatch(/does not correct/i);
    expect(PDF_MESSAGES.ar.smartFixUnavailable).toMatch(/لا يصحّح/);
    for (const [key, value] of [...flatten(PDF_MESSAGES.en), ...flatten(PDF_MESSAGES.ar)]) {
      expect([key, /\bcoming soon\b|\bnot yet\b|\byet to\b|قريبًا|لاحقًا/i.test(value)]).toEqual([
        key,
        false,
      ]);
    }
  });

  it('tells a PDF user what to do instead of correcting', () => {
    expect(PDF_MESSAGES.en.smartFixAdvice).toMatch(/export a new PDF/i);
    expect(PDF_MESSAGES.ar.smartFixAdvice).toMatch(/وورد/);
  });

  it('explains a scanned document and what to do about it, in both languages', () => {
    // ADR-0096: the user's document has no text and PalCert will not invent
    // any. The sentence that matters is the one telling them how to fix it.
    expect(PDF_MESSAGES.en.textLayerHints.IMAGE_ONLY).toMatch(/no text to read/i);
    expect(PDF_MESSAGES.en.scannedAdvice).toMatch(/export a new PDF/i);
    expect(PDF_MESSAGES.ar.textLayerHints.IMAGE_ONLY).toMatch(/صورة/);
    expect(PDF_MESSAGES.ar.scannedAdvice).toMatch(/أصدر/);
  });

  it('never claims to have read text out of a picture', () => {
    for (const [key, value] of [...flatten(PDF_MESSAGES.en), ...flatten(PDF_MESSAGES.ar)]) {
      expect([key, /\bOCR\b|optical character|تعرّف ضوئي/i.test(value)]).toEqual([key, false]);
    }
  });

  it('explains an untagged PDF as a property of the file, not a fault', () => {
    // ADR-0093: a user whose headings were "not checked" deserves to know why,
    // and that the alternative was PalCert guessing.
    expect(PDF_MESSAGES.en.untaggedExplanation).toMatch(/cannot tell a heading/i);
    expect(PDF_MESSAGES.en.untaggedExplanation).toMatch(/rather than guessed at/i);
    expect(PDF_MESSAGES.ar.untaggedExplanation).toMatch(/بدل تخمينها/);
  });

  it('never turns a signature field into a signature', () => {
    // ADR-0102.
    expect(PDF_MESSAGES.en.signatureField(1)).toMatch(/field/i);
    expect(PDF_MESSAGES.en.signatureNotVerified).toMatch(/does not check whether/i);
    expect(PDF_MESSAGES.ar.signatureNotVerified).toMatch(/لا يتحقق/);
    for (const [key, value] of [...flatten(PDF_MESSAGES.en), ...flatten(PDF_MESSAGES.ar)]) {
      expect([
        key,
        /\bsigned by\b|\bvalid signature\b|\bverified signature\b|توقيع صحيح|موقَّع من/i.test(
          value,
        ),
      ]).toEqual([key, false]);
    }
  });

  it('never turns a PDF⁄A claim into conformance', () => {
    expect(PDF_MESSAGES.en.pdfaClaim('2', 'b')).toMatch(/states that it is/i);
    expect(PDF_MESSAGES.en.pdfaNotValidated).toMatch(/does not verify/i);
    expect(PDF_MESSAGES.ar.pdfaNotValidated).toMatch(/لا يتحقق/);
  });

  it('says active content was counted and not touched', () => {
    // ADR-0103.
    expect(PDF_MESSAGES.en.activeContent).toMatch(/did not open, run or follow/i);
    expect(PDF_MESSAGES.ar.activeContent).toMatch(/لم يفتح/);
  });

  it('does not let a coverage preview read as a promised result', () => {
    // ADR-0100: supported means "PalCert can read this from a PDF", not "your
    // document will get a verdict".
    expect(PDF_MESSAGES.en.coverageNotAPromise).toMatch(/may still leave it unanswered/i);
    expect(PDF_MESSAGES.ar.coverageNotAPromise).toMatch(/دون إجابة/);
    for (const [key, value] of [...flatten(PDF_MESSAGES.en), ...flatten(PDF_MESSAGES.ar)]) {
      expect([
        key,
        /\bwill pass\b|\bguaranteed\b|\bwill comply\b|مضمون|سيجتاز/i.test(value),
      ]).toEqual([key, false]);
    }
  });

  it('says nothing was charged wherever an analysis failed', () => {
    // §79: a fatal failure releases the reservation. The user needs to read
    // that on the same screen as the failure, not discover it on the balance.
    for (const code of [
      'DOCUMENT_PASSWORD_REQUIRED',
      'DOCUMENT_ENCRYPTION_UNSUPPORTED',
      'DOCUMENT_INVALID',
      'DOCUMENT_TOO_COMPLEX',
    ]) {
      expect([code, PDF_MESSAGES.en.errors[code]]).toEqual([
        code,
        expect.stringMatching(/not been charged/i),
      ]);
      expect([code, PDF_MESSAGES.ar.errors[code]]).toEqual([
        code,
        expect.stringMatching(/لم يُخصم/),
      ]);
    }
  });

  it('never suggests PalCert could open a protected document anyway', () => {
    // §19: PalCert does not collect a password and does not bypass one.
    for (const [key, value] of [...flatten(PDF_MESSAGES.en), ...flatten(PDF_MESSAGES.ar)]) {
      expect([key, /enter the password|unlock|bypass|أدخل كلمة المرور|تجاوز/i.test(value)]).toEqual(
        [key, false],
      );
    }
  });

  it('speaks a person’s language, not PalCert’s', () => {
    for (const [key, value] of [...flatten(PDF_MESSAGES.en), ...flatten(PDF_MESSAGES.ar)]) {
      expect([key, INTERNAL_TERMS.test(value)]).toEqual([key, false]);
      expect([key, FORBIDDEN_FINANCIAL_VOCABULARY.test(value)]).toEqual([key, false]);
    }
  });

  it('pluralizes counts in both languages', () => {
    for (const locale of LOCALES) {
      const messages = PDF_MESSAGES[locale];
      expect(messages.pageCount(7)).toContain('7');
      expect(messages.attachments(1)).not.toBe(messages.attachments(3));
      expect(messages.coverageCounts(3, 9)).toContain('9');
    }
  });

  it('falls back to English for an unknown locale', () => {
    expect(getPdfMessages('fr' as never)).toBe(PDF_MESSAGES.en);
    expect(getPdfMessages('ar')).toBe(PDF_MESSAGES.ar);
  });
});

function flatten(messages: PdfMessages): [string, string][] {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === 'string') entries.push([key, value]);
    else if (typeof value === 'function') entries.push([key, String(value(2, 4))]);
    else if (value !== null && typeof value === 'object') {
      for (const [inner, text] of Object.entries(value as Record<string, string>)) {
        entries.push([`${key}.${inner}`, text]);
      }
    }
  }
  return entries;
}
