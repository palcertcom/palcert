# ADR-0071: The payment provider sits behind a port, and business logic never imports it

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 10

## Context

PalCert takes card payments through Stripe. Stripe's vocabulary — Checkout
Sessions, PaymentIntents, Charges, `checkout.session.completed` — is specific,
detailed, and entirely Stripe's. If that vocabulary spreads into the services
that credit balances and settle refunds, then Stripe is no longer a dependency;
it is the design.

That matters for three reasons beyond portability. A service that imports
Stripe cannot be tested without either the network or a mock of a large API
surface. A service that branches on `event.type === 'charge.dispute.created'`
has to be re-read, not just re-configured, if the provider changes. And a
deployment in a market Stripe does not serve has nowhere to start.

## Decision

**One abstract port, `PaymentProviderPort`, with a provider-neutral vocabulary.
Exactly one adapter per provider implements it. Nothing outside
`infrastructure/payments/` imports a provider SDK.**

- The port is small on purpose: `getCapabilities`, `createTopUpSession`,
  `retrievePayment`, `refundPayment`, `verifyAndParseWebhook`,
  `checkAvailability`.
- `verifyAndParseWebhook` returns a `VerifiedPaymentEvent` whose `kind` is one
  of PalCert's own: `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`,
  `PAYMENT_CANCELLED`, `REFUND_SUCCEEDED`, `REFUND_FAILED`,
  `DISPUTE_OPENED`, `DISPUTE_CLOSED`, `UNSUPPORTED`. The Stripe adapter is the
  only file in the repository that contains a Stripe event name.
- Provider errors are translated to a `PaymentFailureKind` — is it retryable,
  was it declined, was the request itself wrong — because "retry this" is a
  decision the caller must be able to make without knowing whose error it is.
- A `FakePaymentProvider` implements the same port with configurable
  behaviours: unavailable, rate limited, declined, already refunded, wrong
  amount, invalid signature. It is what the test suite runs against, and it is
  refused at startup in production.

## Alternatives considered

**Import Stripe where it is needed and abstract later.** Rejected. "Later" is
after the vocabulary has spread, at which point the abstraction is a refactor
of everything rather than a boundary.

**A generic gateway library.** Rejected. A lowest-common-denominator layer over
several providers hides exactly the details that matter for correctness —
idempotency semantics, signature schemes, what a webhook guarantees — while
still leaking provider concepts when they differ.

## Consequences

- The finance services are tested end to end without a network, including
  failure modes a real provider would be hard to provoke on demand.
- Adding a second provider is implementing one class and registering it; the
  services do not change.
- The port is narrow enough that a provider whose model differs (a redirect
  bank transfer, a local processor) can implement it, and
  `getCapabilities` lets it say what it cannot do rather than pretending.
