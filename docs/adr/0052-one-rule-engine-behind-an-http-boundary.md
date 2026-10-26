# ADR-0052: There is exactly one rule evaluator, behind a narrow HTTP boundary

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 7

## Context

Phase 4 built the deterministic rule engine in Python, next to the analyzer.
Phase 7 orchestrates checks in NestJS. The orchestrator needs rule outcomes,
and it would be perfectly possible to reimplement evaluation in TypeScript —
the operators are not complicated.

That would mean two sets of rounding decisions, two tolerance implementations,
two interpretations of "matched but not evaluated", and two sets of bugs, for
the same measurement. When they disagreed — and they would — there would be no
principled way to say which was right.

## Decision

**Node orchestrates; Python evaluates.** The engine gains an HTTP surface:
`GET /evaluation/capabilities` and `POST /evaluation`.

The boundary is deliberately narrow: a fact set and a list of published rule
definitions in, evaluation results out. What does *not* cross it is the point —
no database connection, no storage credentials, no user session, no raw DOCX,
no object key. The deterministic engine stays a pure function of its two
inputs, which is what makes it testable in isolation and what means a
compromised engine has nothing to reach for.

**Both directions are validated against the shared contract.** The engine
validates the request before evaluating and its own response before returning
it; the orchestrator validates the response again before anything derived from
it is stored. Malformed input from PalCert's own service is still malformed
input, and an immutable report is the wrong place to discover a field was the
wrong shape.

Node never parses arbitrary Python-shaped dictionaries: the analysis artifact
and the evaluation payloads are defined by JSON Schema in `contracts/schemas/`,
from which the TypeScript types are generated and against which both languages
validate.

## Consequences

- One implementation of every operator, one place to fix a rounding bug.
- An engine failure is classified as infrastructure and retried; it never
  becomes a compliance verdict.
- The orchestrator can be tested with a double, and is: the Python golden
  corpus proves the operators, the Node suites prove the orchestration.
