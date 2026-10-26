# Paid document checks

> Phase 11. A document check is something a customer buys with PalCert
> Balance. Credit is **reserved** when the check is created and **charged**
> only when the report is successfully delivered.
>
> The billing rule, in one sentence: **a check is charged for the successful
> delivery of its technical report — not for starting, and not for producing a
> particular compliance outcome.**

```
 READY DOCX  +  PUBLIC_CHECKABLE Standard
        │
        ▼
  GET /pricing/quote  ──►  PriceQuote           the server's price, frozen
        │
        ▼
  POST /checks {documentVersionId, standardId, priceQuoteId}
        │
        │  ONE TRANSACTION ─────────────────────────────────────────┐
        │   quote spent · credit reserved (promo, then cash)        │
        │   ServicePurchase · allocations · DocumentCheck           │
        │   retention lock · CHECK_PREPARE outbox job               │
        └──────────────────────────────────────────────────────────┘
        ▼                                    202 Accepted
  worker: CHECK_PREPARE ─► analysis ─► CHECK_EVALUATION
        │
        ├─ report stored ──► ONE TRANSACTION: results · violations ·
        │                    report · run · CAPTURE every hold ·
        │                    purchase DELIVERED · check COMPLETED
        │
        └─ anything fails ─► release every hold · purchase RELEASED ·
                             check FAILED · no charge
```

## The one principle

**Reserved is not charged.** A reservation sets money aside and writes no
ledger entry; a capture writes one and the money is gone. Every screen, every
API field and both message catalogues keep those two words apart, and a
released reservation is never called a refund — nothing was taken, so there is
nothing to refund (§60, §133).

## What Phase 11 is not

It knows nothing about Stripe. A check spends PalCert Balance and nothing else,
so a customer with credit can buy one while the payment provider is down — and
no code path in the paid-check workflow may even ask the provider (§1, §56).
There is no revenue share, no organization payout and no institution
commission: all document-check revenue is PalCert's (§2). The standard's owner
has no financial interest in, and no visibility of, a check against it.

## The service purchase domain

`ServicePurchase` is one customer buying one deliverable service (ADR-0077).

| Field | Meaning |
| --- | --- |
| `productCode` | what was bought — `DOCUMENT_CHECK` |
| `resourceType`, `resourceId` | which instance — no foreign key, because the purchase is written first |
| `priceQuoteId`, `priceVersionId` | the price, and where it came from |
| `currency`, `amountMinor` | integer minor units, exactly as Phase 10 holds money |
| `status` | see below |
| `idempotencyKey` | the whole commercial request, not just the check |

```
RESERVED ──► PROCESSING ──► DELIVERED ──► REFUNDED
   │             │
   └─────────────┴──► RELEASED

anything ──► RECONCILIATION_REQUIRED   (terminal; a person looks)
```

There is no way back. A retry is a **new** purchase, which is what keeps the
billing history of a failed attempt exactly as it happened (ADR-0081).

The financial identity — owner, product, resource, quote, price version,
currency, amount — is immutable, enforced by `service_purchases_guard`. A later
price change cannot reach a purchase that was already made.

## Allocations, and promotional-first funding

A purchase may be funded from more than one credit class, so it may need more
than one hold:

```
Price $5      PROMOTIONAL available $2      CASH available $10
              ──────────────────────────────────────────────
reserve       PROMOTIONAL hold $2           CASH hold $3
capture       SERVICE_CHARGE −$2            SERVICE_CHARGE −$3
```

`FUNDING_ORDER` is `[PROMOTIONAL, CASH]` and is both the allocation order and
the lock order. Promotional credit is spent first, which preserves the
customer's refundable cash for as long as possible, and each class is captured
into its own account so a later refund returns each to where it came from.
Promotional credit never becomes refundable cash — that is Phase 10's database
CHECK, untouched here.

One finance-domain method does all of it: `ServicePurchaseService.reserve`
locks the accounts in order, computes the split against balances that cannot
move underneath it, creates the holds and writes the allocations. Check code
never allocates credit itself (§11). A shortfall throws, and the caller's
transaction rolls back, so **no partial reservation is ever left behind**.

A deferred constraint trigger requires `SUM(allocations) = purchase.amount` at
COMMIT (§72).

## Price quotes

The client names a quote; it never states an amount, and there is no field for
one (§13, §17). Before the first reservation the server checks that the quote
is the caller's, is for `DOCUMENT_CHECK`, has not expired, and has not already
funded a purchase — a uniqueness constraint on `price_quote_id` makes the last
one structural (§16).

A quote is **not repriced**. A customer shown $3 is charged $3 even after the
price becomes $4, until the quote expires (§15). After that they need a new
one.

## Atomic commercial creation

Everything commits together (ADR-0079):

1. the quote is validated and spent,
2. credit is reserved across as many accounts as it takes,
3. the `ServicePurchase` and its allocations are written,
4. the `DocumentCheck` is written, bound to the purchase,
5. the document retention lock is created,
6. a `CHECK_PREPARE` job is written to the Phase 5 outbox.

The ids are preallocated, so the purchase names the check and the check names
the purchase with no post-commit rebinding (§20). An insufficient balance
leaves **nothing**: no check, no purchase, no hold, no job, and the quote is
still spendable.

## Durable kickoff

Phase 7 dispatched work *after* the commit. Once credit is reserved that gap
means money set aside for work nobody started, so the intent is written inside
the transaction and a worker consumes it (§22, §23).

`CHECK_PREPARE` ensures the analysis (reusing one if it exists), parks the
check if the analysis is still running, and starts the evaluation. Every step
is idempotent, because at-least-once delivery means it will sometimes run
twice (§24). Redis being unavailable at creation time changes nothing — the job
row is committed and the outbox sweep publishes it later (§113).

## Reservation lifetime

`CHECK_RESERVATION_TTL_SECONDS` defaults to one hour: long enough for a queue
wait, an analysis, an evaluation and a report, and still a hard bound (§25).

When it passes, the sweeper expires the holds and converges the rest — purchase
RELEASED, check FAILED — so a late worker cannot deliver a report nobody paid
for (§26, §28, §116). Before any capture, **every** hold is re-checked as
ACTIVE; a stale one refuses the whole settlement rather than being silently
re-taken against the customer's later balance (§27).

Converging the check is not enough on its own, because a worker that was
already in flight when the sweeper ran can still write to it afterwards. And
`FAILED -> WAITING_ANALYSIS` is a *legal* transition — that is exactly what a
deliberate retry does — so the status trigger cannot tell a retry apart from a
stale write and will not stop one. A late preparation pass could therefore
resurrect a check whose reservation had already been released, leaving it
looking live with nothing paying for it.

So the preparation path never writes the status blindly. It moves a check to
`WAITING_ANALYSIS` only from `CREATED` or `WAITING_ANALYSIS`, and
`startEvaluation` reads the status under the check's row lock — the same lock
every settlement path takes first — so a check that has just been settled is
seen as settled rather than raced. A pass that finds the check gone says so and
stops; it does not throw, because a throw would be retried and the retry would
find the same thing.

## Settlement

One service owns all three outcomes (`PaidCheckSettlementService`, §79, §80),
and every path begins the same way: take the check's row lock, re-read its
status inside the transaction. Whichever transaction gets the lock first
decides; the others see a terminal state and stop.

| Outcome | Check | Purchase | Ledger |
| --- | --- | --- | --- |
| Report delivered | `COMPLETED` | `DELIVERED` | one `SERVICE_CHARGE` per allocation |
| Technical failure | `FAILED` | `RELEASED` | nothing |
| Customer cancels | `CANCELLED` | `RELEASED` | nothing |
| Reservation expired | `FAILED` | `RELEASED` | nothing |

**Completion and capture are one transaction** (ADR-0080). The results, the
violations, the report row, the run finalization, the capture of every hold and
the check's completion all commit together or not at all. There is no ordering
of two commits that is safe: complete-then-charge gives the report away when
the charge fails, and charge-then-complete takes the money when the completion
fails.

Deferred constraint triggers enforce the cross-domain invariants at COMMIT:

- a `DELIVERED` purchase has every allocation captured, summing to its exact
  amount, and a `COMPLETED` check;
- a `COMPLETED` paid check has a settled purchase;
- a `RELEASED` purchase has no capture and no service charge anywhere.

Deferred, because the completion transaction necessarily passes through a
moment where only one of the two has been written.

## Lock order

```
document_checks  →  service_purchases  →  credit_holds  →  customer_credit_accounts
                                                             (PROMOTIONAL, then CASH)
```

`FINANCIAL_LOCK_ORDER` in `@palcert/contracts`, used identically by complete,
fail, cancel and reconcile (§81). It is written down in code rather than in
four comments, because a lock order that lives only in comments is not an
order.

## What is billable

All four determinations are delivered services:

| Determination | Charged? |
| --- | --- |
| `COMPLIANT` | yes |
| `NON_COMPLIANT` | **yes** |
| `REVIEW_REQUIRED` | **yes** |
| `INDETERMINATE` | yes, when the report was delivered normally |

The customer bought the analysis and the report, not a pass. Refunding because
a document failed would mean PalCert only charges for good news (§31, §96).

## The free path cannot come back

`document_checks_require_purchase` fires on **INSERT** and requires every new
check to name a purchase that belongs to the same person and points back at
that very check (§21, §121). It is attempted in the test suite with the
schema-owning connection and refused.

Historical checks — created before Phase 11 — are untouched, because the
trigger fires on new rows only. They stay readable for ever, with
`billing: null` and `legacyFree: true` (§4, §89, §122). PalCert does not invent
a purchase for them, and a paid check cannot be laundered into a free one:
`document_checks_purchase_binding_immutable` refuses to change the binding in
either direction (§78).

## Report hash isolation

**No price, purchase, hold, balance or charge appears anywhere in the canonical
report** (ADR-0082). `CheckReportBuilder` is untouched, the Phase 7 golden
fixtures pass unchanged, and `REPORT_CANONICALIZATION_VERSION` is not bumped.
Billing reaches the customer through the `billing` block on a check and through
their balance history — both outside the artifact. A test asserts the negative
against the stored bytes.

## Isolation

`service_purchases` and `service_purchase_allocations` are `USER_SCOPED` under
`FORCE ROW LEVEL SECURITY`. Composite foreign keys make a cross-person purchase
impossible at the SQL layer: a purchase cannot use another person's quote, an
allocation cannot use another person's hold, and a check cannot name another
person's purchase (§70, §123).

The organization whose standard was checked against gets **nothing**: not the
price, not the balance, not whether the check was charged, not that it happened
at all (§69, §129).

| Role | Purchases |
| --- | --- |
| The customer | their own, as the `billing` block on their own checks |
| `PALCERT_FINANCE` | read, with the allocation breakdown |
| `PALCERT_ADMIN`, `PALCERT_AUDITOR`, `PALCERT_SUPPORT` | read |
| Any organization role | **none** |

Support can read a purchase and mutate nothing (§130).

## Reconciliation

`GET /admin/finance/verify-ledger` is extended with the purchase invariants
(§93). Read-only: it reports what it finds and repairs nothing.

- allocations sum to the purchase amount,
- a `RELEASED` purchase has no captured reservation,
- a charged purchase has every reservation captured,
- a charged `DOCUMENT_CHECK` purchase has a `COMPLETED` check.

An impossible state becomes `RECONCILIATION_REQUIRED` so a person looks (§94).

## What the customer sees

| Screen | Words |
| --- | --- |
| New check | price, balance, quote expiry, and the three sentences of §54 |
| Insufficient balance | required, available, shortfall, and a link to add credit |
| Running | **Reserved** $X |
| Completed | **Charged** $X, with a link to the balance |
| Failed / cancelled | **Reservation released** — "No charge was made." |
| Refunded | **Refunded** — only when a charge really was reversed |
| Historical | **No charge** |

Arabic keeps the same four apart: محجوز / تم الخصم / أُلغي الحجز / أُعيد
المبلغ. A released reservation is never استرداد (§133, §134). The balance's
transaction history renders a service charge as *PalCert Document Check* (§64).

Adding credit is never started from the check flow (§90): a short balance links
to the balance page and the customer tops up deliberately.

## API surface

| Method | Path | Change |
| --- | --- | --- |
| `POST` | `/checks` | now requires `priceQuoteId`; returns `402 INSUFFICIENT_BALANCE` when short |
| `POST` | `/checks/{id}/cancel` | new — releases the reservation, refuses after delivery |
| `POST` | `/checks/{id}/retry` | refuses a paid check with `CHECK_RETRY_REQUIRES_NEW_PURCHASE` |
| `GET` | `/checks`, `/checks/{id}` | gain `billing` and `legacyFree` |
| `GET` | `/admin/finance/customers/{id}/purchases` | new — finance and support, read-only |

Error codes: `PRICE_QUOTE_REQUIRED` (422), `QUOTE_ALREADY_USED` (409),
`QUOTE_PRODUCT_MISMATCH` (422), `SERVICE_PURCHASE_NOT_FOUND` (404),
`SERVICE_RESERVATION_EXPIRED` (409), `SERVICE_ALREADY_DELIVERED` (409),
`CHECK_NOT_CANCELLABLE` (409), `CHECK_RETRY_REQUIRES_NEW_PURCHASE` (409).

## The Phase 12 boundary

`ServicePurchase` is deliberately general so SmartFix can reuse it. Phase 11
sells `DOCUMENT_CHECK` and a database CHECK says so; `productCode = SMARTFIX`
starts no workflow and is catalogued as inactive (§147).

Not in Phase 11, and not to be inferred from anything above: SmartFix, a direct
provider charge per check, revenue share, payouts, subscriptions, tax, coupons,
FX conversion, PDF analysis, certificates, and anything blockchain.
