# ADR-0090: The recheck is an ordinary check, classified in the database

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 12

## Context

Phase 11 retired the free check with a database trigger: every new
`document_checks` row must name a purchase that describes it. That rule is what
makes "a check is paid for" a fact rather than a convention.

A SmartFix recheck breaks it. The user already paid for the recheck as part of
the correction, so charging again would be charging twice for one service. But
an exception to "every check names a purchase" is exactly where a free-check
bypass would hide: any code path that can create a check without a purchase is
a code path that can create a free check.

## Decision

**`CheckPurpose` is a column, and the exception is stricter than the rule.**

- `USER_REQUESTED` (the default) still requires a `DOCUMENT_CHECK` purchase
  naming that very check, exactly as Phase 11 established.
- `SMARTFIX_RECHECK` must:
  - name a `SmartFixRequest` that exists and belongs to the same person;
  - be rechecking exactly the version that request produced;
  - carry the same `standardVersionId` the correction was planned against;
  - carry **no** `servicePurchaseId` at all.
- Purpose and the request behind it are write-once, so a user's own check
  cannot be reclassified as a recheck to make it look free, or the reverse.
- Phase 11's completion invariant is taught about rechecks: a `SMARTFIX_RECHECK`
  has no purchase, so there is nothing for it to be consistent with — and
  demanding one would be demanding a second charge.

The recheck is otherwise an ordinary check: same queue, same evaluation, same
report, same retries, same failure handling.

## Alternatives considered

**Give the recheck its own zero-priced purchase.** A £0 purchase in the ledger
is a fiction, and the pricing tables would have to carry a product that exists
only to be free.

**Skip `document_checks` and evaluate inline.** A second evaluation path, and
the recheck stops being comparable to the check it is compared against.

## Consequences

- The recheck uses the **exact historical StandardVersion**, even if it has
  since been archived or made private — checked by the trigger, so a service
  that reached for "the current version" is refused rather than quietly
  reporting against different rules.
- A recheck appears in the user's check history. It is a real check of a real
  document, and hiding it would be hiding what they bought.
