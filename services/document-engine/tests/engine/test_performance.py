"""Performance characteristics of the rule engine.

These are not micro-benchmarks. Each asserts a *complexity* claim the engine's
design rests on, measured at a size the product actually has to handle: a
university formatting standard runs to a couple of hundred rules, and a
200-page thesis normalizes to on the order of ten thousand facts.

Wall-clock thresholds are deliberately loose — an order of magnitude above what
the engine takes on this machine — so the tests catch an algorithmic regression
(a nested scan reintroduced, an index bypassed) rather than the noise of a
loaded CI runner. A test that fails when a runner is busy teaches people to
ignore it.
"""

from __future__ import annotations

import time
from typing import Any

import pytest

from app.engine.evaluation.engine import DeterministicRuleEngine, RuleDefinition
from app.engine.evaluation.limits import EvaluationLimits
from app.engine.facts.model import DocumentFactSet
from tests.engine.conftest import coverage, element_scope, fact_set, number_fact, rule

#: The size the product must handle: 200 rules over a 200-page thesis.
RULE_COUNT = 200
FACT_COUNT = 10_000

#: Distinct properties, so rules address genuinely different fact buckets
#: rather than all hitting one.
PROPERTIES = [f"property{index:02d}" for index in range(20)]
ELEMENT_TYPES = ["PARAGRAPH", "HEADING", "TABLE", "FIGURE", "CAPTION"]


def _facts(count: int) -> DocumentFactSet:
    facts: list[dict[str, Any]] = []
    for index in range(count):
        element = ELEMENT_TYPES[index % len(ELEMENT_TYPES)]
        prop = PROPERTIES[index % len(PROPERTIES)]
        facts.append(
            number_fact(
                element_scope(element, prop),
                # A spread of values so both branches of every comparison are
                # taken; a fact set that all passes exercises only one path.
                str(10 + (index % 7)),
                "POINT",
                f"n-{index:05d}",
                1 + index // 50,
                index + 1,
            )
        )

    entries = [
        coverage("ELEMENT", element_type=element, prop=prop)
        for element in ELEMENT_TYPES
        for prop in PROPERTIES
    ]
    # The coverage vocabulary is bounded by the limits, and 100 entries is
    # inside it; the index is what has to scale, not the coverage list.
    return fact_set(facts, entries[:100])


def _rules(count: int) -> list[RuleDefinition]:
    return [
        rule(
            element_scope(ELEMENT_TYPES[index % len(ELEMENT_TYPES)], PROPERTIES[index % 20]),
            "GREATER_THAN_OR_EQUAL",
            {"type": "NUMBER", "number": 12},
            code=f"PERF.RULE.{index:03d}",
            unit="POINT",
        )
        for index in range(count)
    ]


def _elapsed(work: Any) -> float:
    started = time.perf_counter()
    work()
    return time.perf_counter() - started


@pytest.fixture(scope="module")
def large_fact_set() -> DocumentFactSet:
    return _facts(FACT_COUNT)


class TestFullEvaluationAtProductScale:
    def test_two_hundred_rules_over_ten_thousand_facts_completes(
        self, large_fact_set: DocumentFactSet
    ) -> None:
        engine = DeterministicRuleEngine(EvaluationLimits(max_facts=FACT_COUNT + 1))
        rules = _rules(RULE_COUNT)

        elapsed = _elapsed(lambda: engine.evaluate_all(large_fact_set, rules))

        # The naive O(R x F) form is two million scope comparisons plus two
        # million Fraction conversions; it does not finish in this budget.
        assert elapsed < 10.0, f"{RULE_COUNT} rules over {FACT_COUNT} facts took {elapsed:.2f}s"

    def test_every_rule_produces_a_result(self, large_fact_set: DocumentFactSet) -> None:
        # Speed that came from skipping rules would be worthless.
        engine = DeterministicRuleEngine(EvaluationLimits(max_facts=FACT_COUNT + 1))
        results = engine.evaluate_all(large_fact_set, _rules(RULE_COUNT))
        assert len(results) == RULE_COUNT

    def test_the_result_is_still_exact_at_scale(self, large_fact_set: DocumentFactSet) -> None:
        # Exact arithmetic is not traded away under load: the counts must add up
        # against the facts each rule actually addresses.
        engine = DeterministicRuleEngine(EvaluationLimits(max_facts=FACT_COUNT + 1))
        for result in engine.evaluate_all(large_fact_set, _rules(RULE_COUNT)):
            assert result.counts.evaluated_facts == (
                result.counts.passed_facts + result.counts.failed_facts
            )


class TestSelectionComplexity:
    """Selection must scale with the facts a rule addresses, not with all of them."""

    def test_adding_rules_costs_less_than_linearly_in_the_fact_set(
        self, large_fact_set: DocumentFactSet
    ) -> None:
        engine = DeterministicRuleEngine(EvaluationLimits(max_facts=FACT_COUNT + 1))
        few = _rules(20)
        many = _rules(200)

        one = _elapsed(lambda: engine.evaluate_all(large_fact_set, few))
        ten = _elapsed(lambda: engine.evaluate_all(large_fact_set, many))

        # Ten times the rules must not cost anywhere near ten times a full scan
        # of the fact set. The generous factor absorbs the index build, which is
        # paid once either way, and runner noise.
        assert ten < one * 25, f"20 rules: {one:.3f}s, 200 rules: {ten:.3f}s"

    def test_a_narrow_rule_does_not_pay_for_the_whole_document(
        self, large_fact_set: DocumentFactSet
    ) -> None:
        engine = DeterministicRuleEngine(EvaluationLimits(max_facts=FACT_COUNT + 1))
        # TABLE is every fifth fact and property02 every twentieth, and the two
        # cycles line up, so this bucket holds exactly one fact in twenty.
        narrow = rule(
            element_scope("TABLE", PROPERTIES[2]),
            "GREATER_THAN_OR_EQUAL",
            {"type": "NUMBER", "number": 12},
            unit="POINT",
        )

        result = engine.evaluate(large_fact_set, narrow)

        # It addresses one bucket out of a hundred, so it must have looked at
        # roughly a hundredth of the facts. An unindexed implementation would
        # report having evaluated all of them.
        assert result.counts.evaluated_facts < FACT_COUNT // 10
        assert result.counts.evaluated_facts > 0


class TestIndexConstruction:
    def test_the_index_is_built_once_per_evaluation_not_once_per_rule(
        self, large_fact_set: DocumentFactSet
    ) -> None:
        # If it were per-rule, 200 rules would cost 200 sorts of 10,000 facts,
        # and the batch would be dramatically slower than the sum of the work
        # each rule actually does.
        engine = DeterministicRuleEngine(EvaluationLimits(max_facts=FACT_COUNT + 1))
        rules = _rules(100)

        batched = _elapsed(lambda: engine.evaluate_all(large_fact_set, rules))
        separate = _elapsed(
            lambda: [engine.evaluate(large_fact_set, one_rule) for one_rule in rules]
        )

        assert batched < separate


class TestLimitsHoldUnderLoad:
    def test_a_fact_set_beyond_the_limit_is_refused_rather_than_attempted(self) -> None:
        # Bounded work is a safety property, not a performance one: an unbounded
        # fact set is how one document takes the service down for everyone.
        engine = DeterministicRuleEngine(EvaluationLimits(max_facts=100))
        oversized = _facts(101)

        with pytest.raises(Exception, match="fact"):
            engine.evaluate_all(oversized, _rules(1))

    def test_violations_are_truncated_rather_than_accumulated(
        self, large_fact_set: DocumentFactSet
    ) -> None:
        # A rule every fact fails must not build a ten-thousand-entry list in
        # memory and serialise it into a report.
        engine = DeterministicRuleEngine(EvaluationLimits(max_facts=FACT_COUNT + 1))
        impossible = rule(
            element_scope("PARAGRAPH", PROPERTIES[0]),
            "GREATER_THAN",
            {"type": "NUMBER", "number": 9999},
            unit="POINT",
        )

        result = engine.evaluate(large_fact_set, impossible)

        assert result.truncated
        assert len(result.violations) <= 100
        assert result.total_violation_count == result.counts.failed_facts
