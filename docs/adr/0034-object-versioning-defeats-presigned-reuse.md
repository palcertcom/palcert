# ADR-0034: The finalized object *version* is the artifact, not the key

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 5

## Context

A presigned PUT is valid until it expires. A client can PUT, call finalize, and
then PUT again to the same URL with different bytes — before the worker reads
the object. Without a defence, the worker would validate and scan bytes the
finalize step never saw, or a later reader would get a different file than
the one that was scanned and hashed.

## Decision

**Every read of an uploaded object is pinned to an object version id.**

- Both buckets have S3 object versioning enabled; the readiness probe refuses
  a quarantine bucket without it.
- `finalize` HEADs the staged object and stores its `version_id`, `etag` and
  size on the `document_versions` row (write-once, enforced by trigger).
- The worker reads `key?versionId=<stored>`; a later PUT creates a new object
  version and is simply never read. If the stored version is gone, the job
  fails transiently (`QUARANTINE_OBJECT_MISSING`); if its ETag differs from
  finalize, the job fails (`QUARANTINE_OBJECT_CHANGED`). Neither can produce
  `READY`.
- Promotion copies that exact version; the clean object's own version id is
  stored, and every download URL is signed with it.

## Alternatives considered

- **Short presign TTLs only.** Necessary but insufficient: any window is a
  window.
- **Content-hash the object at finalize and compare later.** Requires reading
  the whole object in the request path (§17), and still races the worker.
- **Storage that refuses overwrites.** Not available uniformly across
  S3-compatible services; versioning is.

## Consequences

- Deploying against a bucket without versioning is a readiness failure, not a
  degraded mode.
- The e2e suite proves the property: a second PUT after finalize is ignored,
  the promoted bytes match the first upload, and the download URL carries a
  `versionId`.
