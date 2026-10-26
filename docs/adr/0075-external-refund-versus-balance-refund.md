# ADR-0075: A refund to a card and a refund to the balance are different acts

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 10

## Context

"Refund" means two unrelated things in a product with a balance.

A **service refund** happens when PalCert fails to deliver something the
customer paid for. Credit that was captured goes back to the customer's
balance. No money leaves PalCert; no card is involved.

An **external refund** sends real money back through the payment provider to
the card that paid. It reverses a top-up.

Conflating them is expensive in both directions. Treat an external refund as a
balance movement and the customer keeps spendable credit *and* gets their money
back. Treat a service refund as an external one and PalCert makes a card
transaction for a service failure that should never have touched a card.

Promotional credit sharpens the point. PalCert grants it; no money ever arrived
for it. If it can be refunded externally, granting $10 of promotional credit
means handing out $10 in cash.

## Decision

**Two mechanisms, two ledger entry types, and a structural barrier between
them.**

- A service refund appends `SERVICE_REFUND` to the customer's balance. It is
  idempotent per originating charge and never contacts the provider.
- An external refund is initiated by finance only — there is no self-service
  endpoint, because "give me my money back" is a conversation with a policy
  behind it. It **reserves the credit before calling the provider**, so the
  customer cannot spend the same money while the refund settles. On provider
  success the reservation is captured as a `PAYMENT_REFUND_DEBIT`; on failure
  it is released and the balance is untouched.
- Promotional credit is unreachable from an external refund by construction,
  not by a check in a service: the reservation is taken against a **CASH**
  account, and a database CHECK refuses a `PAYMENT_REFUND_DEBIT` on any other
  credit class.
- Spending draws promotional credit first, so a customer's refundable cash is
  preserved for as long as possible.
- A chargeback — the customer's bank reversing a payment — is a third thing
  again: `CHARGEBACK_DEBIT`, which may take the balance below zero. PalCert
  does not fabricate credit to keep the number non-negative; the customer is
  told what happened and why.

## Alternatives considered

**One refund concept with a destination flag.** Rejected. Every downstream
decision — does this call the provider, may it use promotional credit, who may
start it, what happens on failure — would branch on that flag, and one missed
branch is real money.

**Allow promotional credit to be refunded when it is the only credit left.**
Rejected. It converts a marketing grant into a cash withdrawal path, which is
what the phase forbids and what the UI tells the customer will not happen.

**Block the refund when the balance is insufficient.** This *is* the behaviour,
and it is why the reservation exists: an external refund of money the customer
has already spent is refused with `INSUFFICIENT_BALANCE` rather than creating a
negative balance on PalCert's initiative.

## Consequences

- The two flows share the ledger and nothing else.
- A refund in flight is visible to the customer as reserved, not missing.
- A negative balance is possible, has exactly one legitimate cause, and is
  explained where the customer sees it.
