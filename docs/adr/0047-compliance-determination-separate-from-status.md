# ADR-0047: Compliance determination is separate from processing status

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 7

## Context

It is very easy to end up with one field. A check that is queued, running,
failed or finished, and a document that complies or does not, both want to be
"the state of this check" — and a single enum holding `EVALUATING`, `FAILED`
and `NON_COMPLIANT` reads naturally right up to the moment a rule engine outage
tells a student their thesis does not meet their university's standard.

That is not a cosmetic error. It is PalCert asserting something false about
someone's work, in the one place they came to the platform to get an answer.

## Decision

Two axes, never merged.

**Processing status** (`CheckStatus`) says how far the work got: `CREATED`,
`WAITING_ANALYSIS`, `EVALUATING`, `GENERATING_REPORT`, `COMPLETED`, `FAILED`,
`CANCELLED`. A failed check has **no determination at all** — the field is
null, in the database, in the API and on the page.

**Compliance determination** (`ComplianceDetermination`) says what was
concluded, and only a completed check has one:

| Determination     | Means                                                       |
| ----------------- | ----------------------------------------------------------- |
| `COMPLIANT`       | every blocking rule was decided and satisfied                |
| `NON_COMPLIANT`   | at least one blocking **deterministic** rule definitively failed |
| `INDETERMINATE`   | a blocking deterministic rule could not be decided           |
| `REVIEW_REQUIRED` | a blocking AI-assisted or manual rule is unresolved          |

Precedence runs in that order: a definite blocking failure outranks anything
undecided, because it is a fact PalCert is certain about.

`INDETERMINATE` is deliberately **not** mapped to a failure. It means the
evidence could not decide — a page-count rule against a structural DOCX
analysis, say — and blaming the document for what PalCert could not read would
be a lie the user has no way to disprove.

Only a *deterministic* `FAIL` counts as definitive. Phase 4 never produces a
`FAIL` for an AI or manual rule, but the guard is what stops a future
provisional AI verdict from silently becoming a certification failure.

## Consequences

- An infrastructure outage can never read as non-compliance.
- The UI shows a stage or a verdict, never a stage dressed as a verdict.
- Callers that want "is this done" and "did it pass" ask two questions, which
  is the honest shape of the answer.
