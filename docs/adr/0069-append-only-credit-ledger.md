# ADR-0069: The balance is a derived sum of an append-only ledger

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 10

## Context

The obvious way to hold a balance is a column: `users.balance = 20.00`, updated
on every charge. It is also the way that loses money.

An `UPDATE` destroys the previous value, so when a balance is wrong there is
nothing to reconstruct it from. Two concurrent updates lose one of them unless
every path remembers to lock. A refund that runs twice is invisible after the
fact. And an "adjustment" — a support agent fixing a mistake — is
indistinguishable from a charge, so nobody can answer the question an auditor
always asks: *why is this number what it is?*

The alternative is the one double-entry bookkeeping settled on several
centuries ago: the balance is not stored, it is *derived* from an immutable
record of every movement.

## Decision

**`credit_ledger_entries` is append-only. The balance is the sum of its
entries. Corrections are new, opposing entries, never edits.**

- Every entry carries a type (`TOP_UP_CREDIT`, `SERVICE_CHARGE`,
  `PAYMENT_REFUND_DEBIT`, `CHARGEBACK_DEBIT`, …), a signed amount, a reason
  code, the reference that caused it, and who or what created it.
- A database CHECK requires the sign to match the type, so a `SERVICE_CHARGE`
  cannot be positive and a `TOP_UP_CREDIT` cannot be negative. Zero-amount
  entries are refused.
- Immutability is enforced by a trigger that raises on **`UPDATE` and
  `DELETE`** — including from the schema-owning role — and by an explicit
  `REVOKE UPDATE, DELETE` on the application role, because Phase 2's
  `ALTER DEFAULT PRIVILEGES` had granted them.
- A mistake is corrected by a compensating entry that records
  `reversal_of_entry_id`. A trigger requires the reversal to be the opposite
  sign of, and on the same account as, the entry it reverses.
- Idempotency is a unique key on the entry. The same `(account, idempotency
  key)` cannot be inserted twice, so a retried webhook, a replayed job and a
  duplicated request all converge on one entry.
- Balance is `SUM(amount_minor)` over the account. A separate
  `rebuildBalance` replays the entries independently, and a verification
  endpoint compares the two along with three other invariant families.

## Alternatives considered

**A balance column with row-level locking.** Rejected. It is correct under
concurrency and still answers no historical question at all. The lock is
needed either way (see ADR-0070); the column adds nothing but a place for the
truth to diverge.

**A balance column maintained by a trigger over the ledger.** Rejected as the
*source of truth*, though it remains available later as a cache. A cache that
is also the authority is just a slower way to be wrong; if it is ever added it
must be reconstructible and periodically verified against the ledger.

**Soft deletes on ledger entries.** Rejected. A `deleted_at` column is an
`UPDATE` with better manners. The entry stays; a second entry says what
changed.

## Consequences

- Balance costs an aggregate rather than a column read. At the volumes Phase 10
  contemplates this is not a problem; an indexed materialization can be added
  later without changing what is authoritative.
- Nothing in the system — no admin path, no support tool, no migration — can
  quietly change financial history. Finance's corrective power is the power to
  *append* a compensating entry, with a reason code and their user id on it.
- A negative balance is representable and is not fabricated away. A chargeback
  debits the account; if that takes it below zero the customer is told why
  (ADR-0075).
