# ADR-0060: A completed AI review is immutable, and hashed separately from the report

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 8

## Context

Phase 7 established that a report, once produced, is a historical record: it is
canonicalized, hashed, and never edited. An AI review is a weaker kind of
statement, but it is still something a person may have read and acted on, and
re-running the model must not quietly change what a previous review said.

There is also a temptation to fold AI output into the Phase 7 report hash, so
there is "one number for the whole check". That would be wrong in a specific
and damaging way: it would make the deterministic report's integrity value
depend on a third-party model's output.

## Decision

A completed `AIReview` and its assessments are append-only, enforced by
database triggers (`ai_reviews_guard`, `ai_output_is_append_only`,
`ai_invocations_guard`) rather than by application discipline. Re-running
produces a **new** review; an old completed one is never overwritten.

Each review gets its own `aiReviewHash` over a canonical digest — RFC 8785 JCS,
the same canonicalization Phase 7 uses, with assessments sorted by rule code
and a pinned canonicalization version. It covers the AI review only.

**The Phase 7 `reportHash` and `evaluationHash` are untouched and unmixed.** A
model's output can never alter the integrity value of a technical measurement.

A review binds the exact immutable identities it was produced from — report id
and `reportHash`, evaluation hash, document version and `documentSha256`,
analysis id, standard version and content hash, artifact `sha256` — and the job
handler re-verifies them, re-hashing the artifact bytes, before it calls the
provider. An AI review never runs against "the latest" anything.

## Alternatives considered

**One hash covering report and AI review.** Rejected, as above.

**Update a review in place when re-run.** Rejected: someone may have read the
old one, and an audit that cannot show what was said at the time is not an
audit.

## Consequences

- A user can hold two reviews of the same check side by side and see which
  model and prompt produced each.
- Tampering with stored AI output fails at the database, not at code review.
- If the underlying evidence has changed or been purged, the review fails with
  `EVIDENCE_INTEGRITY_FAILED` rather than assessing something else.
