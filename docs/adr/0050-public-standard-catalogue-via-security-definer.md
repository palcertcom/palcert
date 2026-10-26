# ADR-0050: The public catalogue is a SECURITY DEFINER boundary

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 7

## Context

A student is not a member of the university whose standard they want to check
against. The Phase 2 tenant policies therefore hide that standard from them —
correctly. But they have to be able to find it and choose it, or the product
does not exist.

The obvious fix is to loosen the policies so standards are globally readable.
That trades a real guarantee for a convenience, and it exposes an
organization's rulebook to everyone, which is not what publishing a standard
for checking means.

## Decision

Organization-owned tables stay exactly as private as they are. Catalogue access
goes through five narrow `SECURITY DEFINER` functions:

`app_catalogue_organizations()`, `app_catalogue_document_types(uuid)`,
`app_catalogue_standards(uuid)`, `app_catalogue_standard(uuid)`,
`app_check_standard_snapshot(uuid)` and `app_check_standard_identity(uuid)`.

Each one:

- has a **fixed `search_path`**, is `STABLE`, and contains no dynamic SQL;
- takes **explicitly typed parameters** and returns a **named, minimal** row
  type — catalogue fields only, never an organization's internal columns;
- carries the eligibility rules in its own `WHERE` clause: organization active
  and `VERIFIED`, document type active, standard active and `PUBLIC_CHECKABLE`,
  at least one `PUBLISHED` version;
- is `REVOKE ALL … FROM PUBLIC` with `GRANT EXECUTE` to `palcert_app` only.

The functions **are** the authorization boundary, not the service above them.
Listing and check creation ask the same function the same question, so they can
never disagree about what is checkable.

**Exposure is opt-in and deliberate.** `standards.check_availability` defaults
to `PRIVATE`, and the Phase 7 migration does not change any existing standard.
Publishing to the catalogue is its own endpoint, behind its own permission
(`standard:check-availability:manage`, held by organization administration, not
by rule authors), and writes its own audit entry with a named actor.

**The catalogue never exposes rules.** "Which standards can I check against"
and "what exactly does this standard require" are different questions with
different answers; these functions answer only the first. The rule *count* is
returned, because it is useful and says nothing.

The snapshot functions are keyed on the **version**, not the standard, so a
check that captured a version keeps evaluating against it — and a report keeps
rendering — after the standard is made private or archived.

## Consequences

- No tenant policy is weakened to make the catalogue work.
- An organization gains nothing by publishing: it learns nothing about who
  checked against its standard, what they checked, or how they scored.
- Adding a catalogue field means editing a function and reviewing it as the
  security boundary it is, which is the right amount of friction.
