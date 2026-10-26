import { describe, expect, it } from 'vitest';
import {
  EXTRACTION_MESSAGES,
  getExtractionMessages,
  type ExtractionMessages,
} from './extraction-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;

const NESTED_MAPS = [
  'sourceKinds',
  'sourceKindHints',
  'authorities',
  'sourceStatuses',
  'sourceRejectionReasons',
  'runStatuses',
  'runFailureKinds',
  'summaryLabels',
  'proposalKinds',
  'proposalKindHints',
  'proposalStatuses',
  'uniformityLabels',
  'automationSupportLabels',
  'rejectionReasons',
  'counterLabels',
  'errors',
] as const;

/**
 * Machine vocabulary a reader should never meet (§78 of Phase 8, §129).
 *
 * "Queued" is deliberately absent: it is ordinary English for waiting your
 * turn, and a reader understands it. What is forbidden is PalCert's own
 * plumbing — the broker, the schema, the provider conversation.
 */
const INTERNAL_TERMS =
  /bullmq|redis|prisma|postgres|\bworker\b|\bthe queue\b|\bs3\b|\bbucket\b|json schema|system prompt|max_tokens|api key|citation block|structured output|\btokens?\b/i;

/**
 * A confidence number, score or percentage, which Phase 9 forbids outright
 * (§34, §147). "187 of 196 paragraphs" is a count a reviewer can verify;
 * "94% confident" is a number PalCert has no basis for.
 */
const CONFIDENCE_CLAIM =
  /\bconfidence\b|\bconfident\b|\bprobabilit|\bscore\b|\d+\s*%|نسبة الثقة|احتمال/i;

/** Claims that the extraction is complete, which PalCert cannot know (§93). */
const COMPLETENESS_CLAIM =
  /\ball requirements\b|\bevery requirement\b|\bcomplete list\b|\bexhaustive\b|كل المتطلبات|جميع المتطلبات/i;

/** Wording that would turn a proposal into a decision (§43, §73, §74). */
const AUTHORITY_CLAIM =
  /automatically (accept|publish|approve)|\bcertified\b|\bapproved by palcert\b|يقبل تلقائياً|ينشر تلقائياً/i;

describe('extraction message catalogue', () => {
  it('defines every key in every locale', () => {
    const reference = Object.keys(EXTRACTION_MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(EXTRACTION_MESSAGES[locale]).sort(), locale).toEqual(reference);
    }
  });

  it('defines every nested label in every locale', () => {
    for (const map of NESTED_MAPS) {
      const reference = Object.keys(EXTRACTION_MESSAGES[DEFAULT_LOCALE][map]).sort();
      for (const locale of LOCALES) {
        expect(Object.keys(EXTRACTION_MESSAGES[locale][map]).sort(), `${locale}.${map}`).toEqual(
          reference,
        );
      }
    }
  });

  it('writes Arabic in Arabic', () => {
    for (const [key, value] of Object.entries(EXTRACTION_MESSAGES.ar)) {
      if (typeof value !== 'string') continue;
      expect(ARABIC_SCRIPT.test(value), `ar.${key}`).toBe(true);
    }
  });

  it('covers exactly the five proposal kinds, and no others', () => {
    // The vocabulary is closed. A sixth label would mean the UI had invented a
    // category the extraction cannot produce.
    expect(Object.keys(EXTRACTION_MESSAGES.en.proposalKinds).sort()).toEqual([
      'AMBIGUOUS_REQUIREMENT',
      'CONFLICTING_REQUIREMENT',
      'EXPLICIT_REQUIREMENT',
      'TEMPLATE_INFERENCE',
      'UNREPRESENTABLE_REQUIREMENT',
    ]);
  });

  it('never describes a template observation as a requirement', () => {
    // The single most important wording rule in the phase (§4, §46, §130). A
    // template shows what one document does; only the institution can say what
    // is required, and the label must not blur that.
    for (const locale of LOCALES) {
      const messages = EXTRACTION_MESSAGES[locale];
      const observed = [
        messages.proposalKinds.TEMPLATE_INFERENCE,
        messages.proposalKindHints.TEMPLATE_INFERENCE,
        messages.observationTitle,
        messages.observationObservedIn,
        messages.observationNotARequirement,
        messages.sourceKindHints.TEMPLATE_DOCX,
        messages.summaryLabels.templateInferenceProposals,
      ].filter((label): label is string => label !== undefined);
      for (const [index, label] of observed.entries()) {
        expect(
          /\brequired by\b|\bmandatory\b|\brequirement of the institution\b|تشترط المؤسسة|إلزامي/i.test(
            label,
          ),
          `${locale}[${index}]`,
        ).toBe(false);
      }

      // And it says positively what it *is*.
      expect(messages.proposalKinds.TEMPLATE_INFERENCE ?? '').toMatch(
        locale === 'ar' ? /ملاحَظ|القالب/ : /observed|template/i,
      );
      expect(messages.observationNotARequirement).toMatch(
        locale === 'ar' ? /ليس بياناً لما تشترطه/ : /not a statement of what/i,
      );
    }
  });

  it('never offers a confidence number, a score or a percentage', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(EXTRACTION_MESSAGES[locale])) {
        expect(CONFIDENCE_CLAIM.test(value), `${locale}.${key}`).toBe(false);
      }
    }
  });

  it('never claims the extraction found everything', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(EXTRACTION_MESSAGES[locale])) {
        expect(COMPLETENESS_CLAIM.test(value), `${locale}.${key}`).toBe(false);
      }
    }
    // And says the opposite where a reader would otherwise assume it.
    expect(EXTRACTION_MESSAGES.en.notExhaustive).toMatch(/read your guidelines yourself/i);
  });

  it('never suggests PalCert decides, accepts or publishes anything by itself', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(EXTRACTION_MESSAGES[locale])) {
        expect(AUTHORITY_CLAIM.test(value), `${locale}.${key}`).toBe(false);
      }
    }
    // The promise, stated to the reader in as many words (§145).
    expect(EXTRACTION_MESSAGES.en.sectionSubtitle).toMatch(
      /Nothing is added to the standard until someone here accepts it/i,
    );
    expect(EXTRACTION_MESSAGES.en.proposalsSubtitle).toMatch(
      /Nothing becomes part of the standard until you accept it/i,
    );
  });

  it('says PalCert has not chosen between disagreeing sources', () => {
    // §62, §63: the product's position is that this is not its decision, and
    // the wording has to say so rather than implying a preference.
    expect(EXTRACTION_MESSAGES.en.conflictExplanation).toMatch(
      /deliberately not chosen between them/i,
    );
    expect(EXTRACTION_MESSAGES.en.conflictExplanation).toMatch(
      /not something that can be inferred from upload order or file type/i,
    );
    expect(EXTRACTION_MESSAGES.ar.conflictExplanation).toMatch(/لم يختر بال‌سيرت بينهما/);
  });

  it('tells a reader that an explanation is PalCert’s wording, not the source’s', () => {
    // §127: an Arabic summary of an English guideline must not read as though
    // the institution wrote it in Arabic.
    expect(EXTRACTION_MESSAGES.en.interpretationIsTranslation).toMatch(
      /PalCert’s wording, not the source document’s/i,
    );
    expect(EXTRACTION_MESSAGES.ar.interpretationIsTranslation).toMatch(/صياغة بال‌سيرت/);
  });

  it('states plainly that rejection feedback is never sent to the provider', () => {
    // §70: no feedback loop, no fine-tuning, and the reviewer is told so
    // before they write anything into the box.
    expect(EXTRACTION_MESSAGES.en.reviewNotesHint).toMatch(/not sent to the AI provider/i);
    expect(EXTRACTION_MESSAGES.en.reviewNotesHint).toMatch(/no model is trained on it/i);
    expect(EXTRACTION_MESSAGES.ar.reviewNotesHint).toMatch(/لا يُدرَّب عليها نموذج/);
  });

  it('offers the manual path when the institution has not agreed', () => {
    // §17: no consent blocks extraction and nothing else. A reviewer must not
    // be left thinking the whole feature is unavailable to them.
    expect(EXTRACTION_MESSAGES.en.manualAlternative).toMatch(
      /upload sources and write rules by hand/i,
    );
  });

  it('separates the institution’s agreement from an individual’s', () => {
    // §15: reusing the personal Phase 8 consent for organization documents
    // would be a category error, and the wording is where a reader notices.
    expect(EXTRACTION_MESSAGES.en.consentOrganizationScope).toMatch(
      /separate from the agreement an individual gives/i,
    );
  });

  it('uses no internal machine vocabulary anywhere', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(EXTRACTION_MESSAGES[locale])) {
        expect(INTERNAL_TERMS.test(value), `${locale}.${key}`).toBe(false);
      }
    }
  });

  it('promises nothing about provider retention it cannot keep', () => {
    // §91 of Phase 8, unchanged here: PalCert may say where processing happens;
    // it may not invent a contractual guarantee on a provider's behalf.
    for (const locale of LOCALES) {
      expect(
        /zero data retention|never stored|not stored|never retained|لا يُحتفظ|يُحذف فوراً/i.test(
          EXTRACTION_MESSAGES[locale].consentRetentionNote,
        ),
        locale,
      ).toBe(false);
    }
  });

  it('falls back to English for an unknown locale', () => {
    expect(getExtractionMessages('fr' as never)).toBe(EXTRACTION_MESSAGES.en);
  });
});

/** Every reader-facing string, including the nested maps, as key/value pairs. */
function flatten(messages: ExtractionMessages): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === 'string') {
      pairs.push([key, value]);
      continue;
    }
    for (const [nested, text] of Object.entries(value as Record<string, string>)) {
      pairs.push([`${key}.${nested}`, text]);
    }
  }
  return pairs;
}
