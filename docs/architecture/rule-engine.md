# The deterministic rule engine

Phase 4. The engine takes a published standard's rules and a **normalized fact
set** describing a document, and returns one verdict per rule. It is a pure
Python library under `services/document-engine/app/engine/` — no HTTP, no
database, no model calls — so it can be tested exhaustively with synthetic
facts before any parser exists.

Decisions: [ADR-0026](../adr/0026-normalized-fact-model.md) (fact model),
[ADR-0027](../adr/0027-exact-decimal-arithmetic.md) (arithmetic),
[ADR-0028](../adr/0028-evaluation-result-semantics.md) (outcomes),
[ADR-0029](../adr/0029-cross-language-contract-source-of-truth.md)
(contracts), [ADR-0030](../adr/0030-rule-schema-v2-blocking-semantics.md)
(blocking).

## 1. Shape

```
DocumentFactSet ──┐
                  ├─► FactIndex ─► select(scope) ─► operator ─► per-fact verdicts ─► aggregate ─► RuleEvaluationResult
RuleDefinition ───┘        │                                                              │
                           └─ coverage_for(scope) ────────────────────────────────────────┘
```

| Package | Responsibility | One home for |
| --- | --- | --- |
| `contracts/` | Load and validate the shared JSON Schema | What a payload may look like |
| `units/` | Dimensions, exact conversion, exact formatting | What a number means |
| `facts/` | The fact set, coverage lookup, indexing and scope selection | Which facts a rule addresses |
| `rules/` | Operator evaluators, the named-pattern registry, text comparison | Whether one fact satisfies a rule |
| `evaluation/` | Orchestration, outcome precedence, limits, results, telemetry | What a set of verdicts means |

Each decision has exactly one place. Scope matching is not repeated inside
operators; outcome precedence is not repeated inside evaluators.

## 2. The fact model

A `DocumentFactSet` is what a parser hands the engine:

```json
{
  "factSchemaVersion": 1,
  "documentId": "…",
  "extractor": { "name": "docx-ooxml", "version": "…" },
  "coverage": [{ "kind": "ELEMENT", "elementType": "PARAGRAPH", "property": "fontSize", "status": "COMPLETE" }],
  "facts": [
    {
      "scope": { "kind": "ELEMENT", "elementType": "PARAGRAPH", "property": "fontSize" },
      "value": { "type": "NUMBER", "number": "12" },
      "unit": "POINT",
      "location": { "locationSchemaVersion": 1, "nodeId": "p-0042", "page": 7, "ordinal": 42 },
      "provenance": { "sourceKind": "OOXML", "confidence": "1" }
    }
  ]
}
```

- **Scope** uses the Phase 3 vocabulary verbatim (`DOCUMENT`, `SECTION`,
  `ELEMENT`, `METADATA`, `PAGE`; element types; page selectors). Each kind is a
  closed shape — a `DOCUMENT` scope cannot carry an `elementType`.
- **Value** is a closed discriminated union: `NUMBER` (a **decimal string**),
  `STRING`, `BOOLEAN`, `STRING_LIST`, `NUMBER_LIST`. A JSON number is rejected
  by schema.
- **Location** is versioned separately (`locationSchemaVersion`) and is
  optional: structural extraction often does not know the page yet.
- **Provenance** records the extractor's source and, only where there is one,
  a confidence. Exact extraction carries no confidence rather than a fake `1.0`.
- **Coverage** is declared per domain, and its default is the whole safety
  story (§4).

Phase 4 constructs fact sets synthetically. Nothing here parses a document.

## 3. Selection

`FactIndex` buckets facts once per evaluation by `(kind, elementType,
property)` and sorts each bucket into canonical order, so:

- evaluating R rules over F facts is proportional to the facts each rule
  addresses, not O(R × F) — 200 rules over 10,000 facts runs in well under a
  second, and the performance suite pins that;
- results cannot depend on the order the extractor emitted facts in.

Matching is structural, with one deliberate asymmetry: **a selector the rule
omits means "any"**. A heading rule with no `level` covers every heading; a rule
naming level 2 covers only level-2 headings. The reverse never holds — a rule
naming a level does not match a fact that has none.

## 4. Coverage and the fail-closed default

For each rule scope the engine asks the fact set what the extractor saw:

| Status | Meaning |
| --- | --- |
| `COMPLETE` | Every fact in the domain is present. Absence means absence. |
| `PARTIAL` | Some facts are present. A pass over them is not a pass. |
| `UNAVAILABLE` | The extractor could not read the domain. Nothing is known. |

Lookup takes the **most specific matching entry** (kind + element type +
property beats kind alone). **Anything undeclared is `UNAVAILABLE`.** An
extractor's silence must never read as "complete, and there was nothing
there", because that turns every unimplemented parser feature into a confident
`PASS`.

## 5. Operators

The fourteen Phase 3 operators, no others. Each evaluator declares which
expected-value types it accepts, mirroring `OPERATOR_VALUE_COMPATIBILITY` in
`@palcert/contracts`; a rule whose value type the operator cannot take is
`INDETERMINATE` / `VALUE_TYPE_INCOMPATIBLE`, never a guess.

| Operator | Notes |
| --- | --- |
| `EQUALS`, `NOT_EQUALS` | Numbers compare exactly (with tolerance if given); text by the property's comparison mode (§7) |
| `GREATER_THAN`, `GREATER_THAN_OR_EQUAL`, `LESS_THAN`, `LESS_THAN_OR_EQUAL` | Tolerance widens toward compliance and never against it |
| `BETWEEN` | Inclusive, over a `NUMBER_RANGE` |
| `IN`, `NOT_IN` | Membership in a string or number list |
| `CONTAINS`, `NOT_CONTAINS` | Substring by the property's comparison mode |
| `MATCHES_PATTERN` | A **named** pattern from the registry (§8); never a user-supplied expression |
| `EXISTS`, `NOT_EXISTS` | Unary; coverage is decisive (§9) |

**Every matching fact is evaluated.** A rule about body paragraphs is judged
over all of them, and the counts in the result are exact even when the returned
violation list is capped.

## 6. Units and precision

Numbers cross the boundary as decimal strings and are converted to
`fractions.Fraction` without loss. Unit conversion multiplies by exact rational
factors; comparison and tolerance are exact; results are rendered with
`format_exact`, never in exponent notation.

Units carry a **dimension**:

| Dimension | Units | Converts |
| --- | --- | --- |
| Length | `MILLIMETRE`, `CENTIMETRE`, `INCH`, `POINT` | Freely, exactly |
| Pixel | `PIXEL` | Never — a pixel has no length without a DPI the engine is not given |
| Count-like | `COUNT`, `WORDS`, `CHARACTERS`, `PAGES`, `LINES` | Only to itself |
| Other | `RATIO`, `DIGITAL_SIZE`, `RESOLUTION` | Only to itself |

Comparing across dimensions is `UNIT_INCOMPATIBLE`. A unit on one side only is
`UNIT_MISSING`. Both are `INDETERMINATE`: an incomparable pair says nothing
about the document.

Why not `Decimal`: `30 mm → pt → mm` at 28 digits gives
`30.00000000000000000000000001`. Property tests prove `Fraction` round-trips
exactly, transitively, and order-preservingly across the whole registry.

## 7. Text comparison

Four named modes, chosen by the scope property and never by the rule author:

| Mode | Applied to | Behaviour |
| --- | --- | --- |
| `EXACT` | The default: anything not listed below (a required declaration, for instance) | NFC only |
| `TRIMMED` | `title`, `author` | NFC + strip |
| `CASE_INSENSITIVE` | `alignment`, `language`, `citationStyle`, `numberingFormat` | NFC + strip + casefold |
| `NORMALIZED` | `fontFamily`, `fontName`, `styleName`, `heading` | NFC + strip + collapse whitespace + casefold |

Every mode normalizes to Unicode NFC first, so two byte sequences that render
identically compare equal. Normalization is idempotent (property-tested), so it
can be applied at any layer without changing the outcome.

## 8. Patterns

`MATCHES_PATTERN` takes a name from a fixed registry of sixteen patterns —
`STARTS_WITH`, `ENDS_WITH` (the only two with an argument), `DIGITS_ONLY`,
`LETTERS_ONLY`, `NO_LEADING_WHITESPACE`, `NO_TRAILING_WHITESPACE`,
`SENTENCE_CASE`, `TITLE_CASE`, `UPPERCASE`, `ARABIC_SCRIPT`, `LATIN_SCRIPT`,
`DOI`, `ISSN`, `ISBN`, `EMAIL`, `URL`.

The registry is the only place a regular expression exists. **A rule never
carries one**, because a caller-supplied pattern is a denial-of-service vector
(catastrophic backtracking) and an injection vector. Registry patterns contain
no nested quantifiers, inputs are capped at 10,000 characters, and a test feeds
every pattern hostile input and holds the whole registry to under a second.

## 9. Outcomes

| Outcome | Produced when |
| --- | --- |
| `PASS` | Every matching fact satisfied the rule under `COMPLETE` coverage |
| `FAIL` | Any matching fact violated it (evidence attached) |
| `NOT_APPLICABLE` | `COMPLETE` coverage and no matching fact — the document has none of the thing |
| `INDETERMINATE` | Anything the engine cannot honestly decide |

**Precedence:** any `FAIL` ⇒ `FAIL`; else any `INDETERMINATE` ⇒
`INDETERMINATE`; else `PARTIAL` coverage ⇒ `INDETERMINATE`; else `PASS`.

**Presence operators** are where coverage is decisive. `EXISTS` with no facts
is `FAIL` only under `COMPLETE` coverage; under anything less, "not found" is
`INDETERMINATE`, because the extractor may simply not have looked.

**The two things the engine never does.** It never turns missing evidence into
`PASS`, and it never turns its own limitation — an unsupported operator, an
incomparable unit, an internal error — into `FAIL`. Both are `INDETERMINATE`
with a reason code naming the cause.

**Evaluation authority.** Phase 4 evaluates `DETERMINISTIC` rules only.
`AI_ASSISTED` and `MANUAL` rules return `INDETERMINATE` with
`requiresReview: true` and the reason `AI_REVIEW_REQUIRED` /
`MANUAL_REVIEW_REQUIRED`. The engine does not fabricate a verdict for a rule it
is not the authority on, and it makes no AI call.

### Reason codes

Stable and machine-readable; downstream code switches on these and never parses
message text.

| Group | Codes |
| --- | --- |
| Satisfied | `SATISFIED` |
| Violated | `VALUE_MISMATCH`, `OUTSIDE_TOLERANCE`, `BELOW_MINIMUM`, `ABOVE_MAXIMUM`, `OUTSIDE_RANGE`, `REQUIRED_VALUE_MISSING`, `FORBIDDEN_VALUE_PRESENT`, `PATTERN_MISMATCH`, `NOT_IN_ALLOWED_SET`, `IN_FORBIDDEN_SET` |
| No evidence | `NO_COMPLETE_EVIDENCE`, `NO_MATCHING_FACTS`, `SCOPE_NOT_PRESENT` |
| Incomparable | `UNIT_INCOMPATIBLE`, `UNIT_MISSING`, `VALUE_TYPE_INCOMPATIBLE` |
| Engine | `EVALUATOR_NOT_SUPPORTED`, `AI_REVIEW_REQUIRED`, `MANUAL_REVIEW_REQUIRED`, `FACT_SCHEMA_UNSUPPORTED`, `RULE_SCHEMA_UNSUPPORTED`, `RESOURCE_LIMIT_EXCEEDED`, `INTERNAL_ERROR` |

## 10. Results

A `RuleEvaluationResult` is evidence, not prose:

```json
{
  "ruleCode": "MARGIN.TOP.MIN",
  "outcome": "FAIL",
  "reasonCode": "BELOW_MINIMUM",
  "evidenceLevel": "DETERMINISTIC",
  "requiresReview": false,
  "blocking": true,
  "severity": "MAJOR",
  "evaluationMode": "DETERMINISTIC",
  "operator": "GREATER_THAN_OR_EQUAL",
  "counts": { "matchedFacts": 1, "evaluatedFacts": 1, "passedFacts": 0, "failedFacts": 1, "indeterminateFacts": 0 },
  "violations": [
    {
      "reasonCode": "BELOW_MINIMUM",
      "location": { "locationSchemaVersion": 1, "nodeId": "sect-1", "page": 1 },
      "expected": { "value": "25", "unit": "MILLIMETRE" },
      "actual": { "value": "2.3", "unit": "CENTIMETRE", "normalizedValue": "23", "normalizedUnit": "MILLIMETRE" },
      "tolerance": "0.5"
    }
  ],
  "totalViolationCount": 1,
  "truncated": false,
  "engine": { "engineName": "palcert-deterministic", "engineVersion": "1.0.0", "ruleSchemaVersion": 2, "factSchemaVersion": 1 }
}
```

- `blocking`, `severity` and `evaluationMode` are carried from the rule so
  Phase 7 can finalise compliance without re-reading the standard.
- `actual` carries both what the author wrote and the normalized quantity, so a
  report can say "your 2.3 cm, which is 23 mm, against the required 25 mm".
- Serialization is canonical: fixed key order, absent values omitted,
  violations sorted by location. The same evaluation is byte-identical every
  time, which the golden fixtures assert.
- `engine` records which engine and schema versions produced the result, so a
  verdict stays explainable after a hundred unrelated deployments.

## 11. Limits

Facts and rules are untrusted structured input at a service boundary.

| Limit | Default | On breach |
| --- | --- | --- |
| Rules per evaluation | 1,000 | Refused (`ResourceLimitExceededError`) |
| Facts per set | 100,000 | Refused |
| Coverage entries | 500 | Refused |
| String length | 10,000 | Refused by schema and by the pattern registry |
| List items | 1,000 | Refused by schema |
| Returned violations per rule | 100 | **Truncated**; `totalViolationCount` stays exact |
| Returned violations per response | 5,000 | Truncated across rules, in rule order |

Input limits refuse rather than truncate: evaluating the first thousand of a
million facts would produce a verdict about a document nobody submitted.
Violation limits truncate rather than refuse: a document with 40,000 identical
violations has genuinely failed 40,000 times and the report should say so — it
just must not serialize 40,000 objects to do it.

The same values are published as `EVALUATION_LIMITS` in `@palcert/contracts`.

## 12. Determinism and reproducibility

Same rule, same facts, same engine version ⇒ the same result, byte for byte:

- selection order is canonical, not extractor order (§3);
- arithmetic is exact (§6);
- no dictionary iteration order reaches the output;
- there is no clock, no randomness and no I/O inside an evaluation.

`ENGINE_VERSION` changes when evaluation semantics change, and only then. The
golden fixtures in `contracts/fixtures/evaluation/` are committed results, not
regenerated ones: a behaviour change fails a test rather than quietly updating
a file.

## 13. Rule schema versions

The engine implements versions **1 and 2** and refuses anything else with
`RULE_SCHEMA_UNSUPPORTED` rather than guessing. The two differ only in what may
be `blocking` ([ADR-0030](../adr/0030-rule-schema-v2-blocking-semantics.md)):

- **v1**: only a `DETERMINISTIC` rule. Validated and evaluated under its own
  rules; nothing published was rewritten and the v1 golden hash is unchanged.
- **v2**: any evaluation mode. A blocking `AI_ASSISTED` or `MANUAL` rule is
  representable and resolves to `INDETERMINATE` + `requiresReview`, which holds
  the compliance decision open until a reviewer resolves it. The engine, not the
  validator, is where the safety property now lives.

Upgrading is an explicit, audited clone option in the API; see
[standards.md](standards.md) and [API conventions](../api/conventions.md).

## 13a. Fact schema versions

The engine accepts fact schema versions **1 and 2** and refuses anything else
with `FACT_SCHEMA_UNSUPPORTED`. The two differ only in the element vocabulary:

- **v1** (Phase 4): the original twelve element types.
- **v2** (Phase 6): adds `ENDNOTE` and `TEXTBOX`. WordprocessingML keeps both
  in their own stories, and filing them under `PARAGRAPH` would let a rule
  about body text fail because of a footnote or a text box.

A fact set that *declares* version 1 may not use the new types, or "version 1"
would silently mean two vocabularies. That is enforced in both runtimes by a
version-aware check alongside the JSON Schema, because expressing it as a
schema conditional would require two implementations to agree on the same
conditional. Rules are unrestricted at either version: a rule naming an
element type the extractor never emits selects nothing, which is already a
meaningful answer. Nothing published changed, and Phase 4's golden fixtures
still declare version 1 and still pass.

## 14. Cross-language contracts

`contracts/schemas/evaluation.schema.json` is the single definition of
`DocumentFactSet`, `RuleEvaluationResult`, `EvaluationRequest` and
`EvaluationResponse`. TypeScript types are generated from it with a CI drift
check; Ajv (strict) and `jsonschema` validate against the same file; the same
accepted and rejected fixtures run in both suites. Details and the divergence
this caught during Phase 4 are in
[ADR-0029](../adr/0029-cross-language-contract-source-of-truth.md).

## 15. Observability

`evaluate_all` emits one structured record, `rule_engine.evaluation_completed`,
at `info`. Field names are constants in `evaluation/telemetry.py`
(`MetricField`) and are the contract for dashboards:

| Field | Meaning |
| --- | --- |
| `engine_name`, `engine_version`, `fact_schema_version` | What produced the result |
| `document_id`, `extractor_name`, `extractor_version` | Correlation identifiers |
| `rule_count`, `fact_count`, `coverage_entry_count`, `duration_ms` | Size and cost |
| `outcome_pass`, `outcome_fail`, `outcome_not_applicable`, `outcome_indeterminate` | Verdict distribution |
| `review_required`, `blocking_failed`, `blocking_unresolved` | What the review queue and Phase 7 will see |
| `facts_evaluated`, `violations_total`, `violations_returned`, `rules_truncated` | Work done and evidence returned |
| `reason_codes` | Count per reason code, in fixed order |

**The record carries identifiers and numbers only.** No fact value, no expected
value, no violation evidence, no rule code, no document text. A fact set
describes an unpublished thesis or a manuscript under blind review, and a test
feeds the engine a sentinel value and asserts it never reaches the log.

## 15a. Projection authority: what may become a fact

The engine's outcome precedence — `FAIL`, then `INDETERMINATE`, then the
coverage demotion, then `PASS` — has a consequence every later phase has to
build around:

> **`PARTIAL` coverage prevents a false pass. It does not prevent a false
> failure.** `_aggregate` checks `failed > 0` before it looks at coverage, so a
> fact whose value is wrong fails the rule no matter what coverage says about
> the domain it came from.

That is the correct engine behaviour and it is pinned by
`tests/engine/test_engine.py::TestCoverage::test_partial_coverage_does_not_
protect_a_wrong_value`. It is not a defect and must not be "fixed".

The boundary therefore lives upstream, in whatever projects evidence into a
`DocumentFactSet`. An extractor may hold rich, inferred, partial evidence; a
*fact* is a much smaller claim. A property may enter a fact set only when all
four hold:

1. **the semantic element identity is deterministic** — the scope the fact is
   attached to was established from structure, not from classification.
   Coverage cannot repair a wrong element identity: `PARTIAL` says "we did not
   see everything", never "what we did see might not be what we called it";
2. **the value is deterministic** — read or computed exactly, not inferred;
3. **the property is on that phase's explicit projector allow-list** — a named,
   reviewed constant, not whatever the extractor happened to compute;
4. **an explicit coverage entry is emitted for it** — a property with no entry
   resolves to `UNAVAILABLE` and can never reach `_aggregate`, which is the
   fail-closed default working as intended.

One corollary worth stating separately, because it is easy to get wrong: an
**aggregate count** is emitted with `COMPLETE` coverage or `UNAVAILABLE`
coverage, never `PARTIAL`. A partial count is not a missing value, it is a
*wrong* value — a lower bound wearing the name of an exact one — and a rule such
as "at least twenty references" would fail a compliant document on it.

Phase 18 is the first phase to hold evidence that fails these tests. Its rich
citation and reference evidence lives in the analysis artifact and is advisory;
only the four properties on its allow-list are projected.

## 16. What Phase 4 deliberately does not do

No DOCX or PDF parsing. No document upload. No AI provider call. No final
compliance score. No persisted checks, findings or reports. No public
evaluation API. No user-supplied regular expression, and no expression language
of any kind. The engine is a library, and the only callers are tests.
