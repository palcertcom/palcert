# ADR-0081: A reservation has a product-specific lifetime, and a paid retry is a new purchase

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 11

## Context

Phase 10's generic hold TTL is fifteen minutes, which is right for a refund
settling with a payment provider and far too short for a document check that
queues, is analyzed, is evaluated and has a report stored.

But a reservation cannot simply last forever either. A check whose worker died,
or whose dependency never recovered, would hold a customer's money indefinitely
with nothing to show for it — and worse, a very late worker could finish
afterwards and either charge a reservation the customer had given up on or, if
the hold had quietly lapsed, deliver a report nobody paid for.

Then there is what happens next. Phase 7's "retry a failed check" restarted
processing on the same check. For a paid check that is either free work or a
silent re-take against whatever balance the customer has now.

## Decision

**`CHECK_RESERVATION_TTL_SECONDS` (default one hour) bounds a check's
reservation, and a paid check is never retried in place.**

- The TTL is separate from `CREDIT_HOLD_TTL_SECONDS` and long enough for normal
  processing, while still a hard upper bound.
- When it passes, the sweeper expires the holds and then converges the rest:
  the purchase is RELEASED and the check FAILED. A worker arriving afterwards
  finds a terminal check and captures nothing — and even if it tried, every
  hold is re-checked as ACTIVE before any of them is captured, so a partial or
  resurrected charge is impossible.
- `POST /checks/{id}/retry` refuses a paid check with
  `CHECK_RETRY_REQUIRES_NEW_PURCHASE`, saying plainly that no charge was made.
  Running it again is a new quote, a new purchase and a new check.
- Historical free checks keep the Phase 7 retry behaviour, which can no longer
  produce a new free check because the database refuses one.

## Alternatives considered

**Reuse the generic hold TTL.** Rejected: a check would routinely outlive its
own reservation, and the failure would look like a product that randomly
refuses to finish.

**Extend the hold when processing takes long.** Rejected. It turns a bound into
a suggestion, and a stuck check would extend forever.

**Re-reserve on retry.** Rejected. It mutates a settled purchase back into a
reserved one, which destroys the billing history of the attempt that actually
happened and makes "what did I pay for?" unanswerable.

## Consequences

- A customer whose check took too long is told it failed, gets their money
  back, and can run it again at the current price.
- Every paid attempt has its own immutable record, which is what makes the
  finance diagnostic able to say anything at all.
- The one-hour default is configuration, so a deployment with slower
  infrastructure raises it rather than discovering the limit in production.
