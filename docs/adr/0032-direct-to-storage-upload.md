# ADR-0032: Uploads go directly to object storage through a presigned PUT

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 5

## Context

Documents are up to 200 MiB. Streaming them through the NestJS API would tie
up request workers, put the API in the path of every byte, and make the API's
memory and timeout limits the effective upload limits. It would also make the
API a tempting place to "just parse" a file inside a request, which §17 forbids.

## Decision

**The API authorizes uploads; it never receives file bytes.**

1. `POST /documents/{id}/versions` validates the request (filename, declared
   size, declared type), allocates a version and an `upload_session`, and
   returns a **presigned PUT** for one generated key in the quarantine bucket.
   The signature binds the exact `Content-Length`, `Content-Type` and, when
   the client supplied one, the SHA-256 checksum; the browser cannot change any
   of them without invalidating the URL.
2. The browser PUTs the bytes to storage.
3. `POST …/finalize` is the only thing that turns an upload into a version:
   the API HEADs the object, verifies the size against the authorization and
   the format ceiling, records the object's ETag and **object version id**
   (ADR-0034), transitions the version to `UPLOADED`, and enqueues processing
   in the same transaction (ADR-0036).

Storage keys are generated (`staging/users/{owner}/documents/{doc}/versions/{ver}/upload-{random}`);
the user-supplied filename is metadata only and never influences a path, key,
bucket, temp file or command argument. Clients never choose a bucket or key.

## Alternatives considered

- **Multipart upload through the API.** Rejected: the API becomes the
  bottleneck and the byte path; every limit doubles up.
- **POST policy uploads.** Functionally similar; presigned PUT keeps a single
  method and signs the content headers explicitly.
- **Tus / resumable uploads.** Deferred: worthwhile for unreliable networks,
  but adds a stateful server; the presigned model can grow into multipart
  presigning later without changing the contract.

## Consequences

- The storage service needs CORS for `PUT` from the web origin and must expose
  `ETag` and `x-amz-version-id`; `pnpm storage:provision` configures it.
- Presigned URLs are short-lived (`STORAGE_UPLOAD_URL_TTL_SECONDS`), never
  logged, never persisted; the upload session id is the identifier.
- The SDK's automatic CRC32 checksum is disabled for presigning: it would sign
  a checksum of an empty body and break every real upload.
