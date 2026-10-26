# ADR-0126: At-least-once delivery, deduplicated on the event id

- **Status:** Accepted
- **Date:** 2026-09-18
- **Phase:** 17

## Context

Exactly-once delivery across a network to a system PalCert does not control is
not available. What is available is a choice about which failure to take: send
at most once and sometimes lose an event, or send at least once and sometimes
repeat one.

## Decision

**At least once, and say so.**

A worker that crashes after writing a request to the socket and before
committing the outcome genuinely does not know what happened, so the retry may
deliver an event a receiver has already seen.

The envelope's `id` is the **`WebhookEvent`'s** id, not the delivery's, and it
is stable across every automatic retry and every manual replay. That is the
receiver's deduplication key, and the integrator documentation says so in as
many words, with a table of which identifiers change and which do not.

## Consequences

An automatic retry reuses the delivery id; a manual replay creates a new one;
both carry the same event id. A receiver that deduplicates on the delivery id
gets the retry behaviour right and the replay behaviour wrong, which is why the
documentation names the mistake rather than only the rule.

A test message and a verification handshake carry no event id at all, because
they project no event.

PalCert does not attempt to suppress a duplicate it cannot be sure about. A
suppression that is wrong loses a real event, which is strictly worse than a
duplicate the receiver can discard.
