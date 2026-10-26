"""What the evaluator does with provenance today (Phase 18, Checkpoint 15).

Written **before** the advisory path was implemented, and kept afterwards. The
point of a characterization test is that it states the starting position
precisely enough to argue about, so a later change either preserves it on
purpose or breaks it visibly.

Four findings are pinned here, and three of them are the reason Checkpoint 15
exists:

* PARTIAL coverage demotes a PASS and does **not** prevent a FAIL;
* a rule that fails on one fact fails whatever coverage says;
* the evaluator did not read `provenance` at all, so a HEURISTIC fact decided a
  rule exactly as an OOXML one did;
* every PASS or FAIL was stamped `DETERMINISTIC`, whatever produced it.

Those four together are the answer to the question the checkpoint asks first:
`PARTIAL` alone does not protect certification semantics, so heuristic evidence
could not simply be projected and left to coverage.
"""

from __future__ import annotations

import pytest

from app.engine.evaluation.engine import DeterministicRuleEngine
from app.engine.rules.outcomes import EvidenceLevel, Outcome
from tests.engine.conftest import coverage, document_scope, fact_set, number_fact, rule


def heuristic_fact(prop: str, value: str, confidence: str | None = "0.95") -> dict:
    """A document-scoped number that says it was inferred rather than read."""
    fact = number_fact(document_scope(prop), value)
    provenance: dict[str, object] = {"sourceKind": "HEURISTIC"}
    if confidence is not None:
        provenance["confidence"] = confidence
    fact["provenance"] = provenance
    return fact


def exact_fact(prop: str, value: str) -> dict:
    fact = number_fact(document_scope(prop), value)
    fact["provenance"] = {"sourceKind": "OOXML"}
    return fact


# --- what coverage does and does not protect --------------------------------


def test_partial_coverage_demotes_a_pass_to_indeterminate(
    engine: DeterministicRuleEngine,
) -> None:
    """ "Everything we could read is correct" is not "everything is correct"."""
    facts = fact_set(
        [exact_fact("pageCount", "10")],
        [coverage("DOCUMENT", status="PARTIAL", prop="pageCount")],
    )
    only = engine.evaluate(
        facts, rule(document_scope("pageCount"), "EQUALS", {"type": "NUMBER", "number": "10"})
    )
    assert only.outcome is Outcome.INDETERMINATE
    assert only.reason_code.value == "NO_COMPLETE_EVIDENCE"


def test_partial_coverage_does_not_prevent_a_definitive_fail(
    engine: DeterministicRuleEngine,
) -> None:
    """The asymmetry Checkpoint 15 had to design around.

    Coverage says "we did not see everything". It does not say "what we did see
    might not be what we called it" — so a fact whose value is wrong fails the
    rule, and no coverage status intervenes. A heuristic count projected as an
    ordinary fact could therefore fail a compliant document outright.
    """
    facts = fact_set(
        [exact_fact("pageCount", "3")],
        [coverage("DOCUMENT", status="PARTIAL", prop="pageCount")],
    )
    only = engine.evaluate(
        facts, rule(document_scope("pageCount"), "EQUALS", {"type": "NUMBER", "number": "10"})
    )
    assert only.outcome is Outcome.FAIL
    assert only.evidence_level is EvidenceLevel.DETERMINISTIC


def test_unavailable_coverage_is_indeterminate_rather_than_a_pass(
    engine: DeterministicRuleEngine,
) -> None:
    facts = fact_set([], [coverage("DOCUMENT", status="UNAVAILABLE", prop="pageCount")])
    only = engine.evaluate(
        facts, rule(document_scope("pageCount"), "EQUALS", {"type": "NUMBER", "number": "10"})
    )
    assert only.outcome is Outcome.INDETERMINATE


# --- what provenance did, before this checkpoint ----------------------------


@pytest.mark.parametrize("expected", ["10", "3"])
def test_a_heuristic_fact_is_no_longer_allowed_to_decide(
    engine: DeterministicRuleEngine, expected: str
) -> None:
    """The behaviour this checkpoint changed, stated from both sides.

    Before Checkpoint 15 this rule returned PASS for `10` and FAIL for `3`,
    because `provenance` was never consulted: a value PalCert *inferred* voted
    exactly as one it *read*. Both directions are asserted, because the
    dangerous one is not only the false pass — a heuristic detector that missed
    something could produce a definitive failure on a compliant document.
    """
    facts = fact_set(
        [heuristic_fact("observedCitationCount", "10")],
        [coverage("DOCUMENT", status="PARTIAL", prop="observedCitationCount")],
    )
    only = engine.evaluate(
        facts,
        rule(
            document_scope("observedCitationCount"),
            "EQUALS",
            {"type": "NUMBER", "number": expected},
        ),
    )
    assert only.outcome is Outcome.INDETERMINATE
    assert only.outcome is not Outcome.PASS
    assert only.outcome is not Outcome.FAIL


def test_an_exact_fact_still_decides_exactly_as_it_always_did(
    engine: DeterministicRuleEngine,
) -> None:
    """The other half of the pin: nothing about exact evaluation moved."""
    facts = fact_set(
        [exact_fact("pageCount", "10")],
        [coverage("DOCUMENT", status="COMPLETE", prop="pageCount")],
    )
    only = engine.evaluate(
        facts, rule(document_scope("pageCount"), "EQUALS", {"type": "NUMBER", "number": "10"})
    )
    assert only.outcome is Outcome.PASS
    assert only.evidence_level is EvidenceLevel.DETERMINISTIC
