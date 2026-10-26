# ADR-0099: The PDF's page count is authoritative; a DOCX has none

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 13

## Context

"The thesis must be at least 80 pages" is an ordinary rule and PalCert has never
been able to answer it. A DOCX does not contain its page count: pagination is
produced by the renderer from the text, the fonts installed, and the printer
driver, and the number cached in `app.xml` is whatever Word last calculated,
possibly on a different machine, possibly never.

A PDF does contain it. The page tree *is* the pagination — a PDF with 84 page
objects has 84 pages, on every reader, for ever.

## Decision

**`pageCount` is `EXACT` for PDF and `UNSUPPORTED` for DOCX.**

- The count comes from the page tree, not from any metadata field claiming it.
- Every location in a PDF fact carries its `page`, so a finding points at a page
  a user can turn to.
- The cached count in a DOCX's `app.xml` is not read as a fact. It is a claim
  made by whatever last saved the file, and answering a page-count rule from it
  would be answering from a number PalCert cannot verify.

## Alternatives considered

**Estimate DOCX pagination.** It would require a layout engine and the user's
fonts, and the estimate would be wrong for exactly the borderline documents
where the rule matters.

**Read `app.xml`'s count and label it DERIVED.** It is not derived — it is
declared, by software PalCert has no information about, at a time it cannot
determine. `UNSUPPORTED` is the honest answer.

## Consequences

- Page-count rules are answerable from a PDF and INDETERMINATE from a DOCX,
  which is the reverse of the usual direction and worth saying plainly in the
  compatibility preview.
- An institution whose standard is mostly about pagination gets better coverage
  from PDFs. That is a genuine reason to ask students for one.
