# Secure document upload, storage, versioning and processing

_Status: current as of Phase 5._

Phase 5 gives PalCert its first real input: a user's own DOCX or PDF, taken in
safely. Nothing in this phase reads document *content* for meaning — no
formatting extraction, no rule evaluation, no AI, no scoring. It establishes
the pipeline every later phase consumes:

```
Upload → Quarantine → Validate → Malware scan → Hash → Secure storage → Ready
```

## 1. Ownership: user-private, never organization-scoped

A document belongs to exactly one user ([ADR-0031](../adr/0031-user-private-document-ownership.md)).
The tables `documents`, `document_versions`, `upload_sessions` and
`document_retention_locks` carry `owner_user_id` as their only isolation key
and are classified `USER_SCOPED`. Row-level security compares it with
`app_current_user_id()`, set transaction-locally by
`TenantPrismaService.withUser(userId)` — the Phase 2 mechanism pointed at a
user instead of an organization.

No document route takes an organization id. The permissions
`document:read:self`, `document:write:self`, `document:download:self` and
`document:delete:self` are granted to every self-service role and are the
only document permissions that exist. An organization owner asking for a
member's document gets `404 DOCUMENT_NOT_FOUND`, exactly like a stranger.
Official submission is a later, explicit act with its own records (Phase 14).

## 2. Data model

| Table | Role | Isolation |
| --- | --- | --- |
| `documents` | User-facing container: display name, `ACTIVE`/`DELETED`, soft-delete timestamp | USER_SCOPED |
| `document_versions` | The immutable artifact: version number, lifecycle status, identity (keys, object version ids, SHA-256, size, detected format), rejection/failure codes, stage timestamps | USER_SCOPED |
| `upload_sessions` | The upload authority: one per version; `CREATED → FINALIZED / EXPIRED / CANCELLED`; declared size/type/checksum, idempotency key, expiry | USER_SCOPED |
| `processing_jobs` | Transactional outbox and job ledger: type, resource, owner, attempts, lease, outcome | SYSTEM |
| `document_retention_locks` | Append-only reasons a version must be kept (for checks, certificates, submissions, financial records in later phases) | USER_SCOPED |

Composite foreign keys (`(id, owner_user_id)`) make it impossible to attach a
version to another user's document even with a forged id. Triggers enforce:

- identity columns are write-once (`document_versions_guard`);
- lifecycle transitions are exactly the enumerated ones;
- `READY` requires a full identity; `REJECTED`/`FAILED` require a code;
- `documents_guard`, `upload_sessions_guard` and `processing_jobs_guard`
  mirror the transition tables in `@palcert/contracts`;
- retention locks can be inserted, never updated or deleted.

### Version lifecycle

```
AWAITING_UPLOAD ──finalize──► UPLOADED ──► VALIDATING ──► SCANNING ──► READY
      │  │                       ▲              │  ▲          │
      │  └─ expire ─► UPLOAD_EXPIRED            │  └──────────┘ (a retried attempt starts over)
      └──── cancel ─► CANCELLED                 ├─ content decision ─► REJECTED (final)
                                                └─ attempts exhausted ─► FAILED ──owner retry──► UPLOADED
```

`REJECTED` is a verdict on the content and is never retryable; `FAILED` is an
infrastructure outcome and is retryable while the staged bytes still exist.

## 3. Upload architecture ([ADR-0032](../adr/0032-direct-to-storage-upload.md))

1. `POST /api/v1/documents/{documentId}/versions` with
   `{ originalFilename, sizeBytes, declaredMimeType?, sha256? }` and an optional
   `Idempotency-Key` header. The API sanitizes the filename (metadata only),
   checks the extension is `.docx`/`.pdf`, checks the declared size against
   the per-format ceiling, allocates the next version number under a row lock,
   creates the `upload_session`, and returns a presigned `PUT` for a
   **generated** quarantine key plus the exact headers to send.
2. The browser `PUT`s the bytes straight to storage (`uploadToStorage` in the
   web client, with progress and abort).
3. `POST …/finalize`. The API `HEAD`s the object, verifies its size against the
   authorization and the ceiling, records the object's ETag and **object
   version id**, moves the version to `UPLOADED`, inserts the processing job in
   the same transaction, then publishes it.

The user's filename, extension, declared MIME type and checksum are advisory
throughout: the pipeline decides from the bytes.

Idempotency: the same `Idempotency-Key` for the same document returns the same
version and a fresh authorization; the same key with different parameters is
`422 IDEMPOTENCY_KEY_REUSED`. Finalize is idempotent by state: a second call
returns the current version without creating a second job.

Expiry: an authorization lives `UPLOAD_SESSION_TTL_SECONDS`. Finalizing after
that is `410 UPLOAD_SESSION_EXPIRED` and the version becomes `UPLOAD_EXPIRED`.
The sweeper (`app_expire_upload_sessions`, `SECURITY DEFINER`, no user
context) expires abandoned sessions in batches and deletes their staged
objects; the quarantine bucket's lifecycle rule is the second line of defence.

## 4. Storage layout ([ADR-0033](../adr/0033-quarantine-and-clean-buckets.md))

| Zone | Bucket | Key | Written by | Readable by |
| --- | --- | --- | --- | --- |
| quarantine | `STORAGE_QUARANTINE_BUCKET` | `staging/users/{owner}/documents/{doc}/versions/{ver}/upload-{24 hex}` | presigned PUT | worker only |
| clean | `STORAGE_BUCKET` | `users/{owner}/documents/{doc}/versions/{ver}/source` | worker (server-side copy) | presigned GET for `READY` versions |

Both buckets: versioning enabled, public access blocked, server-side
encryption (`STORAGE_SERVER_SIDE_ENCRYPTION`, required in production), CORS
for the web origins, lifecycle rules (quarantine: expire after 2 days,
non-current versions after 1 day; clean: non-current versions after 30 days
only — current clean objects are never expired). `pnpm storage:provision`
applies all of it idempotently; nothing needs the MinIO console.

Users never see a bucket name, object key or object version id; the API
returns opaque identifiers and short-lived signed URLs.

## 5. Presigned URL security

- Upload URLs bind the exact `Content-Length` and `Content-Type` (and the
  client's SHA-256 when given) as *signed* headers, not query parameters; a
  different body length or a tampered key or signature is refused by storage.
- TTLs: `STORAGE_UPLOAD_URL_TTL_SECONDS` (default 15 min),
  `STORAGE_DOWNLOAD_URL_TTL_SECONDS` (default 2 min).
- URLs are never logged (logger redaction covers `*.upload.url`,
  `*.download.url`, `*.presignedUrl`), never persisted, and never used as an
  identifier; the upload session id is.
- The SDK's automatic CRC32 request checksum is disabled for presigning
  (`requestChecksumCalculation: WHEN_REQUIRED`); it would otherwise sign the
  checksum of an empty body into every URL.
- **Reuse after finalize is defeated by object versioning**
  ([ADR-0034](../adr/0034-object-versioning-defeats-presigned-reuse.md)):
  finalize captures the object version id; the worker reads that version and
  only that version; a later PUT to the same URL creates a version nobody
  reads.

## 6. Validation policy (worker, `IngestPipeline`)

Order matters: the cheapest, safest checks run first, and nothing later runs
on bytes an earlier step disowned.

1. **Object identity** — `HEAD key?versionId=`; missing → transient
   `QUARANTINE_OBJECT_MISSING`; ETag differs from finalize →
   `QUARANTINE_OBJECT_CHANGED`.
2. **Stream to a private temp file while hashing** — `sha256ToFile` writes
   with `O_EXCL` and mode `0600` under a per-job temp directory (never a path
   derived from the filename), enforces a byte ceiling, and rejects `FILE_EMPTY`
   and, when the client sent a digest, `FILE_CHECKSUM_MISMATCH`.
3. **Magic bytes** — a PDF must start with `%PDF-`; a DOCX must be a ZIP
   (`PK\x03\x04`). A ZIP named `.pdf` or a PDF named `.docx` is
   `FILE_TYPE_MISMATCH`; an executable or anything else is
   `FILE_TYPE_UNSUPPORTED`. The browser's `Content-Type` is never consulted.
4. **PDF structure** — header version, `%%EOF` trailer, `startxref` present;
   otherwise `FILE_CONTAINER_INVALID`.
5. **DOCX / ZIP safety** (`zip-safety.ts`, `docx-validator.ts`) — the central
   directory is inspected with `yauzl`; **nothing is ever extracted to disk**.
   Limits from configuration: entry count, per-entry and total uncompressed
   size, compression ratio (`INGEST_MAX_*`). Rejections: `FILE_ARCHIVE_UNSAFE`
   (traversal names, absolute or backslash paths, control characters, bombs,
   nested archives), `FILE_CONTAINER_INVALID` (encrypted entries; missing
   `[Content_Types].xml`, `word/document.xml`, or the main-part relationship),
   `FILE_MACRO_UNSUPPORTED` (`vbaProject.bin`, macro content types, `.docm`
   packages), `FILE_EMBEDDED_OBJECT_UNSUPPORTED` (`word/embeddings/`, OLE
   objects, ActiveX, embedded packages — except a legacy scientific equation
   that passes every structural check of ADR-0142, which is accepted as data), `FILE_EXTERNAL_CONTENT_UNSUPPORTED` (external relationships other
   than hyperlinks). Only the small parts needed for these decisions are read,
   each capped at `INGEST_MAX_INSPECTED_PART_BYTES`. Nothing inside the package
   is executed or rendered.
6. **Malware scan** — see §7.
7. **Promotion** — server-side copy of the exact quarantine object version to
   the clean key; the copy's size must equal the source; the clean object's
   version id is recorded; the version becomes `READY`; the staged object is
   deleted.

Every step runs under `INGEST_VALIDATION_TIMEOUT_MS` /
`INGEST_SCAN_TIMEOUT_MS`; a timeout is transient (`PROCESSING_TIMEOUT`).
Rejections carry a code and a short operator detail; the user sees a
localized message (English and Arabic) that never names an engine, bucket or
queue.

## 7. Malware scanning ([ADR-0035](../adr/0035-malware-scanning-as-a-gate.md))

`MalwareScannerPort` returns `CLEAN`, `INFECTED { signature }` or
`ERROR { reason }`. The ClamAV adapter streams the temp file to `clamd` with
`INSTREAM` in length-prefixed chunks — no path, no shell, no execution.
`ERROR` is transient (retried, then `FAILED` with `SCANNER_UNAVAILABLE`,
retryable); `INFECTED` is final (`REJECTED` with `FILE_MALWARE_DETECTED`,
staged bytes deleted, signature and engine recorded for operators and
audited, never shown to the user). The fake scanner recognises the EICAR
string and is refused in production configuration.

## 8. Queue, outbox and worker ([ADR-0036](../adr/0036-transactional-outbox-and-bullmq.md), [ADR-0037](../adr/0037-at-least-once-delivery-and-db-leases.md))

```
finalize tx ─ insert processing_jobs(PENDING) ─ commit
      └─ dispatchNow: claim (DISPATCHED, lease) → BullMQ add {processingJobId}
OutboxDispatcher.sweep (every process, UPLOAD_SWEEP_INTERVAL_MS):
      reap lapsed leases → RETRY_PENDING now / DEAD (fail the version)
      claim due PENDING/RETRY_PENDING → publish
Worker (apps/api/src/worker, own process `pnpm --filter @palcert/api start:worker`):
      start(jobId, workerId): DISPATCHED → RUNNING, or no-op (duplicate delivery)
      heartbeat every lease/3 · withUser(owner) · IngestPipeline.run
      rejected → version REJECTED, job SUCCEEDED
      ready    → version READY,    job SUCCEEDED
      throw    → classify: transient → RETRY_PENDING (backoff w/ jitter) or DEAD → version FAILED
```

- BullMQ's own retries are off (`attempts: 1`); the ledger owns the policy
  (`QUEUE_MAX_ATTEMPTS`, `QUEUE_BACKOFF_BASE_MS`, `QUEUE_BACKOFF_MAX_MS`,
  `QUEUE_LEASE_SECONDS`).
- Queue job ids are `{ledgerId}-{attempt}`; duplicates of one attempt
  deduplicate in Redis and, if delivered anyway, no-op in the database.
- An owner retry (`POST …/retry`) is allowed only for `FAILED` versions whose
  staged object still exists; it resurrects the `DEAD` job with a fresh
  attempt budget.
- The worker exposes `/health/live` and `/health/ready` (Redis, object
  storage, scanner) on `WORKER_PORT`.

## 9. Download authorization

`POST …/download-authorization` requires `document:download:self`, the
owner's scope, an `ACTIVE` document and a `READY` version; anything else is
`409 DOCUMENT_NOT_READY` / `DOWNLOAD_NOT_AVAILABLE` (or `404` for a document
the caller cannot see). The response is a short-lived signed GET for the
clean object *version* with `Content-Disposition: attachment` carrying the
sanitized original filename (RFC 6266/8187, so Arabic names survive) and the
canonical content type. Every issue is audited (`DOCUMENT_VERSION_DOWNLOADED`)
without the URL. Knowing a version id authorizes nothing.

## 10. Deletion and retention

`DELETE /documents/{id}` soft-deletes (`DELETED`, `deleted_at`) and enqueues a
`DOCUMENT_PURGE` job. The purge deletes clean objects (all object versions)
for versions that have **no** `document_retention_locks` row and marks them;
locked versions are kept. Later phases insert locks when a check, report,
certificate, submission or financial record references a version. Clean,
authoritative documents are never expired by lifecycle rules.

## 11. Observability and privacy

- Audit events: document created/renamed/deleted, version created, upload
  finalized/expired/cancelled, processing started/ready/rejected/failed,
  retry requested, download authorized. Never per polling cycle.
- Logs carry identifiers, sizes, codes and durations — never document text,
  full filenames beyond what an audit row needs, signed URLs or credentials.
  Health responses name dependencies (`object-storage`, `malware-scanner`)
  without endpoints, buckets or credentials.
- The web UI speaks in product terms ("checking the file", "scanning for
  threats") in English and Arabic; it never shows ClamAV, S3, BullMQ or Redis.

## 12. Configuration

See `.env.example`: `STORAGE_*`, `UPLOAD_*`, `INGEST_*`, `QUEUE_*`,
`WORKER_*`, `MALWARE_SCANNER`, `CLAMAV_*`. Production refuses the fake
scanner, requires server-side encryption, TLS to storage and two distinct
buckets.

## 13. Runbook

| Symptom | Where to look |
| --- | --- |
| Uploads stuck in `UPLOADED` | `SELECT status, attempt_count, last_failure_code FROM processing_jobs …`; is a worker running? Is Redis up? The sweep republishes on its own. |
| Versions `FAILED` with `SCANNER_UNAVAILABLE` | clamd down or overloaded; fix it, then owners can retry (or resurrect jobs by SQL). Never mark them ready by hand. |
| Readiness amber on `object-storage` | bucket missing or quarantine versioning not `Enabled`; run `pnpm storage:provision`. |
| Browser `PUT` fails with CORS | web origin missing from `API_CORS_ORIGINS` at provisioning time; re-run provisioning. |
| Quarantine bucket growing | sweeper not running or lifecycle rule missing; both are independent safety nets. |

## 14. What this phase deliberately does not do

DOCX or PDF formatting extraction, rule evaluation against uploads, AI
analysis, compliance scoring, reports, SmartFix, payments, official
submission, cross-user deduplication, resumable/multipart uploads, virus
re-scan schedules.
