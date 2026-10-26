# ADR-0033: Two buckets — quarantine for untrusted bytes, clean for promoted ones

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 5

## Context

An uploaded file is untrusted until it has been validated, hashed and scanned.
Anything that can serve, parse or download it before then is a vulnerability.
Bucket-level separation is the simplest boundary that every later component
can rely on without re-checking.

## Decision

- **Quarantine bucket** (`STORAGE_QUARANTINE_BUCKET`): the only place a
  presigned upload can write. Nothing is ever served from it; no download URL
  is ever signed for it. A lifecycle rule expires its objects after two days
  as the second line of defence behind the session sweeper.
- **Clean bucket** (`STORAGE_BUCKET`): written only by the worker, only after
  the pipeline returned `ready`, by a server-side copy of the exact quarantine
  object version. Its keys are
  `users/{owner}/documents/{doc}/versions/{ver}/source`. Download URLs are
  signed only for clean objects and only for `READY` versions.
- Both buckets: versioning enabled, public access blocked, server-side
  encryption required in production (`STORAGE_SERVER_SIDE_ENCRYPTION`).
- After promotion the quarantine object is deleted; a rejected or failed
  version keeps its staged bytes until the owner retries (failed) or the
  lifecycle rule expires them.

## Alternatives considered

- **One bucket with a prefix per state.** Rejected: a prefix is a convention,
  a bucket is a boundary — policies, lifecycle rules and audit apply per
  bucket.
- **Scanning before storage (proxy scan on upload).** Rejected: puts the API
  in the byte path (ADR-0032) and cannot bound scan time per request.

## Consequences

- A document is never readable by anyone, including its owner, before it is
  `READY`; the UI shows processing stages instead.
- The readiness probe verifies both buckets exist and that quarantine
  versioning is `Enabled`; a misconfigured deployment is amber, not silently
  insecure.
