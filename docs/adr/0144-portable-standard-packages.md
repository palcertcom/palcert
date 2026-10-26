# ADR-0144: Portable standard packages are content, imported only as drafts

- **Status:** Accepted
- **Date:** 2026-09-30
- **Phase:** Post-RC standards lifecycle
- **Related:** [ADR-0024](0024-published-immutability.md), [ADR-0143](0143-publishing-a-successor-supersedes-the-version-in-force.md)

## Context

Institutions want to reuse each other's formatting standards: one exports its
PhD thesis standard, another adopts it — possibly after changing a margin. The
obvious shortcut, a database dump or the published snapshot, is wrong for this:
a dump carries identifiers, people and private records; the snapshot is proof
of what *one* organization published and has no place in another's history.

## Decision

A **portable standard package** (`PALCERT_STANDARD`, format version 1) is a
versioned JSON transfer contract, separate from the storage model:

- It carries the standard's code, names and descriptions, the document
  category, the version label and window, every rule in the rule API's own
  vocabulary, the rule schema and canonicalization versions, and human-readable
  provenance (`source`). **No identifier of any kind**, and no users,
  credentials, checks, submissions, certificates, balances, audit rows,
  webhooks, AI prompts or output, source documents, storage keys or URLs.
  Source documents are deliberately out of scope for v1.
- `contentHash` is SHA-256 over the canonical form (the standard canonicalizer:
  sorted keys, NFC, nulls omitted) of everything except `exportedAt`,
  `contentHash` and `signatures`, with rules ordered by code. It is an
  **integrity** check, never evidence of who exported the file.
- `signatures` is reserved: v1 readers accept and ignore it, so signing can be
  added later without making packages unreadable. Any other shape change is a
  new `formatVersion`, which older readers refuse.

**Export** is a read (`standard:definition:read`) and works for any status;
the exported status is informational. It is audited as `STANDARD_EXPORTED`.

**Import** is two requests. *Preview* parses the uploaded text on the server
(size, depth, forbidden keys, exact field sets), checks format and schema
versions, verifies the hash, validates every rule with the same
`validateRuleDefinition` a hand-written rule meets — plus structural checks a
file needs and a form does not — and describes destinations. It writes
nothing. *Import* receives the same text and the `packageHash` the preview
returned; a different package is refused. In one transaction it creates the
standard (if asked), a **DRAFT** version, its rules with new ids, a
`standard_version_imports` provenance row and a `STANDARD_IMPORTED` audit
event. It never publishes and never modifies an existing version.

Nothing is normalized: an invalid rule is reported with its path and blocks
the import; a tolerance finer than the stored `DECIMAL(12,4)` is refused
rather than rounded; a malformed date is refused rather than reinterpreted. An
older rule schema is read under its own rules and the current one, and the
draft is written under the current schema with an explicit notice.

### Origin and adoption

Imported rules keep their `origin` exactly. The receiving organization does not
adopt them by importing: the draft carries a provenance card saying so, and
adoption is the ordinary publish of that draft by the receiving organization.

### Duplicates and conflicts

- Duplicate rule codes inside a package are invalid rules.
- A code already used in the receiving organization is never overwritten: the
  user changes the code or imports into that standard as a new version.
- A version label already used in the chosen standard is refused.
- Importing into a standard that already has drafts creates another,
  separate draft; nothing is merged.
- A package whose hash was already imported into the organization is refused
  unless the request sets `acknowledgeDuplicate`, and the preview says when it
  was imported before.

## Alternatives considered

- **Export the published snapshot.** Rejected: it is evidence of one
  organization's publication, not a draft for another, and exists only for
  published versions.
- **Trust the browser's parsed object on import.** Rejected: the server reads
  the text itself on both requests, and the hash pins import to preview.
- **Store provenance in rule `originReference`.** Rejected: that would mix
  foreign text into the columns the content hash is built from.

## Consequences

- One additive migration (`standard_version_imports`); no existing row changes.
- Import is deterministic and local: no AI provider, no document engine, no
  queued work.
- The body limit is raised to accept a 5 MB package on the two import routes
  only; the rest of the API keeps the framework default.
