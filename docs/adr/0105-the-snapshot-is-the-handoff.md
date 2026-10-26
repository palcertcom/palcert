# ADR-0105: An official submission hands over a snapshot, not a reference

- **Status:** Accepted
- **Date:** 2026-09-15
- **Phase:** 14

## Context

Having decided that an organization sees only what was submitted (ADR-0104),
there are two ways to give it that.

The cheap one is a reference: the submission row points at the author's
document version and their check report, and the organization's queries are
allowed to follow those pointers. Nothing is copied.

The problem is that a pointer is not a record. The author can upload a new
version, delete the old one, run a new check, or have a retention policy purge
the bytes. The report artifact is regenerated when report rendering changes.
Whatever the university read last week is not necessarily what it can read
today, and there is no way to tell. Worse, allowing those reads at all means
widening row-level security on the author's private tables — the exact move
ADR-0031 forbids, and one that cannot be made "only for submitted rows"
without the policy on `documents` having to reason about submissions.

## Decision

**Preparation copies the exact bytes to organization-scoped storage, verifies
the copy, and the organization reads only the copy.**

- The document is copied as an exact object version. Nothing is re-rendered,
  re-encoded, converted or regenerated.
- The report artifact is copied as it stands. It is never rebuilt from current
  tables, so a standard published since changes nothing about what the
  institution is reading.
- The source digests are verified before the copy and the destination digests
  after it. A mismatch fails the preparation; it never becomes a submission.
- The snapshot key is organization-scoped and carries no name, email or title.
  Access is a short-lived signed GET; there is no public URL and no public ACL.
- The snapshot has its own retention lock, so the submitted bytes outlive the
  private check's lifecycle.
- Row-level security on `documents`, `document_versions`, `document_checks`,
  `check_runs`, `check_reports`, the AI tables, the SmartFix tables and every
  finance table is untouched.

## Alternatives considered

**Pointers with a "submitted" exception in the policies.** Rejected: it makes
every private table's policy depend on the submission tables, and one mistake
in that predicate exposes documents nobody submitted.

**Copy lazily, on the organization's first read.** Rejected: the bytes may be
gone by then, and "the evidence exists" would depend on somebody looking at it
in time.

**Store the snapshot as a new row in the author's own tables.** Rejected: the
author could then delete it, and an institution's record of what it received
is not the author's to remove.

## Consequences

Storage cost is duplicated for every submitted revision. That is the price of a
record, and it is small next to what it buys: the submission can still produce
its evidence years later, and the digest in the row proves it is the same
evidence.

Preparation is asynchronous and can fail. That failure is a processing failure
with its own vocabulary and is never surfaced as an institution decision.
