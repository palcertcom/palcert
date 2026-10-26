import { AppError } from '@palcert/contracts';
import { assertRevisionMatches, parseIfMatch, revisionToETag } from './concurrency';

describe('revisionToETag', () => {
  it('renders a revision as a strong entity tag', () => {
    expect(revisionToETag(3)).toBe('"3"');
  });
});

describe('parseIfMatch', () => {
  it('accepts a strong entity tag', () => {
    expect(parseIfMatch('"7"')).toBe(7);
  });

  it('accepts the weak form some proxies rewrite to', () => {
    expect(parseIfMatch('W/"7"')).toBe(7);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseIfMatch('  "7"  ')).toBe(7);
  });

  it.each([undefined, '', '   '])('refuses a missing precondition (%p)', (header) => {
    // Not treated as "no opinion": that would make the protection opt-in and
    // silently hand last-write-wins to every client that forgot the header.
    expect(() => parseIfMatch(header)).toThrow(AppError);
  });

  it('refuses the wildcard, which is not a precondition at all', () => {
    expect(() => parseIfMatch('*')).toThrow(AppError);
  });

  it.each(['7', 'abc', '"7', '7"', '"-1"', '"1.5"', '""'])('refuses %p', (header) => {
    expect(() => parseIfMatch(header)).toThrow(AppError);
  });

  it('refuses an absurdly long value rather than parsing it', () => {
    expect(() => parseIfMatch(`"${'9'.repeat(40)}"`)).toThrow(AppError);
  });

  it('reports a missing header as a validation failure, naming the header', () => {
    try {
      parseIfMatch(undefined);
      throw new Error('expected parseIfMatch to throw');
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_FAILED');
      expect((error as AppError).details).toEqual({ header: 'If-Match' });
    }
  });
});

describe('assertRevisionMatches', () => {
  it('passes when the caller holds the current revision', () => {
    expect(() => assertRevisionMatches(4, 4)).not.toThrow();
  });

  it('refuses a stale revision', () => {
    expect(() => assertRevisionMatches(3, 4)).toThrow(AppError);
  });

  it('refuses a revision from the future, not only a stale one', () => {
    // A client that invents a revision is as wrong as one holding an old value,
    // and letting it through would defeat the check entirely.
    expect(() => assertRevisionMatches(9, 4)).toThrow(AppError);
  });

  it('reports the current revision so the client can re-read and retry', () => {
    try {
      assertRevisionMatches(3, 4);
      throw new Error('expected assertRevisionMatches to throw');
    } catch (error) {
      expect((error as AppError).code).toBe('STANDARD_VERSION_CONFLICT');
      expect((error as AppError).details).toEqual({ expectedRevision: 3, currentRevision: 4 });
    }
  });
});
