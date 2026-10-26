# ADR-0031: Documents are user-private; organizations never own or see them

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 5

## Context

Phase 2 made the organization the tenant: every organization-owned row carries
`organization_id` and is fenced by row-level security keyed on it. The natural
extension would be to store uploaded documents under the organization too.

That would be wrong for the product. A thesis, manuscript or report is the
author's private work until the author decides to submit it. An organization
admin must not be able to browse a member's drafts; an organization must not
even learn that a document exists. Official submission (Phase 14) is an
explicit, separate act that creates its own records.

## Decision

**A document belongs to exactly one user.** `documents`, `document_versions`,
`upload_sessions` and `document_retention_locks` carry `owner_user_id` and
nothing else as their isolation key. They are classified `USER_SCOPED` in
`table_isolation_classification`, and the row-level-security policies compare
`owner_user_id` with `app_current_user_id()` — the same transaction-local
mechanism as tenant isolation (ADR-0019), pointed at the user.

Consequently:

- no document route accepts an organization identifier, and no organization
  role or permission grants document access; the four `document:*:self`
  permissions are the only ones that exist and are granted to every
  self-service role;
- an organization owner or admin reading a member's document receives the same
  `404` as a stranger (ADR-0017's non-disclosure rule);
- the worker re-enters the owner's scope from the job row
  (`TenantPrismaService.withUser(job.ownerUserId)`); asynchronous work never
  bypasses row-level security.

## Alternatives considered

- **Organization-owned documents with member visibility.** Rejected: it makes
  every draft visible to organization staff by default and conflates private
  authoring with official submission.
- **Dual ownership (user plus optional organization).** Rejected for now: the
  optional column invites a policy that reads `OR organization_id = …`, which
  is exactly the widening this decision forbids. Submission will link a version
  to an organization through its own table.

## Consequences

- The RLS coverage test (`tenant-rls-coverage.e2e-spec.ts`) requires every
  `USER_SCOPED` table to have a `FOR ALL` policy whose `USING` and
  `WITH CHECK` name `owner_user_id`.
- Organization deletion or suspension has no effect on documents.
- Platform administrators can reach documents only through
  `withPlatformAdmin`, which is audited; no such route exists in this phase.
