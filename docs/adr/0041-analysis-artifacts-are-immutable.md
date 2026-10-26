# ADR-0041: An analysis is immutable, versioned, and reusable

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 6

## Context

Phase 7 will record compliance results. Phase 15 will issue certificates over
them. Both will point at facts, and both will be asked months later "why did it
say that?". If the analyzer can be improved — and it will be — then the facts
behind an old result must not change underneath it.

Analysis is also expensive, and the same document will be checked against
several standards. Re-reading it each time would be waste.

## Decision

A **`DocumentAnalysis`** records that one analyzer version, reading one
immutable document version, produced one immutable artifact. Its identity is
four fields: the document version, the analyzer name, the analyzer version and
the fact-schema version.

- **Immutable on success.** A trigger refuses to change the identity, the
  artifact key, the artifact digest, or the status once `SUCCEEDED`. A better
  analyzer produces a *new* analysis; the old one stays exactly as it was.
- **Reusable.** `ensureDocxAnalysis` returns any compatible analysis and
  creates one only when there is none. A partial unique index over the live
  states makes that idempotent in the database, so concurrent callers race
  safely rather than racing dangerously.
- **Failures are recorded, not hidden.** A `FAILED` analysis is outside the
  uniqueness index: it keeps its account of what went wrong and does not block
  a retry.
- **On demand, not on upload** (§9). Every READY DOCX is analyzable; none is
  analyzed until something asks. Phase 7 asks when a user requests a check.

Two artifacts travel in one envelope: the `DocxStructuralModel` (rich, for
SmartFix and debugging) and the `DocumentFactSet` (the Phase 4 contract). They
are separate layers because pouring style ids and part names into facts would
tempt rules into depending on OOXML implementation details.

## Alternatives considered

- **Update the analysis in place on re-analysis.** Rejected: it breaks every
  historical result that points at it.
- **Analyze every upload automatically.** Rejected: it spends money on
  documents nobody checks, and makes upload latency depend on analysis.
- **One artifact, facts only.** Rejected: SmartFix would have nothing to edit
  against, and a finding could not be traced to an element.

## Consequences

- The artifact is serialized canonically and hashed, so the same bytes and the
  same analyzer version produce byte-identical output (§85–§87).
- `artifactSha256` is integrity metadata for the derived object, distinct from
  `DocumentVersion.sha256` and from `StandardVersion.contentHash`.
- Analysis reuses Phase 5's outbox, queue, leases and retry policy rather than
  introducing a second job system (§89).
