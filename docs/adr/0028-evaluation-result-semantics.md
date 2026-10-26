# ADR-0028: Four outcomes, and neither absence nor error ever becomes a verdict

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 4

## Context

The simplest rule engine returns a boolean per rule. PalCert cannot, because a
boolean has to answer two questions it has no basis for:

- *The document has no figures. Did it pass the figure-caption rule?* It did
  not satisfy the rule; the rule had nothing to say. Scoring a "pass" here
  inflates a compliance percentage with rules that were never tested.
- *The extractor could not read the tables. Did the table rules pass?* Nothing
  is known. A "pass" would certify on the strength of a parser's silence; a
  "fail" would punish the author for a tooling gap.

There is also the question of what a rule engine should do when *it* is the
problem — an operator it does not implement, a unit it cannot convert, a bug.

## Decision

**Every rule evaluation produces exactly one of four outcomes, with a stable
machine-readable `reasonCode`:**

| Outcome | Meaning |
| --- | --- |
| `PASS` | Every matching fact satisfied the rule, under evidence the engine trusts. |
| `FAIL` | At least one matching fact violated the rule. Evidence is attached. |
| `NOT_APPLICABLE` | Coverage is `COMPLETE` and no fact matched: the document genuinely has none of the thing the rule is about. |
| `INDETERMINATE` | The engine cannot say. Coverage was incomplete, the rule needs a reviewer, the operator or unit is unsupported, or the engine failed. |

Three rules govern how outcomes are reached:

1. **Every matching fact is evaluated.** "Every body paragraph is 12 pt" is
   not answered by inspecting the first paragraph. Counts are exact even when
   the returned violation list is capped.
2. **Precedence: any `FAIL` ⇒ `FAIL`; else any `INDETERMINATE` ⇒
   `INDETERMINATE`; else `PARTIAL` coverage ⇒ `INDETERMINATE`; else `PASS`.**
   A failure is the most specific thing the engine can say, and an unknown must
   never be able to mask one. Equally, a pass over a partial view is not a pass.
3. **Never a false verdict.** Missing evidence is never `PASS`. An unsupported
   operator, an incompatible unit or an internal error is never `FAIL`. Each
   is `INDETERMINATE` with a reason code naming the cause, so the report can
   say "could not evaluate" instead of blaming the author or clearing them.

Two further fields travel with every result. `evidenceLevel` records whether the
verdict rests on a deterministic measurement or on nothing, so a later
certificate can be issued only on the former. `requiresReview` is `true` for
every `AI_ASSISTED` and `MANUAL` rule: Phase 4 evaluates deterministic rules
only, and the engine returns an explicit unresolved state for the others rather
than a fabricated verdict.

Results are **machine-readable evidence, not prose**: reason code, expected,
actual, tolerance, location. The report layer (Phase 7) and the AI explanation
layer (Phase 8) turn those into sentences; they must never have to parse one.

## Alternatives considered

**Three outcomes, folding `NOT_APPLICABLE` into `PASS`.** Rejected: the
compliance score of Phase 7 must be able to exclude untested rules from its
denominator, and it cannot if they look like passes.

**Reporting the first violation only.** Rejected: a report that says "7
violations" has to have counted them, and an author fixing one paragraph at a
time would be given a new one per round trip.

**Raising on evaluator errors.** Rejected at the per-rule level. One
unsupported operator would abort the evaluation of two hundred other rules.
Input-limit violations do raise, because a request too large to answer is the
caller's decision to make, not a verdict to soften.

## Consequences

- Phase 7 has what it needs to finalise compliance without re-reading the
  standard: `outcome`, `blocking`, `severity`, `evaluationMode`,
  `requiresReview` and `evidenceLevel` are all on the result.
- A blocking rule that comes back `INDETERMINATE` holds the compliance decision
  open. This is the mechanism that makes Rule Schema v2's blocking amendment
  safe ([ADR-0030](0030-rule-schema-v2-blocking-semantics.md)).
- A document whose parser sees little will score many `INDETERMINATE` results.
  That is honest, and it is a pressure on parser coverage rather than on the
  engine.
- Results are canonically serialized (fixed key order, absent values omitted,
  violations sorted by location), so the same evaluation produces byte-identical
  JSON — a property the golden fixtures assert and any later result hash will
  rely on.
