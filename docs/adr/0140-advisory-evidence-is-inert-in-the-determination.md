# ADR-0140: Advisory evidence is inert in the determination

- **Status:** Accepted
- **Date:** 2026-09-20
- **Phase:** 18

## Context

ADR-0139 made a rule answered from heuristic facts always `INDETERMINATE`. That
is the right verdict for the *rule*: PalCert recognized something, it did not
read it, and the observation must not become a PASS or a FAIL.

It left the document-level question unanswered. `determineCompliance` classified
any `INDETERMINATE` result from a `DETERMINISTIC` rule as "deterministic
evidence that could not decide", so a **blocking** advisory rule moved an
otherwise `COMPLIANT` document to `INDETERMINATE` — and `INDETERMINATE` is not
`COMPLIANT`, so the certificate was withheld.

That looks conservative and is not. The safety property Phase 18 needs is that
heuristic evidence cannot *grant* authority it does not have. Withholding a
certificate a document authoritatively earned is a different thing: it is a
false negative, caused by a detector not recognizing a citation style, charged
to a student whose thesis was fine. A heuristic layer that can cost somebody a
certificate is a heuristic layer nobody should ship.

The same reasoning applies to the score. An advisory rule counted as unresolved
weight reports "coverage 0.5" for a standard whose authoritative rules were all
evaluated — describing a detector's silence as a failure to read the document.

## Decision

**Advisory results take no part in authoritative aggregation.** They are counted
(`advisoryCount`), recorded in the report in full, and enter neither the
determination nor the score. Removing every advisory result from a check changes
the determination, the score, the coverage and every count in
`DeterminationResult` by nothing at all — which is the property, stated
directly, and tested as such rather than case by case.

The matrix that follows:

| Authoritative | Advisory | Determination |
| --- | --- | --- |
| PASS | anything | `COMPLIANT` |
| FAIL | anything | `NON_COMPLIANT` |
| blocking INDETERMINATE | anything | `INDETERMINATE` |
| none at all | anything | `INDETERMINATE` |

**A standard with results but no authoritative ones is `INDETERMINATE`.** This
is the one case advisory evidence decides, and only by its absence: nothing
authoritative was checked, so there is nothing to have complied with.
`COMPLIANT` there would be the most dangerous answer in the system — a
certificate earned by a standard that decided nothing. The existing
`INDETERMINATE` is used rather than a new status, because it already means
exactly this and a new value would need handling at every site a determination
is read.

**A blocking rule about an advisory-only property is refused at rule
validation.** Both available models were considered — refuse it, or define
`blocking` as having no effect on advisory evidence. Refusal was chosen because
the alternative leaves a standard's author looking at a rule marked blocking,
believing a certificate depends on it, with nothing anywhere saying otherwise.
Refusing says so once, when they write it, where the message can be acted on.
The predicate is "advisory in at least one format and authoritative in none", so
a property that is `EXACT` for DOCX and `ADVISORY` for PDF stays blockable.

Determination ignores `blocking` on advisory results as well. That is a backstop
for historical content and callers that bypass validation, not the contract.

## Consequences

Certificate eligibility is unchanged and now provably unreachable through
advisory evidence in either direction: an advisory observation cannot grant
`COMPLIANT`, cannot remove it, and cannot hide an authoritative `FAIL`. The same
follows for everything keyed off the determination — institutional approval,
submission state, reviewer decisions, payment capture, certificate issuance and
SmartFix eligibility — none of which this checkpoint touches.

`RuleOutcomeSummary` and `ScorableRule` gain an optional `evidenceLevel`, absent
meaning authoritative, so every caller predating Phase 18 keeps its behaviour
exactly.

Nothing is hidden: `advisoryCount` is reported and every advisory rule keeps its
identity, evidence level, outcome, reason code and counts in the stored report.
Inert is not invisible.

The cost is that an advisory rule cannot express urgency at all. A standard
author who genuinely wants "warn me loudly about citations" has severity and
report presentation, not blocking — and the honest answer is that PalCert cannot
yet make a citation requirement authoritative for an untagged PDF, which is a
roadmap item rather than a switch.
