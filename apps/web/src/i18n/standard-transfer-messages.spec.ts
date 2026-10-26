import { describe, expect, it } from 'vitest';
import { STANDARD_TRANSFER_MESSAGES } from './standard-transfer-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;

/** Every leaf, with functions rendered using sample arguments. */
function leaves(value: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof value === 'string') out.push([path, value]);
  else if (typeof value === 'function') {
    out.push([path, String((value as (...args: unknown[]) => string)('1.0', 3, 2, 1))]);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) leaves(child, `${path}.${key}`, out);
  }
  return out;
}

describe('standard transfer message catalogue', () => {
  it('defines every key, nested ones included, in every locale', () => {
    const reference = leaves(STANDARD_TRANSFER_MESSAGES[DEFAULT_LOCALE], '')
      .map(([path]) => path)
      .sort();
    for (const locale of LOCALES) {
      expect(
        leaves(STANDARD_TRANSFER_MESSAGES[locale], '')
          .map(([path]) => path)
          .sort(),
        locale,
      ).toEqual(reference);
    }
  });

  it('has no empty text and translates every line into Arabic', () => {
    const en = new Map(leaves(STANDARD_TRANSFER_MESSAGES.en, ''));
    for (const [path, text] of leaves(STANDARD_TRANSFER_MESSAGES.ar, '')) {
      expect(text.trim().length, `ar${path}`).toBeGreaterThan(0);
      expect(text, `ar${path} contains no Arabic`).toMatch(ARABIC_SCRIPT);
      expect(text, `ar${path} is untranslated`).not.toBe(en.get(path));
    }
  });

  it('never promises that importing publishes or adopts anything', () => {
    for (const [path, text] of leaves(STANDARD_TRANSFER_MESSAGES.en, '')) {
      expect(text, path).not.toMatch(
        /automatically (publish|adopt|approve)|is now (in force|published)/i,
      );
    }
    expect(STANDARD_TRANSFER_MESSAGES.en.draftOnly).toMatch(/draft only/);
  });

  it('uses the exact integrity and unsupported-format wording', () => {
    expect(STANDARD_TRANSFER_MESSAGES.en.errors.STANDARD_IMPORT_INTEGRITY_FAILED).toBe(
      "The file's integrity check failed. The contents may have been changed after export.",
    );
    expect(STANDARD_TRANSFER_MESSAGES.en.errors.STANDARD_IMPORT_UNSUPPORTED).toBe(
      'This standard was created by a newer PalCert format that this installation does not support.',
    );
  });
});
