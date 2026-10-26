# ADR-0022: Rules are data, never an executable expression

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 3

## Context

A compliance rule has to express things like "the top margin is at least 25 mm"
and "every reference entry has a DOI". The obvious implementation is a small
expression language, or a stored snippet the evaluator runs. Every product in
this space eventually reaches for one.

## Decision

A rule is a **closed tuple of enumerated choices plus typed literal values**.
There is no expression language, no `eval`, and no place in the schema where
JavaScript, Python, SQL, a shell command or a caller-supplied regular
expression could be stored.

Concretely, a rule is: `ruleCode`, `category`, `evaluationMode`, a discriminated
`scope`, an `operator` drawn from a fixed list of fourteen, a discriminated
`expected` value, an optional `unit` and `tolerance`, `severity`, `blocking`,
`autofix`, provenance, display order, and bilingual text. Nothing else.

Pattern matching is the case that most invites an escape hatch, so it is
handled explicitly: `MATCHES_PATTERN` takes a **named, PalCert-implemented
matcher** (`DOI`, `STARTS_WITH`, `ARABIC_SCRIPT`, …) plus literal arguments —
never a regex supplied by the author.

## Consequences

- An attacker who obtains write access to the rules table gains **data, not code
  execution**. This is the single largest reason for the decision.
- A caller-supplied regular expression is also a denial-of-service vector
  (catastrophic backtracking). The schema has no shape that can carry one.
- A rule can be **validated completely before it is ever evaluated**, which is
  what makes the draft-validation and publication checks possible.
- A rule can be **canonicalized and hashed**, which is what makes a published
  standard verifiable (ADR-0023).
- Anything that cannot be expressed as this tuple is `AI_ASSISTED` or `MANUAL` —
  a question put to a model or a person — not a new operator smuggled in as a
  string.
- Growing the operator list is a deliberate, versioned schema change:
  `RULE_SCHEMA_VERSION` is stamped on every stored rule, and an evaluator that
  does not implement a version refuses the rule rather than guessing.

## Alternatives considered

**A small expression DSL.** Rejected. Every DSL grows until it is a language,
and a language in a database column is remote code execution waiting for a
parser bug. It would also make canonical hashing meaningless, because two
semantically identical expressions could differ textually.

**Storing a compiled predicate.** Rejected for the same reason, with the added
problem that a stored predicate cannot be shown to an author, translated, or
explained in a report.
