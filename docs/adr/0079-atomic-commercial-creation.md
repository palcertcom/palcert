# ADR-0079: Buying and starting a check is one transaction, with preallocated ids

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 11

## Context

Phase 7 created a check in a transaction and then, after the commit, made sure
an analysis existed and queued the evaluation. If the API process died in
between, the check sat there doing nothing. Annoying, and free.

Once the customer's credit is reserved, the same gap means money set aside for
work that nobody ever started. The customer cannot spend it and cannot see why.
That is a support ticket at best and a refund at worst, caused by an ordinary
deploy landing at an unlucky moment.

There is a second problem in the same shape. The purchase must name the check
it paid for, and the check must name the purchase that paid. Writing one, then
the other, then going back to fix up the first is three steps, and a crash
between any two of them leaves a row pointing at nothing.

## Decision

**Everything commercial and everything structural commits together, and the ids
are allocated before the transaction starts.**

One transaction contains: the quote validated and spent, the credit reserved
across as many accounts as it takes, the purchase row, its allocation rows, the
check row, the document retention lock, and the **durable processing intent**
written to the Phase 5 outbox.

The check id and the purchase id are `randomUUID()`s generated first. The
purchase is written with `resourceId = checkId`, the check with
`servicePurchaseId = purchaseId`, and a trigger verifies the pair. Nothing is
rebound afterwards because nothing needs to be.

The API returns `202` once that intent exists. A worker consumes
`CHECK_PREPARE`, which ensures the analysis, parks the check if it is not
ready, and starts the evaluation — all idempotently, because at-least-once
delivery means it will sometimes run twice.

## Alternatives considered

**Keep the post-commit dispatch and add a sweeper for orphans.** Rejected. It
is a reconciliation job whose whole purpose is to clean up a gap that does not
need to exist; the outbox was built for exactly this in Phase 6.

**Write the check first, then the purchase, then update the check.** Rejected:
three steps and a rebinding, and the rebinding is precisely what ADR-0077's
immutability trigger forbids.

**Return `201` with the check and dispatch synchronously.** Rejected. A check
takes seconds to minutes; holding the request open for it was already refused
in Phase 7 and money does not change that.

## Consequences

- An insufficient balance leaves **nothing** behind: no check, no purchase, no
  hold, no job, and the quote is still spendable. The transaction simply rolls
  back.
- A crash immediately after the commit loses nothing: the intent is a row.
- Redis being down at creation time is not a failure either — the job row is
  committed and the outbox sweep publishes it later.
