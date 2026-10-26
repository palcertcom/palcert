import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES } from './locales';
import {
  CERTIFICATES_MESSAGES,
  getCertificatesMessages,
  type CertificatesMessages,
} from './certificates-messages';

const ARABIC_SCRIPT = /[؀-ۿ]/;

const NESTED_MAPS = [
  'statuses',
  'statusHints',
  'issuanceStatuses',
  'ineligible',
  'reasons',
  'errors',
] as const;

/**
 * Keys whose value is deliberately a Latin format sample rather than prose.
 * A placeholder showing the shape of a certificate number is the same shape
 * in both languages, because the number itself is.
 */
const NOT_PROSE = new Set(['verifyPlaceholder']);

/** PalCert's plumbing, which nobody reading a certificate should meet (§129–§135). */
const INTERNAL_TERMS =
  /\bRLS\b|\brow[- ]level security\b|\bSECURITY DEFINER\b|\bs3\b|\bbucket\b|\bobject key\b|\bsnapshot key\b|\bidempotency\b|\bprisma\b|\bsigned url\b|\bjob\b/i;

/**
 * §2, §3, §38–§44: the claim is about a document and a decision. It is never a
 * degree, an accreditation, a licence, a peer-review verdict or a judgement of
 * quality — in either language.
 */
const MERIT_VOCABULARY =
  /\bdegree\b|\baccredit|\blicen[cs]|\bquality\b|\bexcellen|\bendorse|\bauthentic\b|\bgenuine\b|\bpeer[- ]review|شهادة جامعية|اعتماد أكاديمي|ترخيص|جودة|تميّز|تزكية/i;

/** §10, §11, §129: the public claim is document-bound, never person-bound. */
const IDENTITY_VOCABULARY =
  /\bstudent (name|number|id)\b|\bholder'?s name\b|\bemail\b|\bfull name\b|اسم الطالب|رقم الطالب|البريد الإلكتروني|اسم صاحب/i;

/** Phase 10's vocabulary guard, still in force. */
const FORBIDDEN_FINANCIAL_VOCABULARY =
  /\bwallet\b|\bcrypto|\bblockchain\b|\bcoin\b|\bfee\b|\bprice\b|محفظة|عملة رقمية|رسوم/i;

describe('Certificate message catalogue', () => {
  it('defines every key in every locale', () => {
    const reference = Object.keys(CERTIFICATES_MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(CERTIFICATES_MESSAGES[locale]).sort()).toEqual(reference);
    }
  });

  it('defines every label at every depth in every locale', () => {
    const reference = flatten(CERTIFICATES_MESSAGES[DEFAULT_LOCALE])
      .map(([key]) => key)
      .sort();
    for (const locale of LOCALES) {
      expect(
        flatten(CERTIFICATES_MESSAGES[locale])
          .map(([key]) => key)
          .sort(),
      ).toEqual(reference);
    }
  });

  it('defines every nested label in every locale', () => {
    for (const map of NESTED_MAPS) {
      const reference = Object.keys(CERTIFICATES_MESSAGES[DEFAULT_LOCALE][map]).sort();
      for (const locale of LOCALES) {
        expect([locale, map, Object.keys(CERTIFICATES_MESSAGES[locale][map]).sort()]).toEqual([
          locale,
          map,
          reference,
        ]);
      }
    }
  });

  it('writes Arabic in Arabic', () => {
    for (const [key, value] of flatten(CERTIFICATES_MESSAGES.ar)) {
      if (NOT_PROSE.has(key)) continue;
      expect([key, ARABIC_SCRIPT.test(value)]).toEqual([key, true]);
    }
  });

  it('keeps PalCert’s result and the institution’s decision in separate words', () => {
    // §114: the rule the whole architecture exists to preserve. Arabic in
    // particular must not collapse both authorities into one generic word.
    expect(CERTIFICATES_MESSAGES.ar.technicalResult).toContain('نتيجة الامتثال التقني');
    expect(CERTIFICATES_MESSAGES.ar.institutionDecision).toContain('قرار المؤسسة');
    expect(CERTIFICATES_MESSAGES.ar.technicalResult).not.toContain('قرار المؤسسة');
    expect(CERTIFICATES_MESSAGES.ar.institutionDecision).not.toContain('الامتثال التقني');

    for (const locale of LOCALES) {
      const messages = CERTIFICATES_MESSAGES[locale];
      expect([locale, messages.technicalResult]).not.toEqual([
        locale,
        messages.institutionDecision,
      ]);
      expect([locale, messages.compliant]).not.toEqual([locale, messages.approved]);
      // And the statement of what the certificate means names both, so nobody
      // reads one as standing in for the other.
      expect([locale, messages.authorityNote.length > 80]).toEqual([locale, true]);
    }
  });

  it('says revoked and expired in words, not only in colour', () => {
    // §111, §112: a holder waving an old PDF must meet a sentence, not a badge.
    expect(CERTIFICATES_MESSAGES.en.statuses.REVOKED).toMatch(/revoked/i);
    expect(CERTIFICATES_MESSAGES.en.statuses.EXPIRED).toMatch(/expired/i);
    expect(CERTIFICATES_MESSAGES.ar.statuses.REVOKED).toContain('أُلغيت');
    expect(CERTIFICATES_MESSAGES.ar.statuses.EXPIRED).toContain('انتهت');
    for (const locale of LOCALES) {
      for (const status of ['VALID', 'REVOKED', 'EXPIRED']) {
        expect([locale, status, CERTIFICATES_MESSAGES[locale].statusHints[status]]).not.toEqual([
          locale,
          status,
          undefined,
        ]);
      }
    }
  });

  it('says a revocation does not unsay the technical result or the decision', () => {
    // §63: revoking changes the certificate's validity and nothing else.
    expect(CERTIFICATES_MESSAGES.en.statusHints.REVOKED).toMatch(/unchanged/i);
    expect(CERTIFICATES_MESSAGES.ar.statusHints.REVOKED).toContain('لم يتغيّرا');
  });

  it('never blames the institution for a technical result', () => {
    // §116–§121: "not compliant" is PalCert's finding. Wording it as a refusal
    // by the university would be a lie about who decided what.
    expect(CERTIFICATES_MESSAGES.en.ineligible.NOT_COMPLIANT).not.toMatch(
      /institution (decision of )?(rejected|declined)|rejected by/i,
    );
    expect(CERTIFICATES_MESSAGES.ar.ineligible.NOT_COMPLIANT).not.toContain('رفض');
    // And the mirror: a rejection is not described as a compliance failure.
    expect(CERTIFICATES_MESSAGES.en.ineligible.NOT_APPROVED).not.toMatch(/compliant|technical/i);
    expect(CERTIFICATES_MESSAGES.ar.ineligible.NOT_APPROVED).not.toContain('الامتثال');
    // Waiting is waiting, and says so rather than implying a refusal.
    expect(CERTIFICATES_MESSAGES.en.ineligible.AWAITING_INSTITUTION_DECISION).toMatch(/still/i);
  });

  it('claims only what PalCert measured, never merit', () => {
    for (const [key, value] of [
      ...flatten(CERTIFICATES_MESSAGES.en),
      ...flatten(CERTIFICATES_MESSAGES.ar),
    ]) {
      expect([key, MERIT_VOCABULARY.test(value)]).toEqual([key, false]);
    }
  });

  it('keeps the public wording document-bound, not person-bound', () => {
    for (const [key, value] of [
      ...flatten(CERTIFICATES_MESSAGES.en),
      ...flatten(CERTIFICATES_MESSAGES.ar),
    ]) {
      expect([key, IDENTITY_VOCABULARY.test(value)]).toEqual([key, false]);
    }
  });

  it('keeps PalCert’s plumbing and finance vocabulary out of both languages', () => {
    for (const [key, value] of [
      ...flatten(CERTIFICATES_MESSAGES.en),
      ...flatten(CERTIFICATES_MESSAGES.ar),
    ]) {
      expect([key, INTERNAL_TERMS.test(value)]).toEqual([key, false]);
      expect([key, FORBIDDEN_FINANCIAL_VOCABULARY.test(value)]).toEqual([key, false]);
    }
  });

  it('tells a verifier there is no directory to browse', () => {
    // §13–§16: holder-mediated verification, stated rather than implied.
    expect(CERTIFICATES_MESSAGES.en.verifyIntro).toMatch(/no directory|cannot be searched/i);
    expect(CERTIFICATES_MESSAGES.ar.verifyIntro).toContain('دليل');
  });

  it('warns that a revocation cannot be undone', () => {
    // §67: there is no un-revoke, so the reviewer is told before, not after.
    expect(CERTIFICATES_MESSAGES.en.revokeHint).toMatch(/cannot be undone/i);
    expect(CERTIFICATES_MESSAGES.ar.revokeHint).toContain('لا يمكن التراجع');
    expect(CERTIFICATES_MESSAGES.en.revokeCommentHint).toMatch(/never shown publicly/i);
    expect(CERTIFICATES_MESSAGES.ar.revokeCommentHint).toContain('لا تُعرض للعموم');
  });

  it('falls back to English for an unknown locale', () => {
    expect(getCertificatesMessages('fr' as never)).toBe(CERTIFICATES_MESSAGES.en);
    expect(getCertificatesMessages('ar')).toBe(CERTIFICATES_MESSAGES.ar);
  });
});

function flatten(messages: CertificatesMessages | object, prefix = ''): [string, string][] {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(messages)) {
    const path = `${prefix}${key}`;
    if (typeof value === 'string') entries.push([path, value]);
    else if (typeof value === 'function') entries.push([path, String(value(2))]);
    else if (value !== null && typeof value === 'object') {
      entries.push(...flatten(value as object, `${path}.`));
    }
  }
  return entries;
}
