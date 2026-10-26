# ADR-0092: PDF is an inspection format, never a SmartFix format

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 13

## Context

Phase 12 gave PalCert the ability to correct a DOCX: change a margin, change a
font size, produce a new document version, and prove what changed. The obvious
next question is whether the same applies to a PDF, and the answer looks like
it should be yes — PalCert can now read a PDF's geometry and typography
precisely enough to say a margin is wrong.

Reading and rewriting are not the same capability. A DOCX stores the author's
intent: a margin is a property with a name, and changing it is changing the
instruction the renderer will follow. A PDF stores the *result*: the page is a
sequence of drawing operators positioned in absolute coordinates, and there is
no margin to change. "Fixing" a PDF margin would mean re-laying out every
glyph, re-breaking every line, and re-flowing every page — which is to say,
re-typesetting the document, using a layout engine PalCert does not have and
whose output would not match what the author's own software produced.

The failure mode is not "the fix is imperfect". It is a returned document whose
pages differ from the author's, silently, in ways they discover at submission.

## Decision

**PalCert analyzes PDFs and never edits them.**

- There is no PDF SmartFix, no PDF content rewriting, no PDF-to-DOCX
  conversion, and no citation or reference rewriting in a PDF.
- A PDF check reports findings. Where the document can be fixed, the fix is
  made in the source DOCX and re-exported by the author.
- The report says this explicitly rather than leaving an empty SmartFix panel
  for the user to interpret as a missing feature.
- SmartFix's existing DOCX contracts, capability registry and plan hashes are
  untouched by Phase 13.

## Alternatives considered

**Incremental PDF update for "simple" properties.** Some changes really are
local — a metadata title, a page rotation. But a capability that fixes the
title and not the margin is one a user cannot predict, and the boundary between
"local" and "reflow" is not visible from the report. A capability nobody can
predict is worse than one that does not exist.

**Convert to DOCX, fix, convert back.** The round trip is lossy in both
directions, and the document PalCert returned would not be the document the
author wrote. This is the failure mode above with extra steps.

**Fix the PDF's source instead.** PalCert does not have the source. The author
does, which is why the report tells them what to change rather than doing it.

## Consequences

- A user who uploads a PDF gets findings and no corrections, and the UI says so
  in English and Arabic before they pay.
- A user who wants corrections uploads a DOCX. That is a reasonable ask: they
  had one, because the PDF was exported from it.
- PalCert never returns a document whose layout it silently altered.
