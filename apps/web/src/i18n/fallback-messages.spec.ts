import { describe, expect, it } from 'vitest';
import { FALLBACK_MESSAGES, getFallbackMessages, localeFromPathname } from './fallback-messages';
import { LOCALES } from './locales';

describe('fallback messages', () => {
  it('has every key in every locale', () => {
    const keys = Object.keys(FALLBACK_MESSAGES.en).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(FALLBACK_MESSAGES[locale]).sort()).toEqual(keys);
    }
  });

  it('translates every string rather than falling back to English', () => {
    for (const key of Object.keys(FALLBACK_MESSAGES.en) as Array<
      keyof typeof FALLBACK_MESSAGES.en
    >) {
      expect(FALLBACK_MESSAGES.ar[key]).not.toBe(FALLBACK_MESSAGES.en[key]);
      expect(FALLBACK_MESSAGES.ar[key].trim().length).toBeGreaterThan(0);
    }
  });

  it('shows no machine contract to the reader', () => {
    for (const locale of LOCALES) {
      for (const value of Object.values(FALLBACK_MESSAGES[locale])) {
        expect(value).not.toMatch(/[A-Z][A-Z_]{5,}/);
        expect(value).not.toMatch(/\b\d{3}\b/);
      }
    }
  });

  it('reads the locale from the address, because neither boundary gets params', () => {
    expect(localeFromPathname('/ar/documents/abc')).toBe('ar');
    expect(localeFromPathname('/en')).toBe('en');
    expect(localeFromPathname('/ar')).toBe('ar');
  });

  it('falls back to the default rather than throwing on anything else', () => {
    for (const path of ['', '/', null, undefined, '/fr/documents', '//ar', '/EN']) {
      expect(LOCALES).toContain(localeFromPathname(path));
    }
    expect(localeFromPathname('/fr/documents')).toBe('en');
    expect(getFallbackMessages('en')).toBe(FALLBACK_MESSAGES.en);
  });
});
