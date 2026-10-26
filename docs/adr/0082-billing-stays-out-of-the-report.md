# ADR-0082: Billing never enters the canonical report

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 11

## Context

Phase 7 made a check report an immutable, canonicalized, hashed artifact. Its
hash is the thing that lets anyone verify later that a report says what it said
when it was issued, and a report already issued must keep verifying for ever.

Phase 11 adds a price, a purchase and a charge to the same workflow. It would
be easy — and tempting — to put the amount paid into the report: it is true, it
is about the same event, and someone will eventually ask for it on an invoice.

Doing so would change the canonical bytes of every report, and therefore every
report hash. Reports issued before the change would no longer match reports
issued after it for identical evidence, and the golden fixtures that prove the
canonicalization is stable would all have to be regenerated — which is exactly
the moment a canonicalization bug becomes invisible.

It would also conflate two domains that answer to different people. A report is
compliance evidence. A charge is a commercial fact. A reader verifying a report
should not have to care what it cost, and an auditor reconciling revenue should
not be reading rule outcomes.

## Decision

**No price, purchase, hold, balance or charge appears anywhere in the canonical
report, and `REPORT_CANONICALIZATION_VERSION` is not bumped by Phase 11.**

- `CheckReportBuilder` is untouched. `reportHash` and `evaluationHash` for
  identical evidence are byte-for-byte what they were before checks were paid
  for, and the Phase 7 golden fixtures pass unchanged.
- Billing reaches the customer through the API's `billing` block on a check,
  and through their PalCert Balance transaction history. Both are outside the
  artifact.
- A test asserts the negative directly: the stored artifact matches no
  billing vocabulary at all.

## Alternatives considered

**Add billing and bump the canonicalization version.** Rejected. A versioned
bump is the right tool for a change to what a report *means*; using it to
attach commercial metadata spends the mechanism on something that is not
evidence, and invalidates every golden fixture for no compliance gain.

**A second, parallel "receipt" artifact.** Not rejected on principle — it is a
reasonable future feature — but not built, because nothing in Phase 11 needs
it and an unused artifact format is a liability.

## Consequences

- Report verification is unaffected by anything commercial, for ever.
- An invoice, when one is wanted, is built from the purchase and the ledger,
  which is where the authoritative numbers already live.
- The separation is enforced by test rather than by memory, so someone adding
  a field to the report will be told what they have done.
