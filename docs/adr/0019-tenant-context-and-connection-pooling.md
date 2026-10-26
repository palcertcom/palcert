# ADR-0019: Transaction-local tenant context

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 2

## Context

Row-level security needs to know which tenant a query belongs to. PostgreSQL's
natural mechanism is a runtime setting read by the policy, but PalCert uses a
connection pool: if that setting outlives the request that set it, the next
request to borrow the connection inherits another tenant's context. That is a
cross-tenant leak with no application bug behind it, and it is invisible to
ordinary tests because it only appears under connection reuse.

## Decision

Tenant context is **transaction-local**, always.

```ts
await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('palcert.current_organization_id', ${orgId}, true)`;
  await tx.$executeRaw`SELECT set_config('palcert.current_user_id', ${userId}, true)`;
  await tx.$executeRaw`SELECT set_config('palcert.platform_admin', 'off', true)`;
  return work(tx);
});
```

`set_config(..., is_local => true)` is the function form of `SET LOCAL`.
PostgreSQL discards it at `COMMIT` **and** at `ROLLBACK`. There is no code
path — not an exception, not a failed constraint, not a killed request — by
which one request's tenant survives into the next.

`TenantPrismaService` is the only supported way to reach tenant data, with three
entry points:

| Method | Context | Used by |
| --- | --- | --- |
| `withTenant({ organizationId, userId })` | one organization | every tenant-scoped request |
| `withUser(userId)` | user only, no organization | the organization switcher, tenant resolution, invitation acceptance |
| `withPlatformAdmin({ actorUserId, reason })` | elevated | PalCert staff routes only |

`withPlatformAdmin` demands a stated reason, logs a warning, and is called only
from administrative paths that also write an audit record. Elevation is
transaction-local like everything else, so it cannot persist either.

### Tests

Three properties are proved with the pool deliberately capped at **one**
connection, so reuse is guaranteed rather than hoped for:

1. Tenant A → tenant B → tenant A on the same connection each see only their own
   rows.
2. After a transaction commits, `current_setting` returns nothing.
3. After a transaction **rolls back**, `current_setting` returns nothing and the
   next tenant is unaffected.

Plus: an unscoped query with no context returns zero rows, and platform
elevation does not survive its transaction.

## Alternatives considered

- **Session-level `SET`.** Rejected outright: this is the bug.
- **A separate connection pool per tenant.** Rejected: unbounded pools, and
  PalCert expects many small tenants.
- **`DISCARD ALL` when returning a connection.** Would work, but relies on the
  pool implementation doing it on every path including error paths. Transaction
  scope is guaranteed by PostgreSQL itself.

## Consequences

- Every tenant read and write happens inside a transaction, including
  single-statement reads. The overhead is one round trip; the alternative is a
  class of leak that cannot be tested away.
- Code that forgets the wrapper does not silently read across tenants — it reads
  *nothing*, because policies default to denying with no context. Failing closed
  and loudly is the intended ergonomics.
