# ADR-0048: The score is deterministic, exact, and bounded in meaning

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 7

## Context

A percentage is the most quotable thing PalCert produces. A student will put it
in front of a supervisor; a supervisor may treat it as a grade. Whatever the
number means, it will be read as more authoritative than it is — so the design
question is not "what is a reasonable formula" but "what is the narrowest claim
we can actually defend".

Three specific ways to get it wrong are easy to reach by accident: letting
unreproducible evidence into it, letting one rule count many times, and
computing it in binary floating point.

## Decision

**Only deterministic rules count.** An AI-assisted or manual rule has no verdict
in Phase 7, and a score that moved when one was added would be a number nobody
could reproduce from the evidence.

**A rule counts once.** A body-font rule violated in seventy-three paragraphs is
one failed rule with seventy-three violations. Weighting by violation count
would let a single formatting slip in a long thesis dominate every other
requirement in the standard.

**Weights are severity, not count:** `INFO` 0, `MINOR` 1, `MAJOR` 4,
`CRITICAL` 10 — the Phase 3 `RULE_SEVERITY_WEIGHT` table, unchanged. `INFO`
weighs nothing by design: advice must not be indistinguishable from a
requirement. `NOT_APPLICABLE` rules are excluded from both numerator and
denominator.

**Arithmetic is exact.** Weights are integers; the score is computed as a
rational in `BigInt` and rendered as a decimal string at four places, rounding
half away from zero in integers. A reader who recomputes it gets the same
digits. Nothing crosses a boundary as a JSON number.

**Unresolved is not passed.** Unresolved deterministic weight is tracked
separately and reported as `coverage`, and `complete` is false whenever any
deterministic rule was left undecided. A score of 100 over a third of the
requirements is displayed with what it covered, never as an unqualified 100%.

**Null is not zero.** A standard made entirely of manual rules has no
deterministic score. `value` is `null`, and the UI says "no score" with an
explanation — rendering that as 0% would be a failing grade for a document
PalCert never examined.

## Consequences

- The number is small in scope and honest about it, and the UI carries a
  standing note saying so: the score reflects automatically measurable
  formatting rules in one standard, and decides nothing about university
  approval, publication, certification or scientific quality.
- A standard whose rules are mostly manual will show a low coverage, which is
  the truth about how much PalCert could check.
