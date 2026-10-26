# ADR-0077: A purchase is a reusable domain, not a column on a check

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 11

## Context

Phase 11 makes a document check something a customer buys. The smallest thing
that would work is three columns on `document_checks`: a price, a hold id, and
a flag saying whether it was charged.

That works exactly once. The next paid thing — a correction service, a
re-check, a bundle — needs the same reservation, the same capture-on-delivery,
the same release-on-failure and the same refund path, and would either copy all
of it or grow a second, subtly different version of it. Financial logic that
exists twice is financial logic that disagrees with itself eventually.

There is a second reason, which is about the money rather than the code. A
check funded from two credit classes is *two* reservations against two
accounts. Three columns cannot hold that, and a design that assumes one hold
per check would have to be unpicked the moment promotional credit exists —
which it already does.

## Decision

**A `ServicePurchase` is one customer buying one deliverable service, and
`ServicePurchaseAllocation` records which credit paid for it.**

- A purchase names `productCode` (what was bought) and
  `(resourceType, resourceId)` (which instance). Phase 11 sells
  `DOCUMENT_CHECK` and a CHECK constraint says so; the *domain* is general.
- Its financial identity — owner, product, resource, quote, price version,
  currency, amount — is immutable, enforced by trigger. A later price change
  cannot reach a purchase that was already made.
- Its lifecycle is `RESERVED → PROCESSING → DELIVERED → REFUNDED`, with
  `RELEASED` from either pre-delivery state and `RECONCILIATION_REQUIRED`
  reachable from anywhere and terminal. There is no way back: a retry is a new
  purchase, so the billing history of a failed attempt stays exactly as it
  happened.
- One allocation per credit class per purchase, each bound to one hold. A
  deferred constraint trigger requires the allocations to sum to the purchase
  amount at COMMIT.
- `document_checks.service_purchase_id` is the binding, and a trigger requires
  every *new* check to have one that names it back.

## Alternatives considered

**Columns on `document_checks`.** Rejected on both counts above: it cannot
express multi-class funding, and the next paid thing would copy it.

**A polymorphic `payable` join table.** Rejected as premature. Two columns —
type and id — with no foreign key is exactly what a generic association needs
and no more; a join table would add a level of indirection for one product.

**A foreign key from the purchase to the check.** Tempting, and impossible in
the direction that matters: the purchase must be written first, so that the
check can name it in the same statement it is created by. `resourceId` carries
a preallocated id instead, and the trigger checks the pair (ADR-0079).

## Consequences

- Phase 12's SmartFix reuses reservation, capture, release and refund by
  adding a product code and a resource type.
- A $5 check funded with $2 promotional and $3 cash is one purchase the
  customer sees and two ledger entries the accountant sees, and neither view
  has to lie.
- Purchases are never deleted. `DELETE` is revoked from the application role,
  as it is for the ledger.
