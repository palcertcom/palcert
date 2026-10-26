# ADR-0042: A third bucket for derived data, reachable by no browser

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 6

## Context

An analysis artifact is not small and it is not harmless. It contains the
document's structure, its headings, its metadata and, where the privacy policy
allows, its paragraph text. It is derived from a user's private document and
inherits that document's sensitivity exactly.

Two questions follow: where does it live, and who can reach it?

## Decision

**A third private bucket, `STORAGE_DERIVED_BUCKET`.** Phase 5 established
quarantine and clean; derived joins them as a separate trust zone rather than a
prefix, so lifecycle rules, policies and audit apply to it in its own right.

- Versioned, public access blocked, server-side encryption required in
  production — the same posture as the clean bucket.
- **No CORS at all.** The quarantine bucket allows `PUT` from the web origin
  and the clean bucket allows `GET`; the derived bucket allows nothing,
  because no browser has business there. Adding a CORS rule would be the first
  step toward exposing artifacts.
- **No presigned URL, ever.** The storage port has no download authorization
  path for the derived zone. Artifacts are read by workers and by PalCert's own
  services (§94).
- **The database stores metadata only**: the key, the object version, the
  digest, the size and counters. Not the artifact, and never extracted text.
- Keyed by analysis id, so a second analyzer version writes its own object and
  neither can overwrite the other.

**Retention follows the source.** An artifact must not outlive the document it
describes: the purge path that deletes a soft-deleted document's clean objects
deletes its analyses' artifacts too, subject to the same retention locks (§123).
Nothing expires a current artifact on a timer, because a check may still
reference it.

## Alternatives considered

- **Store the artifact as a JSON column.** Rejected: artifacts reach tens of
  megabytes, and a database is not an object store.
- **Reuse the clean bucket with a `derived/` prefix.** Rejected: a prefix is a
  convention; a bucket is a boundary. The clean bucket is presigned for
  download, and sharing it would put artifacts one policy mistake away from a
  browser.
- **Compress the artifact.** Deferred. Deterministic compression is possible
  but it splits the hash into "hash of stored bytes" and "hash of canonical
  bytes", and an ambiguous integrity claim is worse than a larger object (§88).

## Consequences

- `pnpm storage:provision` creates and configures all three buckets; nothing is
  a manual console step.
- The readiness probe checks all three and reports `object-storage` without
  naming any of them.
- A future report API will expose selected findings, never the raw artifact.
