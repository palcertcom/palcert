# ADR-0110: The evidence hash covers evidence, never the decision

- **Status:** Accepted
- **Date:** 2026-09-15
- **Phase:** 14

## Context

Each revision carries a digest over what was handed to the institution, built
the same way Phase 7's report hash is: RFC 8785 canonical JSON, SHA-256, with
an explicit schema version and canonicalization version so a future format
change is a version bump rather than a silent difference.

The question is what goes inside it. The obvious temptation is "everything
about the revision", which would include the institution's decision — and that
is wrong in a way that only shows up later.

## Decision

**The evidence hash covers identity and digests only, and never the
institution's decision.**

Inside: the schema and canonicalization versions, the organization, the
document type, the document, the revision number, the submitted document
version and its digest, the format, the bound check, run and report with their
report and evaluation hashes, the technical determination, and the standard,
version and content hash it was measured against.

Outside: `institutionDecisionStatus`, the decision events, the comments, the
reviewer, and every timestamp belonging to the review.

## Alternatives considered

**Include the decision, and recompute the hash on each transition.** Rejected:
the row's `evidence_hash` is write-once precisely so that it cannot drift, and
a digest that changes when a reviewer presses Approve is not a digest of the
evidence.

**Hash the snapshot bytes only.** Rejected: it would not bind the bytes to the
report, the standard or the determination, so two different submissions of the
same file would be indistinguishable.

## Consequences

The evidence hash is computed once, when the snapshots are verified, and is
then immutable. A test recomputes it from the stored row and asserts it is
unchanged after an approval — so a future field added to the evidence in the
wrong place fails rather than quietly changing what the digest means.

Phase 15's certificate can bind to this hash: it identifies exactly what was
submitted, independently of what was decided about it.
