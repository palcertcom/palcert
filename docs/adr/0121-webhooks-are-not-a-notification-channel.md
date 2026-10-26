# ADR-0121: Webhooks are their own subsystem, not a `NotificationChannel`

- **Status:** Accepted
- **Date:** 2026-09-18
- **Phase:** 17

## Context

Phase 16 has `NotificationDelivery` with a channel enum — in-app and email.
Adding `WEBHOOK` to that enum would have been a two-line change, and several
things would then have come for free: a delivery table, a retry ladder, a
sweeper.

## Decision

**A separate subsystem.**

The two are different in every dimension that matters. A notification is
addressed to a *person* and its content is the message; a webhook is addressed
to a *machine* and its content is deliberately almost empty. A notification's
recipient is resolved from authority at delivery time; a webhook's recipient is
a URL an organization configured. A notification carries the substance —
names, titles, comment prose; a webhook must carry none of it. A notification
has no signature, no key rotation, no SSRF surface and no verification
handshake.

Sharing the table would have meant a channel column deciding, at every read,
which half of the columns were meaningful — and a payload column that must be
rich for one channel and minimal for the other, with nothing structural keeping
them apart.

## Consequences

Two retry ladders exist in the codebase with similar shapes and different
tuning, and that duplication is accepted (ADR-0119, ADR-0124).

The privacy rule is enforceable: `assertSafeWebhookPayload` allows five keys
across the whole vocabulary, which would be impossible on a shared payload.

An organization that wants both gets both, independently: the email goes to a
person, the webhook goes to a system.
