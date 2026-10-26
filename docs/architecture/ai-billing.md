# Billing for customer-initiated AI services

> [ADR-0149](../adr/0149-centralized-billing-for-customer-initiated-ai-services.md).
> Every AI service a customer starts is paid by the person who starts it.
> No role is free.

```
quote (GET /pricing/quote?product=AI_REVIEW&currency=USD)
   │      server-priced, immutable, 30 min
   ▼
start (POST … { priceQuoteId })            ── authorization, consent, eligibility first
   │   one transaction:
   │     service_purchase RESERVED  + credit_holds (PROMOTIONAL, then CASH)
   │     ai_review / rule_extraction_run  (bound to the purchase; trigger-enforced)
   │     processing_job
   ▼
worker
   │   assertReservationLive  ── lapsed or released? fail RESERVATION_EXPIRED, no provider call
   │   markProcessing
   │   provider call(s)
   ├─► COMPLETED  ── same transaction: capture   → SERVICE_CHARGE ledger entry
   └─► FAILED     ── same transaction: release   → holds RELEASED, nothing charged
cancel (customer / org admin) ── same transaction: CANCELLED + release
```

## Products

| Product code         | Resource type        | English            | Arabic                            |
| -------------------- | -------------------- | ------------------ | --------------------------------- |
| `AI_REVIEW`          | `AI_REVIEW`          | AI Review          | المراجعة بالذكاء الاصطناعي        |
| `AI_RULE_EXTRACTION` | `AI_RULE_EXTRACTION` | AI Rule Extraction | استخراج القواعد بالذكاء الاصطناعي |

The migration inserts both products **without a price**. Finance staff draft
a price per currency (and optionally per market) in the admin console, then
activate it. The amount must be greater than zero. Without an active price,
quoting returns `PRICE_NOT_AVAILABLE` with the message "This AI service is
not currently available in your balance currency." The UI shows that message
and the start button stays disabled.

## Who pays

The authenticated caller, always. For rule extraction, which is
organization-scoped, the run still belongs to the organization and RLS still
scopes it there. The **purchase**, however, belongs to the user who started
it. That user's balance is reserved and charged, and the organization pays
nothing.

The UI says so before confirmation: "This AI service is billed to your
PalCert Balance, even when used for an organization." The `priceQuoteId` is
resolved only among the caller's own quotes. A quote belonging to anyone
else reads as `QUOTE_NOT_FOUND`.

## What counts as delivered

**Billing follows delivery status, not outcome quality.**

| Terminal state | Cause (examples)                                                                                                                                                                                       | Money      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `COMPLETED`    | Valid result written, however thin (all `INSUFFICIENT_EVIDENCE`, no proposals)                                                                                                                         | Captured   |
| `FAILED`       | Provider error, timeout, network, refusal, malformed output, output validation, token-budget overflow, evidence-integrity failure, exhausted retries, internal error, `RESERVATION_EXPIRED` | Released   |
| `CANCELLED`    | Customer (or, for extraction, an org admin) cancelled a queued run                                                                                                                                     | Released   |

The capture runs inside the transaction that writes `COMPLETED`. The release
runs inside the transaction that writes `FAILED` or `CANCELLED`. A
redelivered job finds the purchase already settled and does nothing more.

## Reservation lifetime

`AI_RESERVATION_TTL_SECONDS` sets the hold lifetime: default 7200, bounded
600–86400. The worker refuses to call the provider if any hold is no longer
ACTIVE or is past its expiry, as judged by the application clock. The run
fails with `RESERVATION_EXPIRED` and whatever is left is released. A hold the
sweeper already expired needs no further release.

## The registry and the architecture test

`AI_OPERATION_REGISTRY` (`packages/contracts/src/ai/billing.ts`) lists every
AI operation:

| Operation               | Classification          | Why                                 |
| ----------------------- | ----------------------- | ----------------------------------- |
| `AI_REVIEW`             | `BILLABLE_AI_SERVICE`   | A customer asks for it              |
| `AI_RULE_EXTRACTION`    | `BILLABLE_AI_SERVICE`   | A customer asks for it              |
| `AI_REVIEW_BENCHMARK`   | `INTERNAL_AI_OPERATION` | Evaluation harness; no route        |
| `EXTRACTION_BENCHMARK`  | `INTERNAL_AI_OPERATION` | Evaluation harness; no route        |
| `PROVIDER_HEALTH_PROBE` | `INTERNAL_AI_OPERATION` | Readiness probe; no customer content |

`apps/api/src/modules/finance/ai-billing-classification.spec.ts` finds every
call to a content-bearing provider method outside the adapters. It fails when
any of these holds:

- a call site is unclassified;
- a billable call site lacks `assertReservationLive`, `billing.capture(` or
  `billing.release(`;
- a controller references a benchmark service.

## Database guarantees

- `ai_reviews.service_purchase_id` and `rule_extraction_runs.service_purchase_id`
  are nullable, unique foreign keys (RESTRICT).
- BEFORE INSERT triggers refuse a row without a matching purchase. "Matching"
  means:
  - the same owner (the review's owner, or the run's `created_by_user_id`);
  - the right product and resource type;
  - `resource_id` equal to the row's id.
- A BEFORE UPDATE trigger makes the binding immutable.
- Rows created before this change keep a NULL purchase. They run uncharged
  and are never billed retroactively.
- The failure-kind check on `ai_reviews` also accepts `RESERVATION_EXPIRED`.

## Reporting

- **Customer:** balance history attaches `serviceProductCode` to each hold and
  capture. The UI shows "AI review" or "AI rule extraction" (Arabic: مراجعة
  بالذكاء الاصطناعي, استخراج القواعد بالذكاء الاصطناعي) and never the raw code.
- **Finance**, with `finance:purchase:read`:
  - `GET /admin/finance/purchases/summary` returns, per product and currency:
    purchases, reserved, completed and charged, released, refunded, captured
    revenue. Each currency gets its own row and currencies are never summed.
  - `GET /admin/finance/purchases` returns individual purchases, newest first
    (at most 200), with payer, organization (for extraction runs), amount,
    status and dates.
  - Both accept `productCode`, `currency`, `from`/`to` (UTC days, inclusive),
    `status` and `limit`.

Both read the purchases directly. There is no separate AI revenue ledger.

## Audit

The audit events are `AI_SERVICE_RESERVED`, `AI_SERVICE_CAPTURED` and
`AI_SERVICE_RELEASED`, with target `ServicePurchase`. Each carries:

- `productCode`, `resourceType`, `resourceId`;
- `payerUserId`;
- `organizationId` (extraction only);
- `amountMinor` and `currency` when known;
- `failureCode` on release.

## Tests

- `apps/api/test/ai-billing.e2e-spec.ts` covers:
  - reserve and capture;
  - thin COMPLETED is charged;
  - refusal and malformed output are released;
  - insufficient balance and no price;
  - forged, foreign, mismatched, expired and client-priced quotes;
  - price change after quote;
  - HTTP retry and concurrency;
  - redelivery;
  - cancel;
  - lapsed reservation;
  - every role pays;
  - the database refuses a free row;
  - extraction paid by the initiating template manager;
  - history label, finance summary and report;
  - legacy rows uncharged.
- No test calls a real provider; the Fake AI provider is used throughout.
