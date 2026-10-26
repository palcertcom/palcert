# Database roles and privileges

_See ADR-0018._

## Two identities, never one

| | `palcert` | `palcert_app` |
| --- | --- | --- |
| Purpose | Schema owner; migrations | Every API request |
| Configured as | `DATABASE_ADMIN_URL` | `DATABASE_URL` |
| Superuser | yes (local); owner (production) | **no** |
| `BYPASSRLS` | yes (local) | **no** |
| DDL | yes | **no** |
| Table grants | owner | `SELECT/INSERT/UPDATE/DELETE` |
| `_prisma_migrations` | full | **revoked** |
| `table_isolation_classification` | full | read-only |

Every row-level security policy is decoration if the request path can bypass it.
That is why the split exists, and why it is checked rather than trusted.

## Boot-time assertion

`PrismaService.onModuleInit` queries `pg_roles` for `CURRENT_USER` and throws if
`rolsuper` or `rolbypassrls` is true. A misconfigured `DATABASE_URL` would
otherwise silently remove the tenant boundary while every application test kept
passing.

`DATABASE_ENFORCE_LEAST_PRIVILEGE=false` downgrades the refusal to an error log
for a local experiment. Configuration validation **rejects** that value in
production, and rejects `DATABASE_URL === DATABASE_ADMIN_URL` outright.

## Provisioning

The migration creates the role with the right privileges but `NOLOGIN` and no
password — a committed migration must never contain a secret, and a
half-provisioned deployment should fail closed rather than open.

```bash
APP_DB_PASSWORD='<from the secret manager>' \
DATABASE_ADMIN_URL='postgresql://palcert:…@host/palcert' \
pnpm db:provision-app-role
```

Idempotent, and prints nothing sensitive. Locally, `pnpm db:setup` runs generate,
deploy and provision together.

## Why `FORCE ROW LEVEL SECURITY`

PostgreSQL exempts a table's owner from its own policies unless the table is
`FORCE`d. The migration role owns every table, so without `FORCE` a single
deployment slip — pointing the application at the owner — would disable all
tenant isolation with no error and no test failure. With it, even the owner is
subject to the policies; the migration itself uses `SET row_security = off`
where it genuinely needs to bypass them.

## Adding a table in a later phase

1. Add the Prisma model.
2. Add a row to `table_isolation_classification` in the same migration.
3. If `TENANT_SCOPED`: `ENABLE` and `FORCE` RLS, and write `SELECT`/`INSERT`/
   `UPDATE`/`DELETE` policies (or one justified `ALL`), each write policy with a
   `WITH CHECK`.
4. Grants are automatic via `ALTER DEFAULT PRIVILEGES`.

Skipping step 2 or 3 fails CI: `tenant-rls-coverage.e2e-spec.ts` reads the
catalogue and will not accept an unclassified or unprotected table.
