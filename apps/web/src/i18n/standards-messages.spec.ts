import { describe, expect, it } from 'vitest';
import {
  STANDARDS_MESSAGES,
  getStandardsMessages,
  type StandardsMessages,
} from './standards-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;

const NESTED_MAPS = [
  'versionStatuses',
  'statuses',
  'categories',
  'evaluationModes',
  'severities',
  'autofixCapabilities',
  'origins',
  'operators',
  'units',
  'scopeKinds',
  'systemCategories',
  'errors',
] as const;

/**
 * A handful of labels are legitimately the same in both locales: symbols and
 * initialisms that Arabic technical writing keeps in their original form. They
 * are listed explicitly so the parity test stays strict everywhere else — an
 * untranslated sentence must still fail.
 */
const SHARED_BY_DESIGN: ReadonlySet<string> = new Set(['units.DPI']);

describe('standards message catalogue', () => {
  it('defines every key in every locale', () => {
    const reference = Object.keys(STANDARDS_MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(STANDARDS_MESSAGES[locale]).sort(), locale).toEqual(reference);
    }
  });

  it('defines every nested label in every locale', () => {
    for (const map of NESTED_MAPS) {
      const reference = Object.keys(STANDARDS_MESSAGES[DEFAULT_LOCALE][map]).sort();
      for (const locale of LOCALES) {
        expect(Object.keys(STANDARDS_MESSAGES[locale][map]).sort(), `${locale}.${map}`).toEqual(
          reference,
        );
      }
    }
  });

  it('has no empty strings anywhere', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(STANDARDS_MESSAGES[locale])) {
        if (typeof value === 'string') {
          expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
        } else {
          for (const [nested, nestedValue] of Object.entries(value as Record<string, unknown>)) {
            // A message that takes arguments is judged by what it renders.
            const rendered =
              typeof nestedValue === 'function'
                ? String((nestedValue as (...args: string[]) => string)('1.0', '1.2'))
                : String(nestedValue);
            expect(rendered.trim().length, `${locale}.${key}.${nested}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('genuinely translates Arabic rather than shipping English', () => {
    const { en, ar } = STANDARDS_MESSAGES;

    for (const [key, value] of Object.entries(ar)) {
      if (typeof value !== 'string') continue;
      expect(value, `ar.${key} is untranslated`).not.toBe(en[key as keyof typeof en]);
      expect(value, `ar.${key} contains no Arabic`).toMatch(ARABIC_SCRIPT);
    }
  });

  it('translates every enum label into Arabic', () => {
    const { en, ar } = STANDARDS_MESSAGES;

    for (const map of NESTED_MAPS) {
      const english = en[map] as Record<string, string>;
      const arabic = ar[map] as Record<string, string>;

      for (const key of Object.keys(english)) {
        if (SHARED_BY_DESIGN.has(`${map}.${key}`)) continue;
        expect(arabic[key], `ar.${map}.${key} is untranslated`).not.toBe(english[key]);
      }
    }
  });

  /**
   * Messages that take arguments.
   *
   * The string checks above skip anything that is not a string, so a formatter
   * added to the catalogue would slip past every parity assertion and could
   * ship untranslated. They are rendered with sample arguments and then held to
   * the same standard as every other message.
   */
  const FORMATTERS: ReadonlyArray<{
    readonly key: string;
    readonly render: (messages: StandardsMessages) => string;
  }> = [{ key: 'upgradeRuleSchemaHint', render: (m) => m.upgradeRuleSchemaHint(1, 2) }];

  it('renders every formatter in every locale', () => {
    for (const locale of LOCALES) {
      for (const formatter of FORMATTERS) {
        const rendered = formatter.render(STANDARDS_MESSAGES[locale]);
        expect(rendered.trim().length, `${locale}.${formatter.key}`).toBeGreaterThan(0);
      }
    }
  });

  it('translates every formatter into Arabic', () => {
    for (const formatter of FORMATTERS) {
      const english = formatter.render(STANDARDS_MESSAGES.en);
      const arabic = formatter.render(STANDARDS_MESSAGES.ar);
      expect(arabic, `ar.${formatter.key} is untranslated`).not.toBe(english);
      expect(arabic, `ar.${formatter.key} contains no Arabic`).toMatch(ARABIC_SCRIPT);
    }
  });

  it('lists every formatter the catalogue defines', () => {
    // Otherwise the two tests above quietly stop covering a message the moment
    // someone adds one.
    const defined = Object.entries(STANDARDS_MESSAGES.en)
      .filter(([, value]) => typeof value === 'function')
      .map(([key]) => key)
      .sort();
    expect(defined).toEqual(FORMATTERS.map((formatter) => formatter.key).sort());
  });

  it('covers every rule category the API can return', () => {
    // 23 categories, matching the contract. A category with no label would
    // render as a raw enum value in the UI.
    expect(Object.keys(STANDARDS_MESSAGES.en.categories)).toHaveLength(23);
  });

  it('covers every operator the API can return', () => {
    expect(Object.keys(STANDARDS_MESSAGES.en.operators)).toHaveLength(14);
  });

  it('reads operators as a sentence fragment, not as an enum name', () => {
    // The builder renders "<property> <operator> <value>", so the label has to
    // fit into that sentence.
    expect(STANDARDS_MESSAGES.en.operators.GREATER_THAN_OR_EQUAL).toBe('is at least');
    expect(STANDARDS_MESSAGES.ar.operators.GREATER_THAN_OR_EQUAL).toBe('لا يقل عن');
  });

  it('falls back to English for an unknown locale', () => {
    expect(getStandardsMessages('fr' as never)).toBe(STANDARDS_MESSAGES.en);
  });

  it('says the version lifecycle in both languages, in the same shape', () => {
    const { en, ar } = STANDARDS_MESSAGES;
    expect(Object.keys(ar.lifecycle).sort()).toEqual(Object.keys(en.lifecycle).sort());

    for (const [key, value] of Object.entries(ar.lifecycle)) {
      const arabic =
        typeof value === 'function'
          ? (value as (...args: string[]) => string)('1.0', '1.2')
          : value;
      const english = en.lifecycle[key as keyof typeof en.lifecycle];
      const englishText =
        typeof english === 'function'
          ? (english as (...args: string[]) => string)('1.0', '1.2')
          : english;
      expect(arabic, `ar.lifecycle.${key} contains no Arabic`).toMatch(ARABIC_SCRIPT);
      expect(arabic, `ar.lifecycle.${key} is untranslated`).not.toBe(englishText);
      // Both version labels reach the sentence when the message takes them.
      if (typeof value === 'function' && value.length >= 2) {
        expect(arabic).toContain('1.0');
        expect(arabic).toContain('1.2');
      }
    }
  });
});
