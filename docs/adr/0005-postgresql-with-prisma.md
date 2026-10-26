# ADR-0005: PostgreSQL with Prisma as the ORM and migration tool

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 0

## Context

PalCert's data is strongly relational (organizations → document types →
standards → standard versions → rules → checks → findings → reports →
certificates) and includes an append-only financial ledger requiring
transactional integrity. Some structures — parsed document models, AI payloads,
rule parameters — genuinely benefit from schema-flexible storage (§44).
Migrations must be versioned, reviewable and repeatable (§45).

## Decision

Use **PostgreSQL 17** with **Prisma 6** for schema definition, migrations and
typed access.

- Relational structures are modelled relationally. `JSONB` is used only where
  flexibility is genuinely valuable, never as a substitute for a table.
- Migrations are generated files under `packages/database/prisma/migrations`,
  reviewed like code. An applied migration is never edited; corrections are new
  migrations.
- Where Prisma's query builder is insufficient (recursive queries, window
  functions, RLS session setup), parameterized raw SQL is used deliberately.

## Alternatives considered

- **TypeORM.** Rejected: weaker migration ergonomics and a history of
  correctness issues with complex relations.
- **Drizzle.** Strong SQL-first story and better RLS ergonomics, but a smaller
  ecosystem for a long-lived platform. Reconsider if RLS friction proves high.
- **Raw SQL + a migration runner.** Rejected: loses end-to-end type safety
  across a large domain.

## Consequences

- End-to-end types from schema to API.
- Prisma does not natively manage PostgreSQL row-level security; RLS policies
  will be authored as raw SQL inside migrations, and the session tenant variable
  must be set per connection. This is accepted friction, recorded here so it is
  designed rather than discovered.
- The generated client lives in `packages/database/generated` and is not
  committed; `pnpm db:generate` runs in CI and in image builds.
