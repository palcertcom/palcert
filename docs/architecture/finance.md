# Customer credit, payments and the ledger

> Phase 10. A customer holds **PalCert Balance** — credit with PalCert,
> denominated in an ordinary currency. They add to it by paying through a
> payment provider; PalCert spends it on their behalf. Nothing here is a
> wallet, and nothing here is crypto.
>
> Phase 10 builds the money. It deliberately does **not** connect it to
> document checks: `POST /checks` still costs nothing. Phase 11 is where the
> two meet.

```
                    ┌──────────────────── PalCert ────────────────────┐
  Customer          │                                                 │
     │              │   CustomerCreditAccount  (owner, currency,       │
     │  pay ───────►│    │                      credit class)          │
     │              │    └─► CreditLedgerEntry   append-only, signed   │
     │              │            │                                     │
     │              │            └─ balance = SUM(amount_minor)        │
     │              │                                                  │
     │              │   CreditHold  ACTIVE ──► CAPTURED | RELEASED |    │
     │              │                          EXPIRED                 │
     │              │        available = balance − Σ ACTIVE holds       │
     │              │                                                  │
     │              │   ServiceProduct ─► PriceVersion ─► PriceQuote    │
     │              │                                                  │
  provider ────────►│   PaymentProviderEvent ─► outbox ─► settle        │
  (signed webhook)  │       BalanceTopUp / PaymentRefund / Dispute      │
                    └──────────────────────────────────────────────────┘
```

## Money

An amount is an **integer count of minor units** plus an ISO 4217 code. $10.25
is `{ currency: "USD", minorUnits: "1025" }`. It is `BIGINT` in PostgreSQL,
`bigint` in TypeScript, and a **string** in JSON — never a JSON number, because
`JSON.parse` would have made it a float before any PalCert code saw it
(ADR-0068).

Exactly one module knows how many decimal places a currency has:
`CURRENCY_REGISTRY` in `@palcert/contracts`.

| Currency | Minor units | Notes                         |
| -------- | ----------- | ----------------------------- |
| `USD`    | 2           |                               |
| `EUR`    | 2           |                               |
| `ILS`    | 2           |                               |
| `JOD`    | 3           | three decimal places          |
| `JPY`    | 0           | no minor unit; disabled       |

`currencyExponent` throws for a currency it has never heard of rather than
assuming two. Parsing (`parseMinorUnits`) and formatting (`formatMinorUnits`)
happen at the edges and nowhere else, and both work by moving digits — there is
no division by 100 anywhere in the system. A unit test greps the money module
for `/100`, `Math.`, `parseFloat`, `toFixed` and `Number(` and fails if any
appears.

The browser follows the same rule: `toDecimalString` slices digits, and
`Intl.NumberFormat` is given the exact fraction digits so it formats rather
than rounds.

## Currency model

An account is scoped to **one currency and one credit class**, so a customer
with USD and EUR credit has two accounts and two balances. Phase 10 performs
**no currency conversion at all**: EUR credit pays for a EUR-priced service or
nothing. A product with no active price in the requested currency returns
`PRICE_NOT_AVAILABLE`; it is never silently satisfied from another currency.

Which currencies an installation accepts is configuration
(`PALCERT_ENABLED_CURRENCIES`, `PALCERT_DEFAULT_CURRENCY`), validated at
startup against the registry.

## Credit classes

| Class         | Where it comes from            | Spendable | Refundable to a card |
| ------------- | ------------------------------ | --------- | -------------------- |
| `CASH`        | a payment the customer made    | yes       | yes                  |
| `PROMOTIONAL` | granted by PalCert             | yes       | **never**            |

Promotional credit never became money in PalCert's hands, so it cannot leave as
money. This is structural, not procedural: an external refund reserves against
a **CASH** account, and a database CHECK refuses a `PAYMENT_REFUND_DEBIT` on
any other class. Spending draws promotional credit **first**, which preserves
the customer's refundable cash for as long as possible.

## The ledger

`credit_ledger_entries` is the source of truth. The balance is not stored; it
is `SUM(amount_minor)` over the account (ADR-0069).

| Entry type             | Sign | Means                                        |
| ---------------------- | ---- | -------------------------------------------- |
| `TOP_UP_CREDIT`        |  +   | a verified payment                           |
| `PROMOTIONAL_CREDIT`   |  +   | a grant from PalCert                         |
| `ADMIN_CREDIT`         |  +   | a finance correction upward                  |
| `SERVICE_REFUND`       |  +   | credit returned after a failed service        |
| `CHARGEBACK_REVERSAL`  |  +   | a dispute resolved in PalCert's favour        |
| `SERVICE_CHARGE`       |  −   | a captured hold for work performed            |
| `ADMIN_DEBIT`          |  −   | a finance correction downward                 |
| `PAYMENT_REFUND_DEBIT` |  −   | money sent back to a card                     |
| `CHARGEBACK_DEBIT`     |  −   | the customer's bank reversed a payment        |

Invariants, all enforced in the database rather than in a service:

- the sign must match the type, and zero amounts are refused;
- `PAYMENT_REFUND_DEBIT` may only debit a `CASH` account;
- an entry that references something must reference it completely — a reference
  type without an id, or the reverse, is refused;
- **`UPDATE` and `DELETE` raise**, from every role including the schema owner,
  and the application role's `UPDATE`/`DELETE` grants are explicitly revoked;
- a reversal must be the opposite sign of, and on the same account as, the
  entry it reverses.

Corrections are therefore **compensating entries**, never edits. Finance can
append; nobody can rewrite. `GET /admin/finance/verify-ledger` replays the
entries independently and checks four invariant families, including that the
aggregate balance and the replayed balance agree.

Idempotency is a unique key per account. The same key cannot be inserted twice,
so a retried webhook, a replayed job and a duplicated request converge on one
entry.

## Holds

Spending is two steps: **reserve**, then capture or release (ADR-0070).

```
available = ledger balance − Σ ACTIVE holds
```

A hold is not a ledger entry — nothing has been spent yet, and a debit that
might be reversed would put a transaction in the customer's history that never
happened.

Every hold is created inside a transaction that first takes
`SELECT … FOR UPDATE` on the account row. That single line is the whole
over-spend defence: with a $5 balance and two concurrent $4 requests, the
second waits, re-reads the balance the first one left, and refuses. Capture
appends the debit and closes the hold in one transaction; release just closes
it. `ACTIVE → CAPTURED | RELEASED | EXPIRED` is enforced by a trigger, and all
three outcomes are terminal.

Holds expire. A sweeper releases anything past its TTL
(`CREDIT_HOLD_TTL_SECONDS`), so a crashed worker cannot strand a customer's
money.

## Pricing

`ServiceProduct` is the stable identity (`DOCUMENT_CHECK`). `PriceVersion`
carries the money, and is **immutable once `ACTIVE`** (ADR-0074). A partial
unique index permits exactly one active version per (product, currency,
market); activation retires the incumbent and activates the successor in one
transaction.

**The client never supplies a price.** It names a product and the server
answers. `GET /pricing/quote` returns a `PriceQuote` — an immutable row with an
amount and an expiry — so a customer who is shown a price is charged that price
even if it changes underneath them. Expired quotes are refused, never silently
re-priced.

Pricing is platform-administrative. Organizations have no pricing permission of
any kind, and cannot discount, waive or set anything.

## Adding credit

```
POST /balance/top-ups                    BalanceTopUp CREATED
   └─► provider.createTopUpSession()     → PENDING, checkout URL returned
          └─► browser leaves to the provider's hosted page
                 ├─► provider webhook  ──┐
                 └─► reconciliation    ──┴─► retrieve payment → verify → credit
```

The customer types an amount, confirms it, and is sent to the provider's own
page. PalCert never sees a card number, CVC, expiry or bank credential
(ADR-0072); there is no field in which to store one.

Limits (`TOPUP_MIN_MINOR`, `TOPUP_MAX_MINOR`) and the session TTL are
configuration. Every request carries an `Idempotency-Key`, so a double-clicked
button is one top-up.

### Manual top-ups (bank and app transfers)

The second way to add credit, beside the card path above and sharing nothing
with it but the ledger: a person reports a transfer they made outside PalCert,
and PalCert finance credits it — as exactly one `MANUAL_TOPUP_CREDIT` CASH
entry — only after matching it against the receiving account. See
[manual-topups.md](manual-topups.md) and
[ADR-0147](../adr/0147-manual-topups-and-human-payment-verification.md).

## The payment provider abstraction

`PaymentProviderPort` is an abstract class with six methods:
`getCapabilities`, `createTopUpSession`, `retrievePayment`, `refundPayment`,
`verifyAndParseWebhook` and `checkAvailability` (ADR-0071). Business logic
depends on the port; **nothing outside `infrastructure/payments/` imports a
provider SDK**.

Verified events are translated into PalCert's own vocabulary —
`PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`, `PAYMENT_CANCELLED`,
`REFUND_SUCCEEDED`, `REFUND_FAILED`, `DISPUTE_OPENED`, `DISPUTE_CLOSED`,
`UNSUPPORTED` — so no service branches on a provider's event name. Provider
errors become a `PaymentFailureKind` that says whether a retry is sensible.

`FakePaymentProvider` implements the same port with configurable behaviours
(unavailable, rate limited, declined, already refunded, wrong amount, invalid
signature). The whole test suite runs against it, and the factory **refuses to
start** with `PAYMENT_PROVIDER=fake` in production.

### The Stripe adapter

The one file that knows Stripe exists. It:

- pins the API version explicitly (`STRIPE_API_VERSION`) rather than inheriting
  whatever the SDK shipped with;
- creates a Checkout Session in `payment` mode with an inline `price_data`
  whose `unit_amount` is the minor units PalCert already holds — no conversion;
- puts PalCert's identifiers on the session (`client_reference_id` plus
  metadata), which is what ties a later event back to a PalCert row;
- sends a derived idempotency key on every state-changing call;
- treats a missing field and a null field identically, because Stripe omits
  rather than nulls.

## Webhook security

The webhook is the payment authority; the browser redirect is not (ADR-0073).

- The signature is verified against the **exact raw request bytes**. The Nest
  app is created with `rawBody: true` for this reason: any reserialization
  breaks the signature.
- Browser CSRF logic does not apply. A provider holds no cookie and sends no
  `Origin`; the signature *is* the authentication. The CSRF guard skips routes
  marked `@ProviderSigned()`, and only those.
- A bad signature is a rejection, never a warning.
- The endpoint records a receipt keyed by the provider's event id, enqueues a
  job, and returns. A unique violation means "already seen"; **only** a genuine
  `P2002` counts as a duplicate — anything else is logged and re-thrown, so
  PalCert never acknowledges an event it failed to record.
- Never logged: the signature header, the webhook secret, the raw payload, or
  any customer payment detail.

## Processing and reconciliation

Provider events are **at-least-once and unordered**, and are not authoritative
about themselves (ADR-0076). Processing therefore:

1. ignores the amount and status in the payload;
2. re-retrieves the payment from the provider;
3. compares amount, currency and client reference against the PalCert row;
4. credits only on an exact match.

A mismatch parks the top-up in `RECONCILIATION_REQUIRED` and credits nothing.
Nobody "fixes" the ledger by guessing.

Three independent mechanisms make a second credit impossible: the ledger's
idempotency key, a conditional status update, and a trigger that refuses to
rebind a top-up's credit entry. The suite delivers the same event ten times and
asserts one credit.

Because an event can be lost entirely, a sweeper re-queries any top-up open
longer than `PAYMENT_RECONCILE_AFTER_SECONDS`. Webhook delivery is a latency
optimization, not a correctness dependency: credit arrives without any webhook
at all, just later.

## Refund semantics

Two different acts (ADR-0075):

| | **Service refund** | **External refund** |
| --- | --- | --- |
| What moves | credit, inside PalCert | real money, back to the card |
| Ledger entry | `SERVICE_REFUND` (+) | `PAYMENT_REFUND_DEBIT` (−) |
| Who starts it | the system, on service failure | **finance only** |
| Provider involved | no | yes |
| Promotional credit | yes | structurally impossible |

An external refund **reserves the credit before calling the provider**, so the
customer cannot spend the same money while it settles. On provider success the
reservation is captured; on failure it is released and the balance is
unchanged. A refund of money already spent is refused with
`INSUFFICIENT_BALANCE` rather than creating a negative balance on PalCert's
initiative.

There is no self-service refund endpoint. "Give me my money back" is a
conversation with a policy behind it, and the UI says who arranges one.

## Chargebacks

A chargeback is the customer's bank reversing a payment. PalCert records a
`PaymentDispute` and debits `CHARGEBACK_DEBIT`. **This may take the balance
below zero, and PalCert does not fabricate credit to hide that** — the customer
is shown the negative balance with an explanation of its one legitimate cause.
A dispute resolved in PalCert's favour appends `CHARGEBACK_REVERSAL`.

## Who can see and do what

| Role | Balance | Payments | Ledger | Refund | Adjust | Pricing |
| --- | --- | --- | --- | --- | --- | --- |
| The customer (self) | read + top up | own only | own history | — | — | read quote |
| `PALCERT_FINANCE` | read | read | read | create | create | read/create/activate |
| `PALCERT_ADMIN` | read | read | read | — | — | read |
| `PALCERT_AUDITOR` | read | read | read | — | — | read |
| `PALCERT_SUPPORT` | — | read | — | — | — | — |
| Any organization role | **none** | **none** | **none** | **none** | **none** | **none** |

Manual top-ups follow the same split: `PALCERT_FINANCE` reviews, approves
and rejects; `PALCERT_ADMIN` configures payment methods and reads the queue
but cannot credit anybody; `PALCERT_AUDITOR` reads; support and every
organization role get nothing ([manual-topups.md § Permissions](manual-topups.md#permissions)).

Support deliberately gets payment *visibility* and no financial mutation
permission at all. Organizations have **zero** access to a student's balance,
top-ups, payments, ledger, refunds or provider metadata — asserted both by
route tests and by a SQL query proving no organization-scoped role holds any
`finance:`, `pricing:` or `balance:` permission.

Every financial table carries a row-level security policy and a row in
`table_isolation_classification`: seven are `USER_SCOPED`, three
(`service_products`, `price_versions`, `payment_provider_events`) are `SYSTEM`.

## Availability

A payment provider outage must never take PalCert down. `/health/ready` does
**not** probe the provider; a separate `/health/payments` reports it. Reading a
balance, spending existing credit and viewing history all keep working, and the
UI says precisely that: *adding* credit is unavailable, and everything else is
unaffected.

## Retention

Financial records are not deleted because a document or an account is. Phase 10
keeps the records and leaves the anonymization policy to a later phase — the
schema is shaped so that unnecessary personal data can be removed later without
destroying the financial history that has to be kept.

## API surface

| Method | Path | Who |
| --- | --- | --- |
| `GET` | `/balance` | the customer |
| `GET` | `/balance/currencies` | the customer |
| `GET` | `/balance/transactions` | the customer |
| `GET` | `/balance/holds` | the customer |
| `POST` | `/balance/top-ups` | the customer (`Idempotency-Key`) |
| `GET` | `/balance/top-ups`, `/balance/top-ups/:id` | the customer |
| `GET` | `/balance/refunds` | the customer |
| `GET` | `/pricing/products` | public |
| `GET` | `/pricing/quote` | the customer |
| `POST` | `/webhooks/payments/:provider` | the provider, signature-verified |
| `GET`/`POST` | `/admin/finance/prices…` | pricing permissions |
| `GET` | `/admin/finance/customers/:id/balance`, `…/payments` | finance |
| `POST` | `/admin/finance/adjustments` | finance |
| `POST` | `/admin/finance/refunds`, `GET /admin/finance/refunds/:id` | finance |
| `GET` | `/admin/finance/verify-ledger` | finance |

Provider secrets, raw webhook payloads and internal provider objects appear in
no response.

## The Phase 11 boundary

Phase 10 stops deliberately short. `POST /checks` does not require funds, does
not create a hold, and does not charge. Nothing imports a check into the
finance module.

What Phase 11 will use, already built and tested here:

```
quote  →  reserve (hold)  →  perform check  →  capture   on success
                                            └─ release  on failure
                                            └─ service refund, if already captured
```

Not in Phase 10, and not to be inferred from anything above: paid document
checks, SmartFix, institution revenue share, organization payouts, recurring
subscriptions, FX conversion, tax calculation, and anything blockchain or
crypto.

## AI services

`AI_REVIEW` and `AI_RULE_EXTRACTION` are ordinary service products, sold
through the same quotes, purchases, holds and ledger as checks. The
initiating user always pays, and no role is free. The purchase is captured
on COMPLETED and released otherwise. Finance reads purchases and captured
revenue per product and currency at `GET /admin/finance/purchases/summary`
and `GET /admin/finance/purchases`. See [AI billing](ai-billing.md) and
[ADR-0149](../adr/0149-centralized-billing-for-customer-initiated-ai-services.md).

## Withdrawals and payouts

Money leaves PalCert only through the withdrawal workflow. A user can
withdraw verified, cleared manual top-ups, using a conservative formula
(never "the CASH balance"). An organization can withdraw its settled
INSTITUTION net share, and PalCert its realized revenue. A user's request
reserves a `WITHDRAWAL` CASH hold, which is captured as a `WITHDRAWAL_DEBIT`
exactly once, when finance records the external transfer. Organization and
platform requests reserve against derived availability and write no ledger
entry. See [Withdrawals](withdrawals.md) and
[ADR-0150](../adr/0150-unified-withdrawals-and-payout-settlement.md).

## Attestation fees

Certificate attestation ([attestations.md](attestations.md),
[ADR-0145](../adr/0145-user-submitted-certificate-attestation.md)) is paid from
the same customer balance through the same holds; it adds no second balance
and no organization ledger accounts.

- **Submit** creates a credit hold for the gross fee against the user's CASH
  balance (promotional credit is not used), under the account row lock, with
  no expiry. The request snapshots gross, currency, the institution's
  commission in basis points, the platform fee and the institution net.
- **Approve** captures the hold as a `SERVICE_CHARGE` with reason
  `ATTESTATION_FEE` and reference type `ATTESTATION_REQUEST` (idempotency key
  `hold:<id>:capture`), then records an `attestation_settlements` header and
  exactly two `attestation_revenue_entries` — `INSTITUTION` and
  `PLATFORM_COMMISSION` — whose sum a deferred constraint trigger checks
  against the settlement and the request's snapshot.
- **Reject / cancel** release the hold in full; nothing is charged and no
  revenue is recorded.
- Platform fee = gross × commission, rounded half-up to the minor unit;
  institution net = the remainder. Example: $10.00 at 15% → $1.50 PalCert,
  $8.50 institution.
- Commission rates are per institution, append-only, effective-dated and
  audited (`ORGANIZATION_ATTESTATION_COMMISSION_CHANGED`); the default with
  no row is 0%.
- An approved fee is not refunded automatically, including on revocation.
