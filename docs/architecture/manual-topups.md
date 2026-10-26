# Manual top-ups and human payment verification

A person pays PalCert by bank transfer or through a mobile payment app
(Jawwal Pay, PalPay, Bank of Palestine and the like), reports the transfer,
and a PalCert finance reviewer credits their balance after matching it
against the receiving account. Decision record:
[ADR-0147](../adr/0147-manual-topups-and-human-payment-verification.md).
API: [manual top-ups](../api/manual-topups.md).

Nothing in this feature changes the card-payment path (`balance_topups`,
the provider adapters, webhooks, reconciliation). The two share only the
ledger they credit.

## The flow

```
Admin publishes a method ─► Person opens /balance/add
                                 │ chooses a method (snapshot frozen on the draft)
                                 │ sends money outside PalCert
                                 │ enters amount + reference (+ optional receipt, note)
                                 ▼
                          DRAFT ──submit──► PENDING_REVIEW ──► finance notified
                            │                  │   (cancel only until review starts)
                            └──cancel──► CANCELLED
                                               │ start review (owner can no longer cancel)
                                               ├── approve ──► APPROVED  + one CASH ledger credit
                                               └── reject  ──► REJECTED  (reason, no money moves)
```

## Data

| Table | Classification | Notes |
| --- | --- | --- |
| `manual_payment_methods` | SYSTEM | Where to pay. Type-specific destination fields (CHECKed), min/max in minor units, optimistic `version`, never deleted (no DELETE grant); archiving is permanent. Customers read enabled, unarchived rows only (RLS). |
| `manual_payment_method_logos` | SYSTEM | Raster logos through the upload pipeline. Visible to customers only once READY and attached to a listed method. |
| `manual_topup_requests` | USER_SCOPED (`owner_user_id`) | The report and its decision. `amount_minor BIGINT`, `currency` from the method, `reference_original` / `reference_normalized`, frozen `payment_method_snapshot` (typed JSON), `credit_entry_id` (write-once, FK to the owner's ledger entry). |
| `manual_topup_receipts` | USER_SCOPED (`owner_user_id`) | Optional proof, PDF/PNG/JPEG/WEBP ≤ 5 MB, scanned before anybody can open it. |
| `manual_topup_request_events` | USER_SCOPED (`owner_user_id`) | Append-only history (stamped with `clock_timestamp()`); the source of every notification. |

Database guarantees, independent of the application:

- **State machine** (`manual_topup_requests_guard`): identity and snapshot
  frozen from creation; amount, reference, note and receipt frozen once
  submitted; terminal states final; cancellation only before review starts;
  APPROVED/REJECTED only from the platform elevation; a credit only if it is
  exactly this request's (owner, type, CASH, currency, amount, reference).
- **One transfer, one credit**: `UNIQUE(payment_method_id,
  reference_normalized) WHERE status IN ('PENDING_REVIEW','APPROVED')`, and
  `UNIQUE(reference_id) WHERE entry_type = 'MANUAL_TOPUP_CREDIT'` on the ledger.
- **Ledger shape**: `ledger_entries_sign_matches_type` lists
  `MANUAL_TOPUP_CREDIT` as positive; `ledger_entries_manual_topup_shape`
  requires CASH, a `MANUAL_TOPUP_REQUEST` reference, an author and the
  approval reason — and forbids that reference type on any other entry.
- **History** is append-only, and each side writes only as itself.

Transfer references are normalized for comparison (NFKC, Arabic-Indic digits
to ASCII, case folded, spaces/hyphens/dots/slashes/underscores removed; the
result must be 4–64 letters and digits). IBANs are checked with ISO 13616
mod-97; wallet numbers are 7–15 digits with an optional `+`.

## Approval, exactly

One transaction under the audited platform elevation:

1. `SELECT … FOR UPDATE` the request; refuse a draft (not found), a decided
   request (`MANUAL_TOPUP_ALREADY_DECIDED`, except the same reviewer's retry,
   which returns the existing result) and the reviewer's own request.
2. Require the reviewer to restate the exact amount and currency
   (`MANUAL_TOPUP_CONFIRMATION_REQUIRED` otherwise). The amount is never
   editable; a mismatch is a rejection with `AMOUNT_MISMATCH`.
3. Get or create the owner's CASH account; append one `MANUAL_TOPUP_CREDIT`
   under idempotency key `manual-topup:<id>:credit`.
4. Set `APPROVED`, `decided_at`, `approved_by_user_id`, `credit_entry_id`
   (and the review start, if nobody had opened it).
5. Append the APPROVED history row and emit its domain event in the same
   commit; write the audit row inside the transaction.

Two reviewers deciding at once serialize on step 1. Email is a separate job:
a mail failure can never roll back the credit.

## Notifications

Three platform-scoped Phase 16 types, with `organization_id` NULL (and only
these may be): `MANUAL_TOPUP_SUBMITTED` to `PLATFORM_FINANCE_REVIEWERS`
(the method's assigned reviewers who still qualify, otherwise every
GLOBAL-role holder of `finance:manual-topup:review`, re-checked at send
time — see "Reviewer assignment" below), `MANUAL_TOPUP_APPROVED` and `MANUAL_TOPUP_REJECTED` to the owner. Links
go to `/{locale}/admin/top-ups/{id}` and `/{locale}/balance/top-ups/{id}`.
The copy is fixed text plus a closed list of facts (amount, currency, method
name, reference, submitted time, fixed rejection sentence); never a receipt, IBAN, phone
number or address. Platform events are never webhook-eligible.

## Reviewer assignment (ADR-0148)

An administrator assigns finance staff to each payment method from the
payment-method form. Only ACTIVE users holding `finance:manual-topup:review`
through a GLOBAL role can be chosen; the database refuses anyone else.

| Situation at submission | Who is alerted | Recorded as |
| --- | --- | --- |
| Assigned reviewers still qualify | Those reviewers only | `MANUAL_TOPUP_REVIEWERS_RESOLVED` (`METHOD_REVIEWERS`) |
| Reviewers assigned, none qualifies | Every platform finance reviewer | `MANUAL_TOPUP_REVIEWER_FALLBACK` |
| Nobody assigned (every method before ADR-0148) | Every platform finance reviewer | `MANUAL_TOPUP_REVIEWERS_RESOLVED` (`GLOBAL_NOT_CONFIGURED`) |
| Nobody in PalCert can be alerted | Nobody | `MANUAL_TOPUP_NO_REVIEWER_AVAILABLE` |

A method cannot be offered without an eligible reviewer. Assignment grants
no permission. The review detail page shows administrators who was alerted,
in-app and email status, and why an email was skipped.

## Permissions

| Permission | PALCERT_ADMIN | PALCERT_FINANCE | PALCERT_AUDITOR |
| --- | --- | --- | --- |
| `admin:payment-method:read` | ✓ | ✓ | ✓ |
| `admin:payment-method:manage` | ✓ | — | — |
| `finance:manual-topup:read` | ✓ | ✓ | ✓ |
| `finance:manual-topup:review` | — | ✓ | — |
| `finance:manual-topup:approve` | — | ✓ | — |
| `finance:manual-topup:reject` | — | ✓ | — |

Customers use their existing `balance:read:self` / `balance:topup:self`.
No organization role receives any of these, and organization owners cannot
read a member's requests or receipts.

## Reconciliation

`GET /admin/finance/verify-ledger` adds four findings, all read-only:
`MANUAL_TOPUP_CREDIT_COUNT`, `MANUAL_TOPUP_CREDIT_MISMATCH`,
`MANUAL_TOPUP_CREDIT_WITHOUT_APPROVAL`, `MANUAL_TOPUP_UNAPPROVED_WITH_CREDIT`.

## Audit events

`MANUAL_PAYMENT_METHOD_{CREATED,UPDATED,ENABLED,DISABLED,ARCHIVED}`,
`MANUAL_PAYMENT_METHOD_LOGO_{UPLOAD_STARTED,UPLOADED,READY,REJECTED,FAILED,REMOVED}`,
`MANUAL_TOPUP_{DRAFT_CREATED,SUBMITTED,CANCELLED,REVIEW_STARTED,APPROVED,REJECTED,CREDIT_CREATED}`,
`MANUAL_TOPUP_RECEIPT_{UPLOAD_STARTED,UPLOADED,READY,REJECTED,FAILED,VIEWED}`.
A method update records which fields changed, never the account values.

## Operations

- Backups: receipts and logos are in the backup reference closure and the
  restore re-pin list.
- Throttles: `manual-topup-upload` (30/window) and `manual-topup-submit`
  (20/window) per user; at most 5 open (draft or pending) requests per person.
- Disabling a method stops new submissions against it (drafts are kept);
  pending requests remain reviewable. Archiving is permanent.
