# ADR-0072: Stripe Hosted Checkout is the reference adapter, and PalCert never touches a card

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 10

## Context

Someone has to collect a card number. The question is who, and what that
decision costs.

If PalCert renders the card fields — even in its own form posting directly to
the provider — the page is in scope for PCI DSS SAQ A-EP: script integrity,
change control on every asset the page loads, and an annual assessment of all
of it. If PalCert's *server* ever receives the number, the scope becomes SAQ D
and a different kind of company.

There is a technical cost too. Card authentication is not a form post. 3-D
Secure challenges, regional authentication rules, wallet buttons, and the
regulatory requirements behind them change continuously, and every one of them
has to be implemented in whatever surface collects the card.

## Decision

**Payment details are collected on the provider's own hosted page. PalCert
creates a Checkout Session, redirects the browser to it, and never sees a card
number, CVC, expiry or bank credential.**

- `createTopUpSession` builds a Stripe Checkout Session in `payment` mode with
  an inline `price_data` whose `unit_amount` is the minor units PalCert already
  holds — no conversion, no multiplication by 100.
- The session carries PalCert's own identifiers: `client_reference_id` is the
  top-up id, and metadata repeats the top-up and user ids. These are what tie
  a later provider event back to a PalCert row.
- The API version is **pinned** in the adapter rather than inherited from
  whatever the SDK was built against, so a provider release cannot silently
  change the shape of what PalCert parses.
- Every state-changing provider call carries a derived idempotency key
  (`providerIdempotencyKey`), so a retry after a timeout does not create a
  second payment or a second refund.
- The checkout URL is short-lived, returned once, and never stored on a PalCert
  row.

## Alternatives considered

**Stripe Elements embedded in PalCert's page.** Rejected for Phase 10. It is a
better-looking flow, and it drags the page into SAQ A-EP scope with all the
script-integrity obligations that implies, for no functional gain on a top-up
screen.

**A direct server-to-server charge API.** Rejected outright. It requires the
card number to reach PalCert, which the phase forbids and which no amount of
care makes acceptable for this product.

**Storing the checkout URL so the customer can resume.** Rejected. It is a
bearer capability to a payment context; the customer can always start a new
top-up, which costs nothing and leaks nothing.

## Consequences

- PalCert stores no cardholder data of any kind, and the code cannot express
  storing it: no field exists.
- The customer briefly leaves PalCert, which the UI says explicitly before they
  go, including that PalCert will not see their details.
- Because the browser leaves and returns, the return URL becomes a tempting
  place to credit a balance. It is not one — see ADR-0073.
- Stripe is the reference adapter, not the interface. The port
  (ADR-0071) is what the rest of the system depends on.
