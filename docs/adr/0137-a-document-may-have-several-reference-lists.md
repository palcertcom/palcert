# ADR-0137: A document may have several reference lists

- **Status:** Accepted
- **Date:** 2026-09-20
- **Phase:** 18

## Context

Checkpoints 10 to 13 read a document as having exactly one bibliography. The
detector scanned backwards and kept the last heading whose following lines
looked like reference entries, on the reasoning that a thesis has one
bibliography and it is at the end.

That reasoning is true of a thesis and false of most other things a compliance
customer submits: a book of chapters, a collection of articles, a report whose
appendix carries its own sources, a document with both a main bibliography and
a supplementary list. In those, the single-region assumption does not produce a
*missing* region. It produces a silently mis-scoped one — every citation in the
document resolves against whichever list happened to come last, and `[1]` in
chapter two resolves, confidently, to chapter one's first entry.

That is the worst failure shape PalCert has: a wrong answer indistinguishable
from a right one, produced by machinery that reports a resolution rather than a
guess. A missing citation costs recall. A citation resolved to the wrong work
costs the customer's trust in every citation PalCert has ever reported.

## Decision

**A document has as many reference regions as it defensibly has, and they are
never merged.** Each region keeps its own ordinal, family, heading evidence,
page range, entry population, signal set and confidence, and each is published
in `citationAnalysis.referenceRegions`. Every discovered entry names the region
it came from in `regionOrdinal`.

**A citation resolves against one region's population, chosen by ordinal
containment.** The region serving a citation is the first region that *begins
after* it, because a reference list serves the text it follows — that is what a
per-chapter bibliography is. There is no nearest-region rule, no page-distance
ranking and no threshold of any kind.

**Where no region can be established, ambiguity is preserved rather than
resolved.** A citation with no region after it — an afterword citing a work
when every list is already behind it — widens to the document-wide population
and reports `AMBIGUOUS` over every candidate. It does not fall back to the
nearest list, the last list, or the list whose confidence is highest.

**Region context restricts a candidate population and nothing else.** It never
gives one link method priority over another: `DOI_IDENTITY`, `NUMERIC_LABEL`,
`AUTHOR_YEAR_UNIQUE` and `INTERNAL_DESTINATION` each still resolve on their own
evidence, and the frozen multi-method disagreement rule is untouched.

**A discovered region is evidence, never authority.** `referenceRegionPresent`
stays exact-only, and the heuristic quarantine of ADR-0133 is unchanged.

## Consequences

The analyzer moves to `10.0.0`: a document with two bibliographies now produces
a different artifact than it did, and stored analyses from earlier versions are
not reused.

`CitationAnalysis` gains an optional `referenceRegions` array and
`ReferenceEntry` an optional `regionOrdinal`. Both are additive and optional,
so artifacts produced before this checkpoint remain valid and
`citationAnalysisSchemaVersion` stays at 1 — the same additive treatment
Checkpoint 13 gave `CitationOccurrence.identifiers`.

Publishing the regions is not decoration. A numeric link is only checkable if
the population it chose from is visible: `[1]` resolving to `r4` is right when
`r4` belongs to the region serving that chapter and wrong when it does not, and
before this there was no way for a reader to tell which.

The cost is recall in one specific shape. A document whose citations all
precede a single list is unaffected, but a citation sitting after every list it
could plausibly mean now reports `AMBIGUOUS` where the single-region version
reported a target. That is the trade this ADR chooses deliberately: the earlier
answer was not more informative, only more confident.
