# ADR-0136: A citation carries the same identifier object a reference does

- **Status:** Accepted
- **Date:** 2026-09-20
- **Phase:** 18

## Context

`DOI_IDENTITY` has been in the frozen link-method vocabulary since Checkpoint 2
and had never fired once. The reason was structural rather than a matter of
effort: a `ReferenceEntry` could carry `CitationIdentifier[]`, and a
`CitationOccurrence` was a closed object with no identifier field at all. The
method's own condition — the same normalized identity on the citation side and
the reference side — was unsatisfiable, and Checkpoints 6 and 12 each recorded
it as a contract gap rather than working around it.

Two ways of working around it were available and both were refused earlier.
Deriving a citation's DOI from the surrounding paragraph would satisfy the
letter of the method while destroying its meaning: proximity is not evidence,
and a citation given the identity of a work mentioned beside it resolves —
confidently, through a method labelled *exact* — to the wrong reference.
Inventing a citation-side DOI field of a different shape would give one value
two representations and two normalizations, which is the drift the single
schema strategy exists to prevent.

## Decision

**A citation carries the same `CitationIdentifier` a reference entry does.**
The same object, read by the same extractor, normalized by the same function.
`DOI_IDENTITY` then compares the `normalized` field of one against the
`normalized` field of the other, which is a comparison of like with like
rather than of two parsers that happen to agree today. Adding a *second* DOI
representation was the alternative, and it would have made every future
divergence between them invisible until a citation silently failed to resolve.

**Read from the citation's own `rawText` and from no wider window.** No
paragraph scan, no nearest-marker rule, no geometry. A DOI in the surrounding
prose belongs to the prose.

**An identity PalCert was unsure of is not an identity.** Linking reads
`normalized`, which the Checkpoint-12 extractor withholds whenever a value's
end could not be determined or its shape was malformed. A boundary-ambiguous
or invalid DOI is therefore unmatchable *by construction* rather than by a
second rule that could drift from the first.

**Finding an identifier never changes what an occurrence is.** An exact
citation stating a DOI stays `PDF_TEXT`; a heuristic one stays `HEURISTIC`. A
DOI is strong evidence about *which work* is meant and says nothing about
whether the span is a citation at all, which is the question `sourceKind`
answers.

**DOI is one method among several, with no privileges.** Its proposal joins
the others and the frozen aggregation decides. Where methods agree, both rows
survive, because that repetition is the corroboration an evidence panel should
show. Where they disagree, the frozen rule makes every row `AMBIGUOUS` over the
union of what they found — DOI is not promoted above a numeric label, and a
label is not promoted above a DOI.

**Two entries stating the same DOI are two entries.** They are never
deduplicated inside the linker; the citation is `AMBIGUOUS` over both.

**The integrity pass verifies it, in both runtimes.** Every other method rests
on something the artifact does not record — a tag comparison, a label match, a
destination lookup — so its rows can only be trusted. `DOI_IDENTITY` names an
identity that is *in* the artifact on both sides, making it the one method
whose rows can be checked. A resolved DOI link whose citation states no usable
identity, or whose target does not share it, is rejected as
`DOI_LINK_WITHOUT_SHARED_IDENTITY`.

Candidates are deliberately **not** checked. Under the disagreement rule a
candidate may be present on another method's evidence, and demanding a shared
DOI for it would silently prioritize one method over the other — the exact
thing the union exists to avoid. Writing the invariant the strict way first is
what surfaced this: it rejected a legitimate artifact, and the invariant was
the part that was wrong.

**Nothing is verified.** Matching means *this document states the same
identifier in two places*. It does not mean the work exists, that the DOI
resolves, or that anyone registered it.

## Alternatives considered

**Bump `citationAnalysisSchemaVersion` to 2.** The field is a `const`, so a
bump would invalidate every stored artifact carrying `1` — the opposite of
what adding an optional field means. An optional property is backward
compatible in both directions, and a version whose only purpose is to announce
a compatible addition buys nothing and costs every existing analysis.

**Extract identifiers only on the heuristic side.** It would have left
declared entries without DOIs and made the exact-to-exact case — the one where
both sides are the author's own words — the only case the method could not
serve.

## Consequences

A declared `/BibEntry` now has its stated identifiers read, which is a change
to Checkpoint 12's output for exact entries. It is a narrow and deliberate
one: a DOI written inside a declared entry is stated outright, with no
segmentation to guess at and no sentence to delimit, and without it
`DOI_IDENTITY` could never compare two declared objects. `parseStatus` stays
`UNPARSED` there — reading a stated identifier is not parsing the work, and no
author, year, title or container is read.

The PDF analyzer moves to `9.0.0`. DOCX stays at `4`: it performs no
citation-side identifier extraction, so its observable output did not change,
and a shared schema growing an optional field is not a reason to re-analyze
every stored DOCX.

No public property was added and no DOI value reaches a fact. The provenance
gates on `citationTargetResolved` and `referenceRegionPresent` are unchanged,
so an exact DOI resolution feeds the former exactly as any other exact
resolution does, and a heuristic one feeds nothing.
