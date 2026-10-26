# ADR-0139: Heuristic evidence is reported and never decides

- **Status:** Accepted
- **Date:** 2026-09-20
- **Phase:** 18

## Context

Checkpoints 10 to 14 built heuristic citation discovery — numeric, author-year,
Vancouver, raised and parenthesised forms, across multiple reference regions —
and projected none of it into a fact. ADR-0133 quarantined it behind three
independent gates, and every checkpoint since restated the reason: a recognized
citation's element identity is established by classification, not by structure,
and the projection authority rule requires both identity and value to be
deterministic.

That left a real question unanswered. PalCert can now read an untagged thesis
and find its citations, and a customer who cannot see any of that is being
denied something useful for a reason they never asked about.

The audit that opened this checkpoint established why the obvious answer —
project the counters and let coverage protect them — does not work:

* The deterministic engine checks `failed > 0` **before** it looks at coverage.
  `PARTIAL` demotes a PASS to INDETERMINATE and does nothing whatever to a
  FAIL. A heuristic count projected as an ordinary fact could therefore fail a
  compliant document outright, and no coverage status would intervene.
* The evaluator never read `provenance` at all. A `HEURISTIC` fact decided a
  rule exactly as an `OOXML` one did.
* Every PASS or FAIL was stamped `DETERMINISTIC`, whatever produced it — so
  even the label a report and a certificate gate read would have been wrong.

Those three are pinned as characterization tests, written before any of this
was implemented, because the third one in particular is invisible until
somebody looks.

## Decision

**The evaluator refuses to decide on a fact it did not read.** A rule matching
any fact whose `provenance.sourceKind` is `HEURISTIC` returns `INDETERMINATE`
with reason `ADVISORY_EVIDENCE_ONLY` and the new evidence level `ADVISORY`. The
observation is reported; it never becomes the PASS or FAIL an exact rule
produces.

Three properties of that rule matter:

* It keys on **provenance**, not on a property name. An analyzer that emitted a
  heuristic value for an exact property would be a bug; this makes it a
  harmless one, and that is a second gate rather than a restatement of the
  first.
* It is **any**, not all. A rule mixing exact and heuristic facts is not partly
  authoritative — the verdict would still rest on a recognition, and a reader
  told PASS has no way to know which facts carried it.
* It fires **before** the coverage checks, because coverage is exactly what
  does not protect this.

**`ADVISORY` joins the support vocabulary** as a fourth level beside `EXACT`,
`DERIVED` and `UNSUPPORTED`. It is not a weaker `EXACT` and not a variant of
`DERIVED`: both of those are computations over what the format stores,
exhaustive and repeatable, while this is a belief about what the document
contains. The compatibility preview counts advisory rules in a bucket of their
own and never reports `FULL` when one is present — that number is read by
somebody deciding whether to pay.

**Three document-level counters are exposed**, and deliberately no more:
`observedCitationCount`, `observedReferenceCount`,
`observedReferenceRegionPresent`. The names were already in the artifact's
summary, where Checkpoint 10 chose them precisely because they read as lower
bounds. Nothing element-level, no candidate ids, no link methods, no parsed
titles, no DOIs.

**Advisory counts are over heuristic objects only.** The declared ones are
already answered exactly, and a number mixing both could carry neither
provenance honestly — which matters because provenance is what the gate keys
on. The two populations are disjoint by construction, since the analyzer
suppresses any heuristic object overlapping a declared span.

**Advisory evidence is emitted affirmatively or not at all.** A count of zero
restates the fact's own absence, and emitting it would change the fact set of
every exact-only document to report on a detector that found nothing in it.

**Coverage for an advisory row is `PARTIAL` or `UNAVAILABLE`, never
`COMPLETE`.** "We read the whole file" still does not mean "we recognized
everything in it".

**Confidence is carried only where an honest one exists.** The region marker
carries the strongest contributing region's own confidence — a selection, not a
computation, because the claim is existential. The counts carry none: several
observations with their own confidences contribute to one number, and a single
figure beside "6" would have to mean confidence that there are six, which is
not what any per-object number measured.

## Consequences

The safety argument is a chain, and each link is tested rather than asserted:
an advisory rule is always `INDETERMINATE`; `INDETERMINATE` never contributes
to `COMPLIANT` and a blocking one forces `INDETERMINATE`; only `COMPLIANT` plus
`APPROVED` issues a certificate. So **an advisory rule can move a determination
away from `COMPLIANT` and can never move one towards it.** Heuristic evidence
may withhold a certificate and can never grant one, which is the asymmetry the
whole design is for.

The five exact properties are untouched, and a test pins them as a set of their
own so that adding an advisory row cannot quietly be mistaken for widening
them. `referenceRegionPresent` keeps meaning "proven by structure"; the
recognition is a differently named row beside it, because renaming a proof into
a belief is the failure this checkpoint exists to avoid.

The PDF analyzer moves to `11.0.0`: every PDF now carries three more coverage
entries, and a heuristic one carries up to three more facts.

The cost is that a rule author can write a rule against an advisory property
and will always get `INDETERMINATE`. That is intended and is what the support
registry says in advance — but it does mean the value of these properties today
is in being *read*, not in being *checked*, and a later phase wanting more will
have to earn it with better evidence rather than with a looser gate.
