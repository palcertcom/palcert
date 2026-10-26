# ADR-0106: `DUAL_PARTY_SCOPED`, a fifth isolation class

- **Status:** Accepted
- **Date:** 2026-09-15
- **Phase:** 14

## Context

PalCert's isolation catalogue has named four classes since Phase 2:
`GLOBAL`, `TENANT_SCOPED`, `USER_SCOPED` and `SYSTEM`. Every table declares one,
and a coverage test reads the catalogue rather than a hand-maintained list, so
a table added without isolation fails CI.

The submission tables fit none of them. `USER_SCOPED` would be a lie the
coverage test then asserts: the receiving organization reads these rows, and a
policy saying only the author may would have to be written and then contradicted
in the application. `TENANT_SCOPED` is worse: it says the organization owns the
row, and the author would lose sight of their own submission.

The alternative to a new class is an exception — a table in the catalogue with
a comment saying "special, see the service". Exceptions outside a
classification system are how classification systems stop being true.

## Decision

**Add `DUAL_PARTY_SCOPED` for rows that exist only because one party
explicitly handed something to another, and that both parties may read.**

- A dual-party table names an owner column, exactly as a tenant table names a
  tenant column.
- Its SELECT policy names both parties: `owner_user_id = app_current_user_id()`
  and `organization_id = app_current_organization()`.
- Reading is shared. **Writing is not**, and the class says nothing about
  write authority — see ADR-0107.
- It applies only to tables whose rows are created by an explicit act of
  handing over. It is not a licence to widen an existing private table, and
  `documents`, `document_versions`, `document_checks`, `check_runs`,
  `check_reports`, the AI tables, the SmartFix tables and the finance tables
  remain `USER_SCOPED`. A coverage test asserts exactly that, so widening one
  means deleting an assertion rather than forgetting a rule.

## Alternatives considered

**Keep four classes and mark the submission tables `USER_SCOPED` with an
application-level exception.** Rejected: the coverage test would assert
something untrue, and the real rule would live only in a service.

**Model the organization's view as a separate projection table.** Rejected: two
rows describing one handoff can disagree, and the second one would need its own
immutability story.

## Consequences

`ADR-0031`'s prohibition on `OR organization_id = …` stands unchanged for the
author's private tables. It never applied to a table that exists only because
the author created it to hand something over, and this ADR makes that
distinction explicit rather than leaving it to judgement.

The coverage test gained table-aware assertions: which commands each dual-party
table may be written by, that no dual-party table has a DELETE policy, and that
the private tables are still `USER_SCOPED`.
