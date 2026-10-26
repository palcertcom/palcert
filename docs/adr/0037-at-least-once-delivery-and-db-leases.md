# ADR-0037: Delivery is at-least-once; the ledger decides who runs and when

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 5

## Context

A queue can deliver a job twice, a worker can die mid-job, a job can be
requeued by a sweep while another worker still holds it. Assuming exactly-once
(§58) turns each of these into a double-processed or stuck document.

## Decision

- **Claim in the database.** A delivery first calls `start(jobId, workerId)`,
  an atomic `DISPATCHED → RUNNING` update. Anything else — already `RUNNING`
  elsewhere, `SUCCEEDED`, `DEAD` — returns `null` and the delivery is a no-op.
- **Leases and heartbeats.** A running job holds `lease_expires_at`; the worker
  heartbeats at a third of the lease. The sweep's reaper requeues a lapsed
  lease immediately (`RETRY_PENDING`, attempt spent) or marks it `DEAD` when
  attempts are exhausted, and fails the version.
- **One retry policy.** `attempt_count`, `max_attempts`, full-jitter
  exponential backoff (`QUEUE_BACKOFF_BASE_MS`, `QUEUE_BACKOFF_MAX_MS`) live
  on the row. A transient failure moves to `RETRY_PENDING` with a due time; a
  content rejection is a *success* of the job (its task was to decide).
- **Owner retry.** `POST …/retry` on a `FAILED` version resurrects the `DEAD`
  job with a fresh attempt budget; the attempt counter keeps counting so queue
  ids never repeat.
- **Idempotent effects.** Every state write is guarded by the
  `document_versions_guard` trigger (write-once identity, allowed transitions),
  and promotion copies to a deterministic key whose *object version* is what
  is recorded — a repeated promotion cannot corrupt an earlier one.

## Alternatives considered

- **Redis locks for exclusivity.** Rejected: a second source of truth that can
  disagree with the ledger.
- **Poison-job quarantine by hand.** `DEAD` with the last failure code is the
  quarantine; the owner's retry and the operator's SQL are the tools.

## Consequences

- The e2e suite proves duplicate delivery is a no-op, a lapsed lease is
  re-run, Redis outage loses nothing, and exhausted retries end `FAILED` with
  the transient code, never `READY`.
- A crashed worker that keeps crashing on one job stops after `max_attempts`
  regardless of how quickly it is re-run.
