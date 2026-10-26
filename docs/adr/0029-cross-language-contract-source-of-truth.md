# ADR-0029: One JSON Schema is the source of truth for every cross-language contract

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 4

## Context

The rule engine is Python; the standards service, the API and the browser are
TypeScript. A fact set, an evaluation request and an evaluation result cross
that boundary, and both sides have to agree on their shape — not roughly, but
exactly, because a field one side allows and the other rejects is a request
that fails in production on a document nobody tested with.

Two hand-written models, one per language, are the default outcome of
"just add a type", and they drift the first time either side changes.

## Decision

**`contracts/schemas/evaluation.schema.json` (JSON Schema 2020-12) is the
single definition. Everything else is derived from it or validated against
it.**

- **TypeScript types are generated** from the schema
  (`packages/contracts/scripts/generate-evaluation-types.mjs`), and CI runs the
  generator in `--check` mode so a hand edit to the generated file, or a schema
  change without regeneration, fails the build.
- **TypeScript validation** is Ajv in strict mode over the same schema,
  embedded as a generated constant (the contracts package is CommonJS and must
  not read files at runtime).
- **Python validation** is `jsonschema` over the same file, located by walking
  up from the package to the repository root. There is deliberately no copy of
  the schema inside the Python package, and a test asserts that.
- **Shared fixtures**: `contracts/fixtures/evaluation/*.json` (accepted, with
  golden results) and `contracts/fixtures/invalid/*.json` (rejected) are run by
  *both* test suites. A payload one runtime accepts and the other refuses fails
  CI on the side that disagrees.
- The schema mirrors the Phase 3 rule vocabulary rather than importing it
  (JSON Schema cannot import a TypeScript enum). A **parity test** in the
  contracts package asserts that every scope kind, element type, page selector,
  operator and unit in the schema is identical to the Phase 3 catalogue.

The schema is written **closed** — every object has `additionalProperties:
false`, every string and array is bounded, and discriminated unions are
fully-specified `oneOf` branches rather than `if/then` conditions.

## Alternatives considered

**Hand-written models in each language, kept in sync by review.** Rejected;
this is the failure mode the decision exists to prevent.

**TypeScript as the source, with Python generated.** Rejected. Python has no
mature generator from TypeScript types, and the validation semantics (what
exactly is rejected) would then live in Ajv's interpretation rather than in a
standard both sides implement.

**Protocol Buffers.** Considered seriously. Rejected for now because the
payloads are JSON at every boundary (database JSONB, HTTP, fixtures a person
reads), the vocabulary is enumerations and decimal strings rather than binary
data, and JSON Schema validation gives field-level error paths that a
generated protobuf decoder does not.

## Consequences

- The cross-language test caught a real divergence during Phase 4: Ajv's
  strict mode rejected an `if/then` construct that Python's validator accepted.
  The fix was to restructure the schema, not to relax either validator — and
  the restructured form is stricter (a `DOCUMENT` scope carrying an
  `elementType` is now refused on both sides).
- Adding a field is a three-step change: schema, regenerate, fixtures. That is
  the cost, and it is the point.
- Numbers are decimal strings on the wire by schema, so
  [ADR-0027](0027-exact-decimal-arithmetic.md) is enforced at the boundary
  rather than by convention.
- The schema's `$id` and `$defs` names are part of the contract: the validators
  address definitions by name (`DocumentFactSet`, `RuleEvaluationResult`, …).
