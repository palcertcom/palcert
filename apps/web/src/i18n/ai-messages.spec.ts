import { describe, expect, it } from 'vitest';
import { AI_MESSAGES, getAIMessages, type AIMessages } from './ai-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;
const NESTED_MAPS = ['assessmentLabels', 'priorities', 'errors'] as const;

/** Machine vocabulary that must never surface in a reader-facing string (§68, §78). */
const INTERNAL_TERMS =
  /bullmq|redis|prisma|postgres|worker|queue|sha256|jcs|canonicaliz|system prompt|max_tokens|json schema|api key/i;

/** Claims PalCert is not in a position to make (§43, §44, §56). */
const OVERCLAIMS =
  /\bapproved\b|\baccepted\b|\bcertified\b|\bcertificate\b|معتمد|مقبول|شهادة|اعتماد/i;

/**
 * Wording that frightens rather than informs (§67). A disclaimer people skip
 * protects nobody, and a wall of red warnings is how you train them to skip it.
 */
const ALARMIST =
  /\b(danger|dangerous|beware|warning|caution|critical|severe|fatal|alert|urgent)\b|!|خطر|تحذير|احذر|عاجل/i;

/** Judgements Phase 8 forbids the AI layer from offering at all (§44). */
const FORBIDDEN_JUDGEMENTS =
  /\bconfidence\b|\bprobabilit|\bnovelty\b|\bplagiaris|\bgrade\b|\bscore\b|\b\d+%|نسبة الثقة|درجة|علامة/i;

/**
 * Retention promises PalCert cannot make on a provider's behalf (§91). The
 * catalogue may describe *where* processing happens; it may not invent a
 * contractual guarantee about what happens to the data afterwards.
 */
const RETENTION_PROMISES =
  /zero data retention|never stored|not stored|never retained|not retained|is deleted immediately|لا يُحتفظ|يُحذف فوراً/i;

describe('AI message catalogue', () => {
  it('defines every key in every locale', () => {
    const reference = Object.keys(AI_MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(AI_MESSAGES[locale]).sort(), locale).toEqual(reference);
    }
  });

  it('defines every nested label in every locale', () => {
    for (const map of NESTED_MAPS) {
      const reference = Object.keys(AI_MESSAGES[DEFAULT_LOCALE][map]).sort();
      for (const locale of LOCALES) {
        expect(Object.keys(AI_MESSAGES[locale][map]).sort(), `${locale}.${map}`).toEqual(reference);
      }
    }
  });

  it('covers exactly the three AI assessment values, and no others', () => {
    // The semantic vocabulary is closed: an AI assessment is one of three
    // things, and none of them is a determination (§26).
    expect(Object.keys(AI_MESSAGES.en.assessmentLabels).sort()).toEqual([
      'INSUFFICIENT_EVIDENCE',
      'NOT_SATISFIED',
      'SATISFIED',
    ]);
  });

  it('never reuses deterministic PASS / FAIL wording for an AI assessment', () => {
    // Phase 7 measured; Phase 8 read something and formed an opinion. Sharing
    // the vocabulary would invite a reader to treat them as the same kind of
    // statement (§26, §28).
    for (const locale of LOCALES) {
      for (const [key, label] of Object.entries(AI_MESSAGES[locale].assessmentLabels)) {
        expect(
          /\bpass(ed)?\b|\bfail(ed|ure)?\b|ناجح|راسب|نجاح|رسوب/i.test(label),
          `${locale}.${key}`,
        ).toBe(false);
      }
    }
  });

  it('phrases an AI assessment as an appearance, not a fact', () => {
    expect(AI_MESSAGES.en.assessmentLabels.SATISFIED).toMatch(/appears/i);
    expect(AI_MESSAGES.en.assessmentLabels.NOT_SATISFIED).toMatch(/appears/i);
    expect(AI_MESSAGES.en.assessmentLabels.INSUFFICIENT_EVIDENCE).toMatch(/not enough evidence/i);
    // "Insufficient evidence" is presented as a legitimate answer rather than
    // an error, because refusing to guess is correct behaviour (§32).
    expect(AI_MESSAGES.ar.assessmentLabels.INSUFFICIENT_EVIDENCE).toMatch(/لا تكفي/);
  });

  it('separates the machine status, the AI assessment and the final status', () => {
    // The three labels the UI puts on three separate lines (§66). If any of
    // them were missing the two kinds of result could be blended into one.
    for (const locale of LOCALES) {
      const messages = AI_MESSAGES[locale];
      const labels = [messages.machineStatus, messages.aiAssessment, messages.finalStatus];
      expect(new Set(labels).size, locale).toBe(3);
      for (const label of labels) expect(label.length).toBeGreaterThan(0);
    }
  });

  it('states plainly that a document leaves PalCert', () => {
    // Consent has to describe external processing in the words a person would
    // use, before anything is sent (§14, §68).
    expect(AI_MESSAGES.en.consentExplanation).toMatch(/external/i);
    expect(AI_MESSAGES.en.consentExplanation).toMatch(/sends/i);
    expect(AI_MESSAGES.en.consentProviderNote).toMatch(/not only on PalCert/i);
    expect(AI_MESSAGES.ar.consentExplanation).toMatch(/خارجي/);
  });

  it('says which parts of the document are sent, and which are not', () => {
    // Data minimization is only meaningful to a person if it is stated (§17).
    expect(AI_MESSAGES.en.consentExplanation).toMatch(/does not send your whole document/i);
    expect(AI_MESSAGES.en.consentExplanation).toMatch(/never sends your file/i);
    expect(AI_MESSAGES.ar.consentExplanation).toMatch(/كاملاً/);
  });

  it('never promises a retention guarantee PalCert does not control', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of entries(AI_MESSAGES[locale])) {
        expect(RETENTION_PROMISES.test(value), `${locale}.${key}: ${value}`).toBe(false);
      }
    }
    // It points at the agreement instead, which is the honest answer (§91).
    expect(AI_MESSAGES.en.consentRetentionNote).toMatch(/agreement/i);
  });

  it('never claims a document was approved, accepted or certified', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of entries(AI_MESSAGES[locale])) {
        // One key exists precisely to say what PalCert does *not* do, so it
        // is the single place these words legitimately appear.
        if (key === 'notAnApproval') continue;
        expect(OVERCLAIMS.test(value), `${locale}.${key}: ${value}`).toBe(false);
      }
    }
    expect(AI_MESSAGES.en.notAnApproval).toMatch(/neither .* approves, accepts or certifies/i);
  });

  it('never offers a score, a confidence or a quality judgement', () => {
    // Not a research-quality score, not a novelty score, and not a number
    // dressed up as certainty (§34, §44).
    for (const locale of LOCALES) {
      for (const [key, value] of entries(AI_MESSAGES[locale])) {
        expect(FORBIDDEN_JUDGEMENTS.test(value), `${locale}.${key}: ${value}`).toBe(false);
      }
    }
  });

  it('states the limits of AI output without alarming anyone', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of entries(AI_MESSAGES[locale])) {
        expect(ALARMIST.test(value), `${locale}.${key}: ${value}`).toBe(false);
      }
    }
    expect(AI_MESSAGES.en.disclaimer).toMatch(/can be wrong/i);
    expect(AI_MESSAGES.ar.disclaimer).toMatch(/خاطئة/);
  });

  it('says the technical report is unaffected when the AI layer is not', () => {
    // Every failure path reassures the reader that the deterministic product
    // still stands, because it does (§57, §105).
    expect(AI_MESSAGES.en.unavailableHint).toMatch(/unaffected/i);
    expect(AI_MESSAGES.en.reviewFailedHint).toMatch(/unaffected/i);
    expect(AI_MESSAGES.en.disclaimer).toMatch(/unchanged by this review/i);
    expect(AI_MESSAGES.ar.unavailableHint).toMatch(/غير متأثر/);
  });

  it('keeps human review described as still required, not as a warning', () => {
    expect(AI_MESSAGES.en.humanReviewRequired).toMatch(/still required/i);
    expect(AI_MESSAGES.en.humanReviewNotRequired).toMatch(/advisory/i);
    expect(AI_MESSAGES.ar.humanReviewRequired).toMatch(/بشرية/);
  });

  it('never leaks an internal term into either locale', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of entries(AI_MESSAGES[locale])) {
        expect(INTERNAL_TERMS.test(value), `${locale}.${key}: ${value}`).toBe(false);
      }
    }
  });

  it('names no provider, because the provider is configuration', () => {
    // The catalogue is written against "an external AI provider"; the model
    // actually used comes from the review record at render time, so changing
    // configuration never leaves stale vendor names in the translations (§7).
    for (const locale of LOCALES) {
      for (const [key, value] of entries(AI_MESSAGES[locale])) {
        expect(/anthropic|claude|openai|gemini|gpt/i.test(value), `${locale}.${key}`).toBe(false);
      }
    }
  });

  it('covers every AI error code the API can return', () => {
    expect(Object.keys(AI_MESSAGES.en.errors).sort()).toEqual([
      'AI_CONSENT_REQUIRED',
      'AI_DISABLED',
      'AI_EVIDENCE_INTEGRITY_FAILED',
      'AI_PROVIDER_UNAVAILABLE',
      'AI_REVIEW_CHECK_NOT_COMPLETED',
      'AI_REVIEW_NOT_CANCELLABLE',
      'AI_REVIEW_NOT_FOUND',
      'AI_REVIEW_NO_ASSESSABLE_RULES',
    ]);
  });

  it('writes the Arabic catalogue in Arabic', () => {
    for (const [key, value] of entries(AI_MESSAGES.ar)) {
      // The product name legitimately stays Latin.
      const stripped = value.replace(/PalCert/g, '').trim();
      if (stripped.length === 0) continue;
      expect(ARABIC_SCRIPT.test(stripped), `ar.${key}: ${value}`).toBe(true);
    }
  });

  it('falls back to the default locale for an unknown one', () => {
    expect(getAIMessages('fr' as never)).toBe(AI_MESSAGES[DEFAULT_LOCALE]);
  });
});

/** Every reader-facing string in a catalogue, paired with a locatable key. */
function entries(messages: AIMessages): [string, string][] {
  const flat: [string, string][] = [];
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === 'string') {
      flat.push([key, value]);
    } else if (typeof value === 'object' && value !== null) {
      for (const [nested, text] of Object.entries(value)) {
        if (typeof text === 'string') flat.push([`${key}.${nested}`, text]);
      }
    }
  }
  return flat;
}
