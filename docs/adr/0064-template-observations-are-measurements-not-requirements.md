# ADR-0064: A template is measured deterministically, and what it shows is never a requirement

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 9

## Context

Institutions supply two kinds of document: guidelines, which state what is
required, and templates, which merely demonstrate it. The difference is the
whole of Phase 9's honesty.

A template whose captions are all 10 pt might mean "captions must be 10 pt", or
it might mean the author of the template set one caption that way and copied it.
A template with exactly one caption means nothing at all. Treating either as
policy would have PalCert inventing institutional requirements and then
enforcing them against students.

There is a second, smaller temptation: asking the model what formatting a
template uses. PalCert already knows — the Phase 6 analyzer measured it exactly.
Asking a model would replace an exact answer with a guess, and pay for it.

## Decision

Templates are never sent to a model for measurement. `TemplateObservationEngine`
reads the Phase 6 fact set and counts, producing for each measured property:
the modal value, the number of occurrences, how many matched, how many distinct
values appeared, and a bounded distribution of the top few.

Consistency is reported as a four-value classification with published
thresholds, not as a score: `UNIFORM` (every occurrence agrees),
`MOSTLY_UNIFORM` (the modal value holds at least 90%), `MIXED`, and
`INSUFFICIENT_SAMPLE` (fewer than three occurrences). **No confidence number is
produced anywhere**, because PalCert has no basis for one.

Facts measured in different units are never merged into one distribution.

An observation becomes at most a `TEMPLATE_INFERENCE` proposal, which is a
distinct kind from `EXPLICIT_REQUIREMENT` at every layer: in the contract, in
the database, in the API, and in the UI, where it is labelled "Observed in the
template" and carries the sentence "This is what the template document does. It
is not a statement of what your institution requires."

## Alternatives considered

**Promote a uniform observation to a requirement automatically.** Rejected.
Consistency is evidence of a habit, not of a policy, and only the institution
can convert one into the other.

**Report a confidence percentage.** Rejected. "187 of 196 paragraphs are 12 pt"
is a fact a reviewer can verify; "94% confident" is a number nobody can check
and everybody would round to "yes".

**Ask the model to describe the template.** Rejected: slower, dearer, and less
accurate than the analyzer PalCert already runs.

## Consequences

- Template extraction is fully deterministic and testable without a provider.
- A single-occurrence property is reported as too small a sample rather than as
  a rule, which is the case most likely to produce a wrong standard.
- The uniformity thresholds are constants in the contracts package, so the
  classification means the same thing in the API, the UI and the corpus tests.
