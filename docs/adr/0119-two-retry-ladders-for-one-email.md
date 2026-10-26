# ADR-0119: Two retry ladders, because they are waiting for different things

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 16

## Context

`ProcessingJob` already has a retry ladder: exponential backoff with jitter,
capped in the low seconds, with a bounded attempt budget (ADR-0037). It is
tuned for work PalCert controls — a storage read, an analyzer call, a render.

An outbound email is not that. A relay can be unreachable for hours, and the
right response to that is to try again in an hour, not to exhaust six attempts
in ninety seconds and declare the notification permanently failed. But holding
a queue job in `RETRY_PENDING` for twelve hours would occupy the queue with
waiting, which is not what a queue is for.

## Decision

**Both ladders, each doing what it is good at.**

The queue's ladder handles the ordinary case: a relay hiccups, the next attempt
seconds later succeeds. The email handler rethrows on a retryable failure
rather than recording one — recording "FAILED_RETRYABLE" and returning would
mark the job SUCCEEDED, and a succeeded job is never delivered again, so the
retryable state would be the one state nothing ever retried. (Phase 15 learned
this the same way.)

When the queue's budget is spent the job dies, and the `failExhausted` hook
hands the delivery to the **email ladder**: one minute, five minutes, thirty
minutes, two hours, twelve hours. The delivery goes back to
`FAILED_RETRYABLE` with `next_attempt_at` set, and `NotificationSweeper`
re-enqueues it when that time arrives.

The re-enqueue works because `enqueueInTransaction` resurrects a DEAD job
rather than creating a second one (ADR-0036). One delivery keeps one job for
its whole life, so `NOTIFICATION_EMAIL_SEND:{deliveryId}` stays a meaningful
idempotency key.

When the email ladder is spent too, the delivery is `FAILED_PERMANENT`: a dead
letter an operator can inspect, not a loop.

**A crashed worker leaves `SENDING`, and that is recoverable.** `send()`
accepts a `SENDING` row and closes its open attempt as `WORKER_INTERRUPTED`
before starting another. What makes that safe is the `ProcessingJob` lease
rather than a timer: reaching `send()` means the job was already claimed
through `ProcessingJobService.start`, which refuses a job another worker holds
a live lease on. Two workers cannot both be in `send()` for one delivery while
the first is alive. `failExhausted` closes the same attempt when the queue's
budget runs out instead, so neither route leaves the row open.

`WORKER_INTERRUPTED` is deliberately not `PROVIDER_UNAVAILABLE`: the relay
refusing us and PalCert never finishing the question are different facts, and
attempt history should say which happened.

**The retry can duplicate, and the Message-ID is the mitigation.** If the relay
accepted before the crash, PalCert cannot know it, and the retry sends again —
accepted, because the alternative is somebody never learning their certificate
was revoked. One Message-ID per *logical delivery*, identical on every attempt
and domained from the deployment's own configured sender, gives a relay or a
client the chance to see two transmissions as one PalCert email. It promises no
deduplication; it removes the reason the two would look unrelated.

## Consequences

- A provider outage measured in hours does not turn into permanently failed
  notifications.
- Nothing retries for ever, and nothing occupies a queue slot while waiting
  half a day.
- The sweeper is bounded per pass and idempotent, so running two workers is
  harmless — the same property every other PalCert sweep relies on.
