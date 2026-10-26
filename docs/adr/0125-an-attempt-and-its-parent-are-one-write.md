# ADR-0125: Beginning and finishing an attempt are each one write

- **Status:** Accepted
- **Date:** 2026-09-18
- **Phase:** 17

## Context

An attempt has two rows: the attempt itself and the delivery it belongs to.
Writing them in two transactions leaves two crash windows, and both were found
in review rather than in production — which is the only reason this ADR is
about a design and not an incident.

**Finishing.** The receiver's answer was already durable and the parent did not
know it. A reclaiming worker read a delivery stuck `SENDING` with no open
attempt, called it an interrupted send, and asked the receiver again. PalCert
had the answer on disk and threw it away.

**Beginning.** The delivery was moved to `SENDING` with `attempt_count`
incremented, and then the attempt row was inserted. A crash between them spent a
rung of the retry ladder with no attempt row and no request ever made — and the
recovery path compounded it by incrementing again. Since the ladder is indexed
by that counter, a handful of restarts could exhaust an organization's webhook
retries without a single request leaving the process.

## Decision

**One doorway at each end, and no second way in.**

`app_webhook_delivery_attempt_begin` locks the delivery, checks it is due,
inserts the attempt, increments the counter and moves the delivery to `SENDING`
— returning the attempt number it assigned, which is the ladder's index.

`app_webhook_delivery_attempt_finish` locks the open attempt, derives its
delivery from the attempt id, and writes both outcomes together.

The old standalone doorways are gone or narrowed: there is no way to create an
attempt without touching its parent, and no way to record a receiver's answer —
an HTTP status, or a receiver-derived error code — without moving the delivery
in the same transaction. A partial unique index allows one open attempt per
parent.

## Consequences

`attempt_count = count(attempt rows)` is true by construction, not by
convention, and is asserted after every committed begin.

The at-least-once boundary is exactly where it should be: if the write commits
and the process then dies, the reclaim reads a finished parent and sends
nothing; if it never commits, the attempt is still open and the ambiguous send
is retried, knowingly.

Test fixtures had to move onto the same doorways, which is the point — a
fixture that can build a state the service cannot is a fixture testing
something that will never happen.
