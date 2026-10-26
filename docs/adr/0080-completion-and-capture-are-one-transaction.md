# ADR-0080: Completion and capture are one transaction, guarded by a row lock

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 11

## Context

At the end of a check there are two things to write: the report (results,
violations, the report row, the run, the check's completion) and the money (the
capture of every reservation). Doing them as two commits gives two ways to be
wrong, and both are real.

**Complete, then charge.** The report is handed over and the charge fails — an
expired reservation, a released hold, a database blip. PalCert has done the
work for nothing and has no way to go back: the report exists and the customer
has it.

**Charge, then complete.** The money is taken and the completion fails. The
customer has paid for a report they cannot see.

There is a second contention problem on top. While the worker builds the
report, the customer may cancel, or a failure settlement may fire. All three
paths write the same check and the same purchase.

## Decision

**One transaction, entered through the check's row lock.**

Every path that settles money — completion, failure, cancellation,
reconciliation — begins by taking `SELECT … FOR UPDATE` on the
`document_checks` row and re-reading its status *inside* the transaction.
Whichever transaction takes the lock first decides; the others see a terminal
state and stop. The completion transaction then writes the report **and**
captures every hold **and** marks the check COMPLETED, or it writes none of it.

Locks are taken in one documented order everywhere
(`FINANCIAL_LOCK_ORDER`): check → purchase → holds → accounts, with accounts in
`FUNDING_ORDER`. Two purchases touching the same accounts queue rather than
deadlock.

Because the completion transaction necessarily passes through a moment where
the purchase is DELIVERED and the check is not yet COMPLETED, the cross-domain
invariants are **deferred constraint triggers**, evaluated at COMMIT:

- a DELIVERED purchase has every allocation captured, summing to its exact
  amount, and a COMPLETED check;
- a COMPLETED paid check has a settled purchase;
- a RELEASED purchase has no capture and no service charge anywhere.

## Alternatives considered

**Two commits with a compensating job.** Rejected. The compensation is itself a
money movement that can fail, and the window it covers is one in which the
customer has either a free report or a paid nothing.

**Optimistic concurrency on the check's status.** Rejected. It works for the
completion-versus-cancellation race and does nothing for the multi-row
invariants; the lock covers both and is easier to reason about.

**Immediate (non-deferred) triggers.** Rejected because they would refuse a
correct transaction on the strength of its intermediate state. Deferral is not
a loosening: the question asked at COMMIT is the only question worth asking.

## Consequences

- There is no state in which a check is CANCELLED and charged, COMPLETED and
  released, or partially captured. The race tests assert exactly that, over
  repeated rounds.
- A capture that cannot be made rolls the whole completion back, so the check
  fails and is released rather than being half-charged.
- A report artifact written before a rolled-back commit is an orphan at a
  deterministic key that the next attempt overwrites. Its existence never
  causes a charge — only the committed transaction does.
