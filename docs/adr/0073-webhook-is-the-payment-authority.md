# ADR-0073: The verified webhook is the payment authority; the browser redirect is not

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 10

## Context

After paying on the provider's hosted page, the customer's browser is
redirected back to PalCert, typically to something like
`/balance/payment-return`. It is the obvious moment to add the credit: the
customer is right there, waiting.

It is also a URL. Anyone can type it. A customer who has never paid can visit
it, and so can one who abandoned the payment. A redirect proves that *a
browser navigated somewhere* — nothing about money.

It is also unreliable in the honest case: the customer closes the tab, their
connection drops, the payment completes after an authentication challenge. If
the redirect is what credits the balance, a customer who paid and closed the
tab has paid for nothing.

## Decision

**Credit is applied only by a signature-verified provider event, or by
PalCert's own re-query of the provider. The return page is user experience and
has no authority.**

- The webhook endpoint verifies the signature against the **exact raw request
  bytes**. The application is bootstrapped with `rawBody: true` for this
  reason: any parse-and-reserialize step breaks the signature, and a broken
  signature is rejected, not tolerated.
- Browser CSRF protection is deliberately not applied to this route. A provider
  is not a browser, holds no cookie, and sends no `Origin`; the signature *is*
  the authentication. The CSRF guard skips routes explicitly marked
  `@ProviderSigned()`, and only those.
- A verified event is recorded and then processed asynchronously. Processing
  never trusts the event payload's amount: it re-retrieves the payment from the
  provider and checks the amount, the currency and the client reference against
  the PalCert row before crediting anything. A mismatch parks the top-up in
  `RECONCILIATION_REQUIRED` for a human, and credits nothing.
- Because a webhook can be lost entirely, a sweeper re-queries any top-up that
  has been open longer than a threshold. Credit therefore arrives without any
  webhook at all — just later.
- The return page asks the server for the top-up's *status* and displays it. It
  says "we are confirming your payment" until the server says otherwise, and
  tells the customer they can safely close the page.

## Alternatives considered

**Credit on redirect, verify later.** Rejected. It is a spendable balance
created by a URL visit; the "verify later" step is a reconciliation of money
already given away.

**Credit on redirect only when a provider session id in the query string
checks out.** Rejected. It is better, but it is still a flow whose happy path
depends on the browser returning, and it adds a second crediting path that must
be kept exactly as strict as the first. One authority is simpler to keep
correct.

**Poll the provider instead of accepting webhooks.** Rejected as the primary
mechanism — it is slow and wasteful — but kept as the safety net, which is what
the reconciliation sweeper is.

## Consequences

- A customer who pays and immediately closes the tab still gets their credit.
- A customer who visits the return URL without paying sees "we are confirming",
  then the truth, and no balance changes.
- Provider secrets, signature headers and raw payloads are never logged.
- The end-to-end suite asserts the property directly: after the redirect, the
  balance is still zero; it becomes non-zero only after a verified event.
