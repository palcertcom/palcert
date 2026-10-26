# ADR-0024: Published standard versions are immutable, at both layers

- **Status:** Accepted — amended by [ADR-0143](0143-publishing-a-successor-supersedes-the-version-in-force.md) (the `SUPERSEDED` state)
- **Date:** 2026-09-13
- **Phase:** 3

## Context

A published standard version has been used to judge real documents. If it could
still be edited, every past result would silently change meaning and every
issued certificate would become a claim about something that no longer exists.

## Decision

`DRAFT → PUBLISHED → ARCHIVED`, with a draft also able to go straight to
`ARCHIVED` when abandoned. There is **no `PUBLISHED → DRAFT`**, no reviving an
archived version, and no deletion of a non-draft version at all.

The supported way to change a published standard is **clone → edit the new draft
→ publish**. The clone copies every rule verbatim and deliberately does *not*
copy the publication state.

This is enforced in **two places**:

- the services, where it produces a good error message
  (`STANDARD_VERSION_IMMUTABLE`, with the clone workflow named); and
- **database triggers** — `standard_versions_freeze`, `standard_rules_freeze`
  and `standard_version_snapshots_append_only` — which reject the write whatever
  issued it.

Only one version of a standard may be `PUBLISHED` at a time, enforced by a
partial unique index rather than a trigger.

## Consequences

- The guarantee holds against a bug in a service, a future endpoint whose author
  did not know the rule, and a hand-run `UPDATE` during an incident — which is
  exactly when someone is most likely to reach for one.
- Archiving a published version keeps its content hash. A document was judged
  against it, so the result must stay explainable.
- Archiving a *standard* deliberately leaves its published versions readable,
  for the same reason.
- The triggers are owned by the migration role; the least-privileged application
  role cannot drop them (asserted by test).

## Alternatives considered

**Application-only enforcement.** Rejected: it is one forgotten check away from
being untrue, and the failure is silent and retroactive.

**Soft-deleting and re-creating on edit.** Rejected: it makes "which version was
in force on that date?" unanswerable, which is the question a dispute turns on.
