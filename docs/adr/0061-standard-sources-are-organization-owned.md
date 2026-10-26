# ADR-0061: A Standard's source documents are owned by the organization, not by the uploader

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 9

## Context

Phase 5 established that a document is private to the person who uploaded it
(ADR-0031): a student's thesis belongs to the student, and nobody at the
institution can read it without going through a check the student started.

Phase 9 introduces a second kind of uploaded file that looks superficially the
same — bytes, a filename, a digest, a malware scan — and is nothing like it. A
thesis-formatting guideline is the institution's own policy document. The
registrar who uploads it, the template manager who replaces it next year, and
the reviewer who reads the proposals extracted from it are all acting for the
institution, and none of them personally owns the file.

Reusing the Phase 5 ownership model would have produced an obviously wrong
product: a guideline invisible to the colleague who has to review the rules
drawn from it, and orphaned the moment its uploader left the university.

## Decision

`StandardSourceAsset` is **organization-scoped**, classified `TENANT_SCOPED`
with `organization_id` as its tenant column, and reached through
`TenantPrismaService.withTenant` — the same authorization model as a Standard,
a rule and a document type, and a deliberately different one from a Document.

Visibility follows the organization. Authority follows permissions:
`standard:source:read` for everyone in the organization, `standard:source:create`
and `standard:source:delete` for the authoring roles. `uploadedByUserId` is
recorded for the audit trail and confers nothing.

A source belongs to one **draft** standard version and is bound to it by a
composite `(standardVersionId, organizationId)` foreign key, so a source can
never be attached across a tenant boundary even if every application check were
wrong.

The two models are never mixed in one authorization decision. There is no code
path where an organization-scoped source is read under `withUser`, and none
where a private document is read under `withTenant`.

## Alternatives considered

**Reuse `Document` with a flag.** Rejected. The flag would be the only thing
standing between a student's thesis and an organization-wide read, and one
missing `WHERE` clause would cross the most important boundary in the product.

**A separate "organization documents" module with its own upload path.**
Rejected for the opposite reason: it would duplicate the Phase 5 security
pipeline, and the duplicate would drift. The ingestion pipeline is reused
verbatim instead (see ADR-0062).

## Consequences

- A guideline outlives the person who uploaded it.
- Cross-tenant access is refused by RLS, by composite keys, and by the
  controller — three independent mechanisms, tested with real identifiers.
- Retention is an organization-level concern: a source an accepted rule cites
  is retention-locked and cannot be deleted by anyone, because deleting it
  would destroy the evidence behind a published standard.
