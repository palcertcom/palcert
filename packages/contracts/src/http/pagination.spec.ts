import { describe, expect, it } from 'vitest';
import {
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  buildPage,
  decodeCursor,
  encodeCursor,
  resolveLimit,
} from './pagination.js';

describe('cursor encoding', () => {
  it('round-trips a sort value and id', () => {
    const cursor = encodeCursor('2026-01-01T00:00:00.000Z', 'abc-123');
    expect(decodeCursor(cursor)).toEqual({
      sortValue: '2026-01-01T00:00:00.000Z',
      id: 'abc-123',
    });
  });

  it('accepts a Date and normalizes it to ISO', () => {
    const cursor = encodeCursor(new Date('2026-06-01T12:00:00.000Z'), 'id-1');
    expect(decodeCursor(cursor)?.sortValue).toBe('2026-06-01T12:00:00.000Z');
  });

  it('is opaque — the raw values are not readable in the token', () => {
    const cursor = encodeCursor('2026-01-01T00:00:00.000Z', 'abc-123');
    expect(cursor).not.toContain('abc-123');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('splits on the last separator so a sort value may contain one', () => {
    const cursor = encodeCursor('name|with|pipes', 'id-9');
    expect(decodeCursor(cursor)).toEqual({ sortValue: 'name|with|pipes', id: 'id-9' });
  });

  it('returns null for anything that is not one of our cursors', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('not-base64!!')).toBeNull();
    expect(decodeCursor(Buffer.from('no-separator').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('|id-only').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('sort-only|').toString('base64url'))).toBeNull();
  });
});

describe('resolveLimit', () => {
  it('defaults when unspecified', () => {
    expect(resolveLimit(undefined)).toBe(PAGINATION_DEFAULT_LIMIT);
    expect(resolveLimit(Number.NaN)).toBe(PAGINATION_DEFAULT_LIMIT);
  });

  it('clamps rather than rejecting an out-of-range limit', () => {
    expect(resolveLimit(1000)).toBe(PAGINATION_MAX_LIMIT);
    expect(resolveLimit(0)).toBe(1);
    expect(resolveLimit(-5)).toBe(1);
  });

  it('honours a valid limit', () => {
    expect(resolveLimit(10)).toBe(10);
  });
});

describe('buildPage', () => {
  const toCursor = (row: { id: string }) => encodeCursor('2026-01-01T00:00:00.000Z', row.id);

  it('reports the last page with a null cursor', () => {
    const page = buildPage([{ id: 'a' }, { id: 'b' }], 5, toCursor);

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('trims the probe row and returns a cursor when more remain', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const page = buildPage(rows, 2, toCursor);

    expect(page.items.map((row) => row.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).not.toBeNull();
    // The cursor points at the last returned row, not the probe.
    expect(decodeCursor(page.nextCursor!)?.id).toBe('b');
  });

  it('treats an exactly-full page as the last one', () => {
    const page = buildPage([{ id: 'a' }, { id: 'b' }], 2, toCursor);
    expect(page.nextCursor).toBeNull();
  });

  it('returns an empty page rather than failing on an empty collection', () => {
    expect(buildPage([], 25, toCursor)).toEqual({ items: [], nextCursor: null });
  });
});
