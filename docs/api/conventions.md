# PalCert API conventions

## 1. Versioning and layout

All product endpoints live under a version prefix (§35):

```
/api/v1/...
```

Planned resource roots: `/auth`, `/users`, `/organizations`, `/document-types`,
`/standards`, `/standard-versions`, `/rules`, `/documents`, `/checks`,
`/smartfix`, `/submissions`, `/reviews`, `/balance`, `/payments`,
`/certificates`, `/admin`.

Operational endpoints are deliberately **outside** the version prefix, because
they are infrastructure rather than product contract:

| Endpoint | Purpose |
| --- | --- |
| `GET /health/live` | Liveness — the process is running; touches no dependency |
| `GET /health/ready` | Readiness — dependencies reachable; `200` healthy, `503` not |
| `GET /api/docs` | Swagger UI (non-production only) |
| `GET /api/docs-json` | OpenAPI document (non-production only) |

## 2. OpenAPI

Every endpoint is documented via `@nestjs/swagger` decorators. Undocumented APIs
are not acceptable (§35). Request and response types are shared through
`@palcert/contracts` wherever practical.

## 3. Error responses

Every error — from any endpoint, in any service — has this shape:

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Not enough credit to start this check.",
    "details": { "required": 5, "available": 2 },
    "requestId": "0f3c1c9a-6e2e-4d6a-9b0e-7d0a2f6a1c11"
  }
}
```

- `code` is a stable `PalCertErrorCode` and is safe to branch on. Codes are
  never renamed; a code is deprecated and replaced instead.
- `message` is non-localized and safe to display.
- `details` is optional and always client-safe.
- `requestId` matches the `x-request-id` response header — quote it in support
  requests.

Stack traces, driver errors, connection strings and internal context are
**logged only** and never serialized to a client. Unknown errors always become
`INTERNAL_ERROR` with a generic message.

Default status mapping lives in `packages/contracts/src/errors/app-error.ts` and
is asserted by test for every declared code.

## 4. Correlation

`x-request-id` is accepted on request (max 128 characters), generated when
absent, echoed on every response, and propagated to downstream services so a
single check can be traced end to end.

## 5. Idempotency

Money-moving and job-creating endpoints accept an `Idempotency-Key` header
(`IDEMPOTENCY_KEY_HEADER`). Replaying a request with the same key must never
double-charge a user (§27, Phase 10–11).

Since Phase 5, `POST /documents/{documentId}/versions` honours it: the same
key on the same document returns the same version and a fresh upload
authorization; the same key with different parameters is
`422 IDEMPOTENCY_KEY_REUSED`. Finalize, cancel and retry are idempotent by
state (a repeated call returns the current version and creates nothing).

Since Phase 11 the key covers the **whole commercial request**: the same key
retried with the same document version, standard and quote returns the same
check, the same purchase and the same reservations; the same key with a
different quote is `422 IDEMPOTENCY_KEY_REUSED`, because a different quote is a
different purchase.

Since Phase 10 it is how money stays singular. `POST /balance/top-ups` and the
finance adjustment and refund endpoints honour it, every state-changing call
PalCert makes to a payment provider carries a derived provider idempotency key,
and every ledger entry carries a unique idempotency key per account — so a
retried request, a replayed job and a redelivered webhook converge on one
entry rather than three.

## 6. Validation

Request bodies are validated by a global `ValidationPipe` with `whitelist` and
`forbidNonWhitelisted` enabled: unknown properties are rejected rather than
silently ignored. Validation failures return `VALIDATION_FAILED` with the
individual issues in `details.issues`.

## 7. Rate limiting

Default: 120 requests per 60 seconds per client, configurable via
`API_RATE_LIMIT_LIMIT` and `API_RATE_LIMIT_TTL_SECONDS`. Exceeding it returns
`429` with code `RATE_LIMITED`. Health probes are exempt.

## 8. Authentication

Browser clients authenticate with an **opaque session cookie**, never a token
held in JavaScript (ADR-0011).

| Cookie | Readable by JS | Purpose |
| --- | --- | --- |
| `palcert_session` | No (`HttpOnly`) | The session identifier |
| `palcert_csrf` | Yes, deliberately | Must be echoed in `x-csrf-token` on unsafe requests |

Every unsafe request (`POST`/`PUT`/`PATCH`/`DELETE`) must:

1. come from an allow-listed `Origin`, and
2. carry `x-csrf-token` matching the `palcert_csrf` cookie, when a session
   cookie is present.

A `PENDING_MFA` session is not authenticated: it may reach only
`/auth/mfa/enroll`, `/auth/mfa/confirm`, `/auth/mfa/challenge` and
`/auth/logout`.

### Phase 1 endpoints

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| `POST` | `/auth/register` | public | — |
| `POST` | `/auth/login` | public | — |
| `POST` | `/auth/logout` | session (incl. pending MFA) | — |
| `POST` | `/auth/logout-all` | session | `session:revoke:self` |
| `POST` | `/auth/email/verify` | public | — |
| `POST` | `/auth/email/resend` | public | — |
| `POST` | `/auth/password/forgot` | public | — |
| `POST` | `/auth/password/reset` | public | — |
| `POST` | `/auth/password/change` | session | `password:change:self` |
| `GET` | `/auth/sessions` | session | `session:read:self` |
| `DELETE` | `/auth/sessions/:id` | session | `session:revoke:self` |
| `POST` | `/auth/mfa/enroll` | session (incl. pending MFA) | — |
| `POST` | `/auth/mfa/confirm` | session (incl. pending MFA) | — |
| `POST` | `/auth/mfa/challenge` | pending MFA | — |
| `DELETE` | `/auth/mfa` | session | `mfa:manage:self` |
| `GET` | `/users/me` | session | `profile:read:self` |
| `PATCH` | `/users/me` | session | `profile:update:self` |
| `GET` | `/admin/users` | session | `admin:user:read` |
| `GET` | `/admin/users/:id` | session | `admin:user:read` |
| `POST` | `/admin/users/:id/suspend` | session | `admin:user:suspend` |
| `POST` | `/admin/users/:id/reactivate` | session | `admin:user:reactivate` |
| `POST` | `/admin/users/:id/roles` | session + recent auth | `admin:role:assign` |
| `DELETE` | `/admin/users/:id/roles/:roleCode` | session | `admin:role:remove` |

### Deliberate information withholding

Several endpoints answer less than they know, and this is by design (§34):

| Endpoint | Behaviour | Reason |
| --- | --- | --- |
| `POST /auth/register` | Always 202 | Registration must not reveal which addresses have accounts |
| `POST /auth/login` | One `AUTHENTICATION_FAILED` for every credential failure | "Unknown email" vs "wrong password" is an enumeration oracle |
| `POST /auth/password/forgot` | Always 202 | Same |
| `POST /auth/email/resend` | Always 202 | Same |
| `DELETE /auth/sessions/:id` | 404 for another user's session | 403 would confirm the identifier exists |
| `GET /health/ready` | Dependency failures report `unreachable` | Probe responses are unauthenticated |

Accepted disclosures, and why they are acceptable: `EMAIL_NOT_VERIFIED`,
`ACCOUNT_SUSPENDED` and `ACCOUNT_DISABLED` are returned from login only **after
the correct password has been supplied** — the caller already controls the
account, and telling them why they cannot sign in avoids a support dead end.

## 9. Organization context

A tenant-scoped route carries the organization in its path:

```
/api/v1/organizations/:organizationId/...
```

The identifier is a **selector, not proof**. `OrganizationContextGuard` resolves
it server-side and verifies membership, membership status, organization status
and the caller's permissions *within that organization* before the handler runs
(ADR-0019). An organization id arriving in a header, query, body or cookie is
never trusted.

| Method | Path | Organization permission |
| --- | --- | --- |
| `POST` | `/organizations` | — (any authenticated user) |
| `GET` | `/organizations` | — (returns only your own) |
| `GET` | `/organizations/{organizationId}` | `organization:profile:read` |
| `PATCH` | `/organizations/{organizationId}` | `organization:profile:update` |
| `GET` | `/organizations/{organizationId}/verification` | `organization:verification:read` |
| `POST` | `/organizations/{organizationId}/verification` | `organization:verification:request` |
| `GET` | `/organizations/{organizationId}/members` | `organization:member:read` |
| `PATCH` | `/organizations/{organizationId}/members/{membershipId}` | `organization:member:update` |
| `DELETE` | `/organizations/{organizationId}/members/{membershipId}` | `organization:member:remove` |
| `POST` | `.../members/{membershipId}/roles` | `organization:role:assign` |
| `DELETE` | `.../members/{membershipId}/roles/{roleCode}` | `organization:role:remove` |
| `POST` | `/organizations/{organizationId}/ownership-transfer` | `organization:ownership:transfer` + recent auth |
| `GET` | `/organizations/{organizationId}/invitations` | `organization:member:read` |
| `POST` | `/organizations/{organizationId}/invitations` | `organization:member:invite` |
| `DELETE` | `.../invitations/{invitationId}` | `organization:member:invite` |
| `POST` | `/invitations/preview` | public (token-bearing) |
| `POST` | `/invitations/accept` | authenticated as the invited address |
| `GET` | `/admin/organizations` | `admin:organization:read` |
| `GET` | `/admin/organizations/verification-queue` | `admin:organization:verify` |
| `POST` | `/admin/organizations/{organizationId}/verification` | `admin:organization:verify` + recent auth |
| `POST` | `/admin/organizations/{organizationId}/suspend` | `admin:organization:suspend` + recent auth |
| `POST` | `/admin/organizations/{organizationId}/reactivate` | `admin:organization:suspend` + recent auth |

### Deliberate non-disclosure, continued

| Situation | Response | Reason |
| --- | --- | --- |
| Organization exists, caller is not a member | `404 ORGANIZATION_NOT_FOUND` | Identical to non-existent, so ids cannot be probed |
| Membership id from another tenant | `404 MEMBERSHIP_NOT_FOUND` | 403 would confirm the id is real |
| Invitation id from another tenant | `404 INVITATION_NOT_FOUND` | Same |
| Suspended member | `403 MEMBERSHIP_SUSPENDED` | The caller already knows they belong; a useful answer |
| Suspended organization | `403 ORGANIZATION_SUSPENDED`, reason withheld | The reason is PalCert-internal |

### Phase 5 endpoints (documents)

All under `/documents`, user-private (no organization in the path), cookie
session, permissions `document:*:self`:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/documents` | List the caller's documents (cursor pagination) |
| `POST` | `/documents` | Create a document container |
| `GET` / `PATCH` / `DELETE` | `/documents/{documentId}` | Read, rename, soft-delete |
| `GET` | `/documents/{documentId}/versions` | List versions |
| `POST` | `/documents/{documentId}/versions` | Declare an upload; returns the version and a presigned PUT |
| `GET` | `/documents/{documentId}/versions/{versionId}` | Read a version (status, stage timestamps, codes) |
| `POST` | `…/versions/{versionId}/upload-authorizations` | Re-issue a PUT while the version awaits its upload |
| `POST` | `…/versions/{versionId}/finalize` | Turn the staged object into an `UPLOADED` version and queue processing |
| `POST` | `…/versions/{versionId}/cancel` | Abandon an upload |
| `POST` | `…/versions/{versionId}/retry` | Re-run processing of a `FAILED` version |
| `POST` | `…/versions/{versionId}/download-authorization` | Signed GET for a `READY` version |

Error codes: `DOCUMENT_NOT_FOUND`, `DOCUMENT_DELETED`,
`DOCUMENT_VERSION_NOT_FOUND`, `DOCUMENT_NOT_READY`,
`DOCUMENT_VERSION_NOT_RETRYABLE`, `DOWNLOAD_NOT_AVAILABLE`,
`UPLOAD_SESSION_EXPIRED`, `UPLOAD_SESSION_CANCELLED`,
`UPLOAD_ALREADY_FINALIZED`, `UPLOAD_OBJECT_NOT_FOUND`,
`UPLOAD_SIZE_MISMATCH`, `IDEMPOTENCY_KEY_REUSED`, `FILE_TOO_LARGE`,
`FILE_EXTENSION_UNSUPPORTED`, `STORAGE_UNAVAILABLE`. Content verdicts
(`FILE_TYPE_MISMATCH`, `FILE_ARCHIVE_UNSAFE`, `FILE_MACRO_UNSUPPORTED`,
`FILE_MALWARE_DETECTED`, …) are reported on the version as `rejectionCode`,
never as an HTTP error, because they are decided asynchronously. Responses
never contain bucket names, object keys or object version ids; OpenAPI
examples never contain a real signature.

### Phase 6: document analysis

Phase 6 adds **no user-facing routes**. Analysis is infrastructure for the
Phase 7 check workflow, and an "analyze" endpoint now would be a surface with
no product behind it. It is reached through `ensureDocxAnalysis` in the API,
and exercised in tests through services and workers.

Two things are deliberately never exposed: the analysis artifact itself (it is
internal derived data, in a bucket no browser can reach) and engine internals
such as style ids, OOXML paths or warning codes. Phase 7 will present findings
in user-facing terms.

Error codes reserved for analysis: `DOCX_ANALYSIS_NOT_AVAILABLE`,
`DOCX_ANALYSIS_ALREADY_RUNNING`, `DOCX_ANALYSIS_UNSUPPORTED_FORMAT`,
`DOCX_SOURCE_INTEGRITY_FAILED`, `DOCX_ANALYSIS_FAILED`.

### Phase 7 endpoints (catalogue and checks)

The **catalogue** is read-only and answers one question: which standards may I
check against? It never returns a standard's rules.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/catalogue/organizations` | Verified organizations with at least one publicly checkable standard |
| `GET` | `/catalogue/organizations/{organizationId}/document-types` | Document types that organization publishes standards for |
| `GET` | `/catalogue/document-types/{documentTypeId}/standards` | Checkable standards, each naming the exact version a check would bind to, and its rule count |
| `GET` | `/catalogue/standards/{standardId}` | One checkable standard |

A private, inactive, unpublished or unverified-owner standard answers
`404 CHECK_STANDARD_NOT_AVAILABLE` — the same answer a nonexistent id gets, so
the route cannot be used to probe for private standards.

**Checks** are user-private (no organization in the path), cookie session,
permissions `check:read:self` and `check:create:self`:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/checks` | Start a check; `202` with the check in its initial state. Honours `Idempotency-Key` |
| `GET` | `/checks` | List the caller's checks (cursor pagination; filters: `status`, `determination`, `documentId`, `standardId`) |
| `GET` | `/checks/{checkId}` | One check |
| `GET` | `/checks/{checkId}/results` | Rule results for a completed check, worst first, paginated |
| `GET` | `/checks/{checkId}/report` | Report metadata and integrity hashes |
| `GET` | `/checks/{checkId}/report/artifact` | The immutable canonical report bytes |
| `POST` | `/checks/{checkId}/retry` | Re-run a failed check as a new run |

And one organization-scoped route, behind
`standard:check-availability:manage`:

| Method | Path | Purpose |
| --- | --- | --- |
| `PATCH` | `/organizations/{organizationId}/standards/{standardId}/check-availability` | Publish a standard to the catalogue, or withdraw it |

`POST /checks` returns **`202`, not `200`**: the check has been accepted, not
answered. The client follows `status` rather than holding a request open while
a document is analysed and hundreds of rules are evaluated.

**`status` and `determination` are separate fields and must not be merged.**
`status` is processing state; `determination` is the compliance verdict, and is
`null` for anything that has not completed — a failed check has no verdict at
all. `score` is likewise `null`, and a `score.value` of `null` means "no
deterministic score", which is not zero.

Error codes: `CHECK_NOT_FOUND` (404, also for another user's check),
`CHECK_STANDARD_NOT_AVAILABLE` (404), `CHECK_DOCUMENT_NOT_READY` (409),
`CHECK_DOCUMENT_FORMAT_UNSUPPORTED` (415), `CHECK_ALREADY_COMPLETED` (409),
`CHECK_NOT_RETRYABLE` (409), `REPORT_NOT_FOUND` (404),
`IDEMPOTENCY_KEY_REUSED` (422). Integrity failures
(`STANDARD_SNAPSHOT_INTEGRITY_FAILED`, `ANALYSIS_ARTIFACT_INTEGRITY_FAILED`)
are recorded on the check as `failureCode`, never returned as an HTTP error,
because they are decided asynchronously.

Responses never contain bucket names, object keys or object version ids. The
report artifact is served through the API, never as a presigned URL.

### Phase 8 endpoints (AI review)

AI review is user-private and additive: none of it changes a check, a report or
a determination. Cookie session; permissions `ai-review:read:self` and
`ai-review:create:self`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/ai/consent` | Whether the caller has agreed to external AI processing |
| `POST` | `/ai/consent` | Record agreement, its version and the provider category |
| `DELETE` | `/ai/consent` | Withdraw agreement; existing reviews stay readable |
| `POST` | `/checks/{checkId}/ai-reviews` | Start a review; `202`. Honours `Idempotency-Key` |
| `GET` | `/checks/{checkId}/ai-reviews` | The check's reviews, newest first |
| `GET` | `/checks/{checkId}/ai-reviews/{reviewId}` | One review, with provider, model, versions and usage |
| `GET` | `/checks/{checkId}/ai-reviews/{reviewId}/assessments` | Advisory per-rule assessments |
| `GET` | `/checks/{checkId}/ai-reviews/{reviewId}/supplement` | The bilingual summary and recommendations |
| `POST` | `/checks/{checkId}/ai-reviews/{reviewId}/cancel` | Cancel a queued review |

The start body is `{ "priceQuoteId": "<uuid>" }`, a quote for `AI_REVIEW`
obtained from `GET /pricing/quote?product=AI_REVIEW&currency=…`. The
server reserves the quote's amount from the caller's balance (ADR-0149).
Possible errors: `402 INSUFFICIENT_BALANCE`; `409 QUOTE_EXPIRED`,
`QUOTE_ALREADY_USED` or `QUOTE_PRODUCT_MISMATCH`; `404 QUOTE_NOT_FOUND`. A
body carrying an amount or price is rejected with `400`.

`POST /checks/{checkId}/ai-reviews` returns **`202`, not `200`**: the assessment
does not exist yet, and a response that looked like one would invite clients to
read a verdict out of it.

**An assessment is advisory and says so in its own vocabulary.** `assessment` is
`SATISFIED`, `NOT_SATISFIED` or `INSUFFICIENT_EVIDENCE` — never `PASS` or
`FAIL`, and never a confidence number. Each assessment carries the
deterministic outcome for the same rule beside it and its own
`requiresHumanReview`, which is `true` for every blocking rule whatever the
model concluded.

Review statuses are `CREATED`, `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED` and
`CANCELLED`. `PASS`/`FAIL` are rule vocabulary and are never job statuses.

There is deliberately **no general-purpose AI endpoint**. Every route above
names one PalCert task with a fixed prompt and a validated output schema.

Error codes: `AI_DISABLED` (503), `AI_CONSENT_REQUIRED` (403),
`AI_REVIEW_NOT_FOUND` (404, also for another user's review),
`AI_REVIEW_CHECK_NOT_COMPLETED` (409), `AI_REVIEW_NO_ASSESSABLE_RULES` (409),
`AI_REVIEW_NOT_CANCELLABLE` (409), `AI_PROVIDER_UNAVAILABLE` (503),
`IDEMPOTENCY_KEY_REUSED` (422). `AI_EVIDENCE_INTEGRITY_FAILED` is recorded on
the review as `failureKind`, never returned as an HTTP error, because it is
decided asynchronously.

Responses never contain a prompt, a raw provider request or response, or an API
key.

### Phase 9 endpoints (rule extraction)

All organization-scoped: a Standard's source documents belong to the
institution, not to whoever uploaded them. Permissions are
`standard:source:read|create|delete`, `standard:extraction:read|run`,
`standard:proposal:review|decide` and `organization:ai-consent:manage`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/organizations/{orgId}/ai-consent` | Whether the institution has agreed to external processing |
| `POST` | `/organizations/{orgId}/ai-consent` | Record the institution's agreement; admin only |
| `DELETE` | `/organizations/{orgId}/ai-consent` | Withdraw it; existing proposals stay readable |
| `GET` | `/organizations/{orgId}/standard-versions/{versionId}/sources` | The draft's source documents |
| `POST` | `/organizations/{orgId}/standard-versions/{versionId}/sources` | Register a source and get a presigned upload; honours `Idempotency-Key` |
| `GET` | `.../sources/{sourceId}` | One source, with status, digest and page count |
| `POST` | `.../sources/{sourceId}/finalize` | Hand the uploaded bytes to the ingestion pipeline |
| `POST` | `.../sources/{sourceId}/download-authorization` | A short-lived link to the original |
| `DELETE` | `.../sources/{sourceId}` | Remove a source; refused when an accepted rule cites it |
| `POST` | `.../extractions` | Start a reading; `202`. Honours `Idempotency-Key` |
| `GET` | `.../extractions` | Runs for this version, newest first |
| `GET` | `.../extractions/{runId}` | One run, with provider, model, versions, summary and usage |
| `POST` | `.../extractions/{runId}/cancel` | Cancel a queued run |
| `GET` | `.../extractions/{runId}/proposals` | The proposals, with kind, validation and conflict status |
| `GET` | `.../extractions/{runId}/proposals/{proposalId}` | One proposal with its evidence and observations |
| `POST` | `.../proposals/{proposalId}/accept` | Accept as proposed or as edited. **Requires `If-Match`** |
| `POST` | `.../proposals/{proposalId}/reject` | Reject with a reason kept inside PalCert |
| `POST` | `.../proposals/accept-selected` | Accept an explicitly named list. **Requires `If-Match`** |
| `POST` | `.../proposals/reject-selected` | Reject an explicitly named list, in one transaction |
| `GET` | `.../extractions/{runId}/progress` | Where a running extraction has got to; cheap enough to poll |
| `GET` | `.../rules/{ruleId}/provenance` | Where an accepted rule came from |
| `GET` | `.../extraction-counters` | Source, run and proposal counts for the version |

Starting a reading takes `priceQuoteId` (a quote for `AI_RULE_EXTRACTION`)
alongside `sourceIds`. The member who starts it pays from their own balance,
never the organization, with the same errors as AI review.

`POST .../extractions` returns **`202`, not `200`**: no proposal exists yet, and
a response that looked like one would invite a client to act on it.

**Accepting is a write to the draft**, so it carries `If-Match` with the draft
revision exactly as a hand-written rule edit does, and answers
`STALE_STANDARD_REVISION` (409) when the draft moved. `accept-selected` is an
explicit list, never "accept all", and reports what it skipped and why rather
than dropping it silently. The console's "Accept all valid (N)" sends exactly
that: the N ids the reviewer confirmed, and the server refuses any of them that
carries no valid rule.

`reject-selected` takes at most 200 ids and one reason for all of them. It
rejects every named proposal still pending in a single transaction, writes one
decision and one `RULE_PROPOSAL_REJECTED` audit event per proposal (as an
individual rejection does), and returns `{ rejected, skipped }`. Anything
already decided — including by an earlier attempt of the same request — is
skipped with `RULE_PROPOSAL_ALREADY_DECIDED`, so a retry decides nothing twice;
an id that is not this run's is skipped with `RULE_PROPOSAL_NOT_FOUND`.

`progress` is derived only from what the run stored: its status, the provider
calls it opened and settled in the current attempt, and the evidence it saved.
A reload therefore reads the same answer. `totalBatches`, `evidenceCount`,
`observationCount` and `proposalCount` are `null` until they are actually
known, never estimated.

**A proposal is not a rule.** `kind` is `EXPLICIT_REQUIREMENT`,
`TEMPLATE_INFERENCE`, `AMBIGUOUS_REQUIREMENT`, `CONFLICTING_REQUIREMENT` or
`UNREPRESENTABLE_REQUIREMENT`; the last three carry no rule definition at all,
enforced by a database CHECK. No response contains a confidence value, because
none is produced.

Run statuses are `CREATED`, `QUEUED`, `DISCOVERING_EVIDENCE`,
`GENERATING_PROPOSALS`, `VALIDATING`, `COMPLETED`, `FAILED` and `CANCELLED`.

Error codes: `AI_DISABLED` (503), `ORGANIZATION_AI_CONSENT_REQUIRED` (403),
`ORGANIZATION_AI_CONSENT_NOT_PERMITTED` (403), `STANDARD_SOURCE_NOT_FOUND`
(404, also for another organization's source), `STANDARD_SOURCE_NOT_READY`
(409), `STANDARD_SOURCE_IMMUTABLE` (409), `STANDARD_SOURCE_RETENTION_LOCKED`
(409), `STANDARD_VERSION_NOT_DRAFT` (409), `EXTRACTION_NO_USABLE_SOURCES`
(409), `EXTRACTION_ALREADY_RUNNING` (409), `EXTRACTION_RUN_NOT_FOUND` (404),
`EXTRACTION_NOT_CANCELLABLE` (409), `RULE_PROPOSAL_NOT_FOUND` (404),
`RULE_PROPOSAL_ALREADY_DECIDED` (409), `RULE_PROPOSAL_NOT_ACCEPTABLE` (409),
`STALE_STANDARD_REVISION` (409).

Responses never contain a prompt, a raw provider request or response, a
provider `file_id`, or an API key. Another organization's source, run or
proposal id answers **404, never 403**: the difference would confirm it exists.

### Phase 10 endpoints (PalCert Balance, payments and pricing)

Customer-facing balance routes are **user-scoped**, never organization-scoped:
an institution has no access to a person's money. They require
`balance:read:self`, and adding credit requires `balance:topup:self`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/balance` | Available, reserved, cash and promotional, per currency |
| `GET` | `/balance/currencies` | Currencies this installation accepts |
| `GET` | `/balance/transactions` | The customer's own ledger history, cursor-paginated |
| `GET` | `/balance/holds` | What is currently reserved, and for what |
| `POST` | `/balance/top-ups` | Start adding credit; returns a short-lived provider checkout URL. Honours `Idempotency-Key` |
| `GET` | `/balance/top-ups` | Top-up history, including failures and why |
| `GET` | `/balance/top-ups/{topUpId}` | One top-up's authoritative status |
| `GET` | `/balance/refunds` | Refunds to the customer's card |
| `GET` | `/pricing/products` | The service catalogue; public |
| `GET` | `/pricing/quote` | A price the server derives and freezes briefly |
| `POST` | `/webhooks/payments/{provider}` | Provider events. Signature-verified, not cookie-authenticated |

Administrative finance routes are platform-scoped and separately permissioned
(`pricing:price:read|create|activate`, `finance:payment:read`,
`finance:ledger:read`, `finance:refund:create`, `finance:adjustment:create`):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`/`POST` | `/admin/finance/prices` | List price versions; create a draft |
| `POST` | `/admin/finance/prices/{id}/activate` | Retire the incumbent and activate this one, atomically |
| `POST` | `/admin/finance/prices/{id}/retire` | Retire a price version |
| `GET` | `/admin/finance/purchases/summary` | Purchases and captured revenue per product and currency (never summed across currencies); `finance:purchase:read` |
| `GET` | `/admin/finance/purchases` | Individual purchases (≤200, newest first) with payer and, for organization AI, the organization; `finance:purchase:read` |
| `GET` | `/admin/finance/customers/{userId}/balance` | A customer's balance and accounts |
| `GET` | `/admin/finance/customers/{userId}/payments` | Their top-ups, as views — never raw provider rows |
| `POST` | `/admin/finance/adjustments` | Append a credit or debit with a reason code. `Idempotency-Key` required |
| `POST` | `/admin/finance/refunds` | Send money back to a card. Reserves the credit first |
| `GET` | `/admin/finance/refunds/{refundId}` | One refund's status |
| `GET` | `/admin/finance/verify-ledger` | Replay the ledger and check four invariant families |

**Every amount is `{ "currency": "USD", "minorUnits": "2000" }`** — a string,
never a JSON number, because `JSON.parse` would make it a float. `2000` is
$20.00.

**A client never states a price or an amount to charge.** It names a product;
the server answers with a quote. The only amount a client supplies is how much
credit *it wants to add*, and the server bounds that.

**The webhook route is not a browser route.** It is `@Public()` and
`@ProviderSigned()`: authenticated by a signature over the exact raw request
bytes, exempt from browser CSRF checks — which only apply to routes a browser
actually makes — and never trusted for its contents. Processing re-retrieves
the payment from the provider before crediting anything.

**Nothing in Phase 10 credits a balance because a browser arrived somewhere.**
`PAYMENT_SUCCESS_URL` is a page that asks `GET /balance/top-ups/{id}` and
displays the answer.

Error codes: `INSUFFICIENT_BALANCE` (**402**, not 409 — it is a
payment-required condition, not a conflict), `PAYMENTS_DISABLED` (503),
`PAYMENT_PROVIDER_UNAVAILABLE` (503), `CURRENCY_NOT_SUPPORTED` (422),
`TOPUP_AMOUNT_OUT_OF_RANGE` (422), `TOPUP_NOT_FOUND` (404),
`TOPUP_NOT_PENDING` (409), `CREDIT_HOLD_NOT_FOUND` (404),
`CREDIT_HOLD_NOT_ACTIVE` (409), `LEDGER_ENTRY_NOT_FOUND` (404),
`LEDGER_ENTRY_NOT_REFUNDABLE` (409), `REFUND_EXCEEDS_REMAINING` (409),
`REFUND_NOT_ELIGIBLE` (409 — promotional credit is never refundable to a
card), `PAYMENT_REFUND_NOT_FOUND` (404), `RECONCILIATION_REQUIRED` (409),
`PAYMENT_AMOUNT_MISMATCH` (409), `PAYMENT_CURRENCY_MISMATCH` (409),
`WEBHOOK_SIGNATURE_INVALID` (400), `PRICE_NOT_FOUND` (404),
`PRICE_NOT_AVAILABLE` (409), `PRICE_IMMUTABLE` (409),
`PRICE_ALREADY_ACTIVE` (409), `QUOTE_NOT_FOUND` (404), `QUOTE_EXPIRED` (409),
`SERVICE_PRODUCT_NOT_FOUND` (404), `SERVICE_PRODUCT_NOT_ACTIVE` (409).

No response contains a provider secret, a raw webhook body, a provider payload,
a signature header or any card detail. Another customer's top-up, hold or
refund id answers **404, never 403**.

### Phase 11 endpoints (paid document checks)

A check is bought with PalCert Balance. The client names a **price quote**; it
never states an amount, and there is no field for one anywhere in the request.

| Method | Path | Change |
| --- | --- | --- |
| `POST` | `/checks` | now requires `priceQuoteId`; reserves credit and queues the work in one transaction |
| `POST` | `/checks/{checkId}/cancel` | new — releases the reservation. Refused after the report exists |
| `POST` | `/checks/{checkId}/retry` | refuses a paid check: no charge was made, and running it again is a new check |
| `GET` | `/checks`, `/checks/{checkId}` | gain `billing` and `legacyFree` |
| `GET` | `/admin/finance/customers/{userId}/purchases` | new — `finance:purchase:read`, read-only |

**`POST /checks` is all-or-nothing.** An insufficient balance answers
**`402 INSUFFICIENT_BALANCE`** and leaves no check, no purchase, no hold and no
job behind; the quote is still spendable.

The **billing block** carries three amounts, because "reserved" and "charged"
are different states and a customer shown only a price cannot tell which one
they are in:

```json
{
  "billing": {
    "purchaseId": "…",
    "productCode": "DOCUMENT_CHECK",
    "status": "DELIVERED",
    "amount":   { "currency": "USD", "minorUnits": "300" },
    "reserved": { "currency": "USD", "minorUnits": "0" },
    "charged":  { "currency": "USD", "minorUnits": "300" },
    "failureCode": null
  },
  "legacyFree": false
}
```

A check created before checks were paid for carries `"billing": null` and
`"legacyFree": true`. PalCert does not invent a purchase for one.

**No internal financial identifier appears.** The purchase id is the only
handle: no hold id, no account id, no allocation id, no ledger entry id, in any
response or in the OpenAPI document.

**A charge means a delivered report, not a passing one.** `COMPLIANT`,
`NON_COMPLIANT`, `REVIEW_REQUIRED` and `INDETERMINATE` are all charged. A
technical failure or a cancellation releases the reservation; that is a release,
not a refund, and the wording says so.

Error codes: `INSUFFICIENT_BALANCE` (402), `PRICE_QUOTE_REQUIRED` (422),
`QUOTE_NOT_FOUND` (404, also for another customer's quote),
`QUOTE_EXPIRED` (409), `QUOTE_ALREADY_USED` (409),
`QUOTE_PRODUCT_MISMATCH` (422), `SERVICE_PURCHASE_NOT_FOUND` (404),
`SERVICE_RESERVATION_EXPIRED` (409), `SERVICE_ALREADY_DELIVERED` (409),
`CHECK_NOT_CANCELLABLE` (409), `CHECK_RETRY_REQUIRES_NEW_PURCHASE` (409).

## 10. Pagination

**Cursor pagination everywhere** (ADR-0020).

```json
{ "items": [ … ], "nextCursor": "eyJ…" }
```

| Rule | Value |
| --- | --- |
| `limit` default / maximum | 25 / 100, clamped rather than rejected |
| Cursor | Opaque `base64url(<sortValue>\|<id>)`; never parse it |
| Sort | Always a business column **plus** the primary key, for stability |
| Malformed cursor | `400 VALIDATION_FAILED` — never a silent reset to page one |
| Last page | `nextCursor: null`. Stop on null, not on an empty `items` |
| Empty collection | `200 { items: [], nextCursor: null }`, never 404 |

## 11. Filtering and sorting

Not yet standardized; no Phase 2 endpoint needs it. It will be defined by the
first phase that does, and applied consistently from there.

## Optimistic concurrency (`If-Match` / `ETag`)

Resources with a concurrent-edit risk carry a revision, surfaced as an `ETag`.
From Phase 3 this is standard versions and their rules.

- Every version read returns `ETag: "<revision>"`.
- Every mutating request against a draft — including mutations of its rules —
  **must** send `If-Match` with that value.
- A missing `If-Match` is `VALIDATION_FAILED` (400), never an implicit
  "proceed": treating it as consent would make the protection opt-in.
- A stale `If-Match` is `STANDARD_VERSION_CONFLICT` (**412**, not 409), with
  `details.currentRevision` so the client can re-read and retry.
- `*` is rejected. It means "any current representation", which for an edit is
  indistinguishable from no precondition.

Publishing is the deliberate exception: it takes a row lock instead, and is
idempotent, so a retried publish after a dropped response succeeds rather than
failing. See [ADR-0025](../adr/0025-optimistic-concurrency-for-drafts.md).

Publishing a draft while another version is in force **supersedes** that
version in the same transaction: it becomes `SUPERSEDED`, records
`supersededAt` and `supersededByVersionId`, and keeps its snapshot and hash for
every check, report and certificate that refers to it. There is no "archive it
first" step. The body may carry `replacesVersionId` — the version the caller
expects to replace, or `null` for none — and a publish whose expectation no
longer holds is refused with `CONFLICT` (409). A superseded version cannot be
edited, archived or published again (`STANDARD_VERSION_SUPERSEDED`, 409); clone
it to use its content again. See
[ADR-0143](../adr/0143-publishing-a-successor-supersedes-the-version-in-force.md).

A version of any status can be exported as a portable `.palcert.json` package
and imported by another organization as a new draft — never published, never
merged into an existing version. See
[Portable standard packages](standard-packages.md).

## Field-level validation errors

Where a payload has cross-field semantics — a rule, principally — the error
carries every problem at once, each with the dotted path that caused it:

```json
{
  "error": {
    "code": "RULE_SCHEMA_INVALID",
    "message": "This rule has 2 problem(s).",
    "details": {
      "issues": [
        { "path": "expected.type", "code": "OPERATOR_INCOMPATIBLE", "message": "…" },
        { "path": "tolerance", "code": "NOT_APPLICABLE", "message": "…" }
      ]
    }
  }
}
```

This is what lets a form mark each offending field, instead of the author fixing
one problem per round trip.

## Rule schema versions

Rules and standard versions carry a `ruleSchemaVersion`. The API judges a rule
by the version of the standard version that owns it, not by the latest version
this release knows: a draft written under version 1 is still validated under
version 1's invariants, so historical content that was valid stays valid.

- `GET /standards/rule-schema` returns `ruleSchemaVersion` (what new drafts are
  written under), `supportedRuleSchemaVersions` (every version this release
  validates, oldest first) and `blockingAnyModeFromSchemaVersion`. Clients derive
  their behaviour from these rather than hard-coding a number.
- A new version is written under the current schema version.
- `POST …/versions/{versionId}/clone` preserves the source's schema version by
  default. Passing `"upgradeRuleSchema": true` writes the **new draft** under
  the current version; the source is never modified, the audit event records
  both versions, and a request to "upgrade" to an older version is refused
  (`RULE_SCHEMA_INVALID`, 422).
- A rule whose schema version this release does not support is refused with
  `RULE_SCHEMA_UNSUPPORTED` in its issue list.

See [ADR-0030](../adr/0030-rule-schema-v2-blocking-semantics.md).
