# ADR-0124: A receiver's answer never enters the queue's retry ladder

- **Status:** Accepted
- **Date:** 2026-09-18
- **Phase:** 17

## Context

Phase 16 solved the same-shaped problem by letting the email job *fail* on a
retryable error, exhausting the queue's short ladder, dying, and being revived
by a sweeper (ADR-0119). Reusing that shape for webhooks would mean a receiver's
503 is first asked again several times within about ninety seconds.

For an email relay that is tolerable. For somebody else's production server it
is PalCert hammering a system that has just said it is struggling.

## Decision

**A receiver's answer is never a job failure.**

`WebhookDeliveryService.attempt()` never throws for anything a receiver did. It
records the attempt, classifies the answer, writes the delivery's own
`next_attempt_at` from the webhook ladder (1m, 5m, 30m, 2h, 12h, 24h), and the
job **succeeds**. `WebhookDeliverySweeper` re-arms that same job when the time
arrives.

Only PalCert failing to *carry out* the attempt throws, which is what the
queue's ladder is for.

This needs one new edge in the processing-job lifecycle — `SUCCEEDED` back to
`PENDING` — granted to `WEBHOOK_DELIVER` alone and only to `PENDING`. For every
other job type `SUCCEEDED` stays terminal, because for every other job type a
second run is a duplicate.

The same rule holds for verification, one row further out: an HTTP answer
settles the administrator's intent rather than requeueing the job. Asking again
is an explicit act with a new idempotency key.

## Consequences

Nothing waits in the queue for a day.

A 503 costs exactly one outbound request, which is asserted directly in the
delivery service's unit suite.

The webhook ladder is bounded: when the rungs run out the delivery fails
permanently, while its last attempt still records what the receiver actually
said. Those are two different facts, and the atomic finish doorway accepts that
pairing explicitly.
