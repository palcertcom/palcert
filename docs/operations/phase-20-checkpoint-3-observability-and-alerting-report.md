# Phase 20 — Checkpoint 3 Observability & Alerting Report

**Scope frozen at:** Checkpoint 20.2, commit `0d30489`.
**Closes:** the Checkpoint 20.1 release blocker **F-005 — No metrics, no
tracing, no alert hooks**.
**Does not touch:** deployment architecture, backup/restore, load tuning,
CD/registry, UI, or any product capability.

---

## 0. Verdict

**F-005 is CLOSED.** See §12 for the evidence against each of its stated
remediation and test requirements, and §15 for the gates.

> **Correction, Checkpoint 20.4.** The full end-to-end result originally
> recorded here was not valid evidence. See §15a. The finding does not change
> the F-005 verdict, and the re-certified result is recorded in §15.

Two defects were discovered while building this checkpoint and fixed inside
it. The first would have made the telemetry confidently wrong rather than
absent (§4); the second is the one that matters most, because observability
changed what happened to a customer's work (§4a). Three post-v1 items were
recorded rather than built (§13).

---

## 1. Read-only inventory (what existed before any change)

| Signal | State at `0d30489` |
| --- | --- |
| Metrics | None. No `prom-client`, `prometheus_client`, OpenTelemetry, statsd or Sentry dependency in any manifest. No `/metrics` route anywhere. |
| Tracing | None. |
| Alert definitions | None. No rule file, no thresholds, no documented conditions. |
| Dashboards | None. |
| Structured logging | **Present and good.** pino JSON on the API and worker, structlog JSON in the document engine; `x-request-id` taken from the caller when supplied, generated otherwise, echoed on the response, and on every line. A substantial redaction list already covered passwords, session tokens, AI payloads, presigned URLs, certificate verification codes and API-client secrets. |
| Health probes | Liveness and readiness on API, worker, engine and web, separated correctly by Checkpoint 20.2. |
| Job state | Authoritative in `processing_jobs`, and reachable only by hand-written SQL. |

So the gap was not "no telemetry" — it was "nothing aggregated, nothing
alertable". The `DEAD` terminal state was reached correctly and announced to
nobody. Checkpoint 20.3 builds the aggregate layer and the alert layer on top
of the logging that already worked, rather than replacing it.

## 2. Model

Vendor-neutral by construction: every process emits the **Prometheus text
exposition format** and nothing else. No hosted service, no vendor SDK, no
outbound telemetry connection. Prometheus, VictoriaMetrics, Grafana Agent,
the OpenTelemetry Collector and Datadog's OpenMetrics check all read it.

Alerts ship as a standard Prometheus rule file. The dashboard is a written
specification rather than a vendor export, because shipping a
`dashboard.json` for one product would quietly make that product supported.

| Document | What it holds |
| --- | --- |
| `docs/operations/observability.md` | The signals, every metric, cardinality rules, correlation model, logging contract |
| `docs/operations/alerting.md` | The alert catalogue, severities, and what each threshold assumes |
| `docs/operations/dashboards.md` | Six-screen dashboard specification, one PromQL expression per panel |
| `ops/alerts/palcert.rules.yml` | 25 rules across 10 groups |

## 3. What each runtime now reports

| Runtime | Endpoint | Signals |
| --- | --- | --- |
| API | `:4000/metrics` | build identity, HTTP rate/latency/in-flight, job executions and duration, object-storage outcomes, security events, API-client auth and throttle outcomes, the database-authoritative gauges, collector health, Node process metrics |
| Worker | `:4100/metrics` | the same set; the job counters are the ones it actually increments |
| Document engine | `:8000/metrics` | build identity, HTTP rate/latency, analyses by analyzer and outcome, analysis duration and document-size histograms, Python process/platform/GC metrics |
| Web | `:3000/metrics` | build identity and Node process metrics only |

The web tier reports nothing about the domain on purpose. Everything worth
counting about compliance, jobs or payments already has an authority in the
API and the job ledger; counting it again in the rendering server would be a
second set of numbers to reconcile whenever they disagreed.

## 4. The finding: metrics that would have been confidently wrong

Reading the operational tables from the request-path database role does not
work, and **the way it fails is the dangerous part.**

* `webhook_deliveries` carries no `SELECT` grant for `palcert_app`, so the
  query errors outright. That at least announces itself.
* `document_analyses`, `compliance_certificates`, `balance_topups` and
  `api_clients` have row-level security **FORCEd**. The same aggregate run
  outside a tenant context returns **zero rows** — not an error. Every one of
  those gauges would have reported a confident `0`, and the alerts built on
  them would have been permanently silent.

A dashboard showing no backlog because it cannot see the backlog is worse
than no dashboard. This is a correctness defect in work introduced by this
checkpoint, so it was fixed here rather than recorded.

**Fix:** migration `20260925000000_phase20_operational_metrics` adds two
`SECURITY DEFINER` functions, `app_operational_counts()` and
`app_operational_ages()` — the same mechanism Phase 17 already uses for
system-authority reads (`app_webhook_deliveries_due`).

What they widen is deliberately narrow:

* counts and timestamps only — no row, identifier, payload, amount or address
  ever leaves them;
* grouped by database enums and short closed sets, so a caller cannot use them
  to enumerate anything;
* read-only, and granted `EXECUTE` rather than table `SELECT`, so the app
  role's table privileges are **exactly what they were**.

No policy is relaxed and no caller can reach a row through them. The
four-layer tenancy model is untouched.

It also made the collectors cheaper: two round trips per scrape instead of
nine.

## 4a. The defect that mattered: telemetry failing a job that had succeeded

Found by the full e2e run, in two suites that were green at 20.2.

`palcert_job_duration_seconds` was declared without its `labelNames`.
prom-client validates labels at **observe** time rather than at declaration,
so the metric looked perfectly healthy — it registered, it appeared in the
exposition — until the first real observation, which threw. It threw on every
single job.

That alone was survivable. What made it a correctness defect was *where* the
observation sat: inside the worker's job try-block, immediately after
`jobs.succeed()`. The throw was caught by the block that exists to catch job
failures, the catch called `failTransient`, and the ledger's own guard refused
to move a `SUCCEEDED` job to `RETRY_PENDING`:

```
processing_job 5c6a5b0a-… cannot move from SUCCEEDED to RETRY_PENDING
```

The guard did its job, and that is the only reason this surfaced as an error
rather than as silently duplicated work. But the principle was already
broken: a metric had changed what happened to a customer's job.

**Two fixes, because one of them is not enough.**

1. The histogram declares its label.
2. The telemetry moved into the `finally`, outside the block that decides the
   job's fate. A future mistake in a counter or a log line cannot reach the
   job again — which is what "observability must observe behaviour, not
   redefine it" has to mean in code rather than in a sentence.

The regression guard is a test that exercises every metric with the labels
its call sites actually pass. It is cheap, it fails at the declaration rather
than in production, and it is the test that was missing.

## 5. Cardinality

The first design constraint, not an afterthought. A metric labelled by an
identifier is a memory leak with a dashboard.

**Never a label:** a raw URL containing an id, a user id, an organization id,
a document id, an email address, an API client id, a webhook URL, a payment
reference, an exception message.

**Used instead:** Express's matched route template
(`/api/v1/documents/:documentId`, never the requested path), HTTP method,
status *class* (`2xx` — five values instead of sixty), and database enums.

An unmatched request is labelled `<unmatched>`, so a scanner probing a
hundred paths mints one series rather than a hundred. Proved rather than
asserted: an e2e test probes 25 distinct non-existent URLs and requires **at
most one** new series to appear.

Total series on an idle API instance: **107**, almost all of them Node's own
process metrics. The application's own label sets are bounded by 20 job
types × 6 statuses, 6 delivery statuses, 2 channels, 2 analyzers, and the
route table.

### Where cardinality shaped a design decision

`palcert_api_client_auth_total` is split by outcome — `succeeded` or
`refused` — and nothing finer, and that is a security decision rather than a
cardinality one. Phase 19 refuses every credential failure identically on the
wire precisely so a caller cannot distinguish "no such client" from "wrong
secret"; a metric split by refusal reason would rebuild that oracle for
anyone able to read the endpoint. The reason is logged, where the
administrator who needs it can see it and an attacker cannot.

## 6. Privacy: what telemetry refuses to carry

| Domain | Emitted | Never emitted |
| --- | --- | --- |
| Documents | analyzer name, outcome, duration, size bucket | filename, document id, title, extracted text, any content |
| Notifications | channel, status, backlog age | recipient address, subject, body |
| Webhooks | status, backlog age | endpoint URL, signing secret, organization id, payload |
| Payments | status counts | amount, currency, provider reference, customer, card data |
| Object storage | operation name, outcome class | bucket name, object key, version id |
| Accounts | security-event type counts | user, email address, IP address, user agent |
| API clients | auth outcome, throttle window, client status counts | client id, secret, fingerprint |
| Certificates | issuance status counts | certificate number, verification code, holder |

Payment semantics are untouched. These are operational outcome counts; the
ledger and reconciliation remain the authority on what happened to money, and
no finance metric carries an amount. Certificate eligibility and hash
semantics are untouched: the certificate gauge reads `issuance_status` and
changes nothing.

## 7. Logging

Two changes to what was already there, plus the test that was missing.

1. **Release identity on every line.** `commit` joins `service`, `version` and
   `env` in pino's base. Without it a log line from a half-finished rollout
   cannot be attributed to the version that produced it — which is exactly
   when it matters most.
2. **Redaction extended** to webhook signing secrets, payment credentials,
   `Authorization` in any position, and document text fields.
3. **`/metrics` logs at `debug`**, alongside `/health`, so scrapes do not
   become most of the log volume.

### The required redaction test found a real gap

`log-redaction.spec.ts` asserts, against the *real* pino serializer output
with distinctive values, that none of these ever appears: passwords, API
client secrets, webhook secrets, payment secrets, authorization headers,
document contents, signed capability values, cookies, presigned URLs.

Writing it immediately failed on the first case. `LOG_REDACT_PATHS` covered
`req.body.password` and `*.password`, but **not a bare top-level
`password`** — pino's `*.x` wildcard matches one level down, not a top-level
key. `logger.info({ password })` would have written the password in clear.
The same gap applied to `accessToken`, `refreshToken` and `presignedUrl`.
Fixed by routing all of them through the helper that lists each name at both
levels.

This is the value of testing the serializer rather than the configuration
array: a configuration that is only checked against itself proves nothing
about what lands on disk.

## 8. Correlation

Existing identifiers, reused. Nothing was minted for observability.

```
HTTP request        req.id              x-request-id, taken from the caller when
     │                                  supplied so it spans services, echoed back
     ▼
database write      resourceType/resourceId
     ▼
queued job          jobId, idempotencyKey = {jobType}:{resourceId}
     ▼
worker execution    "Job attempt started" / "Job attempt finished"
     │              { jobId, jobType, resourceType, resourceId, attempt,
     │                workerId, outcome }
     ▼
downstream delivery deliveryId on notification and webhook attempt lines
```

The worker previously logged only failures, and only `jobId`. It now logs the
start and the end of every attempt with the resource the job was created for,
which is what joins an execution back to the request that caused it, and
`attempt`, which distinguishes "this failed once" from "this is failing".

Deliberately absent from those lines: the owner, the organization, the
document name, the payload. The ledger row has them, behind the database's
access controls.

### OpenTelemetry

**Deferred to post-v1 (P-004), as a deliberate decision rather than an
omission.** Full distributed tracing across four runtimes would mean a new
dependency in each, a collector to operate, sampling to tune, and context
propagation to get right through BullMQ and Prisma — a telemetry-platform
migration, which this checkpoint was explicitly told not to become. What
tracing would have answered operationally on day one — "which request
produced this job, and what did the job do?" — the correlation model above
answers from identifiers that already existed. The exposition format is the
OpenTelemetry Collector's native input, so adopting it later requires no
application change.

## 9. Exposure

Telemetry is internal. Two independent controls, and **the first one is
topology**:

1. **The release proxy has no route to `/metrics`.** `location ^~ /metrics`
   returns 404 — not 403, so the outside cannot tell the endpoint exists, and
   `^~` so `/metrics/anything` is covered too. Without it, the proxy's
   catch-all would have forwarded an external `/metrics` straight to the web
   app.
2. **`METRICS_TOKEN`**, optional, compared in constant time, for a deployment
   whose internal network is shared. Unset means the endpoint sits at the same
   trust level as `/health` — a choice a deployment makes, not a default
   pretending to be security.

`METRICS_ENABLED=false` answers 404: a deployment that turned telemetry off
looks like one that never had it.

The API endpoint is excluded from the OpenAPI document, sits outside the
`/api` prefix and is version-neutral, is exempt from throttling (a scraper on
a fixed interval is not abuse, and a rate-limited scrape produces gaps that
look like an outage) and is served `Cache-Control: no-store`.

**Health endpoints are untouched.** Readiness answers one yes/no question for
an orchestrator and did not grow a metrics payload. Monitoring is a separate
surface.

## 10. Production-like validation

Against the release stack (`docker/docker-compose.release.yml`) running the
five images built from this commit.

| # | Proof | Observed |
| --- | --- | --- |
| 1 | `/metrics` through the published proxy is unreachable | 404 for `/metrics`, `/metrics/` and `/metrics/x`, while `/health/ready` on the same proxy answers 200 |
| 2 | API scrapable on the deployment network | 200, 287 lines |
| 3 | Worker scrapable on the deployment network | 200, 288 lines |
| 4 | Document engine scrapable | 200, including Python process metrics |
| 5 | Web scrapable | 200, 168 lines |
| 6 | Release identity matches the built commit | `palcert_build_info{commit="<HEAD>"}` present exactly once on all four |
| 7 | Database-authoritative gauges answer, and the collector reports healthy | `palcert_metrics_collector_up 1`; `palcert_metrics_collector_duration_seconds_sum 0.017` for two aggregate queries |
| 8 | No identifier anywhere in the exposition | zero UUID matches across the whole API exposition |
| 9 | A path-parameter route is templated, not recorded | requesting `/api/v1/public/certificates/ABC-123` produced `route="/api/v1/public/certificates/:verificationCode"` — the capability in the URL never reached a label |

Proof 9 is the one worth dwelling on: that route carries a certificate
verification code as a path segment, and it is precisely the URL an access
log or a metric would otherwise turn into a capability anyone could read.

A CI step (`Verify telemetry is scrapable inside and unreachable outside`)
performs the same checks on every run, so this cannot drift back silently.

## 11. Overhead

Measured, not assumed.

| Measurement | Value |
| --- | --- |
| HTTP middleware, per request | **2.9 µs** (100,000 iterations, including the harness's own object construction, so an overestimate) |
| Full scrape render | **3.9 ms** |
| Series on an idle API instance | **107** |
| Database collectors | 2 queries per **scrape**, not per request; both are aggregates over indexed columns |

The collector's own cost is recorded in
`palcert_metrics_collector_duration_seconds`, so the cost of observing is
itself observable, and the dashboard specification puts it next to memory: if
it climbs alongside RSS, suspect cardinality before suspecting a leak
elsewhere.

`palcert_metrics_collector_up` exists because "no data" and "no backlog" must
not look the same. A database outage makes the collector report `0` while the
scrape still succeeds, rather than the gauges silently vanishing — and there
is a page-severity alert on it, because every job, delivery, certificate and
payment alert is blind while it is firing.

No load tuning was attempted; that is not this checkpoint.

## 12. F-005, requirement by requirement

| F-005 said | Delivered |
| --- | --- |
| "a `/metrics` endpoint on API and worker" | On API, worker, document engine and web |
| "gauges backed by the `processing_jobs` ledger" | 7 job gauges read from the ledger through `app_operational_counts()`/`app_operational_ages()`; proved to survive a restart |
| "counters on the paths in §9" | HTTP, jobs, analyses, notifications, webhooks, certificates, payments, API clients, object storage, security events — the last two named in the frozen Phase 20 scope as "storage errors and authentication anomalies" |
| "documented alert thresholds" | 25 rules; every workload-dependent threshold marked `ASSUMPTION` in the rule file and tabulated in `alerting.md` with what to re-derive |
| "vendor choice deferred to 20.3" | Resolved as **no vendor**: Prometheus exposition format, standard rule file, written dashboard specification |
| *Test:* "metrics endpoint contract test" | `metrics.spec.ts` (23), `metrics-route.spec.ts` (7, web), `test_metrics.py` (18, engine), `observability.e2e-spec.ts` (9) |
| *Test:* "a test asserting a `DEAD` job moves its gauge" | `observability.e2e-spec.ts` — inserts a DEAD job, asserts `palcert_jobs_dead{job_type=…} 1`, asserts a **fresh process reading only the database** sees the same value, and asserts the exposition contains neither the resource id nor the failure text |

**F-005 is CLOSED.**

## 13. Recorded, not built

| Id | Item | Why not now |
| --- | --- | --- |
| **P-004** | OpenTelemetry distributed tracing (reaffirmed) | A telemetry-platform migration across four runtimes. The correlation model answers the operational question today, and the exposition format is the Collector's native input, so adoption later costs no application change. |
| **P-008** | Per-route latency objectives (SLOs) and error budgets | Requires a measured baseline and a product decision about what "fast enough" means per route. Inventing either would produce numbers that look agreed. |
| **P-009** | Re-derive every `ASSUMPTION` threshold from production traffic | Needs production traffic. Tabulated in `alerting.md` so it is a checklist rather than a memory. |

## 14. Tests added

| Suite | Count | What it proves |
| --- | --- | --- |
| `metrics.spec.ts` | 28 | route templating, status classes, double-settle safety, in-flight release on disconnect, probe exclusion, unmatched-path bounding, endpoint enable/token/404/403 behaviour, token never echoed, storage outcomes without bucket or key, security events by type alone, API-client auth kept to two outcomes, **every metric exercised with the labels its call sites pass** |
| `database-metrics.collector.spec.ts` | 14 | aggregates read from the functions not the tables, queue depth arithmetic, DEAD visibility, restart survival, stale-series clearing, unknown metric families ignored, collector-down reporting, no identifier in any label, no money in finance samples |
| `alert-rules.spec.ts` | 5 | every metric a rule names is actually emitted; the required conditions are all present; every alert has a severity and summary; every invented threshold is marked `ASSUMPTION`; no identifier is interpolated and no secret name appears |
| `log-redaction.spec.ts` | 12 | the seven forbidden value classes never reach the real serializer output; build identity on every line |
| `metrics-route.spec.ts` (web) | 7 | exposition, runtime signals, build identity, disabled/token behaviour, no user/session/locale/page label |
| `test_metrics.py` (engine) | 18 | exposition and headers, one build identity, disabled/token behaviour, route templating, unmatched bounding, probe exclusion, outcome mapping, unknown outcomes never mint a label, a rejected upload recorded without naming the document |
| `release-topology.spec.ts` | +2 | the proxy refuses `/metrics`; every service carries the telemetry switches |
| `observability.e2e-spec.ts` | 9 | everything above, against a real database and a real HTTP stack |

## 15. Gates

| Gate | Result |
| --- | --- |
| Document-engine suite | 1792 passed, 85 skipped |
| Contracts | 819 passed |
| Config | 53 passed |
| API unit | 622 passed, 5 skipped |
| Web | 520 passed |
| TypeScript typecheck | clean |
| mypy | clean, 102 files |
| eslint / ruff / prettier | clean |
| Builds (all packages, all five images) | clean |
| Generated-contract drift | clean |
| `docs:check-phases` | clean |
| **One complete API e2e run** | ~~1317 passed, 10 skipped, 0 failed — 73 suites, 31 minutes~~ **Withdrawn; see §15a.** Re-certified in Checkpoint 20.4: **1354 passed, 10 skipped, 0 failed**, against a database proven migration-current before Jest started. |
| Production-like stack telemetry | §10 |

## 15a. Correction: the end-to-end gate recorded above was not valid evidence

**Raised and corrected during Checkpoint 20.4. The original claim is struck
through rather than deleted, because a gate record that quietly improves is
worth less than one that shows what went wrong.**

### What was claimed

§15 originally recorded the last gate as *"One complete API e2e run — 1317
passed, 10 skipped, 0 failed"*, and the verdict in §0 leaned on it.

### Why it was not evidence

The database that the end-to-end suite runs against did not contain
`20260925000000_phase20_operational_metrics` — this checkpoint's own
migration, the one that creates `app_operational_counts()` and
`app_operational_ages()`. Its `_prisma_migrations` table's most recent entry
was Phase 19's, applied the previous day.

Without those functions the database-authoritative collector reports
`palcert_metrics_collector_up 0` and emits no gauges, and four of the nine
tests in `observability.e2e-spec.ts` fail:

```
● reports the DEAD count from the ledger, identified by job type
● keeps the DEAD signal across a restart, because the ledger holds it
● reports queue depth and backlog age from waiting work
● says the collectors answered, so an outage cannot look like an idle system
```

A run in that state cannot have been `0 failed`. The recorded summary and the
state of the database cannot both be true, so the recorded summary is
withdrawn. No attempt is made here to reconstruct what the run actually did;
the honest position is that the evidence is unusable, not that it was
narrowly wrong.

### Cause

Three things had to line up, and they did:

1. **The migration was authored but never applied locally.** Creating a
   migration directory and applying it are separate acts, and nothing in the
   local loop coupled them.
2. **Nothing checked.** Neither the application's readiness probe nor the
   test harness compared the migrations on disk against the migrations in the
   database. A database one migration behind the code starts, serves traffic,
   and fails only on the paths that needed the missing object.
3. **The production-like evidence looked like corroboration and was not.**
   The Checkpoint-20.3 stack proofs *did* observe `palcert_metrics_collector_up 1`
   — but against the release stack's own PostgreSQL, whose migration job had
   applied all 63 migrations. That result was real and remains valid. It said
   nothing about the database the local suite used, and it was allowed to feel
   as though it did.

Continuous integration was never affected: it runs `pnpm db:setup` before the
suite, so its database is always current.

### What changed as a result

The gap is now a gate rather than a matter of care, in three places
(Checkpoint 20.4):

- `pnpm --filter @palcert/database migrations:check` compares the migration
  directories in source against the applied history and fails on a
  difference, an unfinished migration, or a rolled-back one.
- The release deployment sequence runs it after the migration job and before
  any application container is allowed to serve, so traffic cannot open
  against a stale schema.
- The end-to-end harness runs it before Jest starts, so a suite can no longer
  report green against a database that is behind the code.

### Re-certification

Checkpoint 20.4's gate run executed the complete API end-to-end suite against
a database proven migration-current before Jest started — the harness now
refuses otherwise, and the run's first line was
`migrations:check: OK 63 migration(s), database is at the code's level`.

**Result: 76 suites passed, 3 skipped, 79 total — 1354 passed, 10 skipped,
0 failed, in 30 minutes. Exit code 0.**

All nine tests in `observability.e2e-spec.ts` passed, including the four that
fail without this checkpoint's migration. That is the re-certification. The
same number is the Checkpoint-20.4 gate, and is stated in
[its report](phase-20-checkpoint-4-backup-restore-and-disaster-recovery-report.md);
it is evidence for both checkpoints, not two separate claims.

## 16. What this checkpoint changed about behaviour

Nothing, now. It nearly changed one thing, and §4a is the record of it. That
is worth stating plainly rather than burying: an observability checkpoint is
the one most likely to break something by accident, because it touches every
path and is believed to touch none of them. The two defects it introduced
were caught — one by the required stack validation, one by the required full
e2e run — which is the argument for requiring both.

## 17. Explicit non-changes

Nothing in this checkpoint alters compliance semantics, advisory/authoritative
separation, payment logic, certificate eligibility or hash semantics, the
institutional workflow, API-client permissions, webhook delivery semantics or
analyzer results. The one database change adds two read-only functions and
grants `EXECUTE` on them; it creates no table, alters no policy and changes no
grant on any table.

Observability observes behaviour. It does not redefine it.
