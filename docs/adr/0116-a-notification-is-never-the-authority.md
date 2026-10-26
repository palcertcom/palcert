# ADR-0116: A notification reports an authoritative event and never becomes one

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 16

## Context

Every phase before this one produced facts somebody needs to be told about: a
submission reached an institution, a reviewer asked for changes, a certificate
was issued, a certificate was revoked. Until now nobody was told anything. A
person learned what had happened by signing in and looking.

The obvious way to fix that is to have the notification carry the news — put
the decision in the message, show it in the inbox, and let the two surfaces be
interchangeable views of the same thing. That is the failure this ADR exists to
prevent.

The moment a notification is treated as a view of the truth, a stale one is
indistinguishable from a current one. A revocation that arrives after an
approval email is just a later message; nothing in the system says which of
them the reader should believe. Worse, a notification is the easiest row in the
product to write — one that was also authoritative would be a way to make
things true by announcing them.

## Decision

**A notification reports an event. The event's authority stays where the phase
that created it put it.**

Concretely:

- `SUBMISSION_APPROVED` is reported here; whether a submission is approved is
  answered by Phase 14's `SubmissionDecisionEvent` and the revision's
  `institution_decision_status`, and by nothing in this phase.
- `CERTIFICATE_REVOKED` is reported here; whether a certificate verifies is
  answered by Phase 15's `ComplianceCertificate` and the public verification
  route, and by nothing in this phase.
- No Phase 16 table is read by any decision path in Phases 0–15. Deleting every
  row this phase writes would leave every question about what is true answered
  exactly as before.

**`DomainEvent` is a log of what happened, not a second outbox.** `ProcessingJob`
remains the one dispatch and retry mechanism in PalCert (ADR-0036). A domain
event is the *identity* a job refers to: the reason a retried job cannot notify
twice is a UNIQUE index on `(source_type, source_id, event_type)`, not a
worker's control flow.

**Every event is derived from one authoritative row.** Four SECURITY DEFINER
emitters, one per source, each taking a single row id:

| Source | Emitter | Events |
|---|---|---|
| `submission_revisions` | `app_domain_event_emit_submission_ready` | READY, REVISION_READY |
| `submission_decision_events` | `app_domain_event_emit_decision` | UNDER_REVIEW, APPROVED, REJECTED, REVISION_REQUESTED |
| `submission_comments` | `app_domain_event_emit_comment` | COMMENT_ADDED |
| `certificate_events` | `app_domain_event_emit_certificate` | CERTIFICATE_ISSUED, CERTIFICATE_REVOKED |

Each derives the event type, the owner, the organization, the aggregate and
`occurred_at` from that row. There is no parameter through which a caller can
state what happened, which is the difference between a log of events and a log
of claims. There is deliberately no generic emitter.

**The application role cannot write an event at all.** `palcert_app` holds
`SELECT` on `domain_events` and nothing else, so every event in the system is
the work of one of those four functions.

**The event is written in the transaction that made the thing true.** The
business change, the authoritative row, the `DomainEvent` and the
`NOTIFICATION_FANOUT` job commit together or not at all. A crash between them
is not a state the system can reach.

## Consequences

- A stale notification reads as an old message rather than as a competing
  truth, because it never had authority to begin with.
- Adding a tenth event type means adding an authoritative source for it. There
  is no way to notify about something PalCert did not record.
- Rendering is deterministic: `occurred_at` comes from the source row, not from
  `now()`, so a retried emission reproduces the same event.
- The cost is that a fan-out cannot invent recipients or context. Everything it
  knows comes from identifiers on the event, resolved against current state
  when the job runs.
