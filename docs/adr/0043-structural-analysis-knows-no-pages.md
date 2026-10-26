# ADR-0043: Structural analysis does not know where a page begins

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 6

## Context

Standards care about pages. "Margins must be 3 cm", "the abstract must not
exceed one page", "page numbers must appear bottom-centre". It is tempting to
answer all of them from a DOCX, and it is easy to *appear* to: count explicit
page breaks, estimate lines per page, read the page count Word saved in
`app.xml`.

Every one of those is a guess wearing the clothes of a measurement.
WordprocessingML stores content and formatting intent; pagination is produced
by a layout engine from fonts, hyphenation, widow control and the renderer's
own metrics. Two renderers legitimately paginate the same file differently.
A saved page count was true whenever Word last recalculated it, which may be
before the document was edited by something else entirely.

## Decision

**The DOCX analyzer never reports a page.**

- No fact carries a `page` in its location. The Phase 4 `Location` contract
  makes `page` optional precisely so a structural extractor need not invent one.
- No `PAGE`-scoped facts are emitted, and `PAGE` coverage is declared
  `UNAVAILABLE` — which is different from "there are none".
- `DOCUMENT/pageCount` coverage is `UNAVAILABLE`. The application's saved
  statistics are recorded in the structural model as `applicationHints`,
  clearly labelled, and are never promoted to facts.
- A `PAGE` field's cached result ("7") is evidence that a page-number field
  exists, not evidence that anything is on page 7.
- Page *setup* — size, orientation, margins, gutter, header and footer
  distance — **is** extracted, per section, because it is declared rather than
  computed. Mirrored margins are the exception: "left" then means "inside",
  which needs page parity, so those two facts drop to PARTIAL.

## Alternatives considered

- **Estimate pagination.** Rejected. A rule that fails a compliant document
  because PalCert guessed its line height is worse than a rule that says "not
  determinable here".
- **Trust the stored page count.** Rejected: stale by construction.
- **Refuse page-scoped rules entirely.** Rejected: a rendering layer can supply
  them later, and Phase 13's PDF analysis will. The coverage mechanism already
  expresses "this extractor cannot see that", so the rule stays valid and
  resolves as unavailable rather than becoming invalid.

## Consequences

- An anti-regression fixture asserts that no fact carries a page number and
  that `PAGE` coverage is `UNAVAILABLE`, on every fixture in the corpus.
- Standards may still express page rules; against a DOCX-only analysis they
  resolve as unavailable rather than as a confident wrong verdict.
- Rendered pagination is a Phase 13 concern, where a real renderer produces it.
