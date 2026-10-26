# ADR-0143: Publishing a successor supersedes the version in force

- **Status:** Accepted
- **Date:** 2026-09-29
- **Phase:** Post-RC standards lifecycle
- **Amends:** [ADR-0024](0024-published-immutability.md)

## Context

ADR-0024 gave standard versions three states, `DRAFT → PUBLISHED → ARCHIVED`,
and at most one `PUBLISHED` version per standard. Publishing version 1.2 while
1.0 was in force was therefore refused with *"Version 1.0 of this standard is
already published and in force. Archive it first if this version should replace
it."*

That made the ordinary case — a new edition of a standard replacing the old
one — a two-step manual procedure with a window between the steps where the
standard had **no** version in force, and it made `ARCHIVED` mean two different
things: "an administrator deliberately retired this" and "a newer version
replaced this". Only the first is a decision; the second is history.

## Decision

Add a fourth state, `SUPERSEDED`:

```
DRAFT ──publish──> PUBLISHED ──publish a successor──> SUPERSEDED
  │                    └──archive──> ARCHIVED
  └──archive──> ARCHIVED
```

- **`PUBLISHED`** is the single version in force.
- **`SUPERSEDED`** was in force and was replaced by publishing a newer version.
  It is immutable history, never a deletion: its snapshot and content hash are
  untouched, and every check, report and certificate that captured it keeps
  resolving to exactly it. It is not offered for new checks. It records
  `superseded_at` and `superseded_by_version_id`; `archived_at` is not reused.
- **`ARCHIVED`** keeps its one meaning — deliberately retired — and stays
  terminal.

Publishing is one transaction: lock the draft, validate it exactly as before,
lock the version in force, mark it `SUPERSEDED` with its successor, write the
snapshot, flip the draft to `PUBLISHED`, and write both audit events
(`STANDARD_VERSION_SUPERSEDED`, `STANDARD_VERSION_PUBLISHED`). Any failure
rolls all of it back.

There is **no `SUPERSEDED → PUBLISHED`** and no `SUPERSEDED → ARCHIVED`. Going
back to an old version is clone → review → publish, so the audit trail shows a
new decision rather than a resurrected snapshot.

### Enforcement

- The partial unique index `standard_versions_one_published_per_standard` is
  unchanged and remains the arbiter of "at most one in force".
- `standard_versions_freeze` now lets `PUBLISHED` move to `SUPERSEDED` (with
  only the supersession fields changing, the successor in the same standard and
  `archived_at` untouched) and freezes `SUPERSEDED` like `ARCHIVED`.
- A deferred constraint trigger,
  `standard_versions_supersession_requires_successor`, refuses at commit any
  supersession whose successor did not end up `PUBLISHED`. A partial publish —
  or a hand-run `UPDATE` that forgets the publish — cannot leave a standard with
  nothing in force.
- CHECK constraints tie the supersession fields to the status and keep the
  publication fields mandatory for `SUPERSEDED`.
- `app_check_standard_snapshot` and `app_check_standard_identity` accept
  `SUPERSEDED`, so running checks and reports bound to the old version keep
  working. The catalogue functions still select `PUBLISHED` only, so new checks
  bind to the successor.

### Concurrency

The publish request may carry `replacesVersionId`: the version the author saw
in force when they confirmed (null for none). If another version is in force by
the time the transaction runs, the request is refused with `CONFLICT` instead
of replacing a version the author never saw. Without it, two concurrent
publishes still cannot both win: the second queues on the in-force row lock,
finds it superseded, and is refused by the unique index.

## Alternatives considered

- **Keep "archive first".** Rejected: the operator does two things to express
  one intent, the standard is briefly without a version in force, and history
  loses the difference between "retired" and "replaced".
- **Reuse `ARCHIVED` for replaced versions.** Rejected: an existing archived
  version may have been retired for a reason nobody recorded, and treating the
  two alike would put a false statement into history. Existing `ARCHIVED` rows
  are not converted.
- **Allow `SUPERSEDED → PUBLISHED` (rollback).** Rejected: republishing an old
  snapshot would make "which version was in force on that date?" ambiguous.
  Clone and publish produces the same content with an honest record.

## Consequences

- Authors publish a new edition in one confirmed step; the UI names the version
  being replaced and retains it as history.
- The migration adds columns and constraints only. No existing row, id, hash or
  snapshot changes, and no data migration is needed.
- API responses gain `supersededAt`, `supersededByVersionId` and
  `supersededByVersionLabel`; `status` may now be `SUPERSEDED`. A client that
  switches on status must treat the new value as "historical, read-only".
