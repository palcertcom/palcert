# ADR-0093: Semantic roles come from marked content ids, or they do not come at all

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 13

## Context

A standard that says "Heading 1 must be 16pt bold" needs to know which text is
a heading. A DOCX says so: the paragraph carries a style. A PDF usually does
not — an untagged PDF is a sequence of glyphs at coordinates, and the heading is
recognisable to a human only because it is large, bold and alone on its line.

The tempting inference is exactly that: treat large, bold, centred text as a
heading; treat ruled boxes as tables; treat images near captions as figures.
It is what a reader does, and it would raise PalCert's PDF coverage sharply.

It would also mean that a "Heading 1 must be 16pt" rule is checked against
PalCert's own guess about what a heading is. When the guess is wrong, the report
is confidently wrong — it fails a document for a heading the author never wrote,
or passes one it never found. The user cannot tell which happened, because the
report does not distinguish "the document said this" from "PalCert decided
this".

A *tagged* PDF does say so. The author's software wrote a structure tree
declaring this run is an H1 and that one is a P. That is real evidence.

## Decision

**A semantic element type comes from the structure tree, bound to content
through the marked-content id, and from nothing else.**

- Each text span records the marked-content id of the text object it came from
  (`FPDFPageObj_GetMarkedContentID`). Each structure element records the ids its
  `/K` entry names. The two integers are the *same integer* written by the
  author's software — this is an identity, not a resemblance.
- A layout block takes a role only when its lines agree on one unambiguous role.
- An untagged PDF, or a tagged one whose structure tree points at marked content
  that is not in the page, produces no HEADING, TABLE, FIGURE, CAPTION or LIST
  facts at all. Coverage for those element types is reported UNAVAILABLE with
  the reason, and rules about them are INDETERMINATE.
- Deterministic geometric grouping into spans, lines and blocks is still
  performed and still reported — as layout evidence, labelled `PDF_LAYOUT`, and
  called a *block*, never a paragraph.

## Alternatives considered

**Heuristic promotion with a confidence score.** A score invites a threshold,
and a threshold turns a guess into a verdict somewhere. There are no numeric
confidence scores anywhere in PalCert's evidence for this reason.

**Geometric matching between structure elements and layout blocks.** Workable
where a document has both, but it is a resemblance test with tolerances, and it
fails silently on multi-column and rotated content. The marked-content id needs
no tolerance.

**Promote only for headings, where the signal is strongest.** The signal is
strongest for headings in the documents where it does not matter, and weakest in
the thesis with a large bold running head on every page.

## Consequences

- A typical untagged thesis exported from Word has thinner semantic coverage
  than the same thesis as a DOCX. This is deliberate product behaviour and the
  compatibility preview says so before the user pays.
- Tagged PDFs — which accessible-publishing workflows increasingly produce —
  get the full semantic treatment.
- No report ever fails a document against a heading PalCert invented.
