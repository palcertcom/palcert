# ADR-0083: SmartFix corrects a copy; the original is never modified

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 12

## Context

A correction has to produce a document the user can open. The obvious way is to
rewrite the file they uploaded: one object, one row, one version number, and the
user's "my thesis" keeps meaning the same thing.

It is also unrecoverable. Every check ever run against that document quoted its
SHA-256 and asserted it read those exact bytes. Every report's integrity claim
rests on them. And the author's own copy — the one their supervisor read, the
one they will submit — becomes something PalCert edited, with no way back.

## Decision

**A correction is a new `DocumentVersion` of the same document, with its parent
recorded. The source version is never written to.**

- `origin` is `USER_UPLOAD` or `SMARTFIX`, and it is write-once.
- A `SMARTFIX` version must name `sourceDocumentVersionId` and
  `smartFixRequestId`, both belonging to the same person and the same document.
- A `USER_UPLOAD` version may name neither, so an original cannot be
  retro-fitted with a parent to make it look like a correction.
- All of that is a database trigger (`document_versions_origin_lineage`), on
  top of the Phase 5 trigger that already freezes a version's identity columns.

## Alternatives considered

**Rewrite in place, keeping the old bytes in storage.** The row still moves, so
every check that named that version now describes a file it never read. The
history would have to be reinterpreted rather than simply read.

**A separate "corrected documents" table.** Then the recheck could not be an
ordinary check: the analyzer, the check pipeline and every read path would need
a second kind of document to know about. The recheck would test something the
check machinery had never seen, which is the opposite of what a recheck is for.

## Consequences

- A document grows a version per correction, and the version list is a real
  history: uploaded, corrected, corrected again.
- The source of a correction cannot be purged while its child exists — a
  `SMARTFIX` retention lock says so.
- "Which version was submitted?" stays answerable for ever.
