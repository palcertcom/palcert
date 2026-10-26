# PalCert security baseline

Aligned with OWASP ASVS. §38 forbids "secure enough" as an acceptance
criterion: every control below is specific and testable. Each control names the
phase that implements it — Phase 0 controls are live today.

## 1. Controls implemented in Phase 0

| Control | Implementation | Verified by |
| --- | --- | --- |
| Configuration validated at boot | Zod schemas in `@palcert/config`; process exits with code 78 on invalid config | `load-env.spec.ts` |
| Production hardening enforced by config | API docs disabled, JSON logging required, wildcard CORS rejected when `NODE_ENV=production` | `load-env.spec.ts` |
| No secrets in the repository | `.env.example` contains placeholders only; `.env` is git-ignored; gitleaks runs in CI | CI `security` job |
| Secret strength | `AUTH_SESSION_SECRET` must be ≥ 32 characters | `load-env.spec.ts` |
| Security response headers | helmet: CSP `default-src 'none'`, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS in production; `x-powered-by` disabled | `health.e2e-spec.ts` |
| Browser headers on the web app | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, restrictive `Permissions-Policy` | `next.config.mjs` |
| CORS allow-list | Explicit origin list; no wildcard in production | `api-config.service.spec.ts` |
| Rate limiting | `@nestjs/throttler`, 120 requests / 60s by default; health probes exempt | `app.module.ts` |
| Input validation | Global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted`; unknown properties are rejected | `all-exceptions.filter.spec.ts` |
| Error responses leak nothing | Unknown errors and 5xx return a generic message; internal context is log-only | `all-exceptions.filter.spec.ts`, `test_errors.py` |
| Log redaction | Credentials, cookies, API keys, password/token/secret fields redacted inside the logger | `logger.config.spec.ts` |
| Log injection guard | Inbound `x-request-id` bounded to 128 characters | `logger.config.spec.ts`, `test_health.py` |
| Health probes disclose nothing | Dependency failures report `unreachable`, never hostnames or driver errors | `health-indicators.spec.ts` |
| Containers run unprivileged | Every runtime image creates and uses a non-root `palcert` user | `docker/*.Dockerfile` |
| Dependency scanning | `pnpm audit --audit-level high` and `pip-audit --strict` in CI | CI `security` job |
| Query logging off by default | Prisma logs `warn`/`error` only; query text may contain customer data | `prisma-client.ts` |

## 1a. Controls implemented in Phase 1

| Control | Implementation | Verified by |
| --- | --- | --- |
| Argon2id password hashing | 19 MiB / t=2 / p=1 default; production floor enforced by config validation | `password.service.spec.ts`, `load-env.spec.ts` |
| Transparent rehash | PHC parameters compared on each login; weak hashes replaced | `password.service.spec.ts` |
| Length-based password policy | Min 12, max 256, counted in code points; never truncated | `password.service.spec.ts` |
| Breached-password abstraction | `BreachedPasswordPort` with a no-op default, so an outage cannot block sign-ups | `password.service.spec.ts` |
| Opaque server-side sessions | 256-bit token; only its SHA-256 digest persisted | `auth-lifecycle.e2e-spec.ts` |
| Session fixation prevention | New identifier on login, MFA completion and password change | `auth-security.e2e-spec.ts` |
| Idle + absolute session expiry | Separate windows, stricter for privileged roles | `auth-lifecycle.e2e-spec.ts`, `auth-mfa.e2e-spec.ts` |
| Immediate revocation | Logout, logout-all, per-session revoke, password change/reset, suspension | `auth-lifecycle.e2e-spec.ts` |
| Cookie hardening | HttpOnly, Secure in production, SameSite, explicit Path and expiry | `auth-security.e2e-spec.ts` |
| No session identifier in URLs | Cookie is the only accepted channel | `auth-security.e2e-spec.ts` |
| Layered CSRF defence | Origin allow-list + session-bound synchronizer token | `auth-security.e2e-spec.ts` |
| Login throttling | Per-account and per-IP counters, expiring — no permanent lockout | `auth-security.e2e-spec.ts` |
| Account enumeration resistance | Identical responses on register, login, forgot-password and resend | `auth-security.e2e-spec.ts` |
| Single-use credential tokens | Atomic conditional consumption; replay rejected | `auth-lifecycle.e2e-spec.ts` |
| TOTP replay protection | Accepted counter recorded; a code cannot be reused in its window | `auth-mfa.e2e-spec.ts` |
| TOTP secrets encrypted at rest | AES-256-GCM under `AUTH_MFA_SECRET_KEY` | `crypto.spec.ts`, `auth-security.e2e-spec.ts` |
| Single-use recovery codes | ~98 bits entropy, digest-only storage, shown once | `auth-mfa.e2e-spec.ts` |
| Mandatory MFA for privileged roles | Enforced at login and re-checked on every request | `auth-mfa.e2e-spec.ts` |
| Permission-based authorization | Global guards; no role-name branching | `auth-security.e2e-spec.ts` |
| Mass-assignment prevention | Explicit DTOs + `forbidNonWhitelisted` | `auth-security.e2e-spec.ts` |
| Privilege-escalation prevention | Permission checks plus database check/FK constraints | `auth-security.e2e-spec.ts` |
| Horizontal access control | Cross-user session access returns 404, not 403 | `auth-security.e2e-spec.ts` |
| Secret redaction in events | Forbidden-key filter on event and audit payloads | `auth-security.e2e-spec.ts` |
| Durable security and audit records | Append-only, with actor/target/before/after | `auth-security.e2e-spec.ts` |

## 1b. Controls implemented in Phase 2

| Control | Implementation | Verified by |
| --- | --- | --- |
| Request path cannot bypass RLS | Dedicated `palcert_app` role: not superuser, no BYPASSRLS, not the owner, no DDL | `tenant-rls-coverage.e2e-spec.ts` |
| Boot refuses an over-privileged DB role | `pg_roles` check in `PrismaService.onModuleInit` | manual + config test |
| Row-level security on every tenant table | `ENABLE` + `FORCE`, policies for all four commands, `WITH CHECK` on writes | `tenant-rls-coverage.e2e-spec.ts` |
| RLS coverage cannot be forgotten | Catalogue-driven test over `table_isolation_classification` | `tenant-rls-coverage.e2e-spec.ts` |
| Tenant context cannot leak across pooled connections | Transaction-local `set_config`, discarded at COMMIT and ROLLBACK | `tenant-connection-safety.e2e-spec.ts` |
| Unscoped queries are contained | Raw cross-tenant SELECT/UPDATE/DELETE/INSERT as the request role | `tenant-connection-safety.e2e-spec.ts` |
| Cross-tenant IDOR | Real foreign membership and invitation ids rejected as not-found | `tenant-isolation.e2e-spec.ts` |
| Non-disclosure of tenant existence | Foreign and non-existent organizations answer identically | `tenant-isolation.e2e-spec.ts` |
| Organization roles cannot grant platform authority | Scope checks, DB composite FK, and a contract test on the catalogue | `organization-team.e2e-spec.ts`, `rbac.spec.ts` |
| Last-owner invariant | `SELECT … FOR UPDATE` inside the mutating transaction | `organization-team.e2e-spec.ts` |
| Invitation tokens | 256-bit, single-use, expiring, digest-only storage, never logged | `organizations.e2e-spec.ts` |
| Invitation cannot be retargeted | Organization and role read from the stored row, never the payload | `tenant-isolation.e2e-spec.ts` |
| Platform elevation is explicit and audited | `withPlatformAdmin` with a stated reason, security event, audit record | `tenant-isolation.e2e-spec.ts` |
| Reviewer notes never reach the organization | Separate column, never selected by tenant-facing code | `organizations.e2e-spec.ts` |
| Cross-tenant denials are recorded | `CROSS_TENANT_ACCESS_DENIED` security event | `tenant-isolation.e2e-spec.ts` |

## 1c. Controls implemented in Phase 5

| Control | Implementation |
| --- | --- |
| Untrusted upload isolation | Presigned PUT into a quarantine bucket only; the API never receives file bytes; nothing is served from quarantine |
| Presigned URL binding | Size, content type and (optional) SHA-256 are *signed* headers; short TTLs; URLs never logged or persisted; SDK auto-checksum disabled |
| Presigned reuse after finalize | Defeated by object versioning: finalize captures the object version id; the worker reads only that version |
| Content-based type detection | Magic bytes and structure decide; filename, extension, declared MIME and client checksum are advisory |
| Archive safety | Central-directory inspection without extraction; limits on entries, sizes, compression ratio; traversal/absolute/control-character names, nested archives and encrypted entries rejected |
| Office package safety | Macros (`vbaProject.bin`, macro content types), embedded objects, ActiveX and non-hyperlink external relationships rejected; the one exception is an allow-listed legacy equation object (`Equation.DSMT4`, `Equation.3`) that passes structural classification (ADR-0142); nothing inside a package is executed or rendered |
| Malware scanning | ClamAV over `INSTREAM` from a private temp file; `ERROR` is never `CLEAN`; infected files are rejected and their bytes deleted; signature names never shown to users |
| Resource limits and timeouts | Per-format size ceilings, streaming hash with byte ceiling, validation and scan timeouts, worker concurrency |
| Safe storage names | Generated keys derived from ids and random bytes; the user filename never reaches a path, key, bucket, temp file or command |
| Immutability | Write-once identity columns and enumerated transitions enforced by triggers; a new upload is a new version; never overwrite |
| User-scoped RLS | `owner_user_id` policies on every document table; the worker re-enters the owner's scope; organizations have no access |
| Download authorization | Owner + permission + `READY` version only; signed GET bound to the clean object version; `Content-Disposition: attachment`; audited |
| Encryption at rest | `STORAGE_SERVER_SIDE_ENCRYPTION` (AES256 or KMS) required in production; TLS to storage required in production |
| Processing durability | Transactional outbox, database leases and retries; duplicate delivery is a no-op; a scanner or storage outage produces `FAILED`, never `READY` |
| Deletion and retention | Soft delete + asynchronous purge that honours append-only retention locks; clean documents never auto-expire |
| Non-disclosure | Health responses, errors and the UI never name buckets, endpoints, engines or queues; error bodies for foreign documents are indistinguishable from "not found" |

## 1d. Controls implemented in Phase 6

| Control | Implementation |
| --- | --- |
| Hardened XML parsing | Every DOCTYPE refused, so XXE, billion-laughs and parameter entities have no entry; external entity resolution and parameter-entity parsing refused independently |
| XML resource limits | Depth, element count, part bytes and total bytes enforced *while* parsing; separate budgets for paragraphs, runs, tables, cells, styles, numbering, relationships, notes, drawings, facts and artifact size |
| No network from the analyzer | External OPC relationships are recorded as data and never fetched; the analyzer makes no outbound call of any kind |
| Package traversal | Relationship targets are resolved as ZIP entry names; a target escaping the package is refused |
| No office automation | Analysis runs headless in PalCert's own infrastructure; no Word, COM or LibreOffice anywhere in the path |
| Source integrity | Bytes are hashed and compared with the version's authoritative SHA-256 on both sides of the service boundary before anything is believed |
| Exact object version | The analyzer reads the clean object version Phase 5 recorded, never the latest key, never the quarantine object |
| Derived-data isolation | Artifacts live in a third private bucket: versioned, encrypted, no CORS, no presigned URL, worker-only |
| User-scoped RLS | `document_analyses` is USER_SCOPED on `owner_user_id` with composite ownership keys; organizations have no access at any layer |
| Analysis immutability | Identity and artifact are write-once and a succeeded analysis cannot change, enforced by a trigger the request role cannot drop |
| No fabrication | No page numbers, no invented application defaults, no confidence on exact extraction; unknowns are reported as UNAVAILABLE or PARTIAL |
| Retry discipline | Deterministic document failures are recorded and never retried; only infrastructure failures spend attempts |
| Privacy of derived data | Counters in the database and in logs; body text, headings, comments, metadata values and filenames never logged or used as metric labels |

## 1e. Controls implemented in Phase 7

| Control | Implementation |
| --- | --- |
| User-scoped RLS | `document_checks`, `check_runs`, `check_rule_results`, `check_violations` and `check_reports` are USER_SCOPED on `owner_user_id`, `FORCE ROW LEVEL SECURITY`, with composite ownership keys binding every child to its parent's owner |
| Organization non-access | The publishing organization has no route to the document, check, findings, report, score or analysis, and nothing in its view of its own standard changes because a check happened; asserted from the standard owner's own session |
| Catalogue boundary | Six `SECURITY DEFINER` functions with fixed `search_path`, no dynamic SQL, explicit parameter types and minimal named output; `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE` to the request role only. No tenant policy is loosened to serve the catalogue |
| Deliberate exposure | `standards.check_availability` defaults to PRIVATE and no existing standard is changed by migration; publishing is its own endpoint behind its own organization-scoped permission, with a named actor in the audit log |
| No rule disclosure | The catalogue returns a rule *count* and never a rule: choosing a standard and reading its rulebook are different questions |
| Captured identities | Document version + SHA-256, standard version + content hash, analysis + artifact digest are write-once, enforced by a trigger the request role cannot drop |
| Fail closed on mismatch | The artifact digest and the snapshot content hash are re-verified before evaluation; either mismatch fails the check with an integrity code and writes no result |
| Contract validation both ways | The engine validates request and response against the shared schema; the orchestrator validates the response again, and the report against its own schema, before anything is stored |
| Outage is never a verdict | Engine, storage and unknown failures are transient and retried; a failed check carries no determination and no score at any layer |
| Append-only evidence | Rule results, violations and reports cannot be modified after they are written; a retry is a new run, never a rewrite |
| Report artifact isolation | Canonical bytes in the private derived bucket, served only through the authenticated API — no public URL, no presigned link, no raw object key in any response |
| Versioned canonicalization | Report hashing is RFC 8785 at a stored version, with a committed golden verified in CI, so a hash issued today still verifies later |
| Bounded responses | Violations are capped at three points and every cap is disclosed in the data and in words; results are paginated with a server-enforced maximum page size |
| Privacy in telemetry | Codes, counters and identifiers only — never document text, titles, filenames, rule text, user email or organization name, in logs or as metric labels |
| No AI in the path | No model of any kind participates in a Phase 7 verdict; `AI_ASSISTED` and `MANUAL` rules remain explicitly unresolved rather than being guessed at |

## 1f. Controls implemented in Phase 8

| Control | Implementation |
| --- | --- |
| Consent before external processing | No document content reaches a provider until its owner agrees; consent is per user, versioned (`AI_CONSENT_VERSION`), records `providerCategory` and `consentedAt`, and re-asks when the notice changes. An organization cannot grant it |
| External processing is disclosed, not hidden | The UI states what is sent, what is not, and that processing happens at an external provider — in both languages, before the button. PalCert does not promise Zero Data Retention it has no contract for |
| Data minimization | Never the file, the ZIP bytes or OOXML internals: a bounded normalized bundle of outline, selected paragraphs, bounded metadata and the findings already measured. Node, character, rule and token budgets are all enforced |
| Truncation is stated, never silent | When a bound bites, the model is told the evidence is incomplete and instructed to answer `INSUFFICIENT_EVIDENCE` rather than infer |
| No infrastructure in a prompt | No API keys, database or storage credentials, signed URLs, service tokens or session identifiers are ever placed in a context bundle or prompt |
| Prompt injection defence | Prompts are constants with no interpolation; untrusted document text and organization guidance are control-character-stripped, entity-escaped and confined to data sections of the *user* message; the system prompt states the boundary |
| No tools, no prefill, no sampling knobs | Phase 8 calls declare no tools and no `tool_choice`, use no assistant prefill, and set no `temperature`, `top_p` or `top_k` |
| Validated structured output | Schema-constrained output, then validated against the request: exactly the requested rules, once each, citing only nodes PalCert supplied. Fabricated evidence or an invented rule invalidates the response; rejections carry no model text |
| AI never decides compliance | Assessments are advisory and use their own vocabulary; a blocking AI-assisted rule records `requiresHumanReview = true` computed from the rule, enforced by the `ai_rule_assessments_blocking_requires_human` CHECK constraint |
| Deterministic evidence is untouchable | No Phase 8 code path writes to a Phase 7 table; `reportHash`, `evaluationHash`, determination, score and all finding rows are proven identical before and after a review |
| Manual rules are never sent | A `MANUAL` rule is excluded from every provider request: AI is not equivalent to manual review |
| Append-only AI output | Reviews, assessments, supplements and invocations are guarded by triggers; a re-run is a new review, never an overwrite |
| Independent hashing | The AI review is canonicalized and hashed on its own digest at a pinned version, never mixed with the Phase 7 report hash |
| Evidence integrity re-verified | Report hash, evaluation hash, document digest, standard content hash and the re-hashed analysis artifact are all checked before the provider is called; a mismatch fails closed |
| User-scoped RLS | `ai_consents`, `ai_reviews`, `ai_invocations`, `ai_rule_assessments` and `ai_report_supplements` are USER_SCOPED on `owner_user_id` under `FORCE ROW LEVEL SECURITY`, with composite ownership keys; another user's review id returns 404, never 403 |
| Organization non-access | An organization does not see a student's AI review merely because its standard was used |
| Provider secret containment | `ANTHROPIC_API_KEY` never appears in the frontend, a browser bundle, an API response, a queue payload, a log, an audit event, the database or an error response; logger redaction covers the key and the prompt/context/response fields, with a test asserting it |
| No raw prompts or responses stored | By default PalCert persists neither; hashes prove which normalized inputs were used without storing them |
| Bounded telemetry cardinality | Metric labels are provider, model, purpose and outcome only — never a document title, user email, rule text or excerpt |
| AI outage is not a platform outage | `/health/ready` deliberately does not probe the provider; there is no fallback to a second company |
| No general-purpose model endpoint | Every AI route names a PalCert task with a fixed prompt and a validated output schema |
| Fake provider refused in production | Configuration validation rejects `AI_PRIMARY_PROVIDER=fake` when `NODE_ENV=production` |
| CI needs no provider credential | Normal CI runs entirely on the fake provider with synthetic fixtures; no repository or customer document is ever sent |

## 1g. Controls implemented in Phase 9

| Control | Implementation |
| --- | --- |
| AI cannot publish a standard | No code path leads from a completed extraction to `PUBLISHED`; asserted in e2e, and `extraction_requires_draft_version` refuses to attach a source or run to a non-draft version |
| AI cannot create a rule | Every `StandardRule` Phase 9 produces goes through the Phase 3 `insertRule`, reachable only from the accept endpoint behind `standard:proposal:decide` |
| Kinds that must not be accepted carry nothing to accept | The `rule_proposals_kind_shape` CHECK forbids a rule definition on ambiguous, conflicting and unrepresentable proposals |
| Proposal content is immutable | `rule_proposals_guard` and `extraction_output_append_only` make evidence, observations and proposals append-only, so a decision cannot be manufactured by rewriting what the model said |
| Organization consent, separately authorized | `OrganizationAIConsent` is versioned, organization-scoped and requires `organization:ai-consent:manage`; `TEMPLATE_MANAGER` cannot grant it. Without it, upload and manual authoring still work — only extraction is blocked |
| Organization sources use the same ingestion path | Source uploads reuse `IngestPipeline` verbatim: signature detection, DOCX archive and macro safety, PDF structure, PalCert-computed SHA-256, malware scan as a gate, immutable promotion. No weaker organization path exists |
| Storage keys leak nothing | `organizations/{orgId}/standards/{versionId}/sources/{sourceId}/source` — no organization name, email, original filename or standard title |
| Sources are immutable and retention-aware | An uploaded source never changes; one an accepted rule cites is retention-locked and cannot be deleted, so published evidence cannot be destroyed |
| Evidence is provider-grounded, not model-asserted | Only citation data is persisted; a citation naming a source or range PalCert did not supply is discarded as ungrounded. The model's surrounding prose is never stored as if the guideline said it |
| No source document in Pass B | Rule structuring receives verified evidence and deterministic observations only, so it cannot hallucinate a source it was never given |
| Templates are measured, not guessed | The Phase 6 analyzer measures a template; no model is asked what formatting a document uses. Counts are reported, never a confidence value |
| No confidence numbers anywhere | No score, probability or percentage is produced, stored or displayed; the message catalogue spec fails if one appears |
| AI gets no validation bypass | Proposals are validated by the Phase 3 validator at the draft's schema version; a refused proposal is stored `INVALID` with its issues and shown unchanged |
| No AI-authored executable semantics | No regex, SQL, XPath, JavaScript, Python or expression DSL anywhere in the proposal schema; patterns are named PalCert matchers selected from a registry |
| Prompt injection defence | Source text is escaped into delimited data sections of the user message; the model has **no tools**, cannot create a rule and cannot publish. An e2e test runs an injection payload end to end and asserts nothing changed |
| No infrastructure reaches the provider | No credentials, storage keys, signed URLs, member data or audit rows in any prompt; no client-supplied provider `file_id` is ever accepted; the Files API is not used for guideline storage |
| No source content in logs, audits or queues | Excerpts, PDF contents, DOCX text, prompts and provider responses are never logged or persisted in audit rows, job payloads or the invocation ledger; a run's `failureDetail` is content-free and bounded |
| No cost invented from provider pricing | Token counts are recorded; a permanent USD cost is deliberately not computed from hard-coded pricing |
| Reviewer feedback stays inside PalCert | Rejection reasons and notes are never sent to the provider; no fine-tuning and no model training, stated in the UI before the reviewer types |
| Provenance does not alter standard identity | `StandardRuleProvenance` is metadata excluded from `contentHash`; an unaccepted proposal never affects it, asserted by test |
| Tenant-scoped RLS across eleven tables | Every Phase 9 table is `TENANT_SCOPED` on `organization_id` under `FORCE ROW LEVEL SECURITY`, registered in `table_isolation_classification`, with composite `(id, organization_id)` foreign keys |
| IDOR tested with real identifiers | The isolation suite attacks with a genuine source, run and proposal belonging to another organization and expects 404, never 403 — a 403 would confirm the id exists |
| Stale decisions are refused | Accepting carries the draft revision as `If-Match`; a reviewer working from a stale page is told rather than silently overwriting a colleague |
| CI needs no provider credential and no customer content | The corpus is synthetic and committed; the live smoke test is opt-in and skipped by default |

## 1h. Controls implemented in Phase 10

| Control | Implementation |
| --- | --- |
| No floating-point money | Every amount is a `bigint` count of minor units with an ISO 4217 code: `BIGINT` in PostgreSQL, a string in JSON. A unit test greps the money module for `/100`, `Math.`, `parseFloat`, `toFixed` and `Number(` and fails on any of them |
| One canonical currency registry | `CURRENCY_REGISTRY` in `@palcert/contracts` is the only place a currency's exponent is known; `currencyExponent` throws for an unknown code rather than assuming two |
| The balance cannot be edited | `credit_ledger_entries` is append-only: a trigger raises on `UPDATE` and `DELETE` from every role including the schema owner, and the application role's `UPDATE`/`DELETE` grants are explicitly revoked. A raw-SQL attempt is in the test suite |
| A correction is an entry, not an edit | Compensating entries carry `reversal_of_entry_id`; a trigger requires the opposite sign on the same account. Finance's power is to append, with a reason code and their user id |
| Ledger values cannot be nonsense | Database CHECKs enforce sign-matches-type, non-zero amounts, complete references, and `PAYMENT_REFUND_DEBIT` only against a `CASH` account |
| Concurrent spending cannot overspend | Every hold is created under `SELECT … FOR UPDATE` on the account row inside the caller's transaction; proven with 2-way and 10-way races against a balance that can fund fewer |
| The browser never credits a balance | Credit is applied only by a signature-verified provider event or PalCert's own re-query. The golden journey asserts the balance is still zero after the redirect and non-zero only after a verified event |
| Webhook signatures verified over raw bytes | The app is created with `rawBody: true`; the signature is checked against the exact unmodified body, and a bad signature is rejected, never warned about |
| Provider webhooks are exempt from browser CSRF, and only they | The CSRF guard skips routes marked `@ProviderSigned()`. A provider holds no cookie and sends no `Origin`; the signature is the authentication |
| A provider payload is never authoritative | Processing ignores the payload's amount and status, re-retrieves the payment, and compares amount, currency and client reference against the PalCert row. A mismatch parks the top-up in `RECONCILIATION_REQUIRED` and credits nothing |
| Exactly-once credit under at-least-once delivery | Three independent mechanisms: a ledger idempotency key, a conditional status update, and a trigger refusing to rebind a top-up's credit entry. Ten duplicate deliveries produce one credit |
| Only a real duplicate is treated as one | Webhook ingestion treats only Prisma `P2002` as "already seen"; any other failure is logged and re-thrown, so PalCert never acknowledges an event it failed to record |
| No cardholder data, anywhere | Payment details are collected on the provider's hosted page. No field exists for a card number, CVC, expiry, PIN or bank credential |
| Payment secrets are never logged | Signature headers, webhook secrets, raw provider payloads and customer payment details appear in no log, audit row or job payload; the checkout URL is returned once and never stored |
| Promotional credit cannot become cash | Structural, not procedural: an external refund reserves against a `CASH` account and a CHECK refuses `PAYMENT_REFUND_DEBIT` on any other class. Spending draws promotional credit first |
| A refund cannot be spent twice | Credit is reserved before the provider is called; capture on success, release on failure, and `INSUFFICIENT_BALANCE` rather than a negative balance on PalCert's initiative |
| No self-service card refund | External refunds require `finance:refund:create`; there is no customer endpoint |
| The client never sets a price | Amounts come from an `ACTIVE` `PriceVersion`, immutable once activated, one per (product, currency, market) by partial unique index, frozen for the customer in a short-lived immutable `PriceQuote` |
| Organizations have zero financial access | No organization-scoped role holds any `finance:`, `pricing:` or `balance:` permission — asserted by route tests and by a SQL query over the role/permission tables |
| Support cannot move money | `PALCERT_SUPPORT` holds `finance:payment:read` and no financial mutation permission at all |
| Financial tables are RLS-protected | Seven Phase 10 tables are `USER_SCOPED` and three `SYSTEM`, all registered in `table_isolation_classification` under `FORCE ROW LEVEL SECURITY` |
| Idempotency for money-moving operations | `Idempotency-Key` on top-up creation, derived idempotency keys on every state-changing provider call, and a unique idempotency key per ledger account |
| A provider outage is not an outage | `/health/ready` never probes the payment provider (asserted by test); `/health/payments` reports it separately, and existing credit stays spendable |
| A negative balance is disclosed, not hidden | A chargeback debit may take a balance below zero; no credit is fabricated to mask it and the customer is told the cause |
| The fake provider cannot reach production | The provider factory refuses `PAYMENT_PROVIDER=fake` in production, and the environment schema refuses a `STRIPE_BASE_URL` override there |

## 1i. Controls implemented in Phase 11

| Control | Implementation |
| --- | --- |
| No new check without a purchase | `document_checks_require_purchase` fires on INSERT and requires a purchase that belongs to the same person and names that very check. Attempted in the suite with the schema-owning connection and refused |
| Historical free checks stay readable, and stay historical | The trigger fires on new rows only; `document_checks_purchase_binding_immutable` refuses to add, remove or change a binding, so a paid check cannot be laundered into a free one nor a free one retro-fitted to look paid |
| The client never states a price | `POST /checks` takes a quote id. There is no field for an amount in the DTO, the client or the service |
| A quote funds at most one purchase | A uniqueness constraint on `price_quote_id`, plus an explicit `QUOTE_ALREADY_USED` for a usable message |
| A quote is never repriced | The amount is copied onto the purchase from the quote; a price change after the quote does not reach it |
| Nothing is charged before delivery | Capture happens only inside the transaction that persists the report and completes the check. Every pre-delivery failure path releases |
| Completion and capture cannot separate | One transaction: results, violations, report, run, every capture, purchase DELIVERED, check COMPLETED. A capture that cannot be made rolls the whole thing back |
| Settlement paths cannot race | Completion, failure and cancellation all take `SELECT … FOR UPDATE` on the check row and re-read its status inside the transaction. First writer decides; the others stop |
| The money and the service agree at commit | Deferred constraint triggers: a DELIVERED purchase has every allocation captured summing to its exact amount and a COMPLETED check; a COMPLETED paid check has a settled purchase; a RELEASED purchase has no capture and no service charge |
| Allocations must add up | A deferred trigger requires `SUM(allocations) = purchase.amount`, so a purchase funded by less than it costs is refused at COMMIT |
| A purchase's financial identity is write-once | `service_purchases_guard` refuses any change to owner, product, resource, quote, price version, currency or amount; allocations are refused every UPDATE |
| A purchase only moves forwards | The status machine is enforced in PostgreSQL; `RECONCILIATION_REQUIRED` is terminal, so a worker cannot quietly decide an escalated purchase is fine |
| A cross-person purchase is impossible | Composite foreign keys: a purchase cannot use another person's quote, an allocation cannot use another person's hold, a check cannot name another person's purchase |
| Concurrent purchases cannot overspend | Accounts are locked in `FUNDING_ORDER` inside the reserving transaction; two simultaneous checks against a one-check balance yield one 202 and one 402 |
| An expired reservation cannot be silently re-taken | Every hold is re-checked as ACTIVE before any is captured; a stale one fails the whole settlement rather than reserving against the customer's later balance |
| An expired reservation cannot produce a free report | The sweeper releases the holds and converges the purchase and the check to a terminal, non-billable state, so a late worker finds nothing to complete |
| A paid check is never retried in place | `CHECK_RETRY_REQUIRES_NEW_PURCHASE`. Re-reserving would either work for free or re-take against a balance the customer has since spent |
| Financial history is not deleted | `DELETE` is revoked from the application role on `service_purchases`, and `UPDATE`/`DELETE` on allocations |
| Purchases are user-scoped under forced RLS | Both tables are `USER_SCOPED` in `table_isolation_classification` with `FORCE ROW LEVEL SECURITY`; another customer's purchase is invisible to their connection, not merely filtered |
| Organizations have no financial visibility of a check | No organization-scoped role holds any `finance:`, `pricing:` or `balance:` permission; the standard's owner sees no price, no balance and no purchase, asserted by route tests and by a catalogue query |
| Support can read a purchase and move nothing | `finance:purchase:read` is read-only and separate from every mutation; support is refused adjustments and refunds |
| No internal financial identifier reaches a customer | The billing block carries the purchase id only — no hold, account, allocation or ledger id — asserted against the serialized response and against the OpenAPI document |
| The paid-check path never touches the payment provider | A check spends PalCert Balance only. Proven by completing a paid check with the provider set to unavailable and asserting no provider call was made |
| Billing never enters the canonical report | `CheckReportBuilder` is untouched, the Phase 7 golden hashes are unchanged, and the stored artifact is asserted to match no billing vocabulary |
| A negative balance is not a credit facility | A chargeback that takes the balance below zero refuses a new purchase; available credit below zero contributes nothing |

## 2. Controls scheduled by phase

| Control | Phase |
| --- | --- |
| Immutable audit log for sensitive operations | throughout, consolidated in 19 |
| Load, stress, outage, backup and restore testing | 20 |
| Accessibility and Arabic/RTL review | 20 |

## 3. File-handling policy (§37) — in force since Phase 5

Every uploaded file is untrusted. Before a file becomes a `READY` version:
extension validation, content-based type detection, size limits, archive
and ZIP-bomb protection, macro and embedded-object safety, malware scanning,
SHA-256 hashing, a generated storage name, isolated quarantine and clean
buckets, timeouts and resource limits. Embedded Office macros are never
executed; nothing inside a package is extracted to disk. Downloads are served
only for ready versions through signed, expiring URLs bound to an object
version. See [documents.md](../architecture/documents.md).

## 4. Privacy policy (§49)

Documents may contain confidential unpublished academic material.

- Minimize external data exposure; AI provider usage is configurable per
  deployment and documented per content type.
- Document contents and extracted text are never written to logs.
- Retention policies and document deletion are supported where policy allows,
  while immutable financial and audit records are retained separately.
- User documents are never exposed publicly and are never used for unrelated
  purposes. The public certificate verification page exposes verification
  metadata only, never the document.

## 5. Secret management

- No secret is ever committed. `.env.example` holds placeholders only.
- Production secrets come from the deployment secret manager, injected as
  environment variables and validated at boot.
- Secrets are never logged: the logger redacts them and `redactConfig()`
  produces log-safe configuration snapshots.
- CI uses throwaway values that are valid only against ephemeral service
  containers.

## 6. Reporting

Security issues should be reported privately to the PalCert maintainers before
any public disclosure.
