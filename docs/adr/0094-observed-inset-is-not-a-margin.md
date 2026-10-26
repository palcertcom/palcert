# ADR-0094: An observed content inset is a separate property from a margin

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 13

## Context

Almost every academic standard has a margin rule. PalCert can measure, from a
PDF, exactly how far the leftmost ink sits from the left edge of the page. The
two numbers are usually similar, and making the second answer the first would
take PalCert's PDF margin coverage from nothing to complete in one line.

They are not the same measurement.

A margin is an instruction: the author told the layout engine to keep 25 mm
clear, and the DOCX stores that instruction as a property. An observed inset is
a result: it is where ink happened to start. A first line indented by 12.7 mm
reports an inset of 37.7 mm against a margin of 25 mm. A page whose first
element is a full-width rule reports an inset of 25 mm on a page with a 40 mm
margin everywhere else. A landscape figure spilling into the margin reports an
inset smaller than the margin the author set.

A rule reading `marginLeft >= 25 mm` answered from an inset therefore fails
correctly-formatted documents and passes incorrectly-formatted ones, and the
report gives no clue which happened.

## Decision

**`observedContentInsetLeft/Right/Top/Bottom` are their own properties, and no
margin rule is ever satisfied by one.**

- `marginLeft` and its siblings are `EXACT` for DOCX and `UNSUPPORTED` for PDF.
- `observedContentInsetLeft` and its siblings are `DERIVED` for PDF and
  `UNSUPPORTED` for DOCX.
- The pairing is recorded in `contracts/registries/document-property-support.json`
  under `distinctSemantics`, so the refusal is data both runtimes read rather
  than lore in a comment somewhere.
- A margin rule against a PDF is INDETERMINATE, with the reason shown, and the
  compatibility preview says so before payment.

## Alternatives considered

**Answer the margin rule from the inset with a generous tolerance.** The
tolerance would have to cover indents and pull-quotes, at which point it covers
genuinely wrong margins too.

**Answer it and label the provenance HEURISTIC.** The label reaches the report;
it does not reach the PASS/FAIL, and PASS/FAIL is what the user acts on.

**A standard could opt in.** A per-standard switch moves the decision to the
institution that wrote the rule, who has no way to know how PalCert measures.

## Consequences

- Margin-heavy standards have low PDF coverage. A standard that is *only*
  margins is refused for PDF with `CHECK_STANDARD_NOT_SUPPORTED_FOR_FORMAT`
  rather than sold and returned empty.
- An institution that wants margins checked asks for the DOCX, which is the
  right answer, because that is where the margin exists.
- The inset remains available as its own evidence, for standards that want to
  ask about ink rather than about instructions.
