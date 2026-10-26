# ADR-0036: Processing intent is a database row; BullMQ only carries the id

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 5

## Context

"Finalize the version, then publish a job" has a gap: if the process dies
between the two, or Redis is down, the version is `UPLOADED` forever. Putting
the publish inside the transaction does not help — Redis is not part of the
transaction.

## Decision

**Transactional outbox.** `processing_jobs` is a `SYSTEM` ledger table. The
finalize transaction inserts the row (idempotent on `{type}:{resourceId}`);
the commit *is* the durable intent. After commit, the API tries an immediate
publish; a periodic sweep in every process publishes anything still `PENDING`
or `RETRY_PENDING` and due. Redis being down costs latency, never work.

**BullMQ on the existing Redis** delivers `{ processingJobId }` and nothing
else. Its own retries are disabled (`attempts: 1`); the retry policy lives in
the ledger (ADR-0037). The queue job id is `{ledgerId}-{attempt}`, so a
duplicate publish of the same attempt deduplicates and every later attempt is
a new delivery.

## Alternatives considered

- **BullMQ as the source of truth.** Rejected: Redis persistence is not a
  ledger, and the version's state must be recoverable from PostgreSQL alone.
- **Polling the database only (no Redis).** Correct but adds sweep latency to
  every upload; the immediate publish keeps the common case fast while the
  sweep keeps it safe.
- **A separate message broker.** Not justified for one queue.

## Consequences

- `processing_jobs` carries identifiers only; the worker reloads everything
  under the owner's RLS scope.
- Operators can see and reason about every job in SQL; queue depth is a
  metric, not the truth.
