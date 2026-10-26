# ADR-0055: AI output is advisory; deterministic evidence is authoritative

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 8

## Context

PalCert measures things. A margin is 20 mm or it is not, and Phase 7 records
that with a hash over a canonical serialization so the answer can be shown to
be the answer that was given. A language model reads text and forms an opinion.
These are different kinds of statement, and the whole value of the product
rests on not confusing them.

The tempting design is to let the model "fill in" the requirements the
deterministic engine returned `INDETERMINATE` for, and present one merged
verdict. That is the design this ADR exists to forbid.

## Decision

Deterministic results are authoritative technical measurements. AI results are
structured semantic assessments and explanations. The AI layer never rewrites
deterministic evidence or a historical report.

Enforced in four independent places, so no single mistake removes the guarantee:

1. **No write path exists.** No Phase 8 code path writes to `document_checks`,
   `check_runs`, `check_rule_results`, `check_violations` or `check_reports`.
   AI output lives in its own tables.
2. **Separate vocabulary.** An AI assessment is `SATISFIED`, `NOT_SATISFIED` or
   `INSUFFICIENT_EVIDENCE`, never `PASS` or `FAIL`. A reader who sees the two
   words cannot mistake one statement for the other.
3. **`requiresHumanReview` is computed, not received.** For a blocking
   AI-assisted rule, PalCert records `requiresHumanReview = true` regardless of
   what the model concluded. The value comes from `rule.blocking`, not from the
   response.
4. **A database CHECK constraint.** `ai_rule_assessments_blocking_requires_human`
   refuses any row where `blocking` is true and `requires_human_review` is not.
   A future bug in (3) fails at the write, not in front of a student.

The mandated e2e test compares `reportHash`, `evaluationHash`, `determination`,
`deterministicScore`, `scoreCoverage`, every `CheckRuleResult` row and every
`CheckViolation` row before and after an AI review. They must be identical.

## Alternatives considered

**Let the AI resolve INDETERMINATE rules into a final outcome.** Rejected. An
institution acting on a model's opinion believing it to be a measurement is the
harm this whole product is supposed to avoid.

**Show one blended verdict per rule.** Rejected: the UI shows three separate
lines — machine status, AI assessment, final status — precisely so the reader
can see that the AI did not decide anything.

## Consequences

- A reader always knows which claims are measured and which are read.
- If AI prose contradicts a measured value, the measurement wins, and the
  supplement prompt says so explicitly.
- Blocking requirements still need a person. The AI can shorten their reading,
  not replace their judgement.
