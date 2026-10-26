# ADR-0046: A check binds exact identities at creation

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 7

## Context

A compliance result is a claim about a specific document and a specific set of
rules. Both move: a student uploads a new draft, a university publishes a new
version of its thesis standard. If a check meant "the latest of each", then the
same result would mean something different tomorrow, and a report produced in
March could not be explained in September.

The tempting shortcut is to store `documentId` and `standardId` and resolve the
rest at evaluation time. It is simpler to write and impossible to defend.

## Decision

A check captures, at creation and for ever:

- the **document version** and its SHA-256,
- the **standard version** and its content hash,
- later, the **analysis** and its artifact digest,

and a database trigger refuses to change any of them. The check is those bytes
and those rules; a different version is a different check.

The identities are re-verified before evaluation, not merely recorded. The
worker reads the analysis artifact by its exact object version, hashes it, and
compares; it loads the published snapshot and compares its content hash to the
one the check captured. Either mismatch fails the check closed with an
integrity failure code.

Public catalogue labels — the organization's display name, the document type,
the standard's code and name, the version label — are **copied onto the check**
at creation. Not for speed: the check's owner is not a member of the publishing
organization, so their session genuinely cannot read those tables, and must not
be able to. Copying the labels they already saw in the catalogue is what lets a
check render without weakening tenant isolation.

## Consequences

- A result can be explained years later from the report alone.
- Re-checking after a revision is a new check, which is what a person means.
- A standard made private, or archived, stops new checks and leaves existing
  reports intact and readable.
- The cost is denormalization, and the duty to keep it honest: the labels are a
  snapshot of what the user chose, not a live mirror, and the report says so by
  carrying the standard's version label and content hash beside them.
