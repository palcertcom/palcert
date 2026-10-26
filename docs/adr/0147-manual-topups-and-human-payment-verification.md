# ADR-0147: Manual top-ups and human payment verification

- **Status:** Accepted
- **Date:** 2026-10-02
- **Phase:** Post-RC finance
- **Amends:** [ADR-0116](0116-a-notification-is-never-the-authority.md) (Phase 16 events may be platform-scoped for manual top-ups only)
- **Related:** [manual top-ups](../architecture/manual-topups.md), [API](../api/manual-topups.md), [finance](../architecture/finance.md)

## Context

PalCert's only way to add credit was a card payment through the payment
provider (Phase 10). In Palestine most people pay by bank transfer or through
a mobile payment app (Jawwal Pay, PalPay, Bank of Palestine). Those transfers
happen outside PalCert, so PalCert cannot verify them automatically: a person
reports the transfer, and a PalCert finance reviewer matches it against the
receiving account before anything is credited.

Three existing rules had to be kept, and two existing designs could not hold
the feature as they stood. Both conflicts were reported before any change was
made, and the decisions below were taken by the product owner.

1. **Notifications required an organization.** `domain_events` and
   `user_notifications` declared `organization_id NOT NULL`, and every reviewer
   audience was resolved from an organization's members. A manual top-up
   happens to a person and to PalCert — no organization is involved — and its
   reviewers are PalCert staff holding a platform (GLOBAL) role.
2. **The ledger's sign rule listed every entry type explicitly.** A new
   credit type cannot be written until that CHECK knows it.

## Decision

1. **One ledger, one new credit type.** Approval appends exactly one
   `MANUAL_TOPUP_CREDIT` entry (positive, CASH, reference
   `MANUAL_TOPUP_REQUEST`, reason `MANUAL_TOPUP_APPROVED`, idempotency key
   `manual-topup:<request-id>:credit`) to `credit_ledger_entries`. There is no
   second wallet and no balance column; the balance is still the sum. The
   provider top-up model (`balance_topups`) is untouched and is not reused.
   The sign CHECK is replaced, in one transaction, by the same rule with the
   new type added — strictly wider, re-validated against every existing row.
   A shape CHECK and a partial unique index make a manual credit that is not
   cash, not tied to a request, or a second one for the same request
   impossible regardless of the application. Direct finance adjustments may
   not use the approval reason.
2. **Separation of duties, unchanged in spirit.** `PALCERT_ADMIN` manages
   payment methods and reads the queue (`admin:payment-method:read|manage`,
   `finance:manual-topup:read`); `PALCERT_FINANCE` reviews and decides
   (`finance:manual-topup:read|review|approve|reject`, plus
   `admin:payment-method:read`); `PALCERT_AUDITOR` reads. The administrator
   does **not** gain money-moving authority; a deployment that wants one
   person to do both assigns both roles explicitly. Nobody may decide a
   top-up they reported. Approval also requires a recent sign-in.
3. **Phase 16 extended, not duplicated (option 1).** `organization_id` may be
   NULL on `domain_events` and `user_notifications` **only** for the three
   manual top-up types, and must be NULL for them — a CHECK holds both
   directions, and platform events can never be webhook-eligible. A new
   audience, `PLATFORM_FINANCE_REVIEWERS`, is resolved from users holding
   `finance:manual-topup:review` through a GLOBAL role (organization grants
   of the same code never count); the email worker re-checks it at send time.
   Every existing branch of the audience, reviewer and resolver functions is
   reproduced unchanged, and existing rows are untouched.
4. **Email content is a typed allow-list.** The copy stays fixed sentences.
   Manual top-up mail adds a closed list of facts — amount, currency, method
   name, the reference the person typed, and a fixed sentence per rejection
   reason — read from the request at render time through a database function
   that answers only to the fan-out path or the notification's own
   recipient. Never the receipt, an IBAN, a phone number or anybody's
   address, and never carried on the event payload (which holds only the
   request id).
5. **A request is a state machine the database enforces.** DRAFT →
   PENDING_REVIEW (owner) → APPROVED | REJECTED (finance) or CANCELLED (owner,
   only before review starts). The destination snapshot is frozen at
   creation; what was reported is frozen at submission; terminal states never
   change. Concurrent decisions serialize on a row lock: one wins, the other
   is told the request was already decided.
6. **One transfer, one credit.** `UNIQUE(payment_method_id,
   reference_normalized)` over requests that are pending or approved. A
   reference finance rejected (an amount typed wrong, say) may be reported
   again, and a cancelled draft does not burn it. The refusal is one generic
   error that never says whose reference it is or what state it is in.
7. **Receipts and logos use the existing upload pipeline.** Server-generated
   quarantine keys, exact-version finalize, signature detection, malware scan,
   immutable promotion, short-lived signed downloads. Receipts are private to
   their owner and finance (every finance viewing is audited); logos are
   raster only — SVG is refused, because PalCert has no sanitizer it trusts.

## Alternatives considered

- **A separate notification subsystem for platform staff.** Rejected by the
  product owner: two pipelines to keep consistent, two preference models.
- **Letting `PALCERT_ADMIN` approve.** Rejected: publishing where money goes
  and deciding that money arrived are the two halves of a fraud; they stay
  with different roles.
- **Unique references across all statuses.** Rejected as worse for honest
  users (a typo in the amount would make a real transfer unreportable)
  without adding protection: the invariant that matters — one credit per
  transfer — is enforced over pending and approved requests and by the
  ledger's own unique index.
- **An identity column to order request history.** Rejected: the sequence
  would need a grant the read-only backup role is deliberately never given.
  History rows are stamped with `clock_timestamp()` instead.

## Consequences

- Finance can credit balances from transfers PalCert cannot see; the control
  is the human review, its permissions, its audit trail and
  `verify-ledger`, which now checks both directions (every approved request
  has exactly one matching credit; every manual credit has an approved
  request) and repairs nothing.
- Organization-scoped notifications behave exactly as before; a migration
  fingerprint on a copy of staging proves no existing row changed.
- Receipts and logos are covered by backup reference closure and restore
  re-pinning like every other stored file.
