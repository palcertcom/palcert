# ADR-0120: The `DomainEvent` is the only source of an outbound webhook

- **Status:** Accepted
- **Date:** 2026-09-18
- **Phase:** 17

## Context

Phase 17 has to answer a question every webhook system answers badly at least
once: what causes a webhook? The tempting answers are all wrong in the same
way. A service method that sends one puts an outbound HTTP call inside a
business transaction. A database trigger puts it inside a lock. A route that
creates one on request makes the webhook the record of what happened, which
inverts the whole point.

Phase 16 already has an append-only, authoritative `DomainEvent` written in the
same transaction as the business change.

## Decision

**A webhook may only be projected from a committed `DomainEvent`.**

Fan-out reads an eligible event and writes a `WebhookEvent` — one per domain
event, enforced by a unique index — and one delivery per subscribed ACTIVE
endpoint. Nothing else creates a business `WebhookEvent`, and no API route
does.

The governing sentence is repeated in the contracts, in the migrations and in
the architecture document, because it is the thing most likely to be eroded by
a plausible-sounding feature request:

> A webhook is an external projection of an authoritative `DomainEvent`. It
> never becomes the authoritative record itself.

## Consequences

An integrator's system may act on a webhook, but PalCert may not. Nothing in
`webhook_*` is read to decide whether a submission was approved.

A control message (`TEST_ENDPOINT`) and a verification handshake are the two
outbound requests with no event behind them, and both are marked as such on the
wire: neither carries a `PalCert-Event-Id` header, so a receiver cannot record
one as business.

Fan-out is a worker, so an outbound integration can never slow down or fail a
business transaction.
