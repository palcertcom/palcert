# ADR-0040: Effective formatting, with provenance, computed by specification

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 6

## Context

"What font is this paragraph?" has no answer in the XML. There is a hierarchy,
and the answer is the result of applying it — in the order ECMA-376 gives, with
one family of properties that does not override but XORs.

Two mistakes are easy and both are silent. Reading the nearest declared
property reports "no font" for most real documents. Treating toggle properties
as last-writer-wins reports *bold* for a style that is based on a bold style
and declares `<w:b/>` again, when Word renders it not bold — so a rule saying
"body text must not be bold" fails exactly the documents it should pass.

## Decision

**Resolution follows the specification's order**, for every run and paragraph:

    document defaults → table style → numbering style
      → paragraph style chain (root first) → character style chain → direct

**Toggle properties use XOR across the style hierarchy** (ECMA-376 §17.7.3),
with direct formatting absolute. Twelve properties are in that family
(`b`, `bCs`, `i`, `iCs`, `caps`, `smallCaps`, `strike`, `vanish`, `outline`,
`shadow`, `emboss`, `imprint`); everything else overrides normally.

**Three states are kept apart**: declared true, declared false, and absent.
`<w:b w:val="0"/>` is an instruction, and it is not the same as silence.

**Every resolved value keeps its provenance** — which layer produced it, which
style id, which theme token. Phase 12 SmartFix cannot safely change a font
without knowing whether it came from one run's direct formatting or from a
style four hundred paragraphs share, and re-deriving that later is not the
same as having recorded it.

## Alternatives considered

- **Last-writer-wins everywhere.** Simpler, and wrong on the toggle cases that
  matter most.
- **Resolve lazily, on demand.** Rejected: the artifact must be complete and
  self-contained, because Phase 7 reads it without the document.
- **Store only effective values, no provenance.** Rejected: it makes SmartFix
  guess, and a guessing SmartFix edits the wrong element.

## Consequences

- A golden fixture exists for each precedence case, including the XOR one that
  naive implementations get backwards.
- The structural model is larger than the fact set, which is why they are
  separate artifacts (ADR-0041).
- A missing parent style, a style cycle or an unresolvable theme reference
  produces a warning and PARTIAL coverage, never a substituted value.
