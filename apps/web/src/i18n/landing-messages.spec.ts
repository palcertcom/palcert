import { describe, expect, it } from 'vitest';
import { LANDING_MESSAGES } from './landing-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;

/** Every string in a catalogue, with its path, functions called with a sample. */
function strings(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'function') return [[path, String((value as (n: number) => string)(2))]];
  if (Array.isArray(value))
    return value.flatMap((item, index) => strings(item, `${path}[${index}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      strings(item, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

/** Keys and list lengths, so both languages say the same number of things. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, key === 'actor' ? item : shape(item)]),
    );
  }
  return typeof value;
}

/**
 * Claims the homepage must never make: invented customers, figures, rankings
 * or guarantees. PalCert markets what it does, not what it would like to be.
 */
const UNSUPPORTED_CLAIMS =
  /\btrusted by\b|\bthousands\b|\bmillions\b|\b\d+\s?%|\bleading\b|\bbest\b|#1|\bguarantee|\bworld-class\b|\brevolution|\bblockchain\b|\bcrypto(?!graphic)/i;

describe('landing message catalogue', () => {
  it('has the same shape in every locale', () => {
    const reference = shape(LANDING_MESSAGES[DEFAULT_LOCALE]);
    for (const locale of LOCALES) expect(shape(LANDING_MESSAGES[locale])).toEqual(reference);
  });

  it('writes Arabic in Arabic', () => {
    // A certificate number and a date are written the same in both languages.
    for (const [path, value] of strings(LANDING_MESSAGES.ar)) {
      if (path === 'sample.certificateNumber' || path === 'sample.issued') continue;
      if (path.endsWith('.actor')) continue; // an identifier, not a word
      expect([path, ARABIC_SCRIPT.test(value)]).toEqual([path, true]);
    }
  });

  it('names the six stages of the workflow in order', () => {
    expect(LANDING_MESSAGES.en.workflow.steps.map((step) => step.title)).toEqual([
      'Define',
      'Check',
      'Fix',
      'Verify',
      'Approve',
      'Certify',
    ]);
  });

  it('makes no unsupported marketing claims', () => {
    for (const locale of LOCALES) {
      for (const [path, value] of strings(LANDING_MESSAGES[locale])) {
        expect([locale, path, UNSUPPORTED_CLAIMS.test(value)]).toEqual([locale, path, false]);
      }
    }
  });

  it('never says PalCert approves a document', () => {
    // Approval is the institution's; PalCert checks and certifies compliance.
    for (const [path, value] of strings(LANDING_MESSAGES.en)) {
      expect([path, /\bPalCert (approves|accepts)\b/i.test(value)]).toEqual([path, false]);
    }
  });
});
