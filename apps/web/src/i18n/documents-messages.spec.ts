import { describe, expect, it } from 'vitest';
import {
  DOCUMENTS_MESSAGES,
  getDocumentsMessages,
  stageForStatus,
  type DocumentsMessages,
} from './documents-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;
const NESTED_MAPS = ['statuses', 'rejections', 'errors'] as const;
const INTERNAL_TERMS = /clamav|clam|bullmq|redis|s3\b|bucket|minio|quarantine bucket|queue/i;

describe('documents message catalogue', () => {
  it('defines every key in every locale', () => {
    const reference = Object.keys(DOCUMENTS_MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(DOCUMENTS_MESSAGES[locale]).sort(), locale).toEqual(reference);
    }
  });

  it('defines every nested label in every locale', () => {
    for (const map of NESTED_MAPS) {
      const reference = Object.keys(DOCUMENTS_MESSAGES[DEFAULT_LOCALE][map]).sort();
      for (const locale of LOCALES) {
        expect(Object.keys(DOCUMENTS_MESSAGES[locale][map]).sort(), `${locale}.${map}`).toEqual(
          reference,
        );
      }
    }
  });

  it('covers every canonical version status and rejection code', () => {
    expect(Object.keys(DOCUMENTS_MESSAGES.en.statuses).sort()).toEqual([
      'AWAITING_UPLOAD',
      'CANCELLED',
      'FAILED',
      'READY',
      'REJECTED',
      'SCANNING',
      'UPLOADED',
      'UPLOAD_EXPIRED',
      'VALIDATING',
    ]);
    expect(Object.keys(DOCUMENTS_MESSAGES.en.rejections)).toHaveLength(12);
  });

  it('genuinely translates Arabic rather than shipping English', () => {
    const { en, ar } = DOCUMENTS_MESSAGES;
    for (const [key, value] of Object.entries(ar)) {
      if (typeof value === 'string') {
        expect(value, `ar.${key}`).not.toBe(en[key as keyof DocumentsMessages]);
        expect(value, `ar.${key} contains no Arabic`).toMatch(ARABIC_SCRIPT);
      } else if (typeof value === 'object') {
        for (const [nested, label] of Object.entries(value as Record<string, string>)) {
          expect(label, `ar.${key}.${nested}`).toMatch(ARABIC_SCRIPT);
        }
      }
    }
  });

  it('translates every formatter into Arabic', () => {
    const formatters: Array<[string, (m: DocumentsMessages) => string]> = [
      ['uploadProgress', (m) => m.uploadProgress(42)],
      ['version', (m) => m.version(3)],
    ];
    const defined = Object.entries(DOCUMENTS_MESSAGES.en)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort();
    expect(defined).toEqual(formatters.map(([k]) => k).sort());
    for (const [key, render] of formatters) {
      expect(render(DOCUMENTS_MESSAGES.ar), key).toMatch(ARABIC_SCRIPT);
      expect(render(DOCUMENTS_MESSAGES.ar), key).not.toBe(render(DOCUMENTS_MESSAGES.en));
    }
  });

  it('never shows an internal implementation term to a user (§78)', () => {
    // Values only: keys are code, not copy.
    const values = (value: unknown): string[] => {
      if (typeof value === 'string') return [value];
      if (typeof value === 'function') return [(value as (n: number) => string)(1)];
      if (value && typeof value === 'object') return Object.values(value).flatMap(values);
      return [];
    };
    for (const locale of LOCALES) {
      for (const text of values(DOCUMENTS_MESSAGES[locale]))
        expect(text, locale).not.toMatch(INTERNAL_TERMS);
    }
  });

  it('describes malware without naming a signature or a scanner (§79)', () => {
    for (const locale of LOCALES) {
      const message = DOCUMENTS_MESSAGES[locale].rejections['FILE_MALWARE_DETECTED']!;
      expect(message).not.toMatch(/eicar|virus|trojan|signature|malware/i);
    }
  });

  it('never blames the document for an infrastructure failure (§80)', () => {
    expect(DOCUMENTS_MESSAGES.en.failedExplanation).not.toMatch(/invalid|your document is/i);
    expect(DOCUMENTS_MESSAGES.en.failedNotInvalid).toMatch(/not a problem with your document/i);
  });

  it('maps every status onto one of the user-facing stages', () => {
    expect(stageForStatus('AWAITING_UPLOAD')).toBe('UPLOADING');
    expect(stageForStatus('SCANNING')).toBe('SECURITY_CHECK');
    expect(stageForStatus('VALIDATING')).toBe('PROCESSING');
    expect(stageForStatus('READY')).toBe('READY');
    expect(stageForStatus('REJECTED')).toBe('REJECTED');
    expect(stageForStatus('FAILED')).toBe('FAILED');
  });

  it('falls back to English for an unknown locale', () => {
    expect(getDocumentsMessages('fr' as never)).toBe(DOCUMENTS_MESSAGES.en);
  });
});
