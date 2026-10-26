# Performance workload models and inventory

The read-only inventory that precedes any measurement or tuning in Phase 20
Checkpoint 6. Nothing here is a benchmark result; it is what the architecture
already fixes, and the workload shapes that follow from it.

**Every number in §4 is an assumption until measured or approved by the
owner.** They are marked `[ASSUMPTION]` individually and none of them is a
production traffic target — PalCert has no production traffic, so a target
would be invention. They exist to give the load profiles a shape, and the
measurements replace them.

---

## 1. What the architecture already fixes

Read from the source at `9793e57`, not from documentation.

### Configured limits

| Knob | Default | Where it bites |
| --- | --- | --- |
| `DATABASE_POOL_MAX` | 10 | per API and per worker process; the ceiling on concurrent DB work |
| `WORKER_CONCURRENCY` | 2 | jobs one worker executes at once |
| `QUEUE_LEASE_SECONDS` | 600 | how long a claimed job stays claimed before it is reapable |
| `QUEUE_MAX_ATTEMPTS` | 5 | attempts before a job goes DEAD |
| `QUEUE_BACKOFF_BASE_MS` / `_MAX_MS` | 5 000 / — | retry spacing under failure |
| `API_RATE_LIMIT_LIMIT` / `_TTL_SECONDS` | 120 / 60 | per-caller request budget |
| `DOC_ENGINE_ANALYSIS_TIMEOUT_MS` | — | API's patience with one analysis |
| `DOC_ENGINE_READINESS_TIMEOUT_MS` | 2 000 | readiness probe budget |
| `STORAGE_REQUEST_TIMEOUT_MS` | 30 000 | object-store call budget |
| `UPLOAD_MAX_DOCX_BYTES` / `UPLOAD_MAX_PDF_BYTES` | — | largest accepted upload |
| `ANALYSIS_MAX_SOURCE_BYTES` | 209 715 200 | largest source the analyzer will read |
| `ANALYSIS_MAX_ARTIFACT_BYTES` | 134 217 728 | largest artifact it will write |
| `CHECK_MAX_STORED_VIOLATIONS_PER_RULE` | 200 | bound on stored findings per rule |
| `CHECK_MAX_RETURNED_VIOLATIONS_PER_RULE` | 50 | bound on response size |
| `CHECK_MAX_PAGE_SIZE` | 50 | bound on list responses |
| engine `max_document_bytes` | 52 428 800 | the analyzer's own refusal |
| engine `processing_timeout_seconds` | 300 | the analyzer's own deadline |

These are the resource guards. **None of them is relaxed to obtain better
numbers**, and the report records the configured value beside every result.

### Structural properties that decide how load behaves

- **The transactional outbox is authoritative** (ADR-0012). `processing_jobs`
  holds the truth; BullMQ carries identifiers only. Jobs are claimed with
  `FOR UPDATE SKIP LOCKED`, so the API's immediate dispatch, the outbox sweep
  and every worker replica can run the same claim concurrently without
  blocking each other or double-claiming. This is the property that decides
  whether worker throughput scales with replicas.
- **Leases, not locks.** A claimed job carries a lease; `reapAbandoned()`
  returns expired-lease jobs to PENDING. A worker that dies does not strand
  work, and a worker that pauses longer than the lease will find its job
  reclaimed — which is where duplicate execution would appear if the lease
  logic were wrong.
- **Rate limiting is Redis-backed** (`RedisThrottlerStorage`), so the budget is
  shared across API replicas rather than per-process. Correctness of that
  sharing is a load question, not a unit-test question.
- **Row-level security is FORCEd on 64 tables**, with 104 policies. Every
  tenant-scoped query carries that cost, and it is part of the measurement
  rather than something to switch off.
- **Certificate verification is key-independent**: lookup is by
  `verification_code_hash = sha256Hex(canonicalCode)`, a single indexed
  equality. An unknown code costs one index probe and no more — which §4.1's
  workload exists to verify rather than assume.
- **The document engine is synchronous per request** and bounded by its own
  byte and time limits; concurrency comes from the number of engine processes
  and from workers not asking it for more than it can take.

---

## 2. Workloads, derived from real PalCert workflows

Each is a path that exists in the product today. None was added for testing.

| # | Workload | Path | Why it is separate |
| --- | --- | --- | --- |
| W1 | public certificate verification | `GET /api/v1/public/certificates/:code` | unauthenticated, the only surface the open internet reaches |
| W2 | authenticated navigation | session-authenticated reads across organizations, documents, checks | carries RLS and session cost that W1 does not |
| W3 | concurrent uploads | upload URL issue → object PUT → finalize | the only path that moves large bytes |
| W4 | DOCX analysis | worker → document engine `/analysis/docx` | CPU-bound in Python, bounded by engine limits |
| W5 | PDF analysis | worker → document engine `/analysis/pdf` | different native engines (PDFium, qpdf); must be measured apart from W4 |
| W6 | paid checks | reservation → analysis → settlement | couples finance invariants to analyzer throughput |
| W7 | SmartFix | plan → apply → recheck | OOXML mutation, heavier than analysis |
| W8 | institutional submission and review | submission → preparation → review queue → decision | dual-party RLS, the widest tenancy surface |
| W9 | notification fan-out | one event → many recipients, through the outbox | queue growth shape |
| W10 | webhook bursts | endpoint delivery with signing, retries | external I/O, keyring, idempotency |
| W11 | API-client traffic | Phase 19 machine authentication | shared rate limit, scopes, revocation |
| W12 | mixed | all of the above together | shared-resource contention, which isolated benchmarks never show |

---

## 3. Load profiles

Four shapes, defined relative to measured capacity rather than to invented
absolute numbers. The multipliers are the definition; the request rates that
result are outputs of §4, not inputs.

| Profile | Definition |
| --- | --- |
| **low** | a rate the system serves with no queueing — used for baselines and for the CI smoke |
| **expected** | roughly half of measured saturation throughput |
| **elevated** | roughly 80% of measured saturation throughput |
| **saturation** | offered load increased until achieved throughput stops rising and latency or queue depth grows without bound |

Saturation is measured first and the other three are derived from it. Choosing
absolute numbers first and calling the largest one "saturation" would describe
the generator, not the system.

---

## 4. Assumptions

Each of these is a shape assumption, used only to build a scenario. **None is
a production target, and each is replaced by a measurement or requires owner
approval.**

| # | Assumption | Used for |
| --- | --- | --- |
| A1 | `[ASSUMPTION]` public verification is the highest-volume endpoint and the most likely to be scraped | why W1 is measured alone and first |
| A2 | `[ASSUMPTION]` a plausible mixed session is ~70% reads, ~20% writes, ~10% uploads | the W12 request mix |
| A3 | `[ASSUMPTION]` representative document sizes: small ≤100 KB, medium ~1 MB, large ~10 MB, near-limit ~45 MB | the analyzer size classes in W4/W5 |
| A4 | `[ASSUMPTION]` a realistic notification fan-out is one event to 10–50 recipients | W9 burst shape |
| A5 | `[ASSUMPTION]` a webhook burst is 100–1 000 events within a minute | W10 burst shape |
| A6 | `[ASSUMPTION]` an invalid verification code is at least as common as a valid one under scraping | the 50/50 valid/invalid split in W1 |
| A7 | `[ASSUMPTION]` API clients poll rather than stream, so W11 is many small authenticated requests | W11 shape |
| A8 | `[ASSUMPTION]` the worker's ~11 MiB/hour memory drift over the Checkpoint 20.6 soak is settling allocation rather than accumulation. **Not established** — twenty minutes cannot distinguish the two. Recorded as P-014 | the soak's memory conclusion in §8 of the 20.6 report |

---

## 5. The environment this will be measured on, and what that means

Recorded in full in the Checkpoint 6 report. The essential caveat belongs
here too, because it governs how every number in that report may be read:

- the host has **4 CPUs and ~15 GiB RAM**;
- the release topology runs **nine containers** on it — PostgreSQL, Redis,
  MinIO, ClamAV, the API, the worker, the web app, the document engine and the
  proxy — with no per-container CPU or memory limits, so they share those 4
  CPUs;
- **the load generator runs on the same host**, competing for the same CPUs.

So the numbers describe *this* system on *this* hardware with the generator
co-resident. They are a capacity envelope for a single small machine, not a
statement about what PalCert supports in production, and the report states the
resource profile beside every result for exactly that reason. A production
deployment with dedicated database hardware and separate API replicas would
have to be measured on its own terms.

Where co-residency plausibly distorts a result, the report says so rather than
presenting the number as clean.

---

## 6. The tooling

Everything is in `perf/`, in version control, and runs from a command line.
There is no bespoke framework: k6 is the generator, the scenarios are small
JavaScript files, and the orchestration is shell. A load harness larger than
the thing it measures is a second product to maintain, and it would be the one
nobody keeps correct.

| Path | What it is |
| --- | --- |
| `perf/seed-load-fixture.mjs` | **Validates** a deployed environment's fixture and writes the descriptor the scenarios read. Creates nothing and mutates nothing — the data comes from the Checkpoint 20.4 recovery fixture, built through real workflows |
| `perf/k6/lib/env.js` | Where an environment is named. A run against staging and a run against a laptop differ by environment variables, not by edited scenarios |
| `perf/k6/public-verification.js` | W1. Hits and misses counted separately; optional spread of simulated client identities |
| `perf/k6/authenticated.js` | W2. One sign-in, several ramp stages, the session carried explicitly |
| `perf/k6/smoke.js` | The CI smoke. Small, threshold-asserting, and wired into the `docker` job of `.github/workflows/ci.yml` |
| `perf/resilience-under-load.sh` | Restarts and dependency failures while traffic is flowing |
| `perf/safety-under-load.sh` | The safety regressions: tenant isolation, ledger and certificate uniqueness, job leases, cross-replica rate limiting, webhook idempotency, machine authorization, the migration gate and metric cardinality — all under load |

Two conventions worth keeping:

**Arrival-rate executors, not fixed virtual users.** With fixed VUs the
generator slows down as the system does and reports whatever throughput the
system happened to sustain, which always looks like success. A constant
arrival rate offers load regardless, and the gap between offered and achieved
is what saturation means.

**No thresholds in the capacity scenarios, thresholds in the smoke.** A
capacity run that aborts on a threshold cannot find the saturation point it
was run to find. A smoke test with no threshold cannot fail. They are
different jobs and the files say which is which.
