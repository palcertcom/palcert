import { describe, expect, it } from 'vitest';
import {
  CHECKS_MESSAGES,
  getChecksMessages,
  stageForCheckStatus,
  type ChecksMessages,
} from './checks-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;
const NESTED_MAPS = [
  'determinations',
  'determinationHints',
  'outcomes',
  'severities',
  'errors',
  'counts',
] as const;
/** Terms from inside the machine that must never reach a reader (§78). */
const INTERNAL_TERMS =
  /bullmq|redis|s3\b|bucket|minio|prisma|postgres|worker|queue|canonicaliz|sha256|jcs/i;
/** Claims PalCert is not in a position to make (§56, §75). */
const OVERCLAIMS =
  /\bapproved\b|\baccepted\b|\bcertified\b|\bcertificate\b|معتمد|مقبول|شهادة|اعتماد/i;

describe('checks message catalogue', () => {
  it('defines every key in every locale', () => {
    const reference = Object.keys(CHECKS_MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(CHECKS_MESSAGES[locale]).sort(), locale).toEqual(reference);
    }
  });

  it('defines every nested label in every locale', () => {
    for (const map of NESTED_MAPS) {
      const reference = Object.keys(CHECKS_MESSAGES[DEFAULT_LOCALE][map]).sort();
      for (const locale of LOCALES) {
        expect(Object.keys(CHECKS_MESSAGES[locale][map]).sort(), `${locale}.${map}`).toEqual(
          reference,
        );
      }
    }
  });

  it('covers every compliance determination', () => {
    expect(Object.keys(CHECKS_MESSAGES.en.determinations).sort()).toEqual([
      'COMPLIANT',
      'INDETERMINATE',
      'NON_COMPLIANT',
      'REVIEW_REQUIRED',
    ]);
  });

  it('covers every rule outcome', () => {
    expect(Object.keys(CHECKS_MESSAGES.en.outcomes).sort()).toEqual([
      'ERROR',
      'FAIL',
      'INDETERMINATE',
      'NOT_APPLICABLE',
      'PASS',
    ]);
  });

  it('writes the Arabic catalogue in Arabic', () => {
    for (const [key, value] of Object.entries(CHECKS_MESSAGES.ar)) {
      if (typeof value !== 'string') continue;
      // Product name and file extensions legitimately stay Latin.
      const stripped = value.replace(/PalCert|\.docx|APA|%/g, '').trim();
      if (stripped.length === 0) continue;
      expect(ARABIC_SCRIPT.test(stripped), `ar.${key}`).toBe(true);
    }
  });

  it('never leaks an internal term into either locale', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(CHECKS_MESSAGES[locale])) {
        if (typeof value === 'string') {
          expect(INTERNAL_TERMS.test(value), `${locale}.${key}`).toBe(false);
        }
      }
    }
  });

  it('never claims a document was approved, accepted or certified', () => {
    // The single most important wording rule in the phase. PalCert checks
    // formatting against a published standard and says nothing more (§56).
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(CHECKS_MESSAGES[locale])) {
        for (const text of flatten(value)) {
          // Two keys are explicit disclaimers — they exist to say what
          // PalCert does *not* do — so they are the one place these words
          // legitimately appear.
          if (key === 'notApproval' || key === 'scoreScopeNote') continue;
          expect(OVERCLAIMS.test(text), `${locale}.${key}: ${text}`).toBe(false);
        }
      }
    }
  });

  it('phrases "could not decide" as a limit of the check, not a failure', () => {
    // Both locales say, in as many words, that this is not the document's
    // fault — the distinction the determination exists to preserve (§10).
    expect(CHECKS_MESSAGES.en.determinationHints.INDETERMINATE).toMatch(/not a failure/i);
    expect(CHECKS_MESSAGES.ar.determinationHints.INDETERMINATE).toMatch(/ليس قصوراً/);
    for (const locale of LOCALES) {
      const label = CHECKS_MESSAGES[locale].determinations.INDETERMINATE!;
      expect(/fail|رسوب|إخفاق/i.test(label), locale).toBe(false);
    }
  });

  it('explains that no score is different from a score of zero', () => {
    expect(CHECKS_MESSAGES.en.scoreUnavailableHint).toMatch(/different from scoring zero/i);
    expect(CHECKS_MESSAGES.ar.scoreUnavailableHint).toMatch(/صفر/);
  });

  it('bounds the score’s meaning in both locales', () => {
    for (const locale of LOCALES) {
      expect(CHECKS_MESSAGES[locale].scoreScopeNote.length).toBeGreaterThan(20);
    }
  });

  it('falls back to the default locale for an unknown one', () => {
    expect(getChecksMessages('fr' as never)).toBe(CHECKS_MESSAGES[DEFAULT_LOCALE]);
  });
});

describe('stageForCheckStatus', () => {
  it('maps each canonical status onto a stage a person understands', () => {
    expect(stageForCheckStatus('CREATED')).toBe('QUEUED');
    expect(stageForCheckStatus('WAITING_ANALYSIS')).toBe('ANALYZING');
    expect(stageForCheckStatus('EVALUATING')).toBe('EVALUATING');
    expect(stageForCheckStatus('GENERATING_REPORT')).toBe('REPORT');
    expect(stageForCheckStatus('COMPLETED')).toBe('DONE');
  });

  it('treats anything terminal-but-unfinished as a failure to show', () => {
    expect(stageForCheckStatus('FAILED')).toBe('FAILED');
    expect(stageForCheckStatus('CANCELLED')).toBe('FAILED');
    expect(stageForCheckStatus('SOMETHING_NEW')).toBe('FAILED');
  });
});

/** Every string inside a message value, nested maps included. */
function flatten(value: ChecksMessages[keyof ChecksMessages]): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).filter((item): item is string => typeof item === 'string');
  }
  return [];
}
