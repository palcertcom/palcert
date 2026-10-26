# ADR-0101: PDF reuses the v1 artifact envelope and Fact Schema v2

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 13

## Context

A new analyzer producing a structurally different model is an obvious reason to
version the envelope that carries it, and PDF's internal geometry is genuinely
richer than DOCX's: page boxes, coordinate systems, rotation, glyph matrices.

Versioning is not free. Every stored artifact is interpreted through its
version, and every existing DOCX analysis, report hash and golden fixture
depends on the current one. A v2 envelope means two readers, two validators, and
a migration for artifacts nobody needed to migrate.

The question is whether v1 can actually carry a PDF analysis, and it can.
Phase 4's fact schema already had `PDF_TEXT` and `PDF_LAYOUT` source kinds,
`Location.page`, and PAGE and METADATA scopes — they were specified for this and
left unused. `structuralModel` in the envelope is an open object with only its
own version pinned, exactly so a second analyzer could put a different model
there.

## Decision

**No Fact Schema v3 and no Artifact Schema v2.**

- Fact Schema stays at 2. PDF facts use the existing `PDF_TEXT` and `PDF_LAYOUT`
  provenance and the existing PAGE, DOCUMENT, ELEMENT and METADATA scopes.
- The artifact envelope gains exactly two additive things: an **optional**
  `format` field, and nineteen new `PDF_*` warning codes. A pre-Phase-13
  artifact still validates, and its hash has not moved.
- `PdfStructuralModel` carries its own `analysisSchemaVersion`, versioned
  independently of the envelope, along with a `coordinateSchemaVersion` and a
  `layoutAlgorithmVersion` — because those are the things that would change how
  the same bytes are interpreted.
- The PDF analyzer validates its artifact against the shared schema before
  returning it, exactly as the DOCX one does. An artifact that fails the
  contract is a failed analysis.

## Alternatives considered

**Fact Schema v3 with PDF-native scopes.** The scopes PDF needs already exist.
A v3 would have been a version number for the sake of a version number, and
every stored fact set would have needed a reader for it.

**A separate PDF artifact schema.** Two envelopes means every consumer — the
check evaluator, the report builder, the purge path — branches on which it got.
One envelope with an optional format field is the same information with one code
path.

## Consequences

- Historical DOCX artifacts remain byte-valid with unchanged hashes, and the
  Phase 6 golden corpus is untouched.
- Report golden hashes are preserved: a DOCX report still says `DOCX` exactly
  where it always did.
- The next format also gets an additive change, provided its model fits the
  same four scopes. When one does not, that will be a real reason to version.
