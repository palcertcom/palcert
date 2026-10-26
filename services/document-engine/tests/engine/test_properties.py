"""Property-based tests.

Used only where a property is genuinely worth proving over a range of inputs
rather than at a handful of points — unit conversion, comparison symmetry,
ordering, and the invariance of a result to fact order. Property testing as
decoration produces slow tests that assert nothing; each of these encodes a
claim the engine actually makes.
"""

from __future__ import annotations

import json
from decimal import Decimal
from fractions import Fraction
from typing import ClassVar

from hypothesis import assume, given, settings
from hypothesis import strategies as st

from app.engine.evaluation.engine import DeterministicRuleEngine
from app.engine.rules.outcomes import Outcome
from app.engine.rules.text import TextComparison, normalize
from app.engine.units.registry import Unit, convert, format_exact, to_fraction
from tests.engine.conftest import coverage, element_scope, fact_set, number_fact, rule

LENGTHS = [Unit.MILLIMETRE, Unit.CENTIMETRE, Unit.INCH, Unit.POINT]

#: Values with a real decimal expansion, bounded so a failure prints legibly.
measurements = st.decimals(
    min_value=Decimal("0.001"),
    max_value=Decimal("10000"),
    places=3,
    allow_nan=False,
    allow_infinity=False,
)


class TestUnitConversion:
    @given(value=measurements, source=st.sampled_from(LENGTHS), target=st.sampled_from(LENGTHS))
    def test_conversion_round_trips_exactly(
        self, value: Decimal, source: Unit, target: Unit
    ) -> None:
        # The claim that justifies Fraction over Decimal throughout.
        original = to_fraction(value)
        assert convert(convert(original, source, target), target, source) == original

    @given(
        value=measurements,
        first=st.sampled_from(LENGTHS),
        second=st.sampled_from(LENGTHS),
        third=st.sampled_from(LENGTHS),
    )
    def test_conversion_is_transitive(
        self, value: Decimal, first: Unit, second: Unit, third: Unit
    ) -> None:
        original = to_fraction(value)
        direct = convert(original, first, third)
        stepwise = convert(convert(original, first, second), second, third)
        assert direct == stepwise

    @given(value=measurements, source=st.sampled_from(LENGTHS), target=st.sampled_from(LENGTHS))
    def test_conversion_preserves_ordering(
        self, value: Decimal, source: Unit, target: Unit
    ) -> None:
        # A larger measurement stays larger after conversion, or every
        # comparison operator would be unsound.
        smaller = to_fraction(value)
        larger = smaller + Fraction(1)
        assert convert(smaller, source, target) < convert(larger, source, target)

    @given(value=measurements)
    def test_equivalent_physical_lengths_are_equal(self, value: Decimal) -> None:
        millimetres = to_fraction(value)
        via_inch = convert(
            convert(millimetres, Unit.MILLIMETRE, Unit.INCH), Unit.INCH, Unit.MILLIMETRE
        )
        via_point = convert(
            convert(millimetres, Unit.MILLIMETRE, Unit.POINT), Unit.POINT, Unit.MILLIMETRE
        )
        assert via_inch == via_point == millimetres

    @given(value=measurements, unit=st.sampled_from(LENGTHS))
    def test_formatting_never_produces_exponent_notation(self, value: Decimal, unit: Unit) -> None:
        # Evidence text goes into reports a person reads; "3.5E+1 mm" is not
        # something a thesis supervisor should have to decode.
        rendered = format_exact(convert(to_fraction(value), Unit.MILLIMETRE, unit))
        assert "E" not in rendered.upper()


class TestComparisonSymmetry:
    @given(left=measurements, right=measurements)
    def test_equality_is_symmetric_across_units(self, left: Decimal, right: Decimal) -> None:
        as_mm = to_fraction(left)
        as_cm = convert(to_fraction(right), Unit.MILLIMETRE, Unit.CENTIMETRE)
        forward = as_mm == convert(as_cm, Unit.CENTIMETRE, Unit.MILLIMETRE)
        backward = convert(as_mm, Unit.MILLIMETRE, Unit.CENTIMETRE) == as_cm
        assert forward == backward

    @given(value=measurements, tolerance=st.decimals(min_value=0, max_value=100, places=3))
    def test_tolerance_is_symmetric(self, value: Decimal, tolerance: Decimal) -> None:
        # abs(actual - expected) <= tolerance must behave the same whichever
        # side of the target the observation falls.
        target = to_fraction("50")
        slack = to_fraction(tolerance)
        below = target - to_fraction(value)
        above = target + to_fraction(value)
        assert (abs(below - target) <= slack) == (abs(above - target) <= slack)


class TestFactOrderInvariance:
    SIZE = element_scope("PARAGRAPH", "fontSize")
    COVER: ClassVar = [coverage("ELEMENT", element_type="PARAGRAPH", prop="fontSize")]

    @given(
        sizes=st.lists(st.sampled_from(["10", "11", "12", "12.5", "14"]), min_size=1, max_size=25),
        permutation_seed=st.integers(min_value=0, max_value=10_000),
    )
    @settings(max_examples=50, deadline=None)
    def test_the_result_does_not_depend_on_input_order(
        self, sizes: list[str], permutation_seed: int
    ) -> None:
        import random

        facts = [
            number_fact(self.SIZE, size, "POINT", f"p-{index:03d}", 1 + index // 5, index + 1)
            for index, size in enumerate(sizes)
        ]
        shuffled = facts[:]
        random.Random(permutation_seed).shuffle(shuffled)  # noqa: S311 - seeded shuffle, not security

        engine = DeterministicRuleEngine()
        target = rule(self.SIZE, "EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT")

        ordered_result = engine.evaluate(fact_set(facts, self.COVER), target).to_json()
        shuffled_result = engine.evaluate(fact_set(shuffled, self.COVER), target).to_json()

        assert json.dumps(ordered_result) == json.dumps(shuffled_result)

    @given(sizes=st.lists(st.sampled_from(["11", "12"]), min_size=1, max_size=20))
    @settings(max_examples=50, deadline=None)
    def test_the_outcome_follows_from_the_facts(self, sizes: list[str]) -> None:
        facts = [
            number_fact(self.SIZE, size, "POINT", f"p-{index:03d}", 1, index + 1)
            for index, size in enumerate(sizes)
        ]
        result = DeterministicRuleEngine().evaluate(
            fact_set(facts, self.COVER),
            rule(self.SIZE, "EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT"),
        )

        wrong = sum(1 for size in sizes if size != "12")
        assert result.counts.failed_facts == wrong
        assert result.total_violation_count == wrong
        assert result.outcome is (Outcome.FAIL if wrong else Outcome.PASS)


class TestTextNormalizationProperties:
    @given(text=st.text(max_size=200), mode=st.sampled_from(list(TextComparison)))
    def test_normalization_is_idempotent(self, text: str, mode: TextComparison) -> None:
        once = normalize(text, mode)
        assert normalize(once, mode) == once

    @given(text=st.text(max_size=200))
    def test_the_looser_mode_never_distinguishes_more_than_the_stricter(self, text: str) -> None:
        # If EXACT considers two strings equal, NORMALIZED must too. A looser
        # comparison that rejected something a stricter one accepted would be
        # incoherent.
        assume(text.strip() != "")
        upper = text.upper()
        if normalize(text, TextComparison.EXACT) == normalize(upper, TextComparison.EXACT):
            assert normalize(text, TextComparison.NORMALIZED) == normalize(
                upper, TextComparison.NORMALIZED
            )
