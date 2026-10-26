# ADR-0148: Payment-method reviewer assignment for manual top-ups

- **Status:** Accepted
- **Date:** 2026-10-03
- **Phase:** Post-RC finance
- **Amends:** [ADR-0147](0147-manual-topups-and-human-payment-verification.md) (who receives a submission alert)
- **Related:** [manual top-ups](../architecture/manual-topups.md), [API](../api/manual-topups.md), [notifications](../architecture/notifications.md)

## Context

Under ADR-0147 a manual top-up submission alerted the whole
`PLATFORM_FINANCE_REVIEWERS` audience: every user holding
`finance:manual-topup:review` through a GLOBAL role. Nobody could say which
finance person owned a given payment method, and every finance reviewer was
alerted about every transfer.

Investigating a report that "no email arrived" showed that the pipeline
already records why: each email delivery is created PENDING at fan-out and
resolved at send time to DELIVERED or SKIPPED with a reason. On our
staging stack every step succeeded and every email was skipped with
`CHANNEL_DISABLED`, because no email provider was enabled there. A
deployment where only `PALCERT_ADMIN` exists (the bootstrap command grants
only that role) has nobody to alert at all, and that left no trace. Neither
cause was visible to an administrator.

## Decision

1. **Assignment references users, never addresses.** A new table,
   `manual_payment_method_reviewers (payment_method_id, user_id, created_at,
   created_by_user_id)` with primary key `(payment_method_id, user_id)`,
   names the reviewers of one method. A database trigger refuses anyone who
   is not ACTIVE and holding `finance:manual-topup:review` through a GLOBAL
   role. An organization role of any kind never qualifies. There is no
   free-text field, so an address that could receive the alert but not open
   the review page cannot be stored.
2. **Assignment grants nothing.** Approving and rejecting still require
   their own permissions; the review permission is re-checked when the alert
   is fanned out and again when the email is sent.
3. **Routing, in the database resolver.**
   - If assigned reviewers who still qualify exist, only they are alerted.
   - If reviewers are assigned but none still qualifies, the alert falls back
     to the global audience and the fan-out writes a
     `MANUAL_TOPUP_REVIEWER_FALLBACK` audit row.
   - A method with nobody assigned keeps the ADR-0147 behaviour. This is how
     every existing method continues to work after the migration.
   - A submission that reaches nobody at all writes
     `MANUAL_TOPUP_NO_REVIEWER_AVAILABLE`, so it is never silent.
   - Routine routing writes `MANUAL_TOPUP_REVIEWERS_RESOLVED` with the
     routing used. Each of these actions is written once per request.
4. **Offering requires a reviewer.** A method cannot be enabled, and an
   enabled method cannot lose its last assignee, unless at least one eligible
   reviewer is assigned (`MANUAL_PAYMENT_METHOD_REVIEWER_REQUIRED`). Methods
   already offered with nobody assigned stay offered.
5. **Diagnostics for administrators.**
   `GET /admin/manual-topups/:id/notifications` (requires
   `admin:payment-method:manage`) returns:
   - each recipient of the submission alert;
   - their in-app status and email status, with the skip reason;
   - the routing used;
   - assignees who could not be alerted.

   Addresses are masked, and nothing from the provider is returned. A
   read-only SQL script, `scripts/diagnostics/manual-topup-notifications.sql`,
   answers the same question from the database for an operator.
6. **The email gains one fact.** The submitted alert also states the
   submission time in UTC. It still carries no receipt and no customer
   address.

## Alternatives considered

- **Free-text reviewer email addresses.** Rejected: an address can outlive
  the person's authority, and it could receive a review link to a page its
  owner cannot open.
- **Silently dropping the alert when no assignee qualifies.** Rejected: a
  transfer nobody is told about is invisible money.
- **Making the bootstrap administrator a reviewer.** Rejected: it would
  quietly merge publishing payment destinations with deciding that money
  arrived, which ADR-0147 keeps apart.

## Consequences

- Each payment method has a visible owner, and finance staff see only the
  alerts for methods they review.
- "No email arrived" can be answered from the admin page without reading
  logs.
- Migration `20261004000000_manual_payment_method_reviewers` is additive. It
  adds one empty table, replaces the platform branch of the reviewer resolver
  (every other branch is reproduced unchanged), adds one column to the facts
  function, and adds two read-only functions. It touches no existing row.
