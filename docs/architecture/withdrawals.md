# Withdrawals and payouts

> [ADR-0150](../adr/0150-unified-withdrawals-and-payout-settlement.md).
> One controlled workflow pays money out of PalCert: a user's eligible real
> money, an organization's settled attestation earnings, or PalCert's own
> realized revenue. Every request is reserved at submission, approved by
> someone other than the requester, and paid by a person outside PalCert. It
> is settled exactly once when the transfer reference is recorded. v1 makes
> no bank or wallet API call.

```
submit (requester, Idempotency-Key)
   │   one transaction, under the beneficiary's lock:
   │     withdrawable check (per currency) + min/max limit + ≤ 5 open
   │     destination snapshot sealed into the request
   │     USER: credit_hold WITHDRAWAL (CASH)   ORG/PLATFORM: withdrawal_reservations ACTIVE
   │     events SUBMITTED + RESERVED → domain event → finance + requester notified
   ▼
PENDING_REVIEW ── reject (reason) ──► REJECTED   reservation released
   │           ── cancel ──────────► CANCELLED  reservation released
   ▼ approve (re-states amount+currency, recent auth, not the requester)
APPROVED ──────── cancel ──────────► CANCELLED  reservation released
   ▼ start-execution (recent auth; separation of duties)
PROCESSING ─────── mark-failed ────► FAILED     reservation KEPT
   │                                  ├─ retry   → PROCESSING (new attempt)
   │                                  └─ release (reason) → CANCELLED
   ▼ mark-paid (reference, re-states amount+currency, recent auth)
PAID   one transaction: consume reservation (USER: WITHDRAWAL_DEBIT entry)
       + withdrawal_settlements row keyed withdrawal:<id>:settle
```

## Scopes and who may ask

| Scope        | Whose money                         | Request permission                                                | Destination owner |
| ------------ | ----------------------------------- | ----------------------------------------------------------------- | ----------------- |
| USER         | the requester's own CASH            | `balance:withdraw:self`                                           | the user          |
| ORGANIZATION | the organization's net share        | `organization:withdrawal:request` (ORGANIZATION_OWNER only)       | the organization  |
| PLATFORM     | PalCert's realized revenue          | `finance:platform-withdrawal:request`                             | PalCert           |

An organization is identified by `organization_id` and PalCert by the
PLATFORM scope alone. No user row stands for either. A destination is usable
only by a request of the same scope and beneficiary. Any other destination
reads as not found.

## What is withdrawable

Every figure is computed per currency, and currencies are never added
together. The formulas are pure functions in
`packages/contracts/src/finance/withdrawals.ts`, each with its tests.

### USER: conservative

```
eligible     = Σ verified manual top-ups past clearing
             − Σ every CASH outflow (charges, refunds out, paid withdrawals …)
             − Σ active withdrawal holds
spendable    = CASH ledger balance − Σ all active CASH holds
withdrawable = max(0, min(eligible, spendable))
```

- Clearing defaults to 14 days (bounds 0–90). It counts from
  `manual_topup_requests.decided_at`, the moment finance approved the
  top-up.
- Card top-ups are **not** withdrawable in v1. A card top-up is refunded to
  the card instead, and the withdraw page explains the difference.
- `ADMIN_CREDIT`, chargeback reversals and every PROMOTIONAL credit never
  count.
- **A card refund also lowers what is withdrawable (accepted for v1).** The
  external refund writes a `PAYMENT_REFUND_DEBIT`, which is a CASH outflow,
  and the formula subtracts every CASH outflow from eligible money. So
  refunding card money back to the card reduces the withdrawable amount by
  the refund, even though the refunded money was never eligible. Example
  (from the e2e suite): 100.00 manual top-up cleared, 20.00 withdrawal
  reserved, then a 200.00 card top-up refunded in full. Withdrawable goes
  from 80.00 to 0. This is the conservative rule working as designed. It
  under-counts and never over-pays, and it stays in v1 by decision. Changing
  it means changing the formula, which needs a new decision and ADR.

> **Why not "withdrawable = CASH balance"?** CASH is one pooled account. Card
> top-ups, manual top-ups, finance adjustments and chargeback reversals all
> credit it, and a debit never records which credit it consumed. History
> therefore cannot prove which part of a CASH balance is real money the user
> sent. The formula assumes every outflow spent eligible money first. It may
> under-count a user, but it can never pay out credit that was not real
> money. Do not "simplify" it.

The balance page shows the breakdown: eligible, in clearing, not eligible
(card, admin credit, promotional), reserved, and withdrawable.

### ORGANIZATION: settled net share

```
available = Σ INSTITUTION revenue settled before (now − clearing)
          − Σ paid organization payouts − Σ active organization reservations
```

Clearing defaults to 30 days (bounds 0–180), counted from
`attestation_settlements.settled_at`. The gross fee, PalCert's commission and
unsettled fees never count. The earnings page shows realized, clearing,
reserved, paid out and available.

### PLATFORM: realized revenue

```
realized  = CASH-funded captures of delivered/refunded purchases
          + settled PLATFORM attestation commission
          − CASH service refunds
          − unrecovered chargeback losses (Σ negative CASH balances)
available = realized − Σ paid platform payouts − Σ active platform reservations
```

Promotional-funded captures are excluded, because no money arrived for them.

## Reservation and locking

- **USER:** a `credit_holds` row with purpose `WITHDRAWAL`, always CASH and
  keyed `withdrawal:<id>:reserve`. It goes through the existing hold
  machinery, so it already counts against spendable balance for checks,
  SmartFix and attestations. Capture maps the purpose to a `WITHDRAWAL_DEBIT`
  ledger entry with reason `WITHDRAWAL_PAID`.
- **ORGANIZATION / PLATFORM:** the service first runs `INSERT … ON CONFLICT
  DO NOTHING` on `withdrawal_accounts` (one row per beneficiary and currency).
  It then takes `SELECT … FOR UPDATE` on that row, computes availability and
  inserts an ACTIVE `withdrawal_reservations` row, all in one transaction.
  The anchor carries no amount and a trigger makes it immutable.

The race test fires two 8,000 requests at 10,000 available. Exactly one
succeeds and the other is refused with `WITHDRAWAL_EXCEEDS_AVAILABLE`.

## Separation of duties

| Act                      | Permission                     | Extra rule                                                                         |
| ------------------------ | ------------------------------ | ---------------------------------------------------------------------------------- |
| read queue / detail      | `finance:withdrawal:read`      |                                                                                    |
| start review, reject, reveal destination | `finance:withdrawal:review` | reveal is audited                                                   |
| approve                  | `finance:withdrawal:approve`   | not the requester; recent auth; re-state amount and currency                        |
| release a FAILED request | `finance:withdrawal:approve`   | recent auth; written reason                                                         |
| start / paid / failed / retry / proof | `finance:withdrawal:execute` | not the requester; start and paid need recent auth                      |

- **PLATFORM:** requester, approver and executor are three different people.
- **USER / ORGANIZATION:** the approver may also execute, but only on a
  session authenticated after the approval.

Each violation returns 403 `WITHDRAWAL_SEPARATION_OF_DUTIES`.

## Destinations and encryption

`payout_destinations` stores the type (BANK_ACCOUNT, MOBILE_WALLET or OTHER),
the label, the beneficiary name and an optional currency in the clear. The
sensitive details are sealed with AES-256-GCM:

| Variable                                   | Meaning                                  |
| ------------------------------------------ | ---------------------------------------- |
| `PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID` | key id used for new writes               |
| `PAYOUT_DESTINATION_ENCRYPTION_KEYS`       | `kid:base64key,…`; old kids stay to read |

- The AAD is `palcert.payout-destinations.v1 | kid | purpose | record id`,
  so a ciphertext copied to another row or purpose does not open.
- This key ring is separate from the email-settings key, which is never
  reused.
- If the key ring is unset, the API still starts, but every destination write
  and every submission is refused with 503
  `PAYOUT_DESTINATION_ENCRYPTION_UNAVAILABLE`.
- Submission seals a copy of the destination into the request (purpose
  `WITHDRAWAL_REQUEST_SNAPSHOT`). Finance always pays the snapshot.
- Views show masked values only (`•••• 1234`). The full snapshot is returned
  only by `GET /admin/withdrawals/:id/destination`.

## Notifications

| Event                       | Audience                    | Email subject (EN)                     |
| --------------------------- | --------------------------- | -------------------------------------- |
| `WITHDRAWAL_PENDING_REVIEW` | withdrawal reviewers        | Withdrawal request: 500.00 USD         |
| `WITHDRAWAL_SUBMITTED`      | requester (org: owners)     | Your withdrawal request was submitted: …|
| `WITHDRAWAL_APPROVED`       | requester                   | Your withdrawal was approved: …        |
| `WITHDRAWAL_REJECTED`       | requester                   | Your withdrawal request was rejected: …|
| `WITHDRAWAL_PAID`           | requester                   | Your withdrawal was paid: …            |
| `WITHDRAWAL_FAILED`         | requester                   | Your withdrawal transfer did not go through: …|

- Emails contain the amount, scope, beneficiary label, masked destination
  and a deep link:
  - user: `/balance/withdrawals/<id>`;
  - organization: `/organizations/<org>/payouts/<id>`;
  - finance and platform: `/admin/withdrawals/<id>`.
- Emails never contain a full IBAN, account or mobile number, and never an
  attachment.
- Reviewers are configured in `/admin/withdrawal-settings`. If none
  qualifies, alerts fall back to every active GLOBAL holder of
  `finance:withdrawal:review`.
- Routing is audited (`WITHDRAWAL_REVIEWERS_RESOLVED`, `_REVIEWER_FALLBACK`,
  `_NO_REVIEWER_AVAILABLE`). The admin detail page lists each recipient's
  in-app and email delivery state.

## Database guarantees

- A trigger on `withdrawal_requests` enforces the transition table. It keeps
  the amount, currency, scope, beneficiary and snapshot immutable, and
  requires the reference on PAID.
- `withdrawal_settlements` is unique per request and on the settlement key,
  and cannot be updated or deleted.
- `withdrawal_execution_attempts`, `withdrawal_request_events` and consumed
  or released reservations are append-only.
- The ledger sign rule admits `WITHDRAWAL_DEBIT` as a negative CASH entry. A
  CHECK allows a WITHDRAWAL hold only on CASH.
- RLS:
  - users see their own requests and destinations;
  - organization members see their organization's;
  - PLATFORM rows and the finance queue need the platform-admin context.

## API surface

| Route                                                         | Permission                             |
| ------------------------------------------------------------- | -------------------------------------- |
| `GET /balance/withdrawable?currency=`                         | `balance:read:self`                    |
| `GET/POST/PATCH /balance/payout-destinations[/:id][/archive]` | `balance:withdraw:self`                |
| `POST /balance/withdrawals` · `POST …/:id/cancel`             | `balance:withdraw:self`                |
| `GET /balance/withdrawals[/:id][/proof]`                      | `balance:read:self`                    |
| `GET /organizations/:org/payouts/earnings` · list · detail · proof | `organization:withdrawal:read`    |
| `POST /organizations/:org/payouts` · `…/:id/cancel`           | `organization:withdrawal:request`      |
| `…/payouts/destinations` (read / manage)                      | `organization:payout-destination:*`    |
| `GET /admin/platform-funds` · `GET …/withdrawals`             | `finance:withdrawal:read`              |
| `POST /admin/platform-funds/withdrawals` · `…/:id/cancel`     | `finance:platform-withdrawal:request`  |
| `…/admin/platform-funds/destinations` (read / manage)         | `finance:payout-destination:*`         |
| `GET /admin/withdrawals[/:id][/notifications][/proof]`        | `finance:withdrawal:read`              |
| `GET /admin/withdrawals/:id/destination`                      | `finance:withdrawal:review`            |
| `POST /admin/withdrawals/:id/{start-review,reject}`           | `finance:withdrawal:review`            |
| `POST /admin/withdrawals/:id/{approve,release}`               | `finance:withdrawal:approve`           |
| `POST /admin/withdrawals/:id/{start-execution,mark-paid,mark-failed,proofs…}` | `finance:withdrawal:execute` |
| `GET/PUT /admin/withdrawal-settings/{policy,limits,reviewers}` | read / `admin:withdrawal-policy:manage` |
| `POST /admin/withdrawal-settings/reconciliation`              | `finance:withdrawal:read`              |

## Reconciliation

`POST /admin/withdrawal-settings/reconciliation` reports and never repairs.
It can return these findings:

- `PAID_SETTLEMENT_COUNT`
- `PAID_SETTLEMENT_AMOUNT`
- `PAID_LEDGER_MISMATCH`
- `OPEN_RESERVATION_MISSING`
- `CLOSED_RESERVATION_NOT_RELEASED`
- `ORPHAN_WITHDRAWAL_HOLD`
- `PROMOTIONAL_WITHDRAWAL_HOLD`
- `ORGANIZATION_OVERCOMMITTED`
- `PLATFORM_OVERCOMMITTED`

Each run is audited as `WITHDRAWAL_RECONCILIATION_RUN`.

## Refunds, chargebacks and disputes

- A user's later chargeback can make CASH negative. Spendable becomes zero,
  so nothing is withdrawable, and the loss reduces PalCert's realized revenue
  until it is recovered.
- A PAID withdrawal is never edited. A correction is a separate compensating
  operation (out of scope for v1).
- A service refund lowers platform realized revenue. Its CASH credit back to
  the user does not count as an eligible inflow.

## Tests

- `packages/contracts/src/finance/withdrawals.spec.ts` covers the formulas,
  validators, masking and the transition table.
- `apps/api/src/modules/withdrawals/payout-destination-keyring.spec.ts`
  covers rotation, row binding and refusal without keys.
- `apps/api/test/withdrawals-journey.e2e-spec.ts` covers:
  - the full user journey;
  - D1/D2/D3;
  - the 8,000 + 8,000 race;
  - idempotency;
  - snapshot immutability;
  - FAILED/retry/release;
  - separation of duties and re-authentication;
  - safe emails;
  - reviewer routing.
- `apps/api/test/withdrawals-organization-platform.e2e-spec.ts` covers:
  - the organization net share and isolation;
  - D6;
  - platform realized revenue with three distinct people.

Every test uses the fake email provider and the test clock. No test makes a
real transfer or sends a real email.
