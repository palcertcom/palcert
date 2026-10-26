# ADR-0070: Spending is a two-step reservation, serialized by a row lock

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 10

## Context

"Check the balance, then charge it" is two operations. Between them, another
request can do the same thing. With a $5 balance and two concurrent $4
requests, both read $5, both decide yes, and the customer ends up $3 overdrawn
on services PalCert has already performed.

There is a second problem that is not about concurrency. A document check takes
time and can fail. Charging up front means refunding on failure — a second
money movement, a second chance to get it wrong, and a window in which the
customer has paid for nothing. Charging afterwards means performing work for a
customer who may no longer have the funds.

Both problems have the same shape as an authorization on a card, and the same
answer.

## Decision

**Money is *reserved* before work starts and settled afterwards: capture on
success, release on failure. A reservation is taken under
`SELECT … FOR UPDATE` on the account row.**

- A `credit_holds` row records the reserved amount, the purpose, an expiry, and
  a status that only moves `ACTIVE → CAPTURED | RELEASED | EXPIRED`. All three
  outcomes are terminal, enforced by a trigger.
- Available balance is `ledger balance − sum of ACTIVE holds`. A hold is not a
  ledger entry: nothing has been spent yet, and inventing a debit that may be
  reversed would put a transaction in the customer's history that never
  happened.
- Every hold is created inside a transaction that first takes an exclusive lock
  on the account row. The second of two racing requests therefore *waits*,
  then reads the balance the first one left, and correctly refuses. This is the
  entire concurrency mechanism, and it is why exactly one method creates holds.
- Capture appends the debit and marks the hold `CAPTURED` in the same
  transaction, under the hold's own idempotency key. Release simply ends the
  hold; there is nothing to reverse.
- Holds expire. A sweeper releases any hold past its TTL, so a crashed worker
  cannot strand a customer's money indefinitely.

## Alternatives considered

**Optimistic concurrency (compare-and-set on a balance version).** Rejected.
It works, but it turns every over-spend race into a retry loop in application
code, and the failure mode when someone forgets the retry is a lost update.
The lock puts the correctness in the database.

**`SERIALIZABLE` isolation.** Rejected as the general mechanism. It is correct
but converts contention into serialization failures that every caller must
handle; `FOR UPDATE` on one well-chosen row is narrower and its behaviour under
contention is easier to reason about.

**Advisory locks.** Rejected. They are not tied to the row they protect, so
nothing stops a future code path from writing to the account without taking
one.

**Charge immediately, refund on failure.** Rejected for the reasons above: it
doubles the money movements and shows the customer a charge that should never
have existed.

## Consequences

- Concurrent spending is safe by construction, and proven: the test suite races
  two $4 holds against a $5 balance and ten simultaneous requests against a
  balance that can fund three, and asserts that the number that succeed is
  exactly the number that can be funded.
- Reserved money is visible to the customer as *reserved*, not missing.
- A hold is the integration point Phase 11 will use for paid checks:
  reserve, perform, capture or release. Phase 10 deliberately does not wire it
  to `POST /checks`.
