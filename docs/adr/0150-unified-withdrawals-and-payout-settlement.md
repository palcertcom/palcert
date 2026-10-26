# ADR-0150: Unified withdrawals and payout settlement

- **Status:** Accepted
- **Date:** 2026-10-04
- **Phase:** Post-RC finance
- **Builds on:** [ADR-0069](0069-append-only-credit-ledger.md) (ledger), [ADR-0070](0070-credit-holds-and-row-locks.md) (holds), [ADR-0148](0148-payment-method-reviewer-assignment.md) (reviewer assignment), [ADR-0149](0149-centralized-billing-for-customer-initiated-ai-services.md) (purchase domain for AI)
- **Related:** [Withdrawals](../architecture/withdrawals.md), [finance](../architecture/finance.md)

## Context

Money enters PalCert in several ways:

- card top-ups;
- manual (bank or mobile-wallet) top-ups that finance verifies;
- attestation fees, split at settlement into an INSTITUTION net share and a
  PLATFORM commission;
- captured service purchases.

Nothing let money leave. A user could not withdraw an unspent balance, an
institution could not collect its attestation earnings, and PalCert had no
recorded way to move its own revenue to its treasury.

The pre-flight inventory found three facts that shape the design:

1. **CASH is ambiguous.** A user's CASH account is one pooled balance. It is
   credited by card top-ups, verified manual top-ups, finance adjustments
   (`ADMIN_CREDIT`) and chargeback reversals. A debit records no link to the
   credit it consumed, so the real-money provenance of any CASH balance
   cannot be recovered from history. "Withdrawable = CASH balance" would let
   an admin credit, or a stolen card's top-up, be paid out to a bank account.
2. **Organizations and PalCert have no wallet.** Their money exists only as
   derived facts: `attestation_revenue_entries` (INSTITUTION or PLATFORM),
   captured holds of delivered purchases, refunds and chargebacks. There is no
   balance row to debit, and none may be invented.
3. **There is no payout provider.** v1 transfers are made by a person in a
   bank or wallet app, outside PalCert.

## Decision

1. **One workflow, three scopes.** A `withdrawal_requests` row has exactly one
   scope:
   - USER: a person's own eligible real money;
   - ORGANIZATION: an organization's settled attestation net share;
   - PLATFORM: PalCert's realized revenue.

   Organizations are named by `organization_id`, and PalCert by nothing.
   No fake User row is created, and no user id ever stands for an
   organization or for PalCert. Every scope shares one state machine, one
   review queue, one settlement rule and one audit vocabulary.

2. **The state machine.**

   ```
   DRAFT → PENDING_REVIEW → APPROVED → PROCESSING → PAID
                 │              │           │
                 ├→ REJECTED    └→ CANCELLED└→ FAILED ⇄ PROCESSING
                 └→ CANCELLED                  FAILED → CANCELLED
   ```

   - PAID, REJECTED and CANCELLED are terminal.
   - A database trigger enforces the same transition table as the contracts.
   - Every change is guarded by `expectedVersion`; a stale write is refused
     with 412 `WITHDRAWAL_CONFLICT`.

3. **Reserve at submission.** The amount is unavailable elsewhere from the
   moment of submission.
   - **USER:** a CASH `credit_hold` with purpose `WITHDRAWAL`, keyed
     `withdrawal:<id>:reserve`.
   - **ORGANIZATION / PLATFORM:** a `withdrawal_reservations` row, taken under
     a row lock on the beneficiary's `withdrawal_accounts` anchor. The anchor
     is created by `INSERT … ON CONFLICT` and then locked with
     `SELECT … FOR UPDATE`. It is a lock anchor only, never a balance, and a
     trigger makes it immutable.

   Concurrent requests serialize on the lock. Two 8,000 requests against
   10,000 cannot both succeed, and the race test proves it.

4. **Withdrawability is conservative and per currency.** Currencies are never
   summed. Each formula is a pure function in `@palcert/contracts`, with a
   test beside it.
   - **USER (D1, D2, D3):**
     - `eligible = cleared verified manual top-ups − every CASH outflow −
       active withdrawal holds`;
     - `withdrawable = min(eligible, CASH balance − all active CASH holds)`,
       never below zero.
     - Every outflow is assumed to have consumed real money first.
     - Card top-ups, admin credits, chargeback reversals and promotional
       credit never count. A card top-up is refunded to the card instead,
       and the UI says so.
     - A manual top-up clears 14 days (bounds 0–90) after finance approved
       it. The clock starts at `manual_topup_requests.decided_at`.
     - A user may be under-counted. Non-real money can never leave as cash.
     - Accepted for v1: refunding card money to the card (a
       `PAYMENT_REFUND_DEBIT`, a CASH outflow) also lowers the withdrawable
       amount by the refund. Example: 80.00 withdrawable, then a 200.00 card
       top-up refunded in full, leaves 0. The formula stays as it is. A
       change needs a new decision.
   - **ORGANIZATION (D4):** only the settled INSTITUTION net share counts,
     after a 30-day clearing period (bounds 0–180) from `settled_at`. Paid
     payouts and active reservations are subtracted. The gross fee, PalCert's
     commission and unsettled fees never count.
   - **PLATFORM (D5):** only realized revenue counts:
     - plus: the CASH-funded part of captured holds on delivered or refunded
       purchases;
     - plus: settled PLATFORM commission;
     - minus: CASH service refunds;
     - minus: unrecovered chargeback losses (Σ negative CASH balances);
     - minus: paid platform payouts and active platform reservations.

     Promotional-funded captures are excluded, because PalCert received no
     money for them. Where a source cannot be reconciled exactly, the lower
     figure is used.

5. **Limits, no fee.** Finance configures a minimum and maximum per currency
   (`withdrawal_currency_limits`). A beneficiary may hold at most five open
   requests per scope. There is no withdrawal fee in v1
   (`WITHDRAWAL_FEE_MINOR = 0`). A fee would need an explicit, versioned
   policy and its own ADR, never a hidden deduction.

6. **Settle exactly once, only on PAID.** `mark-paid` requires:
   - an external transfer reference;
   - a re-statement of the amount and currency (a forged amount is refused);
   - recent authentication.

   In one transaction it then:
   - consumes the reservation (USER: captures the hold, which writes one
     `WITHDRAWAL_DEBIT` ledger entry with reason `WITHDRAWAL_PAID`;
     ORGANIZATION and PLATFORM: marks the reservation CONSUMED);
   - writes one `withdrawal_settlements` row, unique on
     `withdrawal:<id>:settle`;
   - closes the execution attempt as SUCCEEDED.

   A replay finds the settlement and changes nothing. Organization and
   platform settlements write no ledger entry, because those scopes have no
   ledger account. Reject and cancel release the reservation in the same
   transaction as the status change.

7. **FAILED keeps the reservation (D9).** A transfer reported as failed may
   still arrive, so FAILED releases nothing. From FAILED, finance can either:
   - retry, which opens a new execution attempt; or
   - release deliberately, with a written reason, which cancels the request.

   `withdrawal_execution_attempts` is append-only.

8. **Separation of duties (D8).** Viewing, reviewing, approving and executing
   are separate permissions (`finance:withdrawal:read`, `:review`,
   `:approve`, `:execute`). The service enforces three rules on top:
   - The requester never approves or executes their own request.
   - Approve, start-execution, mark-paid and release require recent
     authentication.
   - **PLATFORM:** requester, approver and executor are three different
     people.
   - **USER / ORGANIZATION:** the approver may also execute, but only on a
     session that authenticated *after* the approval (`mfaCompletedAt` or the
     session start must be later than `approvedAt`).

   A refusal returns `WITHDRAWAL_SEPARATION_OF_DUTIES`. Who may request:
   - `balance:withdraw:self` (USER);
   - `organization:withdrawal:request`, held by ORGANIZATION_OWNER only (D6);
   - `finance:platform-withdrawal:request` (PLATFORM).

9. **Destinations: owned, encrypted, snapshotted (D7).**
   - A payout destination belongs to exactly one beneficiary, matching the
     request scope. A destination outside the requester's scope reads as
     not found.
   - The sensitive fields (IBAN, account number, mobile number, branch,
     instructions) are sealed with AES-256-GCM under a dedicated key ring:
     `PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID` and
     `PAYOUT_DESTINATION_ENCRYPTION_KEYS`. The AAD binds the purpose, the key
     id and the row id.
   - The email-settings key is never reused. Without keys, writes are refused
     with 503 `PAYOUT_DESTINATION_ENCRYPTION_UNAVAILABLE`.
   - On submission the destination is copied into the request as a separately
     sealed snapshot (purpose `WITHDRAWAL_REQUEST_SNAPSHOT`). Editing or
     archiving the destination later never changes what finance pays.
   - Lists show only masked values. Revealing the full snapshot needs
     `finance:withdrawal:review` and is audited.

10. **Notifications without secrets.** Submission emits
    `WITHDRAWAL_PENDING_REVIEW` to finance and `WITHDRAWAL_SUBMITTED` to the
    requester. Approve, reject, paid and failed notify the requester. Each
    notification goes in-app and by email.
    - An email carries the amount, currency, scope, beneficiary label and a
      deep link. It never carries an IBAN, account or mobile number, and never
      a proof attachment.
    - Finance alerts go to the configured withdrawal reviewers. If none can
      act, they fall back to every holder of `finance:withdrawal:review`.
    - Routing is audited as `WITHDRAWAL_REVIEWERS_RESOLVED`,
      `WITHDRAWAL_REVIEWER_FALLBACK` or `WITHDRAWAL_NO_REVIEWER_AVAILABLE`.
    - The admin detail page shows per-recipient delivery diagnostics.

11. **Proof of payment is private.** An executor may attach a transfer
    receipt. It goes through the same quarantine → scan → clean pipeline as
    manual top-up receipts (job `WITHDRAWAL_PROOF_INGEST`). It is downloaded
    only through short-lived signed URLs, by finance or by the request's own
    beneficiary.

12. **Immutable history.** `withdrawal_request_events` is append-only and
    trigger-guarded. Every act also writes an audit event. Settlements,
    attempts and consumed reservations cannot be updated or deleted. A
    correction after PAID is a new compensating operation, never an edit.

13. **Reconciliation reports, never repairs.**
    `POST /admin/withdrawal-settings/reconciliation` checks:
    - one settlement per PAID request, with a matching amount and ledger
      debit;
    - a live reservation for every open request, and none for a closed one;
    - no orphan or promotional withdrawal hold;
    - no organization or platform paying out more than it is entitled to.

    It returns findings and changes nothing.

14. **Additive migration.** Two migrations (`20261006000000_withdrawal_enums`,
    `20261006000100_withdrawals`) add enums, tables, triggers, RLS policies,
    notification branches and permissions. The ledger sign rule is widened by
    one negative type and re-checked against every existing entry. No
    existing balance, ledger entry, top-up, purchase, attestation settlement
    or revenue entry is written.

15. **No automatic payouts in v1.** There is no bank API, no mobile-wallet API
    and no provider adapter. Automated tests never perform a real transfer and
    never send a real email.

## Alternatives considered

- **Withdrawable = CASH balance.** Rejected. It pays out admin credits and
  card money, which is the ambiguous-CASH finding above.
- **Tracing provenance by FIFO over the ledger.** Rejected for v1. Debits are
  not linked to credits, so any trace would be a guess presented as fact. The
  conservative bound is honest about what history can prove.
- **Organization and platform wallets (credit accounts).** Rejected. That
  would duplicate the authoritative revenue records and require a backfill
  that rewrites history. Derived availability plus reservations avoids both.
- **Releasing on FAILED.** Rejected. A late-arriving transfer would then be
  money paid out with nothing reserved.

## Consequences

- Users can withdraw only verified, cleared real money. Some users with
  legitimately mixed balances are under-counted. That is the intended cost,
  and the UI shows the breakdown.
- Organizations and PalCert are paid from authoritative facts. Their
  availability can never drift from a balance column, because there is none.
- Every payout is reserved, reviewed by someone other than the requester,
  recorded with an external reference and settled once.
- Deployments must provision the payout key ring before anyone can save a
  destination.
- Future provider integration (bank or wallet APIs) would plug in at
  start-execution / mark-paid as a new execution path writing the same
  attempts, settlements and events. It needs its own ADR.
