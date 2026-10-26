# ADR-0107: Reading a submission is dual-party; writing it is not

- **Status:** Accepted
- **Date:** 2026-09-15
- **Phase:** 14

## Context

The first `DUAL_PARTY_SCOPED` implementation gave each submission table a
single `FOR ALL` policy naming both parties. It read correctly and it was
wrong: it said the two parties have the same authority over the row.

They do not, and the asymmetry is the whole architecture.

- Only the author creates a submission or a revision. An organization able to
  insert one would be an organization helping itself to a document.
- Only the organization records a decision or writes a review comment. An
  author able to insert an `APPROVED` event would be able to forge a
  university's answer about their own thesis.
- Neither may touch the technical result. `Technical Compliance ≠ Institution
  Decision` is not a convention the API observes; it has to be something the
  database refuses.

Row-level security decides which *rows* a caller may touch. It cannot decide
which *columns*, and column `GRANT`s are per-role while both parties share one
application role. So policies alone cannot express this.

## Decision

**Command-specific policies for row authority, and a trigger for column
authority, with the context deciding which party is acting.**

- `official_submissions` and `submission_revisions`: SELECT for both parties,
  INSERT and UPDATE for the owner only, no DELETE policy.
- `submission_decision_events` and `submission_comments`: SELECT for both
  parties, INSERT for the organization only — and the `WITH CHECK` requires
  `actor_user_id` (or `author_user_id`) to equal the caller, so a service that
  passed an actor through from a request body still could not attribute a
  decision to somebody who did not make it. No UPDATE, no DELETE.
- A trigger on `submission_revisions` refuses any organization-originated
  UPDATE that changes a column outside the institution's own decision fields.
  It compares whole rows with those columns removed, so a column added in a
  later phase is refused by default rather than silently becoming
  organization-writable. In the other direction, a submitter-context UPDATE may
  never touch the decision.
- The discriminator is **context, not identity**: a caller with organization
  context is acting as the institution, one without it is acting as the
  submitter. This stays well defined when one person is both the author and a
  member of the receiving organization.
- The one transition PalCert itself owns — `null → SUBMITTED`, when the
  verified snapshots become READY — is a workflow event, not a human decision.
  It goes through a narrow `SECURITY DEFINER` function that performs the whole
  finalisation in one statement. Being recognised as the system writer requires
  both a role switch only that function can reach and a transaction-local flag;
  the flag alone is forgeable by the application role and buys nothing.

## Alternatives considered

**Enforce write authority in the controllers.** Rejected: it is the only
control, and every future route, script and migration would have to remember
it.

**Give the decision path its own database role.** Rejected: the connection pool
is shared, and switching roles per request would mean a connection per party.

**Let the worker write the SUBMITTED event through the ordinary policies.**
Rejected: it would require the submitter's context to be able to insert
decision events, which is precisely the authority being withheld.

## Consequences

Ten release-blocking tests run every forbidden write through the
least-privileged role over raw SQL, counting affected rows rather than trusting
a statement's silence — row-level security removes rows from a statement's
reach rather than raising, so a test that accepted silence as success would
pass on a database with no policies at all.
