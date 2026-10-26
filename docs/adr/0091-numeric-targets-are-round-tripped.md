# ADR-0091: A numeric target is round-tripped through OOXML units before it is planned

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 12

## Context

WordprocessingML measures page geometry in twips — twentieths of a point, 1440
to the inch. A 30 mm margin is 1700.787… twips, and a document can only hold
1701. Read back, 1701 twips is 30.004 mm.

So a rule that says `marginLeft EQUALS 30 mm` with no tolerance cannot be
satisfied by any DOCX at all. An engine that wrote 1701 twips and reported
success would produce a correction that looks right, costs money, and fails its
own recheck — with a manifest claiming the margin is 30 mm and an analyzer
insisting it is 30.004 mm.

The same applies to font sizes, which are stored in half-points: 12.3 pt has no
representation.

## Decision

**Every numeric target is converted into the units the document will really
hold, converted back, and re-evaluated with the same operator the check used.**

- The plan's `after` value is the round-tripped value — what the document will
  actually contain — not the number the rule asked for.
- The planner then runs the real evaluator against that value. If it would not
  pass, the rule is reported as `SMARTFIX_TARGET_NOT_REPRESENTABLE` and no
  action is planned.
- Sizes that are not a whole number of half-points are refused outright by the
  mutator rather than rounded: choosing 12.5 pt for a rule asking 12.3 pt would
  be PalCert picking a size nobody asked for.

In practice this means `marginLeft >= 30 mm` is fixable (1701 twips clears the
bound) while `marginLeft EQUALS 30 mm` with no tolerance is not — and the same
rule *with* a tolerance is fixable again.

## Alternatives considered

**Round and hope.** Delivers a correction that fails its recheck, which the
finalize step then refuses — so the user gets the right outcome by the most
expensive possible route, after PalCert has done all the work.

**Report the requested value in the plan and the rounded one in the manifest.**
Then the plan and the manifest disagree about the same change, and the user has
to work out which is true.

## Consequences

- Some plausible-looking rules are honestly reported as uncorrectable, with a
  code that says why rather than "unsupported".
- The plan's numbers and the document's numbers are the same numbers, so the
  manifest's verification against the output is a real check rather than a
  tautology.
- It nudges standard authors towards tolerances on physical measurements, which
  is what a physical measurement needs anyway.
