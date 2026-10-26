# ADR-0023: Published standard versions carry a canonical content hash

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 3

## Context

A certificate asserts that a document complied with a particular standard. That
assertion is only meaningful if the standard itself can be shown not to have
changed since. "Trust our database" is not an answer a university or a journal
should have to accept, and it is not one PalCert should have to make.

## Decision

Publishing a standard version computes a **SHA-256 over a canonical
serialization of the version's meaning**, stores both the hash and the exact
serialized object, and freezes the version.

The canonical form is a JSON string with:

1. object keys sorted ascending by Unicode code point;
2. no insignificant whitespace;
3. keys whose value is null or undefined omitted entirely;
4. every string NFC-normalized;
5. rules sorted by `ruleCode` (unique within a version);
6. numbers via ECMAScript's Number-to-String algorithm, `-0` normalized to `0`,
   non-finite values refused.

**Included:** everything that changes what a document is judged against — the
standard's code and bilingual names, the document type's system category and
name, the version label, the effective window, and each rule's complete
semantic tuple including `displayOrder` (report ordering is part of the
meaning).

**Excluded, deliberately:** database ids, `organizationId`, `createdAt` /
`updatedAt` / `publishedAt` / `publishedByUserId`, `status`, `revision`,
`clonedFromVersionId`.

Excluding `organizationId` is the choice most worth stating: two organizations
that independently write byte-identical standards get the same hash, because the
hash identifies **content**, not ownership or storage. Isolation is row-level
security's job, not a salt's.

`STANDARD_CANONICALIZATION_VERSION` is stored inside the hashed content and
alongside it, so old hashes stay verifiable if the algorithm ever changes.

## Consequences

- Anyone holding the published snapshot can recompute the hash and verify the
  standard **without trusting PalCert** and without database access. The
  `GET …/snapshot` endpoint re-verifies on every read, so a tampered snapshot is
  reported rather than served as genuine.
- Blockchain anchoring (ADR-0007) becomes publishing an existing value rather
  than inventing one.
- Committed golden fixtures (`canonical.spec.ts`) pin the exact byte sequence.
  If a change alters them, the correct response is to bump the canonicalization
  version and add a *new* golden — never to edit the existing one in place,
  which would silently invalidate every certificate already issued.
- Duplicate rule codes are refused at canonicalization time: they would make the
  sort order ambiguous, and a hash that cannot be reproduced is worse than none.

## Alternatives considered

**Hashing the database rows directly.** Rejected: ids and timestamps would make
the hash depend on storage, and a restore or a migration would change it.

**Recomputing on demand instead of storing a snapshot.** Rejected: recomputation
depends on the live tables and on today's canonicalizer, and the entire point is
to have something that does not.
