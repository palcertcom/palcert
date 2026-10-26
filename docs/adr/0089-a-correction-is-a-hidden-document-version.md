# ADR-0089: A correction is a real document version, hidden until delivered

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 12

## Context

Between generating a corrected document and delivering it, PalCert has to
analyze it and run a full check against it. During all of that the user has not
been charged, the result has not been validated, and the file must not be
visible or downloadable.

So the corrected bytes need somewhere to live that the check pipeline can reach
and the user cannot. Three shapes suggest themselves: a temporary object with no
row, a separate "provisional documents" table, or an ordinary `DocumentVersion`
that the owner cannot see.

The first two share a fatal property: the recheck would then be running against
something the check machinery had never seen. A recheck that exercises a
different code path from a check is not a recheck.

## Decision

**The corrected document is an ordinary `DocumentVersion` with
`visibleToOwner = false`, flipped true in the transaction that delivers it.**

- It goes through the same Phase 5 secure ingestion as a browser upload —
  format detection, digest, malware scan, promotion to the clean zone —
  because "PalCert made it" is not a security property.
- It is analyzed by the same analyzer and checked by the same pipeline.
- The document read paths filter on `visibleToOwner`, and answer *not found*
  rather than *forbidden*: the difference would confirm PalCert is holding a
  file the user cannot download.
- A deferred trigger refuses a visible `SMARTFIX` version whose request has not
  reached `DELIVERED`, and refuses a hidden `USER_UPLOAD` version outright —
  hiding is a property of an undelivered correction and of nothing else.

## Alternatives considered

**A temporary object with no row.** Nothing to recheck, nothing to lock, and
nothing to clean up reliably if the worker dies.

**A separate provisional table.** Every read path, the analyzer, the check
pipeline and the retention machinery would need to know about a second kind of
document, and the recheck would stop being a real check.

## Consequences

- A failed correction leaves a hidden, ingested version behind. It is evidence
  of what happened and is never visible; purging it is a retention concern, not
  a correctness one.
- Version numbers advance even for corrections that are never delivered. That
  is honest: PalCert did produce a version.
