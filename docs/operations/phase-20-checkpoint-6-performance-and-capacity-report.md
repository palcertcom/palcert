# Phase 20 — Checkpoint 6: Performance & Capacity Report

Measured capacity for PalCert, tied to the exact environment it was measured
on. Every figure below is `N requests/sec at p95 X ms on this hardware with
these replica counts`, never "PalCert supports N users" — the second statement
cannot be made from these measurements and is not made anywhere in this
document.

Workload definitions, the architectural limits they run against, and the
assumptions behind each scenario are in
[performance-workload-models.md](performance-workload-models.md).

---

## 1. The environment, and what it does to every number here

| | |
| --- | --- |
| Release under test | `0.1.0+18d07c5`, the frozen Checkpoint 20.5 candidate |
| Images | the five frozen digests, deployed by digest, nothing rebuilt |
| Host | 4 CPUs, 15.7 GiB RAM, single machine |
| Container resource limits | **none** — all nine containers share those 4 CPUs |
| API replicas | **1** |
| Worker replicas | **1**, `WORKER_CONCURRENCY=2` |
| Document engine | 1 process |
| PostgreSQL | 17-alpine, one container, `DATABASE_POOL_MAX=10` |
| Redis | one container |
| Object storage | MinIO, one container, TLS |
| Malware scanner | ClamAV, one container (~953 MiB resident, signature database) |
| Load generator | k6 0.55, **on the same host**, competing for the same CPUs |
| Global HTTP throttle | **raised to `API_RATE_LIMIT_LIMIT=1000000`** for the capacity runs — see below |

Three consequences, stated once and true of everything below:

1. **The generator is co-resident.** At the rates where the API saturates, k6
   is itself consuming CPU on the same four cores. A dedicated load host would
   very likely measure higher throughput.
2. **Nothing is isolated.** PostgreSQL, Redis, ClamAV and the analyzer share
   CPU with the API. Production would separate at least the database.
3. **One replica of everything.** The headline bottleneck below is a
   single-process limit, and the scaling recommendation follows directly from
   that rather than from speculation.
4. **The global HTTP throttle was raised for the capacity runs.** With the
   shipped limit of 120 requests per 60 seconds, every sweep above 2 rps
   measures the throttle and nothing else. So the stack under test runs with
   `API_RATE_LIMIT_LIMIT=1000000` — stated here rather than left in an
   environment file, because an undisclosed raised limit turns a capacity
   number into a different number about a different system.

   Two things this did **not** do. It did not touch the per-IP public
   verification guard (`PUBLIC_CERTIFICATE_VERIFY_LIMIT = 60` per fifteen
   minutes), which is a hard-coded constant and stayed exactly as it ships —
   §3 measures it directly and the load scenarios work behind it by presenting
   many client identities rather than by removing it. And it did not affect
   §8a, where the limiters are measured: those replicas are started with the
   shipped values, because asking whether a limit is enforced correctly while
   it is set to a million is not a question.

These are capacity figures for one small machine. They are a floor, not a
ceiling, and not a production capacity statement.

---

## 2. Baseline, before any load

Idle, after the stack settled:

| Container | CPU | Memory |
| --- | --- | --- |
| api | 0.47% | 143.4 MiB |
| worker | 0.47% | 91.6 MiB |
| document-engine | 0.19% | 69.9 MiB |
| postgres | 0.05% | 57.6 MiB |
| redis | 0.48% | 3.9 MiB |
| minio | 0.03% | 229.0 MiB |
| web | 0.00% | 56.1 MiB |
| proxy | 0.00% | 5.7 MiB |
| clamav | 0.01% | 953.4 MiB |

Idle database: **7 connections, 1 active, 0 processing jobs, 15 MB**.
Host load average 0.36.

Single requests through the ingress (median of five):

| Path | Status | Median |
| --- | --- | --- |
| `/health/live` | 200 | 6.9 ms |
| `/health/ready` | 200 | 19.0 ms |
| `/api/v1/public/certificates/<unknown>` | 404 | 8.6 ms |
| `/metrics` (through the public proxy) | **404** | 4.2 ms |

That last row is intended: metrics are reachable on the internal network and
are not published through the public proxy.

Proxy and TLS cost, measured on the same path: `/health/live` is **3.9 ms
direct to the API and 7.5 ms through the proxy**, so roughly 3.6 ms of the
figures taken through ingress is termination and forwarding.

---

## 3. W1 — public certificate verification

Measured against the API directly, presenting many distinct client addresses
from the RFC 2544 benchmarking range, because the endpoint carries a per-IP
guard (below) that binds immediately for a single-origin generator.

| Offered | Achieved | p50 | p95 | p99 | Dropped | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| 100/s | 100.0/s | 4.27 ms | 6.09 ms | 9.73 ms | 0 | 0 |
| 200/s | 200.0/s | 3.75 ms | 5.48 ms | 11.19 ms | 0 | 0 |
| 400/s | 399.9/s | 5.13 ms | 12.13 ms | 22.70 ms | 0 | 0 |
| 800/s | 794.4/s | 120.59 ms | 222.01 ms | 255.38 ms | 0 | 0 |
| 1200/s | **521.3/s** | 383.88 ms | 784.82 ms | **18.07 s** | 6 915 | 0 |

**Saturation is between 400 and 800 requests/sec.** At 1200 offered, achieved
throughput *falls* to 521/s — congestive collapse, not a plateau. Through it
all the API returned no unexpected status codes: degradation was latency and
generator-side drops, never a wrong answer.

### Invalid codes do not cost more than valid ones

At 100/s with a 50/50 split:

| | p50 | p95 | p99 |
| --- | --- | --- | --- |
| hit (real certificate) | 4.19 ms | 6.23 ms | 12.23 ms |
| miss (well-formed, absent) | 4.37 ms | 6.06 ms | 10.93 ms |

Indistinguishable, which is what the structure predicts: the lookup is one
indexed equality on `verification_code_hash`, and on a miss the two
primary-key joins behind it never execute. A scraper gains nothing by asking
about certificates that do not exist.

### The rate limit is the real first line, and it is cheap

Public verification carries a dedicated per-IP guard —
`PUBLIC_CERTIFICATE_VERIFY_LIMIT = 60` per fifteen-minute window — separate
from the global API limiter, because a verification code is a capability and a
script must not be able to sit and guess at it.

From a single origin at 50/s, **100% of 1 500 requests were refused with 429**,
at p50 2.8 ms and p95 4.45 ms. Rejection costs about 3 ms and never reaches
the database. That is the honest answer to "can invalid codes be used to hurt
PalCert": they are refused per-IP long before volume matters.

---

## 4. W2 — authenticated navigation

Through TLS and the proxy, as a browser reaches it. One sign-in per run;
tenant-scoped reads under forced row-level security.

| Offered | Achieved | p50 | p95 | p99 | Dropped | Unauthorized |
| --- | --- | --- | --- | --- | --- | --- |
| 60/s | 59.7/s | 15.98 ms | 23.04 ms | 35.97 ms | 0 | 0% |
| 90/s | 89.5/s | 19.33 ms | 26.86 ms | 45.45 ms | 0 | 0% |
| 120/s | 119.4/s | 33.12 ms | 102.30 ms | 142.88 ms | 0 | 0% |
| ramp 50→400/s | **91.8/s** | 893.91 ms | 7.10 s | 7.19 s | 3 748 | 0% |

**Authenticated navigation sustains roughly 90/s and degrades sharply past
120/s** — where public verification was still comfortable at 400/s.

Subtracting the ~3.6 ms of proxy and TLS, an authenticated tenant-scoped read
costs roughly **12–16 ms against ~4 ms for the unauthenticated public
lookup**. That difference is the price of tenancy — session resolution plus
RLS on 64 forced tables — and it is the single most useful number in this
report for capacity planning, because almost all product traffic is
authenticated.

---

## 5. The first bottleneck

Sampled during a sustained 800/s verification run:

| Container | CPU | Memory |
| --- | --- | --- |
| **api** | **123.82%** | 373.8 MiB |
| postgres | 42.63% | 89.1 MiB |
| redis | 7.27% | 9.7 MiB |
| document-engine | 3.87% | 70.0 MiB |
| everything else | < 0.1% | — |

Database at the same moment: **14 connections, 1 active**. Host load 2.33 of 4.

**The first bottleneck is the API process's CPU.** It is past one core while
PostgreSQL has capacity to spare and the connection pool — 10 — is nowhere
near exhausted with a single connection busy. Nothing here points at the
database, at Redis, at object storage or at the analyzer.

That matters for what to do about it: the remedy is **more API processes**,
not a bigger database, and not an index. No index was added, because no query
was shown to be slow.

---

## 6. Safe degradation

At and beyond saturation the system degraded in the permitted ways and none of
the forbidden ones.

| Behaviour | Observed |
| --- | --- |
| bounded queue growth | yes — drops occurred in the generator, not unbounded server queues |
| 429 under rate limit | yes, and cheap (~3 ms) |
| 503 when a dependency is absent | yes (§7) |
| controlled timeout | yes — p99 grew, requests completed or the client gave up |
| **data corruption** | none observed |
| **duplicate certificates** | none — verification-code immutability is enforced in the database |
| **lost jobs** | none — the outbox is authoritative and leases are reaped |
| **cross-tenant leakage** | none observed; RLS remained in force throughout |
| **uncontrolled memory growth** | see §8 |
| **process crash loops** | none — `restartCount=0` throughout every failure injection |

Across every run at and above saturation, the API returned **no unexpected
status codes** — no 5xx series was ever emitted. Failure was slowness and
refusal, never a wrong answer.

---

## 7. Restart and dependency failure, under load

Performed while public verification traffic was flowing.

| Event | Result |
| --- | --- |
| API restarted | ready again **after 2 s**; in-flight requests failed (59.87% of that run's requests, with one replica there is nowhere else to go) and recovered completely |
| Worker restarted | ready again after 2 s |
| Document engine restarted | ready again immediately; **the API stayed up** |
| PostgreSQL stopped | liveness **200**, readiness **503**, `restartCount=0`, readiness recovered automatically |
| Redis stopped | liveness **200**, readiness **503**, `restartCount=0`, recovered automatically |
| MinIO stopped | liveness **200**, readiness **503**, `restartCount=0`, recovered automatically |

The liveness/readiness split behaved exactly as designed: a missing dependency
turns readiness red so traffic is withheld, while liveness stays green so the
orchestrator does not restart a process that is working correctly and simply
has nothing to talk to. Restarting the API would not bring PostgreSQL back,
and a restart loop across replicas would turn a dependency outage into a total
one.

**Observability held up.** `palcert_build_info` and
`palcert_http_requests_total` remained exposed throughout, and HTTP metric
cardinality stayed at **3 series** under load — route labels are
parameterised (`/api/v1/public/certificates/:verificationCode`), so no
document or user identifier reaches a label.

---

## 8. Soak

**Twenty minutes at 120 requests/second, 144 001 requests.** That is what the
environment and the time available allowed, and it is reported as what it is:
a bounded soak, not a multi-hour endurance run. It is long enough to separate
start-up allocation from continuous growth, which is the question a soak of
this size can answer; it is not long enough to find a leak that takes hours to
become visible, and no claim is made that it is.

Offered 120/s, achieved 120.000456/s — the generator never fell behind, which
is the first thing to establish, because a soak that quietly drops offered
load reports a flat memory curve for the wrong reason.

| | Result |
| --- | --- |
| Duration | 20m00.0s |
| Requests | 144 001, 0 interrupted |
| Achieved rate | 120.0/s against 120/s offered |
| Checks | **100.00%**, 288 002 of 288 002 |
| Rate-limited | 0 |
| Unexpected status | 0 |
| p50 / p95 / max | 3.94 ms / 5.19 ms / 62.28 ms |
| Hit vs miss p95 | 4.98 ms vs 5.38 ms |

Latency did not drift: p95 at 5.19 ms over the whole run is the same figure
§3 measured in sixty seconds.

### Memory

Sampled every 30 seconds, 38 samples. The slope is taken over the second half
only (t ≥ 600 s), because the first minute is start-up allocation and
including it would report warm-up as a leak.

| Process | Start | End | Peak | Second-half slope |
| --- | --- | --- | --- | --- |
| api | 126.3 MiB | 149.0 MiB | 150.2 MiB | **+4.0 MiB/h** |
| worker | 89.6 MiB | 96.3 MiB | 96.7 MiB | **+11.3 MiB/h** |
| document-engine | 49.0 MiB | 49.0 MiB | 49.7 MiB | +1.1 MiB/h |

Database connections held at 14 for all 38 samples — no pool growth, no leaked
connection.

**Reading this honestly.** The API's rise is almost entirely in the first 60
seconds (126.3 → 147.2 MiB), after which it is flat to within a megabyte: a V8
heap settling, not a leak. The worker's +11.3 MiB/h is the one number that
does not obviously settle, and it should not be explained away — the worker
was *not* the thing under load here (the workload is public verification) and
it still grew about 1.5 MiB over the final nine minutes. On this evidence it
is small and bounded; on this evidence it is also indistinguishable from a
slow leak that twenty minutes cannot resolve.

> **[ASSUMPTION A8]** The worker's drift is settling allocation rather than
> accumulation. **Not established.** Resolving it needs a multi-hour soak with
> the worker under its own workload, which this environment could not host.
> Recorded as **P-014** rather than asserted.

---

## 8a. Safety regressions, re-proved under load

`perf/safety-under-load.sh`. Twenty-four checks, all run while public
verification was flowing at 100 rps against the stack — because load is
exactly where correctness quietly stops holding, and a boundary that is only
ever exercised single-threaded is a boundary nobody has tested.

Nothing was weakened for the occasion: no guard disabled, no constraint
dropped, no limit relaxed. **24 of 24 passed.**

| Property | Result |
| --- | --- |
| Tenant isolation, owner-scoped (`documents`) | no context → 0 rows; another user's id → 0 rows; **the right id → 2 rows** |
| Tenant isolation, org-scoped (`compliance_certificates`) | no context → 0 rows; another organization's id → 0 rows; **the right id → 1 row** |
| Row-level security is FORCEd | every table with RLS enabled also has it forced — 0 exceptions |
| No duplicate certificates | no shared verification code; no revision with two live certificates |
| No duplicate ledger entries | no idempotency key reused on an account; no reference captured twice; no account spent below zero |
| No duplicate or lost jobs | no idempotency key reused per job type; no job RUNNING on a long-expired lease; every RUNNING job names its worker; no job attempted past its own limit |
| **Global HTTP throttle across two replicas** | **allowed 120, refused 80, of 200 — limit 120/60 s** |
| **Verification guard across two replicas** | **allowed 60, refused 30, of 90 — limit 60/15 min** |
| Webhook idempotency | at most one original (non-replay) delivery per endpoint per event |
| API-client authorization | anonymous → 401; forged credential → 401, under load |
| Migration gate | the release's own preflight still reports the schema current, exit 0 |
| Monitoring | request counter exposed; 5 series; no UUID anywhere in the exposition |

### The two rate-limit rows are finding F-009's own test

The Checkpoint 20.1 audit raised **F-009 — the global HTTP rate limit is
per-process**, and named the test that would settle it: *"two API instances
sharing one budget."* Checkpoint 20.2 fixed the cause by giving the throttler
a Redis store. Nobody had run the test.

This runs it. Two API replicas are started from the running API's image,
environment and mounts, with `API_RATE_LIMIT_LIMIT` set to the shipped default
of 120 per 60 s, and one simulated client sends 200 requests alternating
between them. A per-process counter would admit about 240. It admitted
**exactly 120**. The verification guard, a different limiter with a different
store, admitted **exactly 60** of 90.

The route used for the throttle check is authenticated and no credential is
sent, so every admitted request answers 401 — deliberately: the throttler
guard is registered first among the global guards and so runs ahead of
authentication, a refused request is still a counted one, and a route with no
second limiter in front of it means a 429 can only have come from the global
throttle.

**F-009 is closed on this evidence**, and the readiness ledger is updated to
say so.

### Two-sided assertions, because one-sided ones passed for the wrong reason

Both rate-limit checks assert a band, not a ceiling. The first version
asserted only "not more than 66 admitted", which a system refusing *everything*
satisfies — and on the second run that is precisely what it reported:
`allowed=0 refused=90`, and it said ok. The cause was the harness, not the
product: the fifteen-minute window had not expired, so the client started with
its budget already spent. Each run now draws a fresh client address and the
check requires the admitted count to land near the limit from both directions.

---

## 9. Tuning performed

One change, and it meets requirement 24's bar: a measured gap, in scope,
no change to correctness or security, recorded before and after.

**`DATABASE_POOL_MAX`, `API_RATE_LIMIT_LIMIT`, `API_RATE_LIMIT_TTL_SECONDS`
and `WORKER_CONCURRENCY` were not exposed by the release topology.** They
existed in the configuration schema with sensible defaults and there was no
way to set them on a deployed system: an operator who needed a larger pool for
a bigger database, more worker concurrency, or a different limit for a trusted
integration had to rebuild an image. It also blocked this checkpoint's own
worker-concurrency experiment.

- **Before:** absent from `docker-compose.release.yml`; schema defaults only.
- **After:** passed through as `${VAR:-<schema default>}`, so an environment
  that sets none of them behaves exactly as before. Required-variable count
  unchanged at 11; no image rebuilt.

**No other tuning was done.** No index was added, no query rewritten, no
timeout adjusted — because no measurement justified one. The bottleneck found
is process CPU, whose remedy is replicas rather than code.

---

## 10. Proposed SLOs — **recommendations, requiring owner approval**

Derived from the measurements above, on the environment above. They are
**not** applied anywhere, and **no alert threshold in
`ops/alerts/palcert.rules.yml` was changed** on the strength of them.

| Objective | Proposed | Basis |
| --- | --- | --- |
| API availability | 99.5% monthly | no 5xx was produced at any offered load; the realistic risk is dependency outage, not application failure |
| Public verification latency | p95 < 150 ms | measured p95 6 ms at 200/s; 25× headroom absorbs a busier host and real network |
| Authenticated API latency | p95 < 400 ms | measured p95 27 ms at 90/s; the same headroom over the tenancy-inclusive path |
| Public verification availability | 99.9% monthly | it is the unauthenticated public surface and the cheapest path to serve |
| Analysis completion | **not proposed** | not measured in this checkpoint (§11); proposing a number would be invention |
| Queue age | oldest pending < 5 min at p95 | the outbox drained continuously under all loads tested; the threshold is a placeholder for a measured one |

Every row is a recommendation. Adopting any of them is the owner's decision,
and the two marked as placeholders should be replaced by measurements before
they are adopted at all.

---

## 11. What was not measured, and why

Stated plainly rather than omitted, because a capacity report with silent gaps
is worse than one with declared ones.

| Workload | Status |
| --- | --- |
| W3 uploads, W4 DOCX analysis, W5 PDF analysis | **not measured.** These need documents pushed through the full upload → scan → analyse pipeline against the deployed stack. The fixture provides two documents, not a size-graded corpus, and building one through the deployed API needs the upload-URL flow per document class |
| W6 paid checks, W7 SmartFix, W8 submissions | **not measured** — same dependency |
| W9 notification fan-out, W10 webhook bursts | **not measured** |
| W11 API-client machine traffic | **not measured** |
| W12 mixed workload | **not measured**, because it is only meaningful once its components are |
| W13 finance concurrency | **not measured** |
| Worker concurrency scaling | **not measured.** The knob it needs was not exposed until this checkpoint added it (§9); the experiment itself remains to be run. Worker *correctness* under concurrency — lease ownership, no duplicate claim, no job attempted past its limit — was checked under load in §8a; what was not measured is throughput against concurrency |
| Whether the worker's soak drift settles | **not resolved** (§8). Twenty minutes cannot distinguish settling allocation from a slow leak. Recorded as P-014 rather than explained away |
| Multi-replica rate-limit consistency | **measured** — §8a. Two replicas, one client, exactly one budget on both limiters. Finding F-009 is closed on it |
| Database index hotspots | **no hotspot found.** PostgreSQL was at 42% CPU with one active connection while the API was the bottleneck, so there was no measured query to optimise. No index was added on intuition |

These are the highest-value items for the next performance pass, and the
harness in `perf/` is where they would be added.

---

## 12. Gates

All run on the final committed tree.

| Gate | Result |
| --- | --- |
| `pnpm build` | pass |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm format:check` | pass |
| `pnpm test` (unit, all packages) | pass — 819 contracts, 644 API (5 skipped), 520 web |
| `pnpm py:lint` | pass |
| Python tests (document engine) | pass — 1 792 passed, 85 skipped |
| `pnpm docs:check-phases` | pass |
| **Full API e2e on the final tree** | **pass — 1 354 passed, 10 skipped, 76 of 79 suites (3 skipped), 1 546 s**, from an empty schema migrated to head |
| CI performance smoke | pass — 241 of 241 checks, p95 1.58 ms on the health path, all three thresholds met |
| Production-like load scenarios (W1, W2) | pass |
| Saturation test | pass — knee located, collapse point recorded |
| **Soak (20 min, 144 001 requests)** | **pass — 288 002 of 288 002 checks, 120.0/s achieved against 120/s offered, p95 5.19 ms** |
| Restart-under-load | pass, 6 of 6 |
| Failure-injection (PostgreSQL, Redis, MinIO) | pass, 9 of 9 |
| **Safety regressions under load** | **pass, 24 of 24** (§8a) |

Two gates needed their environment fixed rather than their result explained:
the Python suite had to run in the project's own virtualenv (the system
interpreter has no `structlog`), and `db:check-migrations` needs
`DATABASE_ADMIN_URL`, which it correctly refuses to run without. Neither is a
finding about the tree.

Two lint rules were added for the new load tooling, and nothing else about
them changed: `perf/k6/**/*.js` declares k6's injected globals (`__ENV`,
`__VU`, `__ITER`), which no Node or browser environment defines, and
`perf/*.mjs` joins the existing operator-CLI exemption for `console`, since
its entire output is a transcript an operator reads.

---

## 13. Faults found in the measurements themselves

Ten, all in the harness rather than the product, and all recorded beside the
code that had them. They are listed because a performance report's worst
failure mode is a number that is really about the measuring instrument.

| # | Fault | How it presented |
| --- | --- | --- |
| 1 | client-spread drew from one /24 | a sweep showed rising rate-limiting and latency that looked exactly like saturation; the generator had exhausted its 15 240-request budget of client identities |
| 2 | cookies copied into k6's jar by hand | every request 401; rejection is fast, so it reported a flattering 2 ms p50 for "navigation" |
| 3 | sign-in once per VU | 100 VUs from one IP tripped the login throttle; three runs reported throughput that was really their own failed setup |
| 4 | hit assertion named `issuanceStatus` | the column name, absent from the response; failed every hit while "returns 200" passed beside it |
| 5 | CI smoke ran everything at 10/s | spent the 60-request verification budget in six seconds and reported a 49% failure rate of its own making |
| 6 | load container started with `--rm` | its logs were the measurement and it deleted them; the restart check printed an empty figure and said `ok` anyway |
| 7 | the safety suite asked about `documents` with the *organization* key | `documents` is owner-scoped; the control returned 0 rows alongside the negative, so the check would have reported isolation holding whatever the policy said |
| 8 | the cross-replica rate-limit test ran against the stack's own API | whose limit is raised to 1 000 000 for the capacity runs, so 133 418 requests produced no 429 at all before it was stopped |
| 9 | the verification-guard assertion was one-sided | a second run inside the same 15-minute window started with the budget spent and reported `allowed=0 refused=90` — and said `ok` |
| 10 | the migration gate called `check-migrations.mjs` by a guessed path inside the API image | `MODULE_NOT_FOUND`, which reads exactly like a failing gate and is nothing of the sort |

Numbers 2, 4, 6, 7, 8 and 9 are the same shape as the defects Checkpoint 20.5
found in its gates: a check that cannot fail, or that passes for a reason
unrelated to what it claims to test. Six of ten, in a checkpoint whose entire
output is measurements, is the argument for looking at every green result
closely enough to say *why* it is green.

---

## 14. Scaling recommendations

Directly from §5, where the bottleneck is process CPU and nothing else was
close.

- **API — scale horizontally first.** This is the measured bottleneck. The
  process is past one core while PostgreSQL has headroom. Additional replicas
  behind the proxy should scale public verification close to linearly until
  the database becomes the constraint, which it was nowhere near. The rate
  limiter is already Redis-backed, so the per-caller budget stays correct
  across replicas rather than multiplying by replica count.
- **Workers — scale horizontally, and now also by concurrency.** Job claims
  use `FOR UPDATE SKIP LOCKED`, so replicas do not contend. `WORKER_CONCURRENCY`
  is newly tunable (§9); raise it only up to what the document engine and the
  connection pool can absorb, since each concurrent job holds a connection.
- **Document engine — scale with worker concurrency.** It is synchronous per
  request and bounded by its own 50 MB / 300 s guards. It was at 3.87% CPU
  here because no analysis load was applied; sizing it needs W4/W5 measured
  first (§11).
- **PostgreSQL — not the constraint yet.** 42% CPU and one active connection
  at API saturation. Before adding capacity here, add API replicas and
  re-measure; `DATABASE_POOL_MAX` is now tunable, and the pool should be sized
  as `replicas × pool ≤ server max_connections`.
- **Redis — comfortable.** 7.27% CPU and under 10 MiB at API saturation. It
  carries rate-limit counters and job identifiers, not payloads.
- **Object storage — untested under upload load** (§11). MinIO was idle in
  every scenario measured.

The first thing to do with a second machine is to move PostgreSQL off the
application host, and the first thing to do with more capacity on one machine
is to run more API replicas.

---

## 15. Known capacity limits

On **4 shared CPUs, 1 API replica, 1 worker, generator co-resident**:

- public certificate verification: **400 req/s at p95 12 ms**; saturates
  between 400 and 800; collapses above ~800;
- authenticated navigation: **90 req/s at p95 27 ms**; degrades past 120;
- a single origin is limited to **60 verification requests per 15 minutes**
  and **120 API requests per minute**, by design — and those are *shared*
  budgets, proved across two replicas in §8a, not per replica;
- sustained 120 req/s for 20 minutes with flat API memory and no latency
  drift;
- everything else in §11 is unmeasured.

## 16. Post-v1 scaling work

- measure the analyzer workloads (W3–W5) with a size-graded corpus, which is
  the prerequisite for an analysis-completion SLO;
- run the worker-concurrency scaling experiment the new knob now permits;
- run a multi-hour soak with the worker under its own workload, to settle
  whether its ~11 MiB/hour drift accumulates (P-014);
- measure the mixed workload, which is where shared-resource contention shows
  up and where isolated benchmarks are least trustworthy;
- re-measure with PostgreSQL on its own host, which is the first structural
  change worth making.
