# Notifications and reliable event delivery (Phase 16)

> A notification reports an authoritative event.
> It never becomes the authoritative record itself.

Everything below follows from that sentence. If a future change makes some
part of this phase the answer to "was this submission approved?" or "does this
certificate verify?", the change is wrong however well it works.

## What exists

Nine event types, two channels, five tables.

| Table | Class | What it is |
|---|---|---|
| `domain_events` | SYSTEM | Append-only log of authoritative workflow events |
| `user_notifications` | USER_SCOPED (`recipient_user_id`) | One person's private copy, rendered once |
| `notification_deliveries` | SYSTEM | One logical delivery per (notification, channel) |
| `notification_delivery_attempts` | SYSTEM | Append-only history of what was tried |
| `notification_preferences` | USER_SCOPED (`user_id`) | A person's email choices |

The nine types: `SUBMISSION_READY`, `SUBMISSION_REVISION_READY`,
`SUBMISSION_UNDER_REVIEW`, `SUBMISSION_APPROVED`, `SUBMISSION_REJECTED`,
`SUBMISSION_REVISION_REQUESTED`, `SUBMISSION_COMMENT_ADDED`,
`CERTIFICATE_ISSUED`, `CERTIFICATE_REVOKED`.

The two channels: `IN_APP` and `EMAIL`. Nothing else, in this phase or by
accident — the channel is a database enum.

## The path a notification takes

```
  an authoritative row is written
            │  (same transaction)
            ▼
     app_domain_event_emit_*   ──►  domain_events          (UNIQUE source identity)
            │
            ▼
     ProcessingJob(NOTIFICATION_FANOUT, resourceId = event.id)
            │  ── worker ──
            ▼
     resolve recipients   (permissions, now — not at the event)
            │
            ▼
     app_notification_create  ──►  user_notifications      (UNIQUE logical identity)
                             ──►  notification_deliveries(IN_APP, DELIVERED)
            │
            ▼
     notification_deliveries(EMAIL, PENDING)               (UNIQUE per channel)
            │
            ▼
     ProcessingJob(NOTIFICATION_EMAIL_SEND, resourceId = delivery.id)
            │  ── worker ──
            ▼
     eligibility, then NotificationEmailProviderPort
```

Three UNIQUE constraints, at three levels, are what make "tell somebody once"
a property of the schema rather than of a worker's control flow:

- `domain_events_source_identity` — one committed source row produces one
  event of a given type, for ever.
- `user_notifications_logical_identity` — one event notifies one person once.
- `notification_deliveries_logical_identity` — one notification schedules one
  logical email.

At-least-once is what the queue promises. Every one of those layers is where
the second delivery stops.

## Where events come from

Four SECURITY DEFINER emitters, each taking one authoritative row id. There is
no generic emitter, and `palcert_app` holds `SELECT` on `domain_events` and no
write privilege at all — so every event in the system is the work of one of
these four functions.

| Source row | Emitter | Produces |
|---|---|---|
| `submission_revisions` | `app_domain_event_emit_submission_ready` | READY when `revision_number = 1`, REVISION_READY otherwise |
| `submission_decision_events` | `app_domain_event_emit_decision` | UNDER_REVIEW / APPROVED / REJECTED / REVISION_REQUESTED; `SUBMITTED` produces nothing |
| `submission_comments` | `app_domain_event_emit_comment` | COMMENT_ADDED |
| `certificate_events` | `app_domain_event_emit_certificate` | CERTIFICATE_ISSUED / CERTIFICATE_REVOKED |

Two rules that are easy to get wrong and are enforced rather than remembered:

**READY vs REVISION_READY is derived from `revision_number`**, by the database,
and only for a revision whose `processing_status` really is READY. The
preparation worker emits it only when `app_submission_finalize_revision`
returns `true` — that is, only when *this* delivery is the one that finalized
the revision. A duplicate delivery emits nothing, because it made nothing true.

**A decision that carried a comment is one event, not two.** `decide()` writes
an inline `submission_comments` row and does not call the comment emitter; the
decision event reports the whole act. Only a standalone `comment()` produces
`SUBMISSION_COMMENT_ADDED`. Two notifications for one thing that happened is
the failure this rule prevents.

## What an event may carry

Identifiers and a decision status. Nothing else.

```
submissionId · submissionRevisionId · revisionNumber
certificateId · institutionDecisionStatus
```

Never: document text, filenames, titles, report findings, comment bodies, email
addresses, display names, verification codes, certificate numbers, certificate
claims, storage keys, balances, payment data, AI output, SmartFix manifests.

Enforced three times over, because the three fail differently:

1. `ALLOWED_PAYLOAD_KEYS` — a per-type allowlist in the contracts package.
2. A forbidden-key pattern — a key missing from the allowlist is a mistake; a
   key matching this pattern is a leak.
3. `assertSafeEventPayload`, applied by `DomainEventService` to the row that
   was actually written. The SQL builds the payload, so this is the check a
   future migration edit cannot slip past. It throws inside the transaction,
   which rolls the business change back with it — a hard failure, and the right
   trade against writing a document title into a durable log where it survives
   in backups and exports to an audience nobody chose.

The rendered copy obeys the same rule from the other direction: template text
is fixed strings with no value interpolated into it, so rendering cannot leak
what the payload does not carry. A reader is told that something happened and
given a link; the substance requires signing in.

## Who gets told

| Event | Audience |
|---|---|
| READY, REVISION_READY | the organization's reviewers |
| UNDER_REVIEW, APPROVED, REJECTED, REVISION_REQUESTED, COMMENT_ADDED | the submission's owner |
| CERTIFICATE_ISSUED, CERTIFICATE_REVOKED | the certificate's owner |

Owner audiences come off the event itself, so they are the authoritative owner
of the source row and never anything a client sent.

The reviewer audience is `app_notification_submission_reviewers(p_event_id,
p_limit, p_after)`: it resolves `submission:review:read` inside the database,
derives the organization from the event rather than taking it as a parameter,
takes no permission parameter, bounds `p_limit` to 500 and pages by keyset.
Authority is read when the job runs, not when the event happened.

**Fan-out is system work and says so.** Both fan-out functions require
`app_is_notification_fanout_context()` — no user scope, no organization scope.
Every request path sets `palcert.current_user_id` before it touches anything,
so an authenticated route cannot reach them however it is written, and the
worker calls them with no scope set, which is the truth about what it is.

An earlier version gave these functions the emitters' party check, and the
worker satisfied it by opening its transaction as
`withUser(event.owner_user_id)`. It worked, and it was the system borrowing a
customer's identity in order to enumerate an organization's reviewers and write
into their inboxes. The `NOTIFICATION_FANOUT` job carries neither an owner nor
an organization precisely because it is nobody's work but PalCert's.

**The recipient is validated against the audience, in the database.**
`app_notification_create` refuses a recipient the event does not name: an
owner-audience event is for its `owner_user_id` and nobody else, and a
reviewer-audience event is for somebody who satisfies
`app_notification_is_reviewer(organization_id, recipient)` *now*. Until this
existed the doorway was wider than the product rule — pass the caller check and
any user id was accepted — and "the service supplies the right one" is not an
invariant. A valid event plus an arbitrary user id is now refused.

That check and the delivery-time reauthorization solve different races: this
one refuses somebody who was never eligible, and that one refuses somebody who
stopped being eligible.

**Recipients are streamed, one bounded page at a time.** `recipients()` is an
async generator: a page is read, consumed and discarded before the next is
asked for. An earlier version paged the database correctly and then pushed
every page into one array before notifying anybody, which is the same unbounded
read with extra steps. SQL pagination that feeds an unbounded array is not
pagination.

Each recipient is its own transaction. An organization with ten thousand
reviewers would otherwise be one transaction holding ten thousand row locks,
and a failure at recipient 9,999 would discard the 9,998 people already told.
Every write is idempotent, so a re-run finishes the list rather than starting
it again.

**An event this build cannot read is refused rather than guessed at.** The
database requires only `event_schema_version >= 1`, so a later phase can write
a version 2 event into a schema an older deployment is still reading. Fan-out
compares against `DOMAIN_EVENT_SCHEMA_VERSION` and throws
`UnsupportedEventSchemaError` before it interprets the payload or resolves an
audience, leaving no notification and no delivery, and handing the job to the
ordinary failure ladder where a dead letter is something an operator can see.

## Email

`NotificationEmailProviderPort` — deliberately *not* Phase 1's
`MailDeliveryPort`, which is untouched. See ADR-0118: the separation is a
security boundary, not tidiness.

Three adapters, chosen by `NOTIFICATION_EMAIL_PROVIDER`:

- `disabled` (default) — a legitimate production choice. Deliveries record
  `CHANNEL_DISABLED` rather than accumulating retries against a transport that
  was never going to exist.
- `fake` — deterministic, in-memory, refused in production.
- `smtp` — `nodemailer@10.0.10` exactly, no `@types/nodemailer`,
  `disableFileAccess` and `disableUrlAccess` set, five message fields and no
  others.

Eligibility is resolved at send time, in this order (ADR-0117): channel,
account status, verified address, preference, reviewer authority. Status is
read before the verified-address flag, so a contradictory row reads as
ineligible rather than as verified.

`CERTIFICATE_REVOKED` cannot be switched off. The route refuses it with
`NOTIFICATION_TYPE_MANDATORY`, and
`notification_preferences_mandatory_email_stays_on` refuses the stored row —
so the rule holds against a route nobody has written yet.

## Retries

Two ladders (ADR-0119). The queue's is short and fast; the email ladder is one
minute, five, thirty, two hours, twelve hours, driven by `next_attempt_at` and
`NotificationSweeper`, which resurrects the DEAD job rather than creating a
second one.

`notification_deliveries_guard` refuses a terminal delivery moving back to
`PENDING`, so a stale worker cannot send a delivered email twice.

## Interruption

A worker can die between claiming a delivery and hearing back from the relay.
That leaves the row `SENDING`: neither finished nor waiting, and — before this
was handled — a state no sweep looked at and `send()` refused to touch, so the
job reported success and the delivery stayed `SENDING` for ever.

`send()` now accepts `SENDING` and recovers it. What makes that safe is not a
timer but the `ProcessingJob` lease: reaching `send()` at all means
`WorkerService` already claimed the delivery's job through
`ProcessingJobService.start`, which refuses a job another worker holds a live
lease on. A second worker cannot be inside `send()` for the same delivery while
the first is alive — it would have to claim the job first, and the claim is
what it cannot get. Ownership is the queue's, and it is a stronger signal than
any "SENDING for more than N minutes" guess.

Two routes reach the interrupted row, and both close it:

- **The lease lapses.** `reapAbandoned` returns the job to the outbox, it is
  redelivered, and `send()` closes the open attempt as `WORKER_INTERRUPTED`
  before starting a new one.
- **The queue's budget is spent.** The job dies, `failExhausted` closes the
  open attempt the same way and hands the delivery to the email ladder.

`WORKER_INTERRUPTED` is its own code rather than `PROVIDER_UNAVAILABLE`,
because those are different facts: the relay refusing us, and PalCert never
finishing the question. An operator reading attempt history should be able to
tell them apart.

**This is at-least-once, and the duplicate is real.** If the relay accepted the
message before the crash, PalCert cannot know that, and the retry sends it
again. The alternative is somebody never learning their certificate was
revoked, which is the larger harm. What mitigates it is the Message-ID: one
per *logical delivery*, `<notification-delivery-{id}@{sender domain}>`,
identical on every attempt, with a domain taken from the deployment's own
configured sender rather than from event or user data. It guarantees no
deduplication — that is not ours to promise — but it gives a relay or a client
the chance to recognise two transmissions as one PalCert email rather than
two unrelated ones.

## What the database refuses

- Any UPDATE or DELETE on `domain_events`.
- Any INSERT on `domain_events` by `palcert_app`.
- An event whose `source_type` cannot produce its `event_type`.
- An event whose `aggregate_type` does not match what happened.
- A second event for the same `(source_type, source_id, event_type)`.
- Any change to a `user_notifications` row except `read_at`.
- Any read of a notification by anyone but its recipient — including every
  other member of the organization whose context it carries.
- A `notification_preferences` row disabling `CERTIFICATE_REVOKED`.
- A settled delivery restarting.
- `app_notification_submission_reviewers` or `app_notification_create` for a
  caller holding any tenant scope — including the submission's own owner.
- A notification for a recipient the event's audience does not name.

The last one is worth a note. The caller check originally compared the row's
owner and organization against the session GUCs directly; with a GUC unset
those comparisons are NULL, `false OR NULL` is NULL, and `IF NOT NULL THEN`
never fired — so the guard let the caller through. SQL's three-valued logic was
the whole of the defect: the comparison was right and the answer was "unknown",
which an authorization check must read as no. It now requires each context to
exist before it can match, and coalesces the result.

## What this phase does not do

- No SMS, no push, no webhooks, no digests, no in-app toasts pushed over a
  socket. The unread badge polls once a minute; when something is genuinely
  urgent, PalCert sends email.
- No organization-side inbox. There is no route by which one member reads
  another's notifications, and no plan for one: the record that an institution
  was informed is the submission's own history.
- No backfill. The tables start empty, and nothing that happened before this
  phase is notified about. There is deliberately no time watermark — a test
  clock could make a legitimate event look historical, and a cutover that
  depends on wall-clock comparison is a cutover that fails strangely.

## Attestation notifications

Nine types, emitted from `attestation_request_events` and
`attestation_reminders` rows by `app_domain_event_emit_attestation` and
`app_domain_event_emit_attestation_reminder`: `ATTESTATION_SUBMITTED`,
`ATTESTATION_READY_FOR_REVIEW` (institution reviewers), `ATTESTATION_INFORMATION_REQUESTED`,
`ATTESTATION_INFORMATION_PROVIDED` (institution reviewers), `ATTESTATION_APPROVED`,
`ATTESTATION_REJECTED`, `ATTESTATION_REVOKED` (email mandatory),
`ATTESTATION_EXPIRING` and `ATTESTATION_EXPIRED` (reminders). None is
projected to integration webhooks yet (`webhook_eligible = false`). Deep links: `/{locale}/attestations/{id}` for the owner,
`/{locale}/organizations/{org}/attestations/{id}` for reviewers. Reviewer
audiences resolve by `attestation:request:review` at fan-out. Details and the
reminder idempotency rule: [attestations.md § Notifications](attestations.md#notifications).


## Platform-scoped notifications (manual top-ups)

Three types happen to no organization: `MANUAL_TOPUP_SUBMITTED`,
`MANUAL_TOPUP_APPROVED`, `MANUAL_TOPUP_REJECTED`
([ADR-0147](../adr/0147-manual-topups-and-human-payment-verification.md)).
Their events and copies carry `organization_id = NULL`, and a CHECK on each
table holds both directions: these types must have no organization, and every
other type must still have one. Platform events are never webhook-eligible.

`MANUAL_TOPUP_SUBMITTED` goes to `PLATFORM_FINANCE_REVIEWERS` — users who hold
`finance:manual-topup:review` through a GLOBAL role, resolved at fan-out and
re-checked at send time (`app_notification_is_platform_reviewer`); an
organization-scoped grant of the same code never counts. The decisions go to
the owner. Each copy adds a closed, typed list of facts read from the request
at render time (amount, currency, method name, reference, fixed rejection
sentence) through `app_manual_topup_notification_facts`, which answers only
to the fan-out path or the notification's own recipient. The event payload
carries only `manualTopUpRequestId`.
