# ADR-0020: Cursor pagination as the collection convention

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 2 (formalizes a Phase 1 gap)

## Context

Phase 1 shipped a cursor-paginated admin user list before a convention existed —
recorded at the time as technical debt. Phase 2 adds three more collections
(organizations, members, invitations), and later phases add several that grow
without bound: findings, ledger entries, audit records, checks.

## Decision

**Cursor pagination is the default for every collection.**

Offset pagination skips or repeats rows whenever the underlying set changes
between requests. For an append-heavy collection that is not a cosmetic
annoyance — a paginating client silently misses records — and for an audit log
it is a correctness failure.

Rules, all enforced in `@palcert/contracts`:

- **Stable sort.** Every paginated query orders by a business column *and* the
  primary key. Two rows sharing a timestamp can then never be skipped or
  duplicated, which a timestamp alone cannot guarantee.
- **Opaque cursor.** `base64url(<sortValue>|<id>)`. Clients treat it as a token.
  Split on the *last* separator, so a sort value may itself contain one.
- **A malformed cursor is `VALIDATION_FAILED`,** never a silent reset to page
  one. Silently restarting hides client bugs and can loop a paginating client
  forever.
- **`limit`** defaults to 25, caps at 100, and is clamped rather than rejected.
- **`nextCursor` is `null` on the last page.** Clients stop on null, never on an
  empty `items` array — a filtered page can legitimately be empty while more
  pages remain.
- **An empty collection** is `{ items: [], nextCursor: null }` with 200, never
  404.
- **One extra row is fetched** (`limit + 1`) to determine whether a next page
  exists, avoiding a second count query that would be both slower and racy.

## Alternatives considered

- **Offset/limit.** Familiar and allows page numbers, but incorrect under
  concurrent writes, which describes most PalCert collections.
- **Keyset without an opaque wrapper.** Exposes internal sort columns in the API
  surface and makes changing the sort a breaking change.

## Consequences

- No total count and no page numbers. Where a count is genuinely needed it is a
  separate, explicitly approximate endpoint.
- Every paginated query needs a composite index on `(scope…, sortColumn, id)`.
  Phase 2 adds them for members, invitations and organizations.
- The Phase 1 admin user list is migrated onto the shared helpers.
