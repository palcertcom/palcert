# ADR-0149: Centralized billing for customer-initiated AI services

- **Status:** Accepted
- **Date:** 2026-10-03
- **Phase:** Post-RC finance
- **Builds on:** [ADR-0069](0069-append-only-credit-ledger.md) (ledger), [ADR-0070](0070-credit-holds-and-row-locks.md) (holds), [ADR-0077](0077-service-purchase-domain.md) (purchase domain), [ADR-0081](0081-reservation-lifetime-and-paid-retry.md) (product-specific reservation lifetime)
- **Related:** [AI billing](../architecture/ai-billing.md), [AI engine](../architecture/ai-engine.md), [rule extraction](../architecture/rule-extraction.md), [finance](../architecture/finance.md)

## Context

Two features send customer content to an external AI provider at a customer's
request: **AI Review** of a completed check, and **AI Rule Extraction** of an
organization's guideline sources. Both were free. Every provider call costs
PalCert money, and nothing in the code connected "a customer started AI work"
to "someone pays for it". A future AI feature could ship the same way.

PalCert already sells document checks and SmartFix through one purchase
domain: `service_products`, versioned `price_versions`, immutable
`price_quotes`, `service_purchases` that reserve credit as `credit_holds`, and
an append-only ledger. Funding draws PROMOTIONAL credit before CASH.

## Decision

1. **Every customer-initiated AI service is paid, and no role is free.**
   PALCERT_ADMIN, PALCERT_FINANCE, organization owners and admins, reviewers,
   template managers and ordinary users all pay. A permission decides who may
   use a feature; it never decides the price. Authorization and billing stay
   separate checks.
2. **The payer is the authenticated user who starts the work.** This holds even
   when the work is an organization's: a template manager extracting rules for
   University A pays from their own PalCert Balance. There is no organization
   wallet. Nothing in a request can name another payer.
3. **Reuse the purchase domain.** There are two new products, `AI_REVIEW`
   ("AI Review") and `AI_RULE_EXTRACTION` ("AI Rule Extraction"), plus
   matching resource types. There is no AI-specific ledger, wallet or
   revenue table.
4. **Prices are admin-controlled and never defaulted.** A price moves through
   DRAFT → ACTIVE → RETIRED, and its amount is greater than zero. The
   migration inserts the products without a price. If a currency has no
   active price, the service cannot start. The customer is told: "This AI
   service is not currently available in your balance currency."
5. **The client never states a price.** A start request carries only a
   `priceQuoteId`. The server checks:
   - the quote is the caller's (anything else reads as not found);
   - it is for this product;
   - it is unexpired;
   - it is unspent.

   The server then reserves the quote's own amount. A browser cannot submit
   an amount, a price version or a payer. Provider token pricing is never
   exposed.
6. **Reserve → capture on COMPLETED → release otherwise.** Billing follows
   delivery status, not outcome quality.
   - A run that reaches its authoritative **COMPLETED** state is charged,
     even when the result is thin: no rule met, all insufficient evidence, or
     few proposals.
   - The reservation is released when the run ends **FAILED** for any
     reason, or is **CANCELLED**. Failure reasons include provider error or
     timeout, malformed output, refusal, token-budget overflow, output
     validation, exhausted retries, an internal error, and a lapsed
     reservation.
   - Capture runs in the same transaction that writes COMPLETED, and release
     in the same transaction that writes FAILED or CANCELLED. Status and
     money therefore cannot disagree.
7. **Order of checks.**
   1. Authorization.
   2. Consent and every other eligibility check.
   3. Reservation.
   4. Resource creation.

   No credit is held for a request that was going to be refused. The
   reservation and the run row are created in one transaction.
8. **No provider call on lapsed credit.** The worker calls
   `assertReservationLive` before any provider call. The purchase must be
   RESERVED or PROCESSING, and every hold must be ACTIVE and unexpired. If
   not, the run fails with `RESERVATION_EXPIRED`, nothing is sent to the
   provider and nothing is charged. The hold lifetime is
   `AI_RESERVATION_TTL_SECONDS` (default 7200, bounded 600–86400). It is
   separate from the check reservation so queued AI work can wait longer.
9. **Idempotency.**
   - A purchase's key is derived from the resource: `ai-review:<id>` or
     `ai-rule-extraction:<id>`.
   - A quote funds at most one purchase (unique `price_quote_id`), so an
     HTTP retry of the same confirmation returns the run it already started.
   - Capture and release are idempotent, so a worker redelivery charges
     nothing twice and calls the provider at most once per attempt.
10. **The database refuses a free run.** BEFORE INSERT triggers on
    `ai_reviews` and `rule_extraction_runs` require a bound purchase:
    - the right product and resource type;
    - `resource_id` equal to the row's id;
    - an owner equal to the initiating user.

    The binding is immutable afterwards. Rows that existed before this
    change keep a NULL purchase. They complete uncharged, and nothing is
    ever billed retroactively.
11. **A central registry, enforced by test.** `AI_OPERATION_REGISTRY` in
    `@palcert/contracts` classifies every AI operation as
    `BILLABLE_AI_SERVICE` or `INTERNAL_AI_OPERATION`. The internal operations
    are the benchmarks and the health probe, each with a stated reason. An
    architecture test scans the API for every content-bearing provider call
    and enforces three rules:
    - every call site must be classified;
    - every billable call site must contain the reservation check, a capture
      and a release;
    - no controller may reach the benchmark services.

    A new AI feature fails CI until someone decides who pays for it.
12. **Audit.** `AI_SERVICE_RESERVED`, `AI_SERVICE_CAPTURED` and
    `AI_SERVICE_RELEASED` are written against the purchase, carrying the
    product, the resource, the payer and, for organization work, the
    organization. `AI_SERVICE_QUOTED` is reserved in the vocabulary.
    Audit is history, not authority.
13. **Reporting from the purchases themselves.** The admin endpoints are
    `GET /admin/finance/purchases/summary` and `GET /admin/finance/purchases`,
    both requiring `finance:purchase:read`. They report per product and
    currency:
    - purchase count;
    - reserved, captured and released counts;
    - refunds;
    - captured revenue.

    Different currencies are never summed. For organization AI work the
    report shows the payer and the organization, which paid nothing.
    Customer history names the service ("AI review", "AI rule extraction";
    Arabic equivalents) and never a raw code.

## Consequences

- AI cost is recovered per use, and a role with powerful permissions gets no
  free AI.
- Every existing AI and extraction test now starts its runs with a funded
  quote, the only path production has.
- A deployment that activates no AI price simply has no AI. This is the safe
  default, and the UI explains it.
- Cancellation of an extraction by an organization admin who did not start
  it releases the starter's reservation under the starter's own RLS scope.
  The worker repeats the release idempotently if the run settles later.
- Out of scope: per-token or usage-based pricing, organization-paid billing,
  free allowances, and charging for benchmarks or health probes. Each would
  need its own ADR.
