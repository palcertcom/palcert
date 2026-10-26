# ADR-0004: `Organization` as the tenant primitive

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 0

## Context

PalCert's first customers are universities, but the product targets scientific
journals, publishers, research institutions, government bodies and companies
equally (§5, §24). Naming the tenant "University" would leak an incorrect
assumption into the schema, the API and the UI, and would be extremely costly to
unwind once data exists.

## Decision

The tenant entity is **`Organization`**, with an `OrganizationType` enum:
`UNIVERSITY`, `SCIENTIFIC_JOURNAL`, `PUBLISHER`, `RESEARCH_INSTITUTION`,
`GOVERNMENT`, `COMPANY`, `OTHER`.

Every organization-owned row carries `organization_id`. No column, route,
permission or UI string may be university-specific. Journal-specific behavior is
expressed through rules and document types, not through a separate entity family.

Tenant isolation is enforced in the application layer, with PostgreSQL
row-level security evaluated as defence in depth (§36). Frontend filtering is
never a tenant boundary.

## Alternatives considered

- **`University` with a later rename.** Rejected: a rename across schema, API,
  fixtures and stored reports after launch is high-risk and never actually gets
  done.
- **Separate tenant tables per organization type.** Rejected: duplicates every
  relationship for no gain.

## Consequences

- Journal support (Phase 17) requires no schema restructuring.
- Every query that touches organization-owned data must be tenant-scoped, and
  this must be verified by test (Phase 2 and Phase 20).
