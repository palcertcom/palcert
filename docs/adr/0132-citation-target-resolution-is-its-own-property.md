# ADR-0132: Citation-target resolution is its own property, not a widened one

- **Status:** Accepted
- **Date:** 2026-09-19
- **Phase:** 18

## Context

Phase 18 Checkpoint 4 shipped `ELEMENT/CITATION/nativeSourceResolved`: whether
a Word `CITATION` field's tag matches a record in the document's Word
bibliography source store. Checkpoint 8 then asked which of the four approved
citation properties a tagged PDF may project, and found that this one cannot
be among them.

A tagged PDF resolves a declared citation to a declared `/BibEntry` — a
rendered reference entry — by numeric label or by an internal destination. That
is exact evidence of a real relationship, and PalCert had no public property
that meant it. Two wrong answers were available:

* **Project it as `nativeSourceResolved` anyway.** The property's contract says
  "a Word citation's tag matched a Word source record". A PDF has no source
  records. Emitting the PDF's answer under that name would silently redefine
  what the property already promises every DOCX rule author, and a standard
  written for one format would quietly mean something else on the other.
* **Redefine `nativeSourceResolved` to mean "resolves to something".** Same
  damage, applied to the DOCX side as well: every existing rule about it would
  change meaning without its author touching it.

The two relationships are genuinely different, and the difference is in the
graph rather than in the wording. A Word citation's link targets a
`BibliographySource` — a record in a custom XML part, which is the *data* Word
renders an entry from, and which Word may render no entry for at all. A tagged
PDF has no such record; its links target a declared entry. Neither format's
graph can answer the other's question.

## Decision

**Checkpoint 9 adds a new property,
`ELEMENT/CITATION/citationTargetResolved`: whether a declared citation
resolves to exactly one declared reference entry in the same analyzed
document.** `nativeSourceResolved` is unchanged in wording, scope, value,
coverage policy and DOCX support.

The new property is defined without naming a mechanism. A tag match, a numeric
label, an internal destination and a DOI identity are evidence that establishes
the relationship, not the relationship itself, and a rule about it should not
have to know which the document happened to provide.

**Support is derived per format, never copied.** PDF is EXACT; DOCX is
UNSUPPORTED, because that format's graph resolves to a source record and never
to an entry. `nativeSourceResolved` remains EXACT for DOCX and UNSUPPORTED for
PDF — mirror images, because the graphs are.

**The projector consumes the resolution it was given.** It reads the citation's
own `resolutionStatus` and never a link row's method, so it cannot prefer one
exact method over another or become a second resolution algorithm able to
disagree with the producer. `LINKED` is `true`, `UNRESOLVED` is `false`, and
`AMBIGUOUS` and `NOT_ATTEMPTED` emit nothing at all.

## Alternatives considered

**One generic `citationResolved` replacing both.** It would have to mean
"resolves to whatever this format has", which is not a claim a standard author
can write a rule against: the same rule would test two different things
depending on the file uploaded.

**Leaving the PDF relationship unprojected.** This was Checkpoint 8's position,
and it was correct while no truthful property existed. It costs a real
capability: a tagged PDF's citation resolution is exact evidence, and leaving it
in the advisory artifact means no rule can ever use it.

## Consequences

Both analyzers' versions move: DOCX to `4` and PDF to `5.0.0`. The PDF bump is
the ordinary one — it emits facts an earlier version did not. The DOCX bump is
stronger: version 4 emits no new fact, it adds an explicit
`ELEMENT/CITATION/citationTargetResolved: UNAVAILABLE` coverage entry. Without
it a rule about the new property would be read under that format's citation
coverage, which *can* reach `COMPLETE`, and could pass or fail on silence. A
version 3 analysis would be read wrongly rather than merely incompletely, so
reuse of one has to stop.

On PDF the property's coverage is `PARTIAL` at best, even when every identified
citation resolved: it depends on both `SEMANTIC_CITATIONS` and
`SEMANTIC_REFERENCE_ENTRIES`, weakest wins, and a PDF's semantic domains are
never `COMPLETE` because a citation the author did not tag is invisible. So
"every citation resolves" is INDETERMINATE on a PDF rather than passing on the
tagged citations alone. That is the honest answer, and it is the point.

A citation standard that uses all five citation properties now previews as
`PARTIAL` for DOCX as well as for PDF. Standards written before this property
existed are unaffected.
