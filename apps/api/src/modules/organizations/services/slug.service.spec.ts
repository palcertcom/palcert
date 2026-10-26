import {
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  isReservedSlug,
  isValidSlug,
  normalizeSlug,
  slugCandidateFromName,
} from './slug.service';

describe('slug normalization', () => {
  it('lowercases and hyphenates', () => {
    expect(normalizeSlug('Islamic University of Gaza')).toBe('islamic-university-of-gaza');
  });

  it('collapses runs of separators into a single hyphen', () => {
    expect(normalizeSlug('A   B___C///D')).toBe('a-b-c-d');
  });

  it('trims leading and trailing separators', () => {
    expect(normalizeSlug('  --Hello World--  ')).toBe('hello-world');
  });

  it('applies NFKC so visually identical names collapse to one handle', () => {
    // U+FF29 FULLWIDTH LATIN CAPITAL LETTER I normalizes to 'I'.
    expect(normalizeSlug('Ｉ University')).toBe('i-university');
  });

  it('strips characters that have no ASCII form', () => {
    expect(normalizeSlug('الجامعة الإسلامية')).toBe('');
    expect(normalizeSlug('Gaza جامعة University')).toBe('gaza-university');
  });

  it('never emits a trailing hyphen after truncation', () => {
    const long = `${'a'.repeat(SLUG_MAX_LENGTH - 1)} tail`;
    const slug = normalizeSlug(long);

    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('slug validity', () => {
  it('accepts a well-formed handle', () => {
    expect(isValidSlug('iug')).toBe(true);
    expect(isValidSlug('islamic-university-of-gaza')).toBe(true);
    expect(isValidSlug('org-2')).toBe(true);
  });

  it('rejects handles that are too short or too long', () => {
    expect(isValidSlug('ab')).toBe(false);
    expect(isValidSlug('a'.repeat(SLUG_MAX_LENGTH + 1))).toBe(false);
    expect(isValidSlug('a'.repeat(SLUG_MIN_LENGTH))).toBe(true);
  });

  it('rejects malformed handles', () => {
    expect(isValidSlug('-leading')).toBe(false);
    expect(isValidSlug('trailing-')).toBe(false);
    expect(isValidSlug('double--hyphen')).toBe(false);
    expect(isValidSlug('Upper')).toBe(false);
    expect(isValidSlug('has space')).toBe(false);
    expect(isValidSlug('under_score')).toBe(false);
  });

  it('rejects reserved handles that would collide with routes or the brand', () => {
    for (const reserved of ['api', 'admin', 'auth', 'organizations', 'palcert', 'en', 'ar']) {
      expect(`${reserved}:${isReservedSlug(reserved)}`).toBe(`${reserved}:true`);
      expect(`${reserved}:${isValidSlug(reserved)}`).toBe(`${reserved}:false`);
    }
    expect(isReservedSlug('iug')).toBe(false);
  });
});

describe('slugCandidateFromName', () => {
  it('derives a handle from a Latin name', () => {
    expect(slugCandidateFromName('Islamic University of Gaza')).toBe('islamic-university-of-gaza');
  });

  it('falls back when a name yields nothing usable', () => {
    // An Arabic-only name normalizes to an empty string under an ASCII handle
    // policy. That must still produce a working organization, not a dead end.
    expect(slugCandidateFromName('الجامعة الإسلامية بغزة')).toBe('org');
    expect(slugCandidateFromName('中文大学')).toBe('org');
    expect(slugCandidateFromName('!!!')).toBe('org');
  });

  it('falls back when a name normalizes to something too short', () => {
    expect(slugCandidateFromName('X')).toBe('org');
  });

  it('falls back when a name normalizes to a reserved handle', () => {
    expect(slugCandidateFromName('Admin')).toBe('org');
    expect(slugCandidateFromName('API')).toBe('org');
  });

  it('always returns something valid', () => {
    for (const name of ['Islamic University', 'الجامعة', 'A', '', '---', 'admin']) {
      expect(`${name}:${isValidSlug(slugCandidateFromName(name))}`).toBe(`${name}:true`);
    }
  });
});
