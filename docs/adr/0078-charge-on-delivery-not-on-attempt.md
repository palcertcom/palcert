# ADR-0078: A check is charged for a delivered report, not for an attempt

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 11

## Context

A document check is not instantaneous. It queues, an analysis runs, hundreds of
rules are evaluated, a report is canonicalized and stored. Any of those can
fail for reasons that are entirely PalCert's — an analyzer crash, a rule engine
outage, object storage refusing a write.

So there are two moments a charge could happen, and they are not equivalent.

**Charge at the start.** Simple, and wrong in a way customers notice. Every
PalCert failure becomes a refund: a second money movement, a second chance to
get it wrong, a line in the customer's history for a service they never got,
and a support conversation. It also means the failure path is the path that
moves money, which is the path least exercised and most likely to be broken.

**Charge at the end.** The customer's balance must still be protected while the
work runs, or a $3 balance could buy ten checks.

There is a third question hiding inside this one: what counts as delivery? A
document that fails its rules is the most common outcome of a compliance check
and the most useful one. Treating it as a non-delivery would mean PalCert only
charges for good news, which is not a business.

## Decision

**Credit is reserved at creation and captured only when the report is
successfully delivered. Delivery means a stored report artifact and a
completable check — never a particular compliance outcome.**

- `COMPLIANT`, `NON_COMPLIANT`, `REVIEW_REQUIRED` and `INDETERMINATE` are all
  delivered services and all charged. A customer buys the analysis and the
  report, not a pass.
- A technical failure before delivery **releases** the reservation. Nothing was
  charged, so nothing is refunded — and the UI says "no charge was made", not
  "refunded", because the two are different events and conflating them would
  misdescribe the customer's own money.
- The capture happens in the **same transaction** as the results, the
  violations, the report row, the run finalization and the check completion
  (ADR-0080). There is no ordering of two commits that is safe.
- `refundServiceCharge` survives from Phase 10 for the rare post-delivery
  correction, and is never triggered by a compliance outcome.

## Alternatives considered

**Charge on creation, refund on failure.** Rejected above. It is strictly worse
for the customer and puts the money on the least-tested path.

**Charge on creation, no refund.** Rejected outright: it charges for PalCert's
own failures.

**Charge per stage.** Rejected. It is a pricing model nobody asked for, and it
makes "what did this cost?" unanswerable before the fact.

## Consequences

- The ordinary failure path moves no money at all, which is why it is safe.
- A reservation is a real constraint on spending: available balance is the
  ledger balance minus active holds, so a customer cannot start more checks
  than they can pay for.
- A reservation cannot last forever — see ADR-0081.
