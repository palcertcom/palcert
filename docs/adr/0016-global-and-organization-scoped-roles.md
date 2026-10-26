# ADR-0016: Global roles now, organization-scoped roles by construction

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 1

## Context

The PalCert role catalogue mixes two kinds of role. `PALCERT_ADMIN` and
`SERVICE_USER` are platform-wide. `ORGANIZATION_OWNER`, `ORGANIZATION_ADMIN`,
`ORGANIZATION_REVIEWER` and `TEMPLATE_MANAGER` are meaningless without an
organization — and organizations do not exist until Phase 2.

The temptation is either to grant organization roles globally for now, or to
invent a placeholder organization entity to make RBAC "complete". Both are
traps: the first creates real privilege that is scoped to nothing, and the
second creates a schema we would immediately have to undo.

## Decision

Model the distinction now; grant only global roles.

- `roles.scope` is `GLOBAL` or `ORGANIZATION`.
- `user_roles` carries a nullable `organization_id` **and** a mirrored `scope`
  column.
- Three database constraints make the rule structural rather than merely
  intended:

  1. A **composite foreign key** `user_roles(role_id, scope) → roles(id, scope)`
     forces the assignment's scope to equal the role's real scope. A crafted
     payload cannot relabel an organization role as global.
  2. A **check constraint** requires `GLOBAL ⟹ organization_id IS NULL` and
     `ORGANIZATION ⟹ organization_id IS NOT NULL`. Since no organization exists
     yet, no organization-scoped grant can be created at all.
  3. A unique index with **`NULLS NOT DISTINCT`** on
     `(user_id, role_id, organization_id)`. Without it PostgreSQL treats every
     NULL as distinct and a user could hold the same global role repeatedly.

- Organization roles are defined in the catalogue with **no permissions**.
  Granting them capabilities now would mean granting power over entities that do
  not exist.
- `organization_id` has **no foreign key yet**. Adding the reference is a Phase 2
  migration; fabricating the table now would be worse than waiting.

Authorization always evaluates **permissions**, never role names, so no guard
needs to change when Phase 2 starts issuing organization-scoped grants.

## Consequences

- Phase 2 adds: the `organizations` table, a foreign key on
  `user_roles.organization_id`, permissions for the four organization roles, and
  tenant-scoping in the permission check. No restructuring.
- The escalation rules are verified at two levels — a rejected API request and a
  rejected `INSERT` — so an application bug alone cannot produce a mis-scoped
  grant.
- Carrying both `scope` and `organization_id` on `user_roles` is mild
  denormalization. It buys a constraint the database can actually enforce, which
  a trigger-based alternative would not do as clearly.
