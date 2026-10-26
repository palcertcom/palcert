import { describe, expect, it } from 'vitest';
import { ADMIN_MESSAGES } from './admin-messages';

const ARABIC_SCRIPT = /[؀-ۿ]/;
/** Product names and codes that are the same in both languages. */
const NOT_PROSE = new Set(['products.SMARTFIX', 'products.EXPERTFIX']);

function flatten(value: object, prefix = ''): [string, string][] {
  return Object.entries(value).flatMap(([key, inner]) =>
    typeof inner === 'string'
      ? [[`${prefix}${key}`, inner] as [string, string]]
      : flatten(inner as object, `${prefix}${key}.`),
  );
}

describe('Admin message catalogue', () => {
  it('defines every label in both languages', () => {
    const keys = (locale: 'en' | 'ar') =>
      flatten(ADMIN_MESSAGES[locale])
        .map(([key]) => key)
        .sort();
    expect(keys('ar')).toEqual(keys('en'));
  });

  it('writes Arabic in Arabic', () => {
    for (const [key, value] of flatten(ADMIN_MESSAGES.ar)) {
      if (NOT_PROSE.has(key)) continue;
      expect([key, ARABIC_SCRIPT.test(value)]).toEqual([key, true]);
    }
  });

  it('leaves no English sentence behind in the Arabic catalogue', () => {
    for (const [key, value] of flatten(ADMIN_MESSAGES.ar)) {
      if (NOT_PROSE.has(key)) continue;
      expect([key, /\b(the|and|this|with|your)\b/i.test(value)]).toEqual([key, false]);
    }
  });
});
