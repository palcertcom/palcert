import { describe, expect, it } from 'vitest';
import {
  STANDARD_VERSION_STATUSES,
  StandardVersionStatus,
  canTransitionStandardVersionStatus,
  standardVersionIsEditable,
  standardVersionIsUsable,
  standardVersionWasPublished,
} from './standard.js';

describe('standard version lifecycle', () => {
  const { DRAFT, PUBLISHED, SUPERSEDED, ARCHIVED } = StandardVersionStatus;

  it('has four states, SUPERSEDED distinct from ARCHIVED', () => {
    expect([...STANDARD_VERSION_STATUSES].sort()).toEqual(
      ['ARCHIVED', 'DRAFT', 'PUBLISHED', 'SUPERSEDED'].sort(),
    );
  });

  it('allows exactly the documented transitions', () => {
    const allowed = STANDARD_VERSION_STATUSES.flatMap((from) =>
      STANDARD_VERSION_STATUSES.filter((to) => canTransitionStandardVersionStatus(from, to)).map(
        (to) => `${from}->${to}`,
      ),
    ).sort();

    expect(allowed).toEqual(
      [
        'DRAFT->PUBLISHED',
        'DRAFT->ARCHIVED',
        'PUBLISHED->SUPERSEDED',
        'PUBLISHED->ARCHIVED',
      ].sort(),
    );
  });

  it('never republishes or revives history', () => {
    expect(canTransitionStandardVersionStatus(SUPERSEDED, PUBLISHED)).toBe(false);
    expect(canTransitionStandardVersionStatus(SUPERSEDED, ARCHIVED)).toBe(false);
    expect(canTransitionStandardVersionStatus(SUPERSEDED, DRAFT)).toBe(false);
    expect(canTransitionStandardVersionStatus(ARCHIVED, SUPERSEDED)).toBe(false);
    expect(canTransitionStandardVersionStatus(DRAFT, SUPERSEDED)).toBe(false);
  });

  it('edits only drafts and offers only the version in force to new checks', () => {
    expect(STANDARD_VERSION_STATUSES.filter(standardVersionIsEditable)).toEqual([DRAFT]);
    expect(STANDARD_VERSION_STATUSES.filter(standardVersionIsUsable)).toEqual([PUBLISHED]);
  });

  it('treats a superseded version as published history', () => {
    const at = '2026-09-01T00:00:00.000Z';
    expect(standardVersionWasPublished(SUPERSEDED, at)).toBe(true);
    expect(standardVersionWasPublished(PUBLISHED, at)).toBe(true);
    expect(standardVersionWasPublished(ARCHIVED, at)).toBe(true);
    expect(standardVersionWasPublished(ARCHIVED, null)).toBe(false);
    expect(standardVersionWasPublished(DRAFT, null)).toBe(false);
  });
});
