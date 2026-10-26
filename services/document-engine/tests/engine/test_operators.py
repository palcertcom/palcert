"""Operator semantics, one operator at a time."""

from __future__ import annotations

from typing import ClassVar

import pytest

from app.engine.evaluation.engine import DeterministicRuleEngine
from app.engine.rules.operators import REGISTRY, ExpectedValueType, Operator, evaluator_for
from app.engine.rules.outcomes import Outcome, ReasonCode
from tests.engine.conftest import (
    coverage,
    document_scope,
    element_scope,
    fact_set,
    number_fact,
    rule,
    string_fact,
)

SIZE = element_scope("PARAGRAPH", "fontSize")
FAMILY = element_scope("PARAGRAPH", "fontFamily")
SIZE_COVERAGE = [coverage("ELEMENT", element_type="PARAGRAPH", prop="fontSize")]
FAMILY_COVERAGE = [coverage("ELEMENT", element_type="PARAGRAPH", prop="fontFamily")]


class TestRegistry:
    def test_every_phase_three_operator_has_an_evaluator(self) -> None:
        # "Never silently ignore an operator": the registry must be total over
        # the Phase 3 vocabulary.
        assert set(REGISTRY) == set(Operator)

    def test_an_unknown_operator_yields_no_evaluator_rather_than_raising(self) -> None:
        assert evaluator_for("TELEPATHY") is None

    def test_only_the_presence_operators_are_unary(self) -> None:
        unary = {op for op, entry in REGISTRY.items() if entry.unary}
        assert unary == {Operator.EXISTS, Operator.NOT_EXISTS}

    def test_every_evaluator_declares_at_least_one_accepted_value_type(self) -> None:
        for operator, entry in REGISTRY.items():
            assert entry.expected_types, operator

    def test_pattern_matching_accepts_only_a_named_pattern(self) -> None:
        # The design guarantee: there is no shape in which a caller-supplied
        # regular expression could arrive.
        assert REGISTRY[Operator.MATCHES_PATTERN].expected_types == {ExpectedValueType.PATTERN}


class TestNumericEquality:
    def test_equal_values_pass(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COVERAGE)
        result = engine.evaluate(
            facts, rule(SIZE, "EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT")
        )
        assert result.outcome is Outcome.PASS

    def test_unequal_values_fail_with_a_mismatch(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set([number_fact(SIZE, "11", "POINT")], SIZE_COVERAGE)
        result = engine.evaluate(
            facts, rule(SIZE, "EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT")
        )
        assert result.outcome is Outcome.FAIL
        assert result.reason_code is ReasonCode.VALUE_MISMATCH

    def test_trailing_zeros_do_not_change_equality(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set([number_fact(SIZE, "12.00", "POINT")], SIZE_COVERAGE)
        result = engine.evaluate(
            facts, rule(SIZE, "EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT")
        )
        assert result.outcome is Outcome.PASS

    def test_a_float_expected_value_is_exact(self, engine: DeterministicRuleEngine) -> None:
        # 0.1 + 0.2 != 0.3 in binary floating point. The rule stores 11.5 as a
        # JSON number; it must compare exactly against the decimal string 11.5.
        facts = fact_set([number_fact(SIZE, "11.5", "POINT")], SIZE_COVERAGE)
        result = engine.evaluate(
            facts, rule(SIZE, "EQUALS", {"type": "NUMBER", "number": 11.5}, unit="POINT")
        )
        assert result.outcome is Outcome.PASS

    def test_not_equals_inverts_a_pass(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COVERAGE)
        result = engine.evaluate(
            facts, rule(SIZE, "NOT_EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT")
        )
        assert result.outcome is Outcome.FAIL
        assert result.reason_code is ReasonCode.FORBIDDEN_VALUE_PRESENT

    def test_not_equals_does_not_invert_an_indeterminate(
        self, engine: DeterministicRuleEngine
    ) -> None:
        # Not knowing whether two values are equal is not knowing they differ.
        facts = fact_set([number_fact(SIZE, "300", "PIXEL")], SIZE_COVERAGE)
        result = engine.evaluate(
            facts, rule(SIZE, "NOT_EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT")
        )
        assert result.outcome is Outcome.INDETERMINATE


class TestNumericOrdering:
    @pytest.mark.parametrize(
        ("operator", "observed", "expected_outcome"),
        [
            ("GREATER_THAN", "13", Outcome.PASS),
            ("GREATER_THAN", "12", Outcome.FAIL),
            ("GREATER_THAN_OR_EQUAL", "12", Outcome.PASS),
            ("GREATER_THAN_OR_EQUAL", "11.999", Outcome.FAIL),
            ("LESS_THAN", "11", Outcome.PASS),
            ("LESS_THAN", "12", Outcome.FAIL),
            ("LESS_THAN_OR_EQUAL", "12", Outcome.PASS),
            ("LESS_THAN_OR_EQUAL", "12.001", Outcome.FAIL),
        ],
    )
    def test_boundaries(
        self,
        engine: DeterministicRuleEngine,
        operator: str,
        observed: str,
        expected_outcome: Outcome,
    ) -> None:
        facts = fact_set([number_fact(SIZE, observed, "POINT")], SIZE_COVERAGE)
        result = engine.evaluate(
            facts, rule(SIZE, operator, {"type": "NUMBER", "number": 12}, unit="POINT")
        )
        assert result.outcome is expected_outcome

    def test_a_shortfall_reports_below_minimum(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set([number_fact(SIZE, "10", "POINT")], SIZE_COVERAGE)
        result = engine.evaluate(
            facts,
            rule(SIZE, "GREATER_THAN_OR_EQUAL", {"type": "NUMBER", "number": 12}, unit="POINT"),
        )
        assert result.reason_code is ReasonCode.BELOW_MINIMUM

    def test_an_excess_reports_above_maximum(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set([number_fact(SIZE, "20", "POINT")], SIZE_COVERAGE)
        result = engine.evaluate(
            facts, rule(SIZE, "LESS_THAN_OR_EQUAL", {"type": "NUMBER", "number": 12}, unit="POINT")
        )
        assert result.reason_code is ReasonCode.ABOVE_MAXIMUM


class TestTolerance:
    MARGIN = document_scope("marginTop")
    MARGIN_COVERAGE: ClassVar = [coverage("DOCUMENT", prop="marginTop")]

    @pytest.mark.parametrize(
        ("observed", "expected_outcome"),
        [
            ("29", Outcome.PASS),  # exactly on the lower boundary
            ("31", Outcome.PASS),  # exactly on the upper boundary
            ("28.999", Outcome.FAIL),
            ("31.001", Outcome.FAIL),
            ("30", Outcome.PASS),
        ],
    )
    def test_boundaries_are_inclusive(
        self, engine: DeterministicRuleEngine, observed: str, expected_outcome: Outcome
    ) -> None:
        # abs(actual - expected) <= tolerance, so the boundary itself passes.
        facts = fact_set([number_fact(self.MARGIN, observed, "MILLIMETRE")], self.MARGIN_COVERAGE)
        result = engine.evaluate(
            facts,
            rule(
                self.MARGIN,
                "EQUALS",
                {"type": "NUMBER", "number": 30},
                unit="MILLIMETRE",
                tolerance=1,
            ),
        )
        assert result.outcome is expected_outcome

    def test_tolerance_applies_after_unit_conversion(self, engine: DeterministicRuleEngine) -> None:
        # 3.05 cm is 30.5 mm, which is inside 30 mm +/- 1 mm.
        facts = fact_set([number_fact(self.MARGIN, "3.05", "CENTIMETRE")], self.MARGIN_COVERAGE)
        result = engine.evaluate(
            facts,
            rule(
                self.MARGIN,
                "EQUALS",
                {"type": "NUMBER", "number": 30},
                unit="MILLIMETRE",
                tolerance=1,
            ),
        )
        assert result.outcome is Outcome.PASS

    def test_a_converted_boundary_is_still_exact(self, engine: DeterministicRuleEngine) -> None:
        # 3.1 cm is exactly 31 mm, exactly on the boundary.
        facts = fact_set([number_fact(self.MARGIN, "3.1", "CENTIMETRE")], self.MARGIN_COVERAGE)
        result = engine.evaluate(
            facts,
            rule(
                self.MARGIN,
                "EQUALS",
                {"type": "NUMBER", "number": 30},
                unit="MILLIMETRE",
                tolerance=1,
            ),
        )
        assert result.outcome is Outcome.PASS

    def test_failing_outside_tolerance_says_so(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set([number_fact(self.MARGIN, "3.2", "CENTIMETRE")], self.MARGIN_COVERAGE)
        result = engine.evaluate(
            facts,
            rule(
                self.MARGIN,
                "EQUALS",
                {"type": "NUMBER", "number": 30},
                unit="MILLIMETRE",
                tolerance=1,
            ),
        )
        assert result.reason_code is ReasonCode.OUTSIDE_TOLERANCE


class TestRange:
    WORDS: ClassVar = {"kind": "SECTION", "sectionKey": "ABSTRACT", "property": "wordCount"}
    WORD_COVERAGE: ClassVar = [coverage("SECTION", section_key="ABSTRACT", prop="wordCount")]

    @pytest.mark.parametrize(
        ("observed", "expected_outcome"),
        [
            ("150", Outcome.PASS),  # lower bound, inclusive
            ("300", Outcome.PASS),  # upper bound, inclusive
            ("225", Outcome.PASS),
            ("149", Outcome.FAIL),
            ("301", Outcome.FAIL),
        ],
    )
    def test_bounds_are_inclusive(
        self, engine: DeterministicRuleEngine, observed: str, expected_outcome: Outcome
    ) -> None:
        facts = fact_set([number_fact(self.WORDS, observed, "WORDS")], self.WORD_COVERAGE)
        result = engine.evaluate(
            facts,
            rule(
                self.WORDS,
                "BETWEEN",
                {"type": "NUMBER_RANGE", "min": 150, "max": 300},
                unit="WORDS",
            ),
        )
        assert result.outcome is expected_outcome

    def test_outside_the_range_says_so(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set([number_fact(self.WORDS, "500", "WORDS")], self.WORD_COVERAGE)
        result = engine.evaluate(
            facts,
            rule(
                self.WORDS,
                "BETWEEN",
                {"type": "NUMBER_RANGE", "min": 150, "max": 300},
                unit="WORDS",
            ),
        )
        assert result.reason_code is ReasonCode.OUTSIDE_RANGE


class TestMembership:
    def test_a_permitted_font_passes(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set([string_fact(FAMILY, "Amiri")], FAMILY_COVERAGE)
        result = engine.evaluate(
            facts,
            rule(FAMILY, "IN", {"type": "STRING_LIST", "values": ["Times New Roman", "Amiri"]}),
        )
        assert result.outcome is Outcome.PASS

    def test_font_membership_ignores_case_and_spacing(
        self, engine: DeterministicRuleEngine
    ) -> None:
        # A typeface named with a different capitalisation is the same
        # typeface; rejecting the document over it would be nonsense.
        facts = fact_set([string_fact(FAMILY, "  times   new roman ")], FAMILY_COVERAGE)
        result = engine.evaluate(
            facts, rule(FAMILY, "IN", {"type": "STRING_LIST", "values": ["Times New Roman"]})
        )
        assert result.outcome is Outcome.PASS

    def test_a_disallowed_font_fails(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set([string_fact(FAMILY, "Comic Sans MS")], FAMILY_COVERAGE)
        result = engine.evaluate(
            facts, rule(FAMILY, "IN", {"type": "STRING_LIST", "values": ["Times New Roman"]})
        )
        assert result.outcome is Outcome.FAIL
        assert result.reason_code is ReasonCode.NOT_IN_ALLOWED_SET

    def test_not_in_forbids(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set([string_fact(FAMILY, "Comic Sans MS")], FAMILY_COVERAGE)
        result = engine.evaluate(
            facts, rule(FAMILY, "NOT_IN", {"type": "STRING_LIST", "values": ["Comic Sans MS"]})
        )
        assert result.outcome is Outcome.FAIL
        assert result.reason_code is ReasonCode.IN_FORBIDDEN_SET

    def test_numeric_membership_converts_units(self, engine: DeterministicRuleEngine) -> None:
        # 1 inch is in the set {25.4 mm}.
        margin = document_scope("marginTop")
        facts = fact_set(
            [number_fact(margin, "1", "INCH")], [coverage("DOCUMENT", prop="marginTop")]
        )
        result = engine.evaluate(
            facts,
            rule(
                margin, "IN", {"type": "NUMBER_LIST", "values": [20, 25.4, 30]}, unit="MILLIMETRE"
            ),
        )
        assert result.outcome is Outcome.PASS


class TestContainment:
    TITLE: ClassVar = {"kind": "METADATA", "field": "title"}
    TITLE_COVERAGE: ClassVar = [coverage("METADATA", prop=None)]

    def test_contains_finds_a_substring(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set(
            [
                {
                    "scope": self.TITLE,
                    "value": {"type": "STRING", "text": "A Study of Water Rights"},
                    "location": {"locationSchemaVersion": 1, "nodeId": "meta-title"},
                }
            ],
            [coverage("METADATA")],
        )
        result = engine.evaluate(
            facts, rule(self.TITLE, "CONTAINS", {"type": "STRING", "text": "Water"})
        )
        assert result.outcome is Outcome.PASS

    def test_not_contains_rejects_a_present_substring(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set(
            [
                {
                    "scope": self.TITLE,
                    "value": {"type": "STRING", "text": "DRAFT - do not cite"},
                    "location": {"locationSchemaVersion": 1, "nodeId": "meta-title"},
                }
            ],
            [coverage("METADATA")],
        )
        result = engine.evaluate(
            facts, rule(self.TITLE, "NOT_CONTAINS", {"type": "STRING", "text": "DRAFT"})
        )
        assert result.outcome is Outcome.FAIL


class TestTypeCompatibility:
    def test_a_string_fact_against_a_numeric_rule_is_indeterminate(
        self, engine: DeterministicRuleEngine
    ) -> None:
        # Not FAIL: the document may be perfectly correct, the extractor simply
        # gave us something this comparison cannot use.
        facts = fact_set([string_fact(SIZE, "twelve")], SIZE_COVERAGE)
        result = engine.evaluate(
            facts, rule(SIZE, "EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT")
        )
        assert result.outcome is Outcome.INDETERMINATE
        assert result.reason_code is ReasonCode.VALUE_TYPE_INCOMPATIBLE

    def test_an_operator_that_rejects_the_expected_type_is_indeterminate(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COVERAGE)
        result = engine.evaluate(
            facts, rule(SIZE, "GREATER_THAN", {"type": "STRING", "text": "big"})
        )
        assert result.outcome is Outcome.INDETERMINATE
        assert result.reason_code is ReasonCode.VALUE_TYPE_INCOMPATIBLE

    def test_incompatible_units_never_produce_a_failure(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set([number_fact(SIZE, "300", "PIXEL")], SIZE_COVERAGE)
        result = engine.evaluate(
            facts, rule(SIZE, "EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT")
        )
        assert result.outcome is Outcome.INDETERMINATE
        assert result.reason_code is ReasonCode.UNIT_INCOMPATIBLE
        assert result.violations == ()
