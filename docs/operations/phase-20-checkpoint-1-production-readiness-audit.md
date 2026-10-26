# Phase 20 · Checkpoint 1 — Production Readiness Audit

**Read-only.** Nothing in this checkpoint was implemented. Every claim below
carries a file, line or command that produced it, so the remediation work in
20.2 onward starts from evidence rather than from opinion.

Audited at Phase 19's frozen commit `1e2e93c`.

---

## 1. Component inventory

### Runtime processes PalCert requires

| Component | Artifact | Port | Public? | Notes |
|---|---|---|---|---|
| Web application | `docker/web.Dockerfile`, Next.js 15 | 3000 | **Yes** | The only HTML origin |
| API | `docker/api.Dockerfile`, NestJS 11, `dist/main.js` | 4000 | **Yes** | REST + the Phase 19 integration API |
| Worker | **No image exists** — same code, `dist/worker-main.js` | 4100 | No | See F-012 |
| Document engine | `docker/document-engine.Dockerfile`, FastAPI/uvicorn | 8000 | No | DOCX + PDF analysis, SmartFix mutation |
| PostgreSQL 17 | `postgres:17-alpine` | 5432 | No | System of record; RLS is a primary control |
| Redis 7 | `redis:7-alpine` | 6379 | No | BullMQ transport, auth + API-client throttles, caches |
| Object storage | MinIO locally; S3-compatible in production | 9000 | No | Three buckets: clean, quarantine, derived |
| Malware scanner | `clamav/clamav:1.4` | 3310 | No | Every upload is scanned before it leaves quarantine |

The API and the worker are the same build. `apps/api/src/worker-main.ts` boots
`WorkerModule` and exposes health probes only (ADR-0001).

### External dependencies

| Dependency | Required for | Degrades to |
|---|---|---|
| Stripe | Adding credit | `/health/payments` reports unavailable; balances stay spendable |
| Anthropic API | AI review, rule extraction | `/health/ai` reports unavailable; deterministic checks unaffected |
| SMTP relay | Workflow mail | Delivery rows record the failure; in-app inbox still works |
| Customer webhook receivers | Outbound events | Retry with backoff, then terminal |
| DNS / TLS / CDN / reverse proxy | Public reachability | **Not yet chosen** — see §5 |

Both third-party product dependencies are already isolated behind their own
health endpoints that deliberately do **not** feed readiness
(`apps/api/src/health/health.service.ts:32-48`). That is the right call and it
is already made.

### Dependency graph

```
                      Internet
                          │
                 ┌────────┴────────┐
                 │  reverse proxy  │   ← NOT YET SPECIFIED (F-013)
                 │   / LB / TLS    │
                 └────┬───────┬────┘
                      │       │
                ┌─────▼──┐ ┌──▼─────┐
                │  web   │ │  API   │──────────────┐
                │ :3000  │ │ :4000  │              │
                └────┬───┘ └──┬──┬──┘              │
                     └────────┘  │                 │
                                 │                 │ publish
        ┌───────────────┬────────┼─────────┐       │
        │               │        │         │       │
   ┌────▼────┐   ┌──────▼──┐ ┌───▼────┐ ┌──▼────┐  │
   │Postgres │   │  Redis  │ │ object │ │ClamAV │  │
   │  :5432  │   │  :6379  │ │storage │ │ :3310 │  │
   └────▲────┘   └────▲────┘ └───▲────┘ └───▲───┘  │
        │             │          │          │      │
        │        ┌────┴──────────┴──────────┴──┐   │
        └────────┤        worker :4100         ◄───┘
                 └──────────────┬──────────────┘
                                │
                        ┌───────▼────────┐
                        │ document engine│
                        │     :8000      │
                        └────────────────┘

   API  → Stripe, Anthropic, SMTP           (outbound, optional)
   worker → customer webhook receivers      (outbound, SSRF-guarded)
```

---

## 2. Environment and configuration inventory

Four environments are in use: **local** (`.env` from `.env.example`, compose
infrastructure), **test/e2e** (`apps/api/test/support/test-environment.ts`),
**staging** and **production** — the last two exist as a validated
configuration contract but have no deployment substrate yet (§5).

`packages/config/src/env.schema.ts` (1050 lines) is a single Zod schema and it
is the strongest thing in this audit. It carries **~130 variables** and, more
importantly, a `NODE_ENV === 'production'` block that refuses to boot on:

the fake payment provider · the fake AI provider · the fake email provider ·
the fake malware scanner · a Stripe base-URL override · API docs enabled ·
pretty logging · a wildcard CORS origin · Argon2 memory below 19456 KiB ·
Argon2 time cost below 2 · a password minimum below 12 · `SameSite=None` ·
least-privilege database checks disabled · **the request-path connection equal
to the schema-owning connection** · unencrypted object storage · clean,
quarantine and derived sharing a bucket · a non-HTTPS storage endpoint · a
non-HTTPS public web URL · an idle timeout exceeding the absolute one.

Cross-field guards also require Stripe credentials when payments are on, an
SMTP host and sender when the provider is SMTP, an Anthropic key when AI is on,
and the webhook keyring's two halves together with the active kid present in
the ring.

**Classification of every variable** (counts from the schema):

| Class | Count | Examples |
|---|---|---|
| Public configuration | ~12 | `APP_NAME`, `NEXT_PUBLIC_*`, `PALCERT_DEFAULT_CURRENCY` |
| Environment-specific | ~95 | every timeout, bound, limit, TTL, URL, feature flag |
| Secret | 6 | `AUTH_SESSION_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NOTIFICATION_SMTP_PASSWORD`, `STORAGE_SECRET_ACCESS_KEY`, database URLs (embedded passwords) |
| Cryptographic key | 5 | `AUTH_MFA_SECRET_KEY`, `CERTIFICATE_VERIFICATION_SECRET_KEY`, `API_CLIENT_REVEAL_SECRET_KEY`, `WEBHOOK_ENCRYPTION_KEYS`, `STORAGE_KMS_KEY_ID` |
| External-service credential | 3 | `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, SMTP user/password |

**No secret is committed.** `.env` is gitignored (`.gitignore:28-29`) and
untracked; `.env.example` carries placeholders only, and its four base64 key
variables are *empty*, so a copied example fails validation rather than booting
with a known key. gitleaks runs in CI (`.github/workflows/ci.yml:325`).

Findings: **F-002**, **F-003** below.

---

## 3. Secrets and cryptographic material

| Material | Generation | At rest | Rotation | Revocation | Incident replacement |
|---|---|---|---|---|---|
| User password | User-chosen | Argon2id verifier | User-initiated | Session invalidation on change | Forced reset — **no bulk mechanism** |
| Session token | 128-bit random | SHA-256 hash | N/A | Per-session + logout-all | **No bulk invalidation** (F-014) |
| MFA secret | Server random | Sealed with `AUTH_MFA_SECRET_KEY` | **None** | Per-authenticator delete | Key change invalidates every enrolment |
| Certificate verification code | Server random | SHA-256 only, Phase 15 | N/A | Certificate revocation | Cannot be reissued — by design |
| API-client secret | 32 random bytes | Argon2id verifier | **Modelled and tested** (≤12 h overlap) | Immediate, final | Per-client, self-service |
| Webhook signing secret | Server random | Sealed under the keyring | Supported + rewrap worker | Endpoint disable | Keyring rotation supported |
| Webhook keyring | Operator-provided | Environment only | Kid-based, rewrap worker exists | N/A | Add kid, rewrap, retire |
| Stripe / Anthropic / SMTP | Provider | Environment only | Provider console | Provider console | **Undocumented** |
| Storage credentials | Provider | Environment only | Provider console | Provider console | **Undocumented** |

The Phase 17 keyring and the Phase 19 rotation overlap are the two mature
lifecycles. Everything above them is "set it in the environment", which is
acceptable for v1 only once written down — there is currently **no runbook for
replacing any secret under incident conditions**.

Finding: **F-015**.

---

## 4. Database readiness

62 migrations, replayed clean into an empty database during Phase 19 closure.
**88 tables**, of which **64 have RLS enabled and FORCED**.

| Classification | Tables |
|---|---|
| `USER_SCOPED` | 35 |
| `TENANT_SCOPED` | 24 |
| `SYSTEM` | 20 |
| `DUAL_PARTY_SCOPED` | 6 |
| `GLOBAL` | 3 |

The 24 tables without RLS are the 3 `GLOBAL` reference tables, 15 `SYSTEM`
tables reached only through explicit writer flags, and 6 authentication tables
(`users`, `sessions`, `mfa_authenticators`, `mfa_recovery_codes`,
`email_verification_tokens`, `password_reset_tokens`). That last group is a
**recorded Phase 2 decision**, asserted in
`apps/api/test/tenant-rls-coverage.e2e-spec.ts:127-134`: a `USER_SCOPED` table
with no isolation column is guarded by application authorization, because
authentication must read these rows before a principal exists. It is a
defence-in-depth gap worth stating, not a defect.

**Index coverage is access-path shaped and good.** `processing_jobs` carries
`(status, available_at)`; `domain_events` carries a partial
`WHERE webhook_eligible`; `user_notifications` carries a partial
`WHERE read_at IS NULL`; `webhook_deliveries` carries a partial unsettled index.
61 single-column foreign keys lack a supporting index, but they are
overwhelmingly `*_by_user_id` provenance columns that nothing filters on.
**Recommendation: do not blanket-index them.** The residual risk is
foreign-key enforcement scanning children on a parent `DELETE`, and the parents
concerned have no delete path.

**Growth tables, and what retention exists today:**

| Table | Grows with | Retention today |
|---|---|---|
| `processing_jobs` | every job ever run | **none** |
| `domain_events` | every state change | **none** |
| `audit_events` | every privileged act | **none** (correctly retained, but unmanaged) |
| `security_events` | every auth anomaly | **none** |
| `notification_deliveries` / `_attempts` | every notification | **none** |
| `user_notifications` | every recipient copy | **none** |
| `webhook_deliveries` / `_attempts` | deliveries × endpoints | **none** |
| `api_client_operations` | credential management | **none** |
| `credit_ledger_entries` | every money movement | **none** (must be retained) |
| `document_versions` | uploads | bytes purged; **rows retained** |

Finding: **F-004**. **No partitioning is recommended yet** — there is no
production data to size against, and partitioning a table that turns out to
hold 50k rows would be cost without benefit. 20.x should measure first.

---

## 5. Storage readiness

Keys are structured and owner-prefixed
(`apps/api/src/infrastructure/storage/storage-keys.ts`):
`users/{ownerUserId}/documents/{documentId}/versions/{versionId}/source`,
`organizations/{organizationId}/submissions/…`,
`organizations/{organizationId}/certificates/{id}/certificate.pdf`. Uploads land
under a `staging/` prefix with a nonce and move only after scanning.

Confirmed good: three separate buckets enforced in production; server-side
encryption required in production; TLS required to the endpoint; presigned URLs
with a bounded TTL; SHA-256 checksums recorded per version; a purge worker that
respects retention locks and refuses to strip bytes a check, report, certificate
or submission still needs.

**No document requires container-local storage for durability** — every artifact
path writes to object storage, and the containers declare no volumes.

Gaps: no documented object-storage backup or cross-region replication; no
lifecycle policy; no orphan-object reconciliation (an object whose row vanished
is never noticed). See **F-016**.

---

## 6. Worker and job readiness

The job model is the second-strongest thing in this audit and needs no work:

| Property | Mechanism |
|---|---|
| Ownership | `FOR UPDATE SKIP LOCKED` claim (`processing-job.service.ts:226`) |
| Lease | `lease_expires_at`, extended by heartbeat |
| Crash recovery | Lease-lapse sweep resurrects `DISPATCHED`/`RUNNING` (`:270`) |
| Retry ceiling | `max_attempts`, then the `DEAD` terminal state (`:289`) |
| One retry policy | BullMQ `attempts: 1` so the database owns it |
| Duplicate execution | `idempotency_key` unique; BullMQ job id `{ledgerId}-{attempt}` |
| Graceful shutdown | Workers closed then queue closed (`processing-queue.ts:111`); `enableShutdownHooks()` |

Work inventoried: document analysis, check preparation, check evaluation, AI
review, rule extraction, source ingest, SmartFix, submission preparation,
certificate issuance, notification fan-out, notification email send, webhook
delivery, payment reconciliation, purge; plus three sweepers (finance,
notification, webhook).

The one gap is not in the model but around it: **nothing announces a `DEAD`
job.** The terminal state exists, is reached correctly, and is invisible.
That is part of **F-005**.

---

## 7. Network and service exposure

Target topology — and the compose file is **development-only**, publishing
every dependency on localhost, which is correct there and must not be copied:

| Tier | Components |
|---|---|
| Internet | reverse proxy / load balancer, terminating TLS |
| Public application | web :3000, API :4000 |
| Internal only | worker :4100, document engine :8000, PostgreSQL, Redis, object storage, ClamAV |

Nothing in the repository specifies the proxy, the TLS termination point, the
network segmentation or the ingress rules. See **F-013**.

---

## 8. Health and readiness model

| Probe | Proves | Does not prove |
|---|---|---|
| `GET /health/live` (API) | Process alive; touches nothing | — |
| `GET /health/ready` (API) | PostgreSQL, Redis, object storage reachable | **Migration compatibility**; document engine; scanner |
| `GET /health/live` (worker) | Process alive | — |
| `GET /health/ready` (worker) | Redis, storage, scanner | **Document engine — probed and then discarded (F-001)** |
| `GET /api/v1/health/ai` | AI availability; never affects readiness | — |
| `GET /api/v1/health/payments` | Payment availability; never affects readiness | — |

Liveness and readiness are properly separated, and optional third parties are
correctly excluded from readiness. Two real gaps: **F-001** (the worker's
engine probe is computed and dropped) and **F-017** (nothing verifies that the
running code and the database schema agree, so a half-deployed release serves
traffic against a schema it does not match).

---

## 9. Observability

Present: structured pino JSON to stdout; a request id taken from `x-request-id`
or generated and echoed back; a well-developed redaction path list covering
passwords, tokens, presigned URLs, AI prompts and responses, verification codes
and — as of Phase 19 — API-client secrets; log levels that escalate with status
and demote health polling.

Absent: **everything else.** No metrics endpoint, no metrics library, no
tracing, no dashboards, no alert hooks. See **F-005**.

**Minimum production signals Phase 20 must deliver** (requirements, not a
vendor choice — that decision belongs to 20.3):

| Signal | Source | Why it is minimum |
|---|---|---|
| API request rate, error rate, p95/p99 latency | HTTP layer | The only view of user-visible health |
| Web availability | Proxy or synthetic | The web image has no health route (F-008) |
| PostgreSQL connections vs `DATABASE_POOL_MAX`, slow queries | Database | Pool exhaustion is the classic first outage |
| Redis availability and memory | Redis | Queue transport and every throttle |
| Queue depth by status | `processing_jobs` | Backlog is invisible today |
| Oldest `PENDING`/`RETRY_PENDING` job age | `processing_jobs` | Depth alone hides a stuck single job |
| `DEAD` job count and rate | `processing_jobs` | Terminal failures are silent today |
| Analyzer failure rate | `document_analyses` | Distinguishes an engine outage from bad input |
| Payment failures and reconciliation backlog | `payment_events` | Money |
| Webhook delivery failure rate and retry backlog | `webhook_deliveries` | Customer-visible integration health |
| Notification backlog and skip reasons | `notification_deliveries` | Silent mail failure is worse than loud |
| Certificate issuance failures | `compliance_certificates` | The product's final output |
| Storage error rate | Storage adapter | Upload and download both depend on it |
| Authentication anomalies, throttle trips | `security_events` | Attack visibility |

---

## 10. Backup, restore and disaster recovery

**There is no backup mechanism in the repository.** No `pg_dump`, no
`pg_basebackup`, no WAL archiving, no wal-g or barman configuration, no
object-storage replication, no restore script, and no test that a restore
produces a working system. The only persistence is named Docker volumes in a
development compose file.

What must be backed up:

| Asset | Contains | Loss means |
|---|---|---|
| PostgreSQL | Everything transactional: ledger, certificates, audit, submissions | Total loss of the product |
| Object storage — clean bucket | Source documents | Users' theses |
| Object storage — derived bucket | Analyses, reports, claims, certificate PDFs | Regenerable *only if* sources survive |
| Object storage — quarantine | Unscanned/infected uploads | Acceptable to lose |
| Webhook keyring | Decrypts every stored webhook URL | Every endpoint becomes unreadable |
| `AUTH_MFA_SECRET_KEY` | Decrypts every MFA enrolment | Every user locked out of MFA |
| `CERTIFICATE_VERIFICATION_SECRET_KEY` | Certificate verification capability | Public verification breaks |

**Proposed DR targets** — derived from the architecture, with the business
decisions marked:

| Target | Proposed | Basis |
|---|---|---|
| RPO | **≤ 5 minutes** | Continuous WAL archiving is standard for managed Postgres; the ledger makes larger loss unacceptable |
| RTO | **≤ 4 hours** | Restore + migrate + smoke, single region, no warm standby |
| DB backup frequency | Continuous WAL + daily base | Standard |
| DB retention | **30 days** — ⚠️ **owner decision**: any legal/regulatory floor overrides | Not derivable from architecture |
| Object retention | Versioning + **30 day** soft delete — ⚠️ **owner decision** | Not derivable from architecture |
| Off-site | Second region, same provider | Minimum credible |
| Restore ownership | ⚠️ **owner decision** — no operations team is defined | Organisational |

Recovery sequence: provision infrastructure → restore PostgreSQL to a point in
time → restore object storage → reinstate secrets and keyrings → run
`prisma migrate deploy` (a no-op on a current restore) → start API → verify
readiness → start workers → verify queue drains → smoke test.

**Phase 20 must perform this restore, not assert it.**

---

## 11. Security findings

Demonstrated strengths, verified in this audit rather than assumed: four-layer
tenancy with FORCEd RLS; separate least-privileged request role, refused in
production if it equals the owner role; Argon2id with production floors;
opaque, hashed session and CSRF tokens; a machine principal with no `userId`;
a strict production config guard set; SSRF defences generated from committed
IANA registries; three-bucket storage separation with mandatory encryption; and
a redaction path list that already covers Phase 19's secrets.

Findings this audit raises: **F-003** (self-targeting webhook defence off by
default), **F-006** (devDependencies in the web production image), **F-007** (no
CSP or HSTS on the web origin), **F-009** (per-process rate limiting).

Dependency scan evidence: `pnpm audit` reports **2 moderate** advisories, both
vitest (GHSA-82fw-gwwq-j7x9), no high or critical. `pip-audit` over the
document engine's 74 packages reports **no known vulnerabilities**. There is no
licence scan and no container image scan in CI.

---

## 12. Privacy and retention

Personal data held: account identity (email, name, locale), password and MFA
material, session and IP metadata in `security_events`, uploaded documents and
their extracted text, check results and reports, submissions and reviewer
comments, certificates, and payment references (never card data — Stripe holds
it).

Verified separations: an institution sees a user's check **only** through a
submission the user made (Phase 14 `DUAL_PARTY_SCOPED`); an API client sees no
personal information at all and machine reads carry an empty user id so RLS
matches only the organization branch (Phase 19); logs carry no document content,
no AI prompt or response, no presigned URL, no verification code and no
credential.

Gaps: no data-subject export or deletion path; document *rows* survive byte
purge with no stated lifetime; `security_events` retains IP addresses
indefinitely. ⚠️ **Owner decisions**: applicable regime (Palestinian law? GDPR
for EU students?), retention periods, and whether a right-to-erasure obligation
exists. These are recorded as policy items, separate from the technical
finding **F-004**.

---

## 13. Performance and load plan

No load test has ever been run and **no capacity target is claimed here**,
because one invented without a workload is worse than none.

Proposed baseline workload for a first institutional deployment — ⚠️ **every
number needs owner confirmation**:

| Scenario | Assumed baseline | Peak driver |
|---|---|---|
| Interactive web users | 200 concurrent | Submission deadline |
| Document uploads | 20/min sustained, 100/min peak | Deadline day |
| Concurrent DOCX analyses | 20 | Upload burst |
| Concurrent PDF analyses | 10 | PDF is the heavier path |
| Concurrent checks | 30 | Follows uploads |
| SmartFix requests | 5 concurrent | Bounded by mutation cost |
| Institution reviewers | 30 concurrent | Review sessions |
| Public certificate verification | 50/min, spiky | Employer verification |
| Webhook deliveries | 500/min burst | Bulk decisions |
| API clients | 10 clients, 600 req/min each (the Phase 19 ceiling) | Nightly sync |

The load plan for 20.6: drive each scenario against a staging environment with
representative data volume; measure API p95/p99, queue depth and oldest job
age, analyzer duration distribution, database connection saturation and storage
throughput; identify the first saturation point; only then decide whether to
tune. **20.1 designs this plan and tunes nothing.**

---

## 14. Deployment and rollback

Current state: three Dockerfiles, a development compose file, and a CI workflow
that tests but never builds or publishes an image. There is **no deployment
mechanism at all**.

| Requirement | State |
|---|---|
| Immutable builds | Dockerfiles exist; nothing builds or tags them |
| Version identification | `APP_VERSION` is a hand-set env var, not the commit |
| Worker image | **Missing** (F-012) |
| Migration ordering | `prisma migrate deploy` exists; no pre/post ordering defined |
| Rolling vs recreate | Undefined |
| Worker/API compatibility across versions | Undefined |
| Rollback | Undefined |
| Irreversible migrations | Unidentified |
| Post-deploy verification | Undefined |

The rollback plan Phase 20 must produce has to separate: **application
rollback** (redeploy the previous image — safe when the schema is compatible);
**database rollback** (restore to a point in time — loses committed work, last
resort); and **forward-fix-only migrations** (a destructive migration cannot be
un-run; the old image must be able to run against the new schema, or the
release is one-way and must say so). Prisma generates no down-migrations, so
every migration in this repository is forward-fix-only unless proven otherwise.

---

## 15. External-service production requirements

Not switched on in this checkpoint — recorded for 20.8:

| Service | Needed |
|---|---|
| Stripe | Live keys, live webhook endpoint + signing secret, business verification |
| Email | Production relay, SPF, DKIM, DMARC, a warmed sending domain |
| Object storage | Production bucket set, IAM scoped to those buckets, SSE key, versioning |
| Webhook targets | Customer-side; PalCert must publish its egress addresses |
| DNS | Apex + API + verification hostnames |
| TLS | Certificates and automated renewal |
| ClamAV | A signature update path that does not depend on image rebuilds |

---

## 16. Frontend release audit

Confirmed good: EN/AR with a full parallel catalogue and per-locale tests; `dir`
set from the locale at the layout level; loading, empty and permission states
handled per screen; a translated error map on every API failure; no secret in
any client-side store.

Findings: **F-010** (no error boundaries; the only `not-found.tsx` sits outside
the locale segment, so it cannot be translated or RTL), **F-011** (no
accessibility linting), **F-008** (no health route or HEALTHCHECK on the web
image). Responsive layout and browser support have not been measured — 20.7
should, against a stated browser matrix. **No redesign is proposed.**

---

## 17. Readiness ledger

### RELEASE BLOCKER

**F-005 — No metrics, no tracing, no alert hooks** — **CLOSED in Checkpoint
20.3** (see
[the observability and alerting report](phase-20-checkpoint-3-observability-and-alerting-report.md)).
Distributed tracing was deliberately deferred to post-v1 as **P-004**; the
correlation model answers the operational question without it.
*Evidence:* no prom-client/OpenTelemetry/statsd/Sentry dependency in any
manifest; no `/metrics` route in `apps/api/src`.
*Component:* API, worker, web.
*Impact:* queue depth, job age, `DEAD` job count, analyzer failures, payment
failures, webhook failures and notification backlog are observable only by
querying the database by hand. Nothing can be alerted on. The `DEAD` terminal
state is reached correctly and announced to nobody.
*Remediation:* a `/metrics` endpoint on API and worker; gauges backed by the
`processing_jobs` ledger; counters on the paths in §9; documented alert
thresholds. Vendor choice deferred to 20.3.
*Tests:* metrics endpoint contract test; a test asserting a `DEAD` job moves
its gauge.

**F-018 — No backup, no restore, no disaster recovery** — **CLOSED in
Checkpoint 20.4** (see
[the backup, restore and disaster-recovery report](phase-20-checkpoint-4-backup-restore-and-disaster-recovery-report.md)).
Closed with scheduled logical backups and a proved restore, **not** with
point-in-time recovery: continuous WAL archiving remains post-v1 as **P-011**,
and the RPO is honest about being the backup interval.
*Evidence:* no `pg_dump`, `pg_basebackup`, WAL archiving, replication or
restore tooling anywhere in the repository.
*Component:* PostgreSQL, object storage, key material.
*Impact:* total, unrecoverable data loss on a single failure. Every certificate,
ledger entry and document.
*Remediation:* continuous WAL archiving plus daily base backups; object-storage
versioning and replication; a documented recovery sequence; key-material
custody.
*Tests:* **a restore into a clean environment that then passes a smoke test** —
Phase 20 closure requires the restore to be performed, not asserted.

**F-013 — No deployment substrate, topology or rollback procedure**
*Evidence:* `infra/` is empty; CI has no build, publish or deploy stage;
`docker/docker-compose.yml` is development-only and publishes every dependency
on localhost.
*Component:* all.
*Impact:* PalCert cannot be deployed at all, and there is no defined way back
from a bad release.
*Remediation:* production compose or equivalent; a reverse proxy with TLS;
network segmentation keeping the database, worker and document engine internal;
image build and tagging in CI; the three-way rollback plan in §14.
*Tests:* clean-install gate; upgrade-from-Phase-19 gate; rollback rehearsal.

### HIGH

**F-001 — Worker readiness computes the document-engine probe and discards it**
*Evidence:* `apps/api/src/worker/worker-health.controller.ts:44-52` —
`Promise.all` builds four probes, the destructuring binds three, and
`this.build([redis, storage, scanner])` drops `document-analysis`. The comment
directly above states the engine is meant to be part of readiness.
*Component:* worker.
*Impact:* a worker whose document engine is unreachable answers 200 READY,
stays in rotation and claims analysis jobs it cannot finish. Retries prevent
data loss; the readiness gate is defeated.
*Remediation:* include the fourth probe in the aggregate.
*Tests:* a worker-readiness test with the engine unavailable asserting 503.

**F-012 — No worker image and no documented worker entrypoint**
*Evidence:* `docker/` contains api, web and document-engine Dockerfiles only;
`apps/api/src/worker-main.ts` exists and nothing builds or runs it in a
container.
*Component:* worker. *Impact:* the worker cannot be deployed; every
asynchronous capability — analysis, checks, certificates, notifications,
webhooks, payments — would simply not run.
*Remediation:* reuse the API image with `CMD ["node","dist/worker-main.js"]`
and its own HEALTHCHECK against :4100, or a dedicated Dockerfile.
*Tests:* container start test; readiness probe reachable.

**F-004 — No retention or pruning for any append-only operational table**
*Evidence:* `deleteMany` across `apps/api/src` reaches only MFA material and
user roles; `purge-job.handler.ts` purges document *bytes* and no operational
rows; no `processingJob.delete` or equivalent anywhere.
*Component:* PostgreSQL. *Impact:* unbounded growth in twelve tables.
`processing_jobs` is the sharpest: it grows forever *and* sits on the hot claim
path, so the claim index bloats with terminal rows.
*Remediation:* a stated retention position per table — prune, archive or retain
deliberately (the ledger and audit events must be retained); a bounded pruning
job for the operational ones. **Measure before partitioning anything.**
*Tests:* pruning respects the retention boundary; evidence tables are never
pruned.

**F-006 — The web production image ships devDependencies**
*Evidence:* `docker/web.Dockerfile` builds with `pnpm install --frozen-lockfile`
(no `--prod`, no `pnpm deploy`) and the runtime stage copies the whole
`/app/node_modules`. `docker/api.Dockerfile` does it correctly.
*Component:* web. *Impact:* vitest, testing-library, eslint and the Prisma CLI
ship in the public web image; the two moderate vitest advisories become
shipped rather than dev-only.
*Remediation:* `pnpm deploy --filter @palcert/web --prod`, or Next standalone
output.
*Tests:* image-content assertion that no devDependency is present.

**F-007 — No Content-Security-Policy or HSTS on the web origin** — **CLOSED in
Checkpoint 20.7**
*Evidence:* `apps/web/next.config.mjs` set four headers, neither of them CSP
nor HSTS. The API set both (`bootstrap.ts`), but the API serves JSON.
*Component:* web. *Impact:* no defence-in-depth against XSS on the only HTML
origin — one that renders user-supplied document metadata and runs payment
flows. Not a demonstrated vulnerability.
*Remediation:* both shipped in 20.7. The policy starts every directive at
`'none'` and opens only what the application demonstrably loads; HSTS is
production-only, `max-age=31536000; includeSubDomains`.
*Tests:* headers measured on real responses through the release proxy, and the
built application loaded in Chromium across five route shapes with zero CSP
violations.
*Not nonce-based, deliberately.* A nonce policy was built first and measured:
the two dynamic routes were flawless and all twenty-three prerendered routes
refused every one of their own scripts, because a per-request nonce cannot
reach HTML generated at build time. `script-src 'unsafe-inline'` is the
accepted v1 position — recorded as **P-015**, with the escalation paths out of
an injection (`object-src`, `base-uri`, `frame-ancestors`, `form-action`,
`connect-src`) all still closed.

**F-009 — The global HTTP rate limit is per-process** — **CLOSED in
Checkpoint 20.6**
*Evidence:* `apps/api/src/app.module.ts:50-56` configured `ThrottlerModule`
with no `storage`, so v6 used in-memory storage.
*Component:* API. *Impact:* with N replicas the real budget was N × the
configured limit. Authentication throttling and API-client throttling were
**not** affected — both count in Redis.
*Remediation:* a Redis throttler storage — `RedisThrottlerStorage`, wired in
Checkpoint 20.2.
*Tests:* the test this entry named — *two API instances sharing one budget* —
was run in Checkpoint 20.6, under load, in `perf/safety-under-load.sh`. Two
API replicas started from the deployed image with the shipped limit of 120 per
60 s; one simulated client, 200 requests alternating between them: **120
admitted, 80 refused.** A per-process counter would have admitted about 240.
The separate per-IP verification guard was measured the same way and admitted
**60 of 90**. The fix landed in 20.2; the finding is closed here because until
now nothing had demonstrated it.

**F-003 — `WEBHOOK_OWN_HOSTS` defaults to empty in production** — **CLOSED in
Checkpoint 20.7, as a stale finding**
*Re-examined in 20.7: the own-host list is not the variable.* `webhookOwnHosts`
derives PalCert's own public hostname from `APP_PUBLIC_WEB_URL` — which
production requires to be https — and unions it with whatever the variable
adds. An empty variable therefore never meant "nothing is refused"; the
public host has always been refused as a webhook destination. Two tests in
`api-config.service.spec.ts` now assert that, so the property cannot regress
back into the shape this finding described. The original text follows.

**F-003 — `WEBHOOK_OWN_HOSTS` defaults to empty in production**
*Evidence:* `packages/config/src/env.schema.ts:609`; no production guard
requires it. The field's own comment explains why self-targeting must be
refused.
*Component:* webhook delivery. *Impact:* by default, nothing stops an
organization pointing a webhook at PalCert's own public hostnames. The other
SSRF branches (private ranges, IANA special-purpose) still hold.
*Remediation:* require it in production, or derive it from
`APP_PUBLIC_WEB_URL` and the API host.
*Tests:* production config rejecting an empty value; a delivery attempt at
PalCert's own host refused.

**F-017 — Readiness does not prove schema compatibility**
*Evidence:* `health.service.ts:41-48` checks reachability only; nothing
compares applied migrations to the migrations the running build expects.
*Component:* API, worker. *Impact:* during a rolling deploy an instance serves
traffic against a schema it does not match, producing errors that look like
application bugs.
*Remediation:* a readiness indicator comparing `_prisma_migrations` to the
build's expected head.
*Tests:* readiness fails against a deliberately stale database.

### MEDIUM

**F-002** — `AUTH_SESSION_SECRET` is required by config and read by no runtime
code (sessions are opaque random tokens hashed with SHA-256). Misleading
operational surface; not a vulnerability. Remove it or wire it.
**F-008** — The web image has no HEALTHCHECK and Next exposes no health route.
**F-010** *(reassessed in 20.7: a resilience and UX finding, not a security
one; it is out of this checkpoint's scope and stays POST-V1)* — No React error
boundaries; the only `not-found.tsx` is outside the
`[locale]` segment and so cannot be translated or RTL.
**F-011** — No accessibility linting or automated a11y check. *(Reassessed in
20.7: an accessibility finding, not a security one; stays POST-V1.)*
**F-014** — No bulk session invalidation. Under credential-compromise incident
conditions there is no "sign everybody out".
**F-015** — No incident runbook for replacing any secret.
**F-016** — No object-storage lifecycle policy and no orphan-object
reconciliation; an object whose row vanished is never noticed.
**F-019** — `APP_VERSION` is a hand-set environment variable rather than the
build commit, so a running instance cannot reliably say what it is.
**F-020** — No licence scan and no container image scan in CI. **Part-closed
in Checkpoint 20.5 and re-verified in 20.7:** the release workflow scans every
runtime image for vulnerabilities (`scan-images.sh`, fixable HIGH/CRITICAL
fail the release), generates an SBOM per image, and scans images for secrets
with a planted-secret negative self-test. **A licence scan is still absent**
and remains POST-V1.

### POST-V1

**P-001** — Partitioning or time-series storage for the highest-volume tables,
*if and only if* 20.6 measurement shows it is needed.
*Answered in Checkpoint 20.6: not yet needed.* At every offered load up to the
collapse point, PostgreSQL sat at 42% CPU with one active connection while the
API process was pinned at 124% — the bottleneck is application CPU, not the
database, and no query was slow enough to optimise. No index was added and no
table partitioned, because nothing measured justified either. This stays
POST-V1 and should be re-asked against production data volumes rather than
against a two-document fixture.
**P-002** — Row-level security on the six authentication tables, as
defence-in-depth behind the Phase 2 application-authorization decision.
**P-003** — Multi-region or active-active deployment.
**P-004** — Distributed tracing across API → worker → document engine.
*Reaffirmed in Checkpoint 20.3.* Full OpenTelemetry tracing would be a
telemetry-platform migration: a new dependency in four runtimes, a collector to
operate, sampling to tune and context propagation through BullMQ and Prisma.
The 20.3 correlation model answers the operational question from identifiers
that already existed, and the Prometheus exposition format is the
OpenTelemetry Collector's native input, so adoption later costs no application
change.
**P-005** — Data-subject export and erasure tooling, once the applicable
regulatory regime is decided.
**P-006** — A public status page.
**P-007** — Autoscaling policy for the worker pool.

**P-008 — Per-route latency objectives and error budgets** (added in 20.3)
Requires a measured baseline and a product decision about what "fast enough"
means per route. Inventing either would produce numbers that look agreed.

**P-009 — Re-derive every `ASSUMPTION` alert threshold from production
traffic** (added in 20.3)
Every workload-dependent threshold in `ops/alerts/palcert.rules.yml` is marked
and tabulated in `docs/operations/alerting.md`, so this is a checklist rather
than a memory.

**P-011 — Continuous WAL archiving and point-in-time recovery** (added in 20.4)
Checkpoint 20.4 ships scheduled logical backups, which recover to the instant
of the last backup and no finer. A shorter RPO needs WAL archiving, with its
own archive storage, retention policy and restore drill. Recorded so that the
current capability is never described as PITR.

**P-012 — Automated cross-region backup replication** (added in 20.4)
The off-site requirement is stated and the drill simulates it with an
independent cluster and object store. Making it real is a deployment decision.

**P-015 — A nonce or hash `script-src` for the web origin** (added in 20.7)
The v1 Content Security Policy allows inline script, because PalCert prerenders
twenty-three routes and a per-request nonce cannot be written into HTML
generated at build time — measured in a browser, not assumed. Closing it means
making those routes dynamic, which is a rendering-architecture change rather
than a hardening one. Everything else in the policy already denies by default.

**P-016 — Validate the Next.js server's environment at boot** (added in 20.7)
The web server reads two variables directly because it has no startup hook
where the shared schema could run. Both are parsed strictly at the point of
use and both are inventoried, but they are not validated the way every other
process's configuration is.

**P-014 — A multi-hour soak with the worker under its own workload** (added
in 20.6)
The twenty-minute soak in Checkpoint 20.6 found the API and document engine
flat and the worker drifting upward at about 11 MiB/hour while not itself
under load. At that size it is bounded and harmless; twenty minutes cannot
tell settling allocation from a slow leak, and this environment could not host
a run long enough to find out. Sizing the machine and running it is an
operational commitment rather than a piece of code.
*Re-measured in Checkpoint 20.7:* thirty minutes, sixty samples, the worker
idle with an empty queue throughout. Memory rose during warm-up and then
drifted **downward** — a second-half slope of −4.05 MiB/h with a 4.70 MiB
spread. The verdict is *inconclusive* and the growth **did not reproduce**;
nothing was optimized. The remaining recommendation is a worker-RSS alert at a
threshold an owner approves, so a real leak is found by operations rather than
by a benchmark.

**P-013 — Automated restore drills on a schedule** (added in 20.4)
The drill is automated and runs in CI against representative data; running it
against production-scale data on a schedule is an operational commitment
rather than a piece of code.

**Nothing in POST-V1 is a blocker, and nothing classified above it is merely
nice to have.** The three blockers share one property: without them PalCert
either cannot be deployed, cannot be recovered, or cannot be watched.

---

## 18. Proposed checkpoints

| Checkpoint | Scope | Closes |
|---|---|---|
| **20.1** | This audit; scope freeze | — |
| **20.2** | Defect remediation: the readiness and deployment-integrity defects | F-001, F-012, F-017, F-002, F-008, F-019 |
| **20.3** ✅ | Observability: metrics, ledger-backed gauges, alert thresholds | F-005 (closed) |
| **20.4** ✅ | Backup and restore, **including a real restore into a clean environment** | F-018 (closed) |
| **20.5** ✅ | Deployment topology, network segmentation, image build, rollback plan | F-013 (closed) |
| **20.6** ✅ | Performance, load, concurrency and capacity | F-009 (closed); P-008 informed |
| **20.6b** | Retention and growth: measure, then prune what should be pruned | F-004, F-016, P-001 |
| **20.7** ✅ | Final security and configuration hardening | F-007, F-003 (closed); F-020 part-closed; F-010, F-011 remain POST-V1 |
| **20.8** | Load plan execution against staging; external-service production setup | §13, §15 |
| **20.9** | Release gates against a frozen release candidate; v1 declaration | all |

## 19. Release gates for PalCert v1

Clean fresh installation · upgrade from a Phase-19 database · full migration
replay · backup taken · **restore performed and verified** · security scans ·
dependency and licence scans · secret scan · unit, integration and contract
tests · complete API e2e · web tests · analyzer tests · load test against the
stated workload · restart and crash-recovery test · staging smoke test ·
production-like smoke test. Closure uses one frozen release-candidate commit.
