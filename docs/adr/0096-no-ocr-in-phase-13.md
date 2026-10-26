# ADR-0096: A scanned PDF is reported as a scan, not run through OCR

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 13

## Context

A meaningful share of theses submitted as PDFs are scans: a photograph of a
printed page, with no text layer at all. PalCert can detect this precisely — a
page-sized image, no mapped characters — and OCR would turn it into text that
could then be checked.

The text OCR produces is not the document's text. It is a *reading* of the
document, with its own error rate, and Arabic OCR error rates on real scans are
not low. A font-size rule answered from OCR output is answered from a font size
PalCert inferred from pixel heights. A word-count rule is answered from words
OCR believed it saw.

More to the point, a report that says "body text is 11pt, required 12pt" gives
the user no way to know that the 11pt was measured from a photograph.

## Decision

**PalCert does not OCR, in Phase 13 or in the analyzer's design.**

- Pages are classified `NATIVE_TEXT`, `IMAGE_ONLY`, `HYBRID` or
  `EMPTY_OR_UNKNOWN` by a versioned classifier, and the classification is
  reported.
- An `IMAGE_ONLY` page produces page geometry facts and no typography facts at
  all. Coverage for the element scope is UNAVAILABLE with the reason, which
  explicitly includes "no OCR was performed".
- One scanned page in an otherwise searchable document makes the document
  `HYBRID`, not "mostly searchable": coverage is per page precisely so one
  page's limitation is not averaged away.
- The report tells the user their document has no text layer and what to do
  about it — export the PDF from the source rather than scanning it — in
  English and in Arabic.
- The test suite asserts that no OCR module is even imported.

## Alternatives considered

**OCR with provenance marked as low-confidence.** The provenance reaches the
report; the PASS/FAIL reaches the user's decision. A FAIL is a FAIL however it
is labelled.

**OCR for detection only, never for facts.** Detection does not need it: a
page-sized image with no mapped characters is already conclusive, and it is
cheaper and exactly right.

**Offer OCR as a paid extra.** Possibly a later product. It would need its own
accuracy evidence, its own Arabic evaluation, and its own place in the report —
none of which belongs in a phase that is establishing PDF reading at all.

## Consequences

- A user who uploads a scan gets an honest answer quickly, and a clear
  instruction, rather than a detailed report built on a guess.
- PalCert's PDF coverage numbers are lower than a competitor's that OCRs. They
  are also true.
