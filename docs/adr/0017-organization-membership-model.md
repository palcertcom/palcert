# ADR-0017: Organization, membership and scoped roles as three things

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 2

## Context

A user's relationship to an organization has to answer two different questions:
*may this person act here at all?* and *what may they do?* Collapsing them into
one table is tempting — a role assignment could imply membership — but it makes
several ordinary states inexpressible: a member with no capabilities yet, a
suspended member whose roles should be preserved for reinstatement, provenance
of who invited whom, and a removal that must not silently restore old powers if
the person re-joins.

## Decision

Three entities, each with one job.

```
User ──< OrganizationMembership >── Organization
             │  status, joinedAt, suspendedAt, removedAt,
             │  invitedByUserId, invitationId
             │
User ──< UserRole >── Role          (organization_id, scope = ORGANIZATION)
             │
             └── composite FK → organization_memberships(user_id, organization_id)
```

- **`OrganizationMembership`** is the tenant relationship. Its `status`
  (`ACTIVE`/`SUSPENDED`/`REMOVED`) is the sole answer to "may this person act
  here". It also carries provenance and the timestamps a support conversation
  needs.
- **`UserRole`** scoped to the organization carries capability. Reused from
  Phase 1 rather than duplicated, so there is one role system, not two.
- **A composite foreign key** from `user_roles(user_id, organization_id)` to
  `organization_memberships(user_id, organization_id)` makes an organization
  role *impossible* without a membership. That is the constraint that prevents
  the two tables from drifting into disagreement — the failure mode a single
  table was supposed to avoid.

Removing a member deletes their organization roles. A re-invited person
therefore starts from whatever the new invitation grants, never from powers
nobody remembers granting.

## Alternatives considered

- **Role assignment as the only record of membership.** Rejected: no status, no
  provenance, and no way to represent a suspended member without deleting the
  roles you would need to restore.
- **A `members` table duplicating role columns.** Rejected: two sources of truth
  for authorization is exactly the bug this ADR exists to prevent.

## Consequences

- Joining is two inserts inside one transaction; the foreign key orders them.
- "List members with their roles" is a join, not a single-table read. Both
  tables are indexed on `(organization_id, …)` for it.
- Phase 3+ can attach organization-scoped resources to the membership without
  touching the role system.
