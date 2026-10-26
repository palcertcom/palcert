# ADR-0026: Rules are evaluated against a normalized fact model, never a document

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 4

## Context

A rule such as "every body paragraph is 12 pt" has to be judged against
something. The obvious something is the document — a DOCX package or a PDF —
and the obvious design is an evaluator that knows how to walk one.

That design couples every rule to every file format. A margin rule would need
one code path for OOXML section properties and another for PDF media boxes;
adding a format would mean revisiting every operator; and the engine could not
be tested without a real document, which makes the thousands of deterministic
tests a rule engine needs too expensive to write. Worse, it hides the question
that matters most for certification — *what did the parser actually see?* —
inside parser code where no verdict can reference it.

## Decision

**The engine evaluates a `DocumentFactSet` and nothing else.** A fact set is a
flat list of typed facts, each carrying:

- a **scope** (`DOCUMENT`, `SECTION`, `ELEMENT`, `METADATA`, `PAGE`) that
  mirrors the rule scope vocabulary of Phase 3 exactly, so selection is a
  structural match rather than an interpretation;
- a **typed value** (`NUMBER` as a decimal string, `STRING`, `BOOLEAN`,
  `STRING_LIST`, `NUMBER_LIST`) with an optional **unit**;
- a **location** (`nodeId`, page, ordinal) so a verdict can point at what it
  judged;
- **provenance** (which extractor, from which source, with what confidence).

Alongside the facts, the set declares **coverage**: for each scope domain,
whether the extractor saw it `COMPLETE`ly, `PARTIAL`ly, or found it
`UNAVAILABLE`. The default, for anything not declared, is `UNAVAILABLE`.

The fact set is a versioned wire contract (`factSchemaVersion`), defined once in
JSON Schema ([ADR-0029](0029-cross-language-contract-source-of-truth.md)), and
Phase 4 exercises it only with synthetic facts. Parsers arrive in Phase 6 and
Phase 13 and produce this shape; the engine does not change when they do.

## Alternatives considered

**Evaluate the document model directly.** Rejected for the coupling described
above, and because it would make the engine untestable without parsers that do
not exist yet.

**An untyped fact bag (`{ "key": value }`).** Rejected: a rule about a
measurement must not be able to compare a string to a number by accident, and
the engine could not know whether an absent key means "not present" or "not
extracted". Typing and coverage are the two things that make a fact set more
than a dictionary.

**Coverage defaulting to `COMPLETE`.** Rejected. A silent extractor would then
read as a compliant document. Failing closed costs some verdicts becoming
`INDETERMINATE` until extractors declare what they saw; failing open would let
an unimplemented parser certify a thesis.

## Consequences

- Every operator is written once, against typed facts, and is tested with
  synthetic input. Phase 4 ships 300-odd engine tests with no document parser.
- `NOT_APPLICABLE` and `INDETERMINATE` become expressible, because "no facts
  under complete coverage" and "no facts under unknown coverage" are different
  inputs. See [ADR-0028](0028-evaluation-result-semantics.md).
- Parsers own a new obligation: to declare coverage honestly. A parser that
  claims `COMPLETE` for a domain it half-extracts produces confident wrong
  verdicts, and the engine cannot detect that. The contract makes the claim
  explicit so a parser test can check it.
- The fact schema is versioned independently of the rule schema, so either can
  evolve without a coordinated release of the other.
