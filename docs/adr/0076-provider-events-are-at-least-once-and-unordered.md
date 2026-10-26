# ADR-0076: Provider events are at-least-once, unordered, and never self-describing

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 10

## Context

A payment provider's webhook is not a method call. It is a message on an
unreliable channel, and it comes with three properties that break naive
handlers.

It arrives **more than once**: the provider retries anything it does not see
acknowledged, and a slow response is indistinguishable from a lost one. It
arrives **out of order**: a refund event can land before the payment event it
refers to. And it is **not authoritative about itself**: the payload says what
was true when it was generated, which may not be true now, and its amount field
is not proof of what was charged.

Handled naively, the first property credits a balance several times, the second
crashes on a missing row, and the third lets a replayed or crafted payload
decide how much money a customer has.

## Decision

**Every event is recorded, deduplicated, and processed asynchronously and
idempotently, and processing always re-reads the provider's current state.**

- The endpoint verifies the signature, stores a receipt row keyed by the
  provider's event id, enqueues a job, and returns. A unique-violation on the
  receipt means "already seen" — a duplicate, acknowledged and not reprocessed.
  Only a genuine `P2002` counts as a duplicate; every other failure is logged
  and re-thrown, so PalCert never acknowledges an event it failed to record.
- Processing runs through the Phase 6 outbox (ADR-0036, ADR-0037), which is
  itself at-least-once. Handlers are therefore idempotent regardless of the
  receipt: the ledger's idempotency key, a conditional status update, and a
  trigger that refuses to rebind a top-up's credit entry are three independent
  mechanisms that each make a second credit impossible.
- Processing **ignores the amount and status in the payload** and re-retrieves
  the payment from the provider, then compares amount, currency and client
  reference against the PalCert row. Only a match credits.
- An event for a row PalCert does not recognize is not an error to retry
  forever; it is recorded and left, because the missing row may simply not
  exist yet.
- Because events can be lost entirely, a reconciliation sweeper re-queries any
  top-up that has been open too long. Delivery is a latency optimization, not a
  correctness dependency.

## Alternatives considered

**Trust the payload and skip the re-retrieval.** Rejected. The signature proves
the provider sent it, not that it is current — and one replay of a stale
`succeeded` payload would credit a balance for a payment that has since been
reversed.

**Process synchronously inside the webhook request.** Rejected. It ties the
provider's retry behaviour to PalCert's processing time, and a slow database
turns into a storm of duplicate deliveries.

**Order events by a sequence number.** Rejected: there isn't one that means
what it would need to mean. Handlers are written to be order-independent
instead, which is the property that actually holds.

## Consequences

- Ten identical deliveries of the same event produce exactly one credit, which
  the test suite asserts by delivering it ten times.
- A webhook racing the reconciliation sweeper produces one credit, which the
  suite also asserts.
- Events PalCert does not care about are recorded and ignored rather than
  failing, so an unrelated provider feature cannot fill the dead-letter queue.
