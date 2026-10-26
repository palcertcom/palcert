# ADR-0051: Checks, findings and reports are user-scoped, not organization-scoped

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 7

## Context

A check references an organization's standard, so it is tempting to classify it
as organization data — the organization "owns" the rules, after all, and a
university would plausibly like to see how documents fare against its standard.

But the thing being checked is an unpublished thesis. Whether a student's draft
meets a formatting standard, how it scored, and even *that they ran a check at
all* are facts about the student, not about the university. Exposing them would
mean a student's supervisor's institution could watch them iterate on their
work before they chose to submit it.

## Decision

All five Phase 7 tables — `document_checks`, `check_runs`,
`check_rule_results`, `check_violations`, `check_reports` — are classified
`USER_SCOPED` in `table_isolation_classification`, carry `owner_user_id`
explicitly, and are protected by `FORCE ROW LEVEL SECURITY` policies matching
`app_current_user_id()`.

The organization columns on a check (`organization_id`, `document_type_id`,
`standard_id`, `standard_version_id`) are **reference metadata for the report,
not ownership**. No policy, endpoint or query grants access by way of them.

Concretely, the publishing organization has no route to the user's document,
the check, its findings, its report, its score, or its analysis; nothing in the
organization's own view of its standard changes because someone checked against
it — no counter, no timestamp, no event. An e2e suite asserts each of these
from the standard owner's own session.

Another user's check id returns **404, never 403**: the difference would
confirm the id exists.

## Consequences

- A student can use PalCert on unpublished work without telling anyone.
- Any future "institutional insight" feature is a new, consented data flow,
  designed deliberately — not something that falls out of a join.
- Reads run under the caller's own row-level security context, so another
  user's check is not hidden by a `WHERE` clause this code could forget; it is
  invisible to the connection.
