/**
 * PalCert collection pagination convention (formalizes Phase 1 debt).
 *
 * **Cursor pagination** is the default for every collection. Offset pagination
 * skips or repeats rows when the underlying set changes between pages, which
 * for an append-heavy collection (audit records, findings, ledger entries) is a
 * correctness problem rather than a cosmetic one.
 *
 * Rules:
 *
 *  - **Sort is always stable.** Every paginated query orders by a non-unique
 *    business column *and* the primary key as a tie-break, so two rows sharing
 *    a timestamp can never be skipped or duplicated.
 *  - **The cursor is opaque.** It is base64url of `<sortValue>|<id>`. Clients
 *    must treat it as a token, not parse it. A malformed cursor is a
 *    `VALIDATION_FAILED`, never a silent reset to page one — silently resetting
 *    hides bugs and can loop a client forever.
 *  - **`limit`** defaults to 25 and is capped at 100. A larger request is
 *    clamped rather than rejected.
 *  - **`nextCursor` is null when the page is the last one.** Clients stop on
 *    null, never on an empty `items` array, because a filtered page can be
 *    legitimately empty while more pages remain.
 *  - **An empty collection** returns `{ items: [], nextCursor: null }` with 200,
 *    never 404.
 */
export const PAGINATION_DEFAULT_LIMIT = 25;
export const PAGINATION_MAX_LIMIT = 100;

export interface PageRequest {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque token for the next page, or null when this is the last page. */
  readonly nextCursor: string | null;
}

export interface DecodedCursor {
  readonly sortValue: string;
  readonly id: string;
}

const CURSOR_SEPARATOR = '|';

export function encodeCursor(sortValue: string | Date, id: string): string {
  const value = sortValue instanceof Date ? sortValue.toISOString() : sortValue;
  return Buffer.from(`${value}${CURSOR_SEPARATOR}${id}`, 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor. Returns null when the value is not a cursor this
 * service produced; callers surface that as a validation error rather than
 * quietly starting from the beginning.
 */
export function decodeCursor(cursor: string): DecodedCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const separator = decoded.lastIndexOf(CURSOR_SEPARATOR);
  if (separator <= 0 || separator === decoded.length - 1) return null;

  const sortValue = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (sortValue.length === 0 || id.length === 0) return null;

  return { sortValue, id };
}

/** Clamp a requested limit into the permitted range. */
export function resolveLimit(requested: number | undefined): number {
  if (requested === undefined || Number.isNaN(requested)) return PAGINATION_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(requested), 1), PAGINATION_MAX_LIMIT);
}

/**
 * Build a page from `limit + 1` rows.
 *
 * Fetching one extra row is how "is there a next page?" is answered without a
 * second count query, which would be both slower and racy.
 */
export function buildPage<T>(
  rows: readonly T[],
  limit: number,
  toCursor: (row: T) => string,
): Page<T> {
  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }
  const items = rows.slice(0, limit);
  return { items, nextCursor: toCursor(items[items.length - 1]!) };
}
