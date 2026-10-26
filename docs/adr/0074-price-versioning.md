# ADR-0074: Prices are immutable versions; the client never names a price

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 10

## Context

A price is not a number, it is a number that was true at a time. Two questions
make that concrete. What did this customer actually pay in March, after the
price changed in April? And what happens to a customer who opened a checkout
screen showing $1.00 the moment the price becomes $1.50?

A mutable `price` column answers the first question wrongly — it answers with
today's price — and the second question not at all.

There is a security dimension as well. If the client tells the server what a
check costs, then the cost of a check is whatever the client says.

## Decision

**A price is an immutable `PriceVersion` row. Activating a new one retires the
old one; nothing is edited. The server derives the price, and a `PriceQuote`
freezes it for a short window.**

- `ServiceProduct` is the stable thing (`DOCUMENT_CHECK`). `PriceVersion`
  carries the money, the currency, the market, and a status of `DRAFT`,
  `ACTIVE` or `RETIRED`.
- Once a version is `ACTIVE`, its financial fields are immutable — enforced by
  a trigger, not by the service layer.
- A partial unique index permits exactly one `ACTIVE` version per
  (product, currency, market). Activation retires the incumbent and activates
  the successor in one transaction, so there is never a moment with two active
  prices or none.
- `GET /pricing/quote` returns a `PriceQuote`: an immutable row with the amount
  and an expiry. Quotes are append-only; an expired quote is refused rather
  than silently re-priced.
- The client never supplies an amount. It names a product, and the server
  answers.
- Pricing changes are platform-administrative acts, audited as
  `PRICE_CREATED`, `PRICE_ACTIVATED` and `PRICE_RETIRED`, with the actor
  recorded. Organizations have no pricing permissions of any kind.

## Alternatives considered

**A mutable price column with an audit trail.** Rejected. The audit trail
records that the price changed; the historical charge still has to be
reconstructed by replaying it. The version *is* the record.

**Effective-dated rows (`valid_from`, `valid_to`).** A reasonable alternative,
and close to what this is. Status plus a uniqueness constraint was chosen
because "which price is in force right now" becomes an index lookup rather than
an interval query, and because the transition is a single transaction rather
than two date edits that can overlap.

**No quotes; price at the moment of charge.** Rejected. A customer who is shown
a price and charged another has been misled, even by a few cents. The quote is
short-lived precisely so this is a freeze, not a promise.

## Consequences

- Every charge can name the exact price version behind it, forever.
- A price change is safe under load: in-flight quotes honour the old price
  until they expire, and new quotes get the new one.
- Phase 10 carries no currency conversion. A product with no active price in
  the requested currency is an explicit `PRICE_NOT_AVAILABLE`, never a USD
  price converted on the fly.
