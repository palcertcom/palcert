# ADR-0109: A resubmission is a new revision, never a rewrite

- **Status:** Accepted
- **Date:** 2026-09-15
- **Phase:** 14

## Context

A university reads a thesis, asks for the margins to be corrected, and waits
for a revised version. There are two ways to model what comes back.

The simple one updates the existing row: new document version, new report, new
digests, status back to `SUBMITTED`. One row, one case, easy to query.

It also destroys the record. The evidence the university read when it asked for
a revision is gone, replaced by evidence it has not seen. If the request is
later disputed — the student says they were asked for something else, the
university says otherwise — neither side can produce what was actually on the
desk.

## Decision

**`OfficialSubmission` is the long-lived case. Each `SubmissionRevision` is an
immutable official handoff, and a resubmission adds one.**

- One case per (author, organization, document), enforced by a unique index.
  A resubmission is a revision of that case, never a second case.
- Revision numbers are monotonic per case and are never reused.
- Every revision of a case belongs to the same `Document`. A new
  `DocumentVersion` is expected; a different document is not.
- Each revision binds one exact COMPLETED Check, its CheckRun and its
  CheckReport, at creation. Nothing is resolved by "latest" afterwards.
- One check is one revision's evidence: submitting the same check twice is
  refused by a unique index and by a named error.
- A revision is allowed only where the institution asked for one. The gate
  reads the case's highest-numbered revision under the case lock — not the
  case's current-revision pointer, which advances only when a revision reaches
  READY and therefore cannot see one still being prepared.
- `REVISION_REQUESTED` is terminal for its revision and not for the case.
  `APPROVED` and `REJECTED` are terminal for both.
- A `SMARTFIX_RECHECK` check may be submitted without buying a second
  `DOCUMENT_CHECK`. The recheck is already a paid, completed check.

## Alternatives considered

**Update the existing revision in place.** Rejected: it erases the evidence the
institution acted on.

**Start a new case for each resubmission.** Rejected: the institution would see
two unrelated submissions of the same thesis with no link between them, and
"the current official revision" would mean nothing.

**Allow a revision at any time.** Rejected: sending a second document while a
reviewer is reading the first makes the queue ambiguous and wastes their time.

## Consequences

The organization's view of a case is a history, and the current revision is
flagged rather than being the only one. Older revisions are visible as history,
not as work items.

Concurrency matters here: two simultaneous resubmissions must produce one
revision. The case row is locked before the highest revision number is read,
and a unique index on `(submission_id, revision_number)` catches it even if the
lock is ever lost.
