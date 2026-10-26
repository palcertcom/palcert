import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  directionFor,
  isLocale,
  negotiateLocale,
  resolveLocale,
} from './locales';
import { MESSAGES, getMessages } from './messages';

describe('locales', () => {
  it('supports Arabic and English from the start', () => {
    expect(LOCALES).toContain('en');
    expect(LOCALES).toContain('ar');
  });

  it('maps each locale to the correct text direction', () => {
    expect(directionFor('en')).toBe('ltr');
    expect(directionFor('ar')).toBe('rtl');
  });

  it('recognises supported locales only', () => {
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it('falls back to the default locale for unknown values', () => {
    expect(resolveLocale('de')).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale('ar')).toBe('ar');
  });
});

describe('negotiateLocale', () => {
  it('returns the default when no header is present', () => {
    expect(negotiateLocale(null)).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale('')).toBe(DEFAULT_LOCALE);
  });

  it('matches a regional tag to its base locale', () => {
    expect(negotiateLocale('ar-PS,ar;q=0.9')).toBe('ar');
    expect(negotiateLocale('en-GB')).toBe('en');
  });

  it('respects quality weighting', () => {
    expect(negotiateLocale('fr;q=1.0,ar;q=0.8,en;q=0.5')).toBe('ar');
  });

  it('ignores unsupported languages', () => {
    expect(negotiateLocale('fr-FR,de;q=0.8')).toBe(DEFAULT_LOCALE);
  });

  it('ignores a zero-quality entry', () => {
    expect(negotiateLocale('ar;q=0,en;q=0.5')).toBe('en');
  });
});

describe('messages', () => {
  it('defines every message key in every locale', () => {
    const referenceKeys = Object.keys(MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(MESSAGES[locale]).sort(), `locale ${locale}`).toEqual(referenceKeys);
    }
  });

  it('has no empty translations', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('actually translates Arabic rather than duplicating English', () => {
    expect(MESSAGES.ar.tagline).not.toBe(MESSAGES.en.tagline);
    expect(MESSAGES.ar.tagline).toMatch(/[؀-ۿ]/);
  });

  it('returns the requested catalogue', () => {
    expect(getMessages('ar')).toBe(MESSAGES.ar);
  });
});
