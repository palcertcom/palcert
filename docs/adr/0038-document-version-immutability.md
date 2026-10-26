# ADR-0038: A document version is immutable; a new upload is a new version

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 5

## Context

Checks, reports, certificates, SmartFix outputs and official submissions
(later phases) will all reference a document version and its SHA-256. If the
bytes or the identity behind a version could change, none of those records
would mean anything. Object storage happily overwrites a key; the schema must
not.

## Decision

- **Document vs. version.** `documents` is the user-facing container (name,
  status); `document_versions` is the immutable artifact with a monotonically
  increasing `version_number` per document, allocated under a row lock.
- **Write-once identity.** `quarantine_object_key`, `sha256`, `size_bytes`,
  `detected_format`, `clean_object_key`, `clean_object_version_id` and
  `quarantine_object_version_id` can be set once and never changed; a
  database trigger raises on any later change, and the RLS role cannot drop
  the trigger. `READY` requires all of them (`check` constraint).
- **Transitions are enumerated** in one place in the contracts and mirrored by
  the trigger; the only re-entrant path is a retried attempt starting over at
  `VALIDATING`, and `FAILED → UPLOADED` for an owner retry.
- **Never overwrite.** Each version has its own key in both buckets; a new
  upload for the same document is a new version. Storage versioning is a
  second guard, not the mechanism.
- **Deletion is soft.** `DELETE /documents/{id}` marks the document `DELETED`
  and enqueues a purge job; the purge deletes clean objects only for versions
  without a `document_retention_locks` row (append-only, the hook for
  submissions, certificates and financial records to pin what they reference).
  Clean, authoritative documents are never expired automatically.
- **No cross-user deduplication.** Two users uploading identical bytes get
  two objects; equality of hashes is never observable across owners.

## Alternatives considered

- **Mutable "current file" per document.** Rejected: it is the overwrite
  design this ADR exists to prevent.
- **Content-addressed storage (key = SHA-256).** Rejected: it creates a
  cross-user side channel and complicates purge and retention.

## Consequences

- The e2e suite proves a second upload leaves version 1 unchanged, that the
  schema owner cannot rewrite a `READY` identity, and that a deleted document
  is purged while a locked version is kept.
- Phase 6 parsing reads the clean object *version* recorded here and can cache
  results by `sha256` within the owner's scope.
