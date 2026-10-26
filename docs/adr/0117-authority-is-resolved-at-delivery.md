# ADR-0117: Authority and eligibility are resolved when the message is sent

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 16

## Context

There is a window between an event and the message that reports it. The
interesting cases all live in that window: a reviewer leaves the organization,
a person verifies their address, somebody turns a preference off, an account is
suspended.

Capturing the recipient list at fan-out time is the natural implementation and
the wrong one. A captured list is a standing grant: it keeps delivering to
somebody after the authority that put them on it is gone, and it does so
silently, because nothing re-reads the permission that justified it.

## Decision

**Fan-out is system work, and the database checks that it is.** Both fan-out
functions require `app_is_notification_fanout_context()`: no user scope, no
organization scope. Every request path sets `palcert.current_user_id`, so an
authenticated route cannot reach them, and the worker runs with no scope set
because that is what it is. The first cut gave these functions the emitters'
party check instead, and the worker satisfied it by opening its transaction as
the submission's owner — the system borrowing a customer's identity to gain
authority it should never have needed.

**The recipient is checked against the audience, by the database.** Passing the
caller check used to be enough for any user id. `app_notification_create` now
refuses a recipient the event does not name: an owner-audience event is for its
owner alone, and a reviewer-audience event is for somebody who holds
`submission:review:read` with an active membership in that organization *now*.
So a valid event plus an arbitrary user id cannot inject a notification into an
unrelated inbox, whatever a future application bug does.

That check and the delivery-time recheck below are not redundant. They solve
different races: one refuses somebody who was never eligible, the other
somebody who stopped being eligible.

**Who is told is a query against current permissions, not a stored list.**

`app_notification_submission_reviewers(p_event_id, p_limit, p_after)` resolves
`submission:review:read` inside the database, from an **event id** rather than
an organization id — the organization is derived from the authoritative event,
for the same reason the emitters derive everything from their source row. The
permission code is not a parameter either: nobody can ask "who holds
`certificate:revocation:write`" and receive a mailing list. The result is
bounded and keyset-paginated, because an organization's reviewer list is
unbounded in principle.

**Whether to send is asked again when the message would go out**, in this
order:

1. The deployment sends workflow mail at all — otherwise `CHANNEL_DISABLED`.
2. The account is `ACTIVE` — otherwise `ACCOUNT_INELIGIBLE`.
3. The address is verified — otherwise `NO_VERIFIED_EMAIL`.
4. The preference allows it, unless the type is mandatory — otherwise
   `PREFERENCE_DISABLED`.
5. A reviewer recipient still holds the permission — otherwise
   `AUTHORIZATION_REVOKED`.

Status is read **before** the verified-address flag, deliberately. A row that is
`PENDING_VERIFICATION` with an `email_verified_at` timestamp is a contradiction,
and the safe reading of a contradiction is "do not send" rather than "one of
these two columns must be right".

**A skip is not a failure.** It carries its reason and nothing retries, so "no
email arrived" has an answer that does not require reading anybody's mail.

**The in-app copy is unaffected by all of this.** Turning email off is a choice
about mail, not about being told.

## Consequences

- A reviewer who left the organization between the event and the send is not
  told about its work, and the row says why.
- A person who verifies their address in that window does get the mail, because
  eligibility was never decided early.
- Fan-out and delivery are two jobs rather than one. That is the cost of asking
  the question late, and it is what makes the answer meaningful.
