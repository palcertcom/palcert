# ADR-0018: PostgreSQL row-level security and database role separation

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 2

## Context

PalCert is multi-tenant, and a cross-tenant leak is the worst defect the
platform can have. Application-layer authorization is necessary but it is also
*one layer*: a forgotten `WHERE organization_id = ?` in a repository method is
an ordinary mistake that no amount of endpoint testing detects, because the
endpoint never intended to check anything.

Phase 0 (ADR-0005) chose Prisma and recorded that row-level security would need
hand-written SQL. This is that decision.

## Decision

### Row-level security on every tenant-scoped table

`organizations`, `organization_memberships`, `organization_invitations`,
`organization_verification_requests` and `user_roles` all have RLS **enabled and
FORCED**, with explicit policies for `SELECT`, `INSERT`, `UPDATE` and `DELETE`,
each write policy carrying a `WITH CHECK` clause so a row cannot be written
*into* another tenant.

`FORCE` matters specifically because the tables are owned by the migration role,
and PostgreSQL exempts a table's owner from its own policies unless forced (§17).
Without it, one deployment slip — the application connecting as the owner —
would silently disable every policy.

### Two database identities

| Identity | Used by | Privileges |
| --- | --- | --- |
| `palcert` (owner) | Prisma CLI, migrations | Owns the schema. Superuser in local development. |
| `palcert_app` | **every request** | `SELECT/INSERT/UPDATE/DELETE` only. **Not** superuser, **no** `BYPASSRLS`, **not** the owner, no DDL. |

The migration creates `palcert_app` with `NOLOGIN` and no password — a committed
migration must never contain a secret — and a separate provisioning step applies
the password from the environment. A half-provisioned deployment therefore fails
closed.

**The API asserts this at boot** by querying `pg_roles` for `CURRENT_USER` and
refusing to start if `rolsuper` or `rolbypassrls` is true. A misconfigured
connection string would otherwise remove the tenant boundary while every
application test kept passing, which is precisely the failure RLS exists to
catch.

### RLS is defence in depth, never the only control

Application authorization still decides every request through
`OrganizationContextGuard`. The policies exist so that a *bug* in that layer is
contained rather than catastrophic. Both layers are tested: the HTTP suite
proves the application refuses, and a separate suite issues raw unscoped SQL as
the request role and proves the database refuses too.

### Where RLS is deliberately not the boundary

`user_roles` rows with `organization_id IS NULL` are global assignments, and
those are governed by application authorization (the `admin:role:assign`
permission, the administrative endpoint, an audit record). Self-registration
grants `SERVICE_USER` with no administrator and no organization in sight;
requiring elevation for that would mean running ordinary sign-ups with
cross-tenant powers, which is strictly worse. RLS on that table confines
*organization-scoped* rows, which is the part it is actually for.

### Coverage is enforced, not remembered

A `table_isolation_classification` table records how every table is isolated
(`GLOBAL`, `TENANT_SCOPED`, `USER_SCOPED`, `SYSTEM`). A test reads the
PostgreSQL catalogue and fails CI when a table is unclassified, or when a
`TENANT_SCOPED` table lacks RLS, `FORCE`, a tenant column, or policy coverage.
The failure mode being defended against is a future developer forgetting — a
hand-maintained list would be forgotten alongside the policy.

## Consequences

- Local development needs two connection strings and one provisioning step;
  `pnpm db:setup` does all three.
- Every tenant query must run inside a tenant context (ADR-0019), which is a
  real constraint on how data access is written — and the point.
- Two SECURITY DEFINER functions exist, each doing one narrow thing:
  `app_organization_for_invitation` (token digest → organization id) and
  `app_slug_available` (handle → boolean). Both are documented in the migration.
