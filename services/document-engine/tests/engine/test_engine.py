"""Engine semantics: coverage, multi-fact aggregation, outcomes, determinism.

These are the tests that encode the two properties the engine exists to
guarantee — never a false PASS, never a false FAIL — so they are written as
statements about evidence rather than about code paths.
"""

from __future__ import annotations

import json
import random
from typing import ClassVar

import pytest

from app.engine.evaluation.engine import (
    ENGINE_NAME,
    ENGINE_VERSION,
    DeterministicRuleEngine,
    RuleDefinition,
)
from app.engine.evaluation.limits import EvaluationLimits, ResourceLimitExceededError
from app.engine.rules.outcomes import EvidenceLevel, Outcome, ReasonCode
from tests.engine.conftest import (
    coverage,
    element_scope,
    fact_set,
    number_fact,
    rule,
    section_scope,
    string_fact,
)

SIZE = element_scope("PARAGRAPH", "fontSize")
SIZE_COMPLETE = [coverage("ELEMENT", element_type="PARAGRAPH", prop="fontSize")]
SIZE_PARTIAL = [coverage("ELEMENT", "PARTIAL", element_type="PARAGRAPH", prop="fontSize")]
SIZE_UNAVAILABLE = [coverage("ELEMENT", "UNAVAILABLE", element_type="PARAGRAPH", prop="fontSize")]

TWELVE_PT = {"type": "NUMBER", "number": 12}


def size_rule(**kwargs: object) -> RuleDefinition:
    return rule(SIZE, "EQUALS", TWELVE_PT, unit="POINT", **kwargs)  # type: ignore[arg-type]


class TestMultipleFacts:
    def test_every_matching_fact_is_evaluated(self, engine: DeterministicRuleEngine) -> None:
        # Not just the first. "Every body paragraph is 12 pt" is not answered
        # by looking at one paragraph.
        facts = fact_set(
            [number_fact(SIZE, "12", "POINT", f"p-{i}", 1, i) for i in range(1, 6)],
            SIZE_COMPLETE,
        )
        result = engine.evaluate(facts, size_rule())
        assert result.outcome is Outcome.PASS
        assert result.counts.matched_facts == 5
        assert result.counts.evaluated_facts == 5
        assert result.counts.passed_facts == 5

    def test_one_failure_among_many_fails_the_rule(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set(
            [number_fact(SIZE, "12", "POINT", f"p-{i}", 1, i) for i in range(1, 5)]
            + [number_fact(SIZE, "11", "POINT", "p-5", 2, 5)],
            SIZE_COMPLETE,
        )
        result = engine.evaluate(facts, size_rule())
        assert result.outcome is Outcome.FAIL
        assert result.counts.passed_facts == 4
        assert result.counts.failed_facts == 1

    def test_each_failure_gets_its_own_located_violation(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set(
            [
                number_fact(SIZE, "11", "POINT", "p-1", 1, 1),
                number_fact(SIZE, "12", "POINT", "p-2", 1, 2),
                number_fact(SIZE, "14", "POINT", "p-3", 2, 3),
            ],
            SIZE_COMPLETE,
        )
        result = engine.evaluate(facts, size_rule())
        assert [violation.location.node_id for violation in result.violations] == ["p-1", "p-3"]

    def test_a_failure_outranks_an_indeterminate(self, engine: DeterministicRuleEngine) -> None:
        # An unknown must never mask a known failure.
        facts = fact_set(
            [
                number_fact(SIZE, "11", "POINT", "p-1", 1, 1),
                number_fact(SIZE, "300", "PIXEL", "p-2", 1, 2),
            ],
            SIZE_COMPLETE,
        )
        result = engine.evaluate(facts, size_rule())
        assert result.outcome is Outcome.FAIL
        assert result.counts.failed_facts == 1
        assert result.counts.indeterminate_facts == 1

    def test_an_indeterminate_outranks_a_pass(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set(
            [
                number_fact(SIZE, "12", "POINT", "p-1", 1, 1),
                number_fact(SIZE, "300", "PIXEL", "p-2", 1, 2),
            ],
            SIZE_COMPLETE,
        )
        result = engine.evaluate(facts, size_rule())
        assert result.outcome is Outcome.INDETERMINATE

    def test_counts_add_up(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set(
            [
                number_fact(SIZE, "12", "POINT", "p-1", 1, 1),
                number_fact(SIZE, "11", "POINT", "p-2", 1, 2),
                number_fact(SIZE, "300", "PIXEL", "p-3", 1, 3),
            ],
            SIZE_COMPLETE,
        )
        counts = engine.evaluate(facts, size_rule()).counts
        assert counts.evaluated_facts == (
            counts.passed_facts + counts.failed_facts + counts.indeterminate_facts
        )


class TestCoverage:
    def test_complete_coverage_with_all_facts_passing_is_a_pass(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COMPLETE)
        assert engine.evaluate(facts, size_rule()).outcome is Outcome.PASS

    def test_partial_coverage_downgrades_an_otherwise_clean_pass(
        self, engine: DeterministicRuleEngine
    ) -> None:
        # "All 2 paragraphs we could read are correct" is not "all paragraphs
        # are correct".
        facts = fact_set(
            [number_fact(SIZE, "12", "POINT", "p-1"), number_fact(SIZE, "12", "POINT", "p-2")],
            SIZE_PARTIAL,
        )
        result = engine.evaluate(facts, size_rule())
        assert result.outcome is Outcome.INDETERMINATE
        assert result.reason_code is ReasonCode.NO_COMPLETE_EVIDENCE

    def test_partial_coverage_does_not_hide_a_real_failure(
        self, engine: DeterministicRuleEngine
    ) -> None:
        """A violation we did see is still a violation.

        **This behaviour is deliberate and must not be changed.** ``_aggregate``
        checks ``failed > 0`` before it looks at coverage, so PARTIAL demotes an
        otherwise-clean pass and does nothing whatever to a failure. That is
        right: a failure is the most specific thing the engine can say, and an
        unknown must never mask one.

        It is also the reason the Phase 18 projector exists. PARTIAL protects
        against a false PASS and not against a false FAIL, so evidence whose
        *value* might be wrong — a heuristic reference count, an inferred
        "no year present" — can never be projected as an ordinary fact and made
        safe by coverage. See ``test_partial_coverage_does_not_protect_a_wrong
        _value`` below, and the projection rules in
        docs/architecture/rule-engine.md.
        """
        facts = fact_set([number_fact(SIZE, "11", "POINT", "p-1")], SIZE_PARTIAL)
        assert engine.evaluate(facts, size_rule()).outcome is Outcome.FAIL

    def test_partial_coverage_does_not_protect_a_wrong_value(
        self, engine: DeterministicRuleEngine
    ) -> None:
        """The Phase 18 case, stated as a pin rather than discovered later.

        Here the extractor did not merely miss something — the value it emitted
        is wrong, which is what a heuristic extractor produces when it guesses.
        The rule fails on it, under PARTIAL coverage, with DETERMINISTIC
        evidence and a violation attached. Nothing in the engine can tell that
        the 11 was inferred rather than measured.

        So the boundary has to be upstream: a property whose value is not
        deterministically established is never projected into a fact set. This
        test exists so that a future attempt to "fix" the engine instead is
        recognised as the wrong repair.
        """
        facts = fact_set([number_fact(SIZE, "11", "POINT", "p-1")], SIZE_PARTIAL)
        result = engine.evaluate(facts, size_rule())
        assert result.outcome is Outcome.FAIL
        assert result.evidence_level is EvidenceLevel.DETERMINISTIC
        assert result.total_violation_count == 1
        assert result.reason_code is not ReasonCode.NO_COMPLETE_EVIDENCE

    def test_unavailable_coverage_is_indeterminate_even_with_facts(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_UNAVAILABLE)
        result = engine.evaluate(facts, size_rule())
        assert result.outcome is Outcome.INDETERMINATE
        assert result.reason_code is ReasonCode.NO_COMPLETE_EVIDENCE

    def test_no_coverage_entry_defaults_to_unavailable(
        self, engine: DeterministicRuleEngine
    ) -> None:
        # Fail closed. An extractor that said nothing about a domain has told
        # us nothing, and silence must never read as compliance.
        facts = fact_set([number_fact(SIZE, "12", "POINT")], [])
        assert engine.evaluate(facts, size_rule()).outcome is Outcome.INDETERMINATE

    def test_the_most_specific_coverage_entry_wins(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set(
            [number_fact(SIZE, "12", "POINT")],
            [
                coverage("ELEMENT", "UNAVAILABLE"),
                coverage("ELEMENT", "COMPLETE", element_type="PARAGRAPH", prop="fontSize"),
            ],
        )
        assert engine.evaluate(facts, size_rule()).outcome is Outcome.PASS


class TestNotApplicable:
    def test_no_facts_under_complete_coverage_is_not_applicable(
        self, engine: DeterministicRuleEngine
    ) -> None:
        # A caption rule over a document with no figures. Emphatically not PASS:
        # the document did not satisfy the rule, the rule had nothing to say.
        captions = element_scope("CAPTION", "textCase")
        facts = fact_set(
            [], [coverage("ELEMENT", "COMPLETE", element_type="CAPTION", prop="textCase")]
        )
        result = engine.evaluate(
            facts, rule(captions, "EQUALS", {"type": "STRING", "text": "SENTENCE"})
        )
        assert result.outcome is Outcome.NOT_APPLICABLE
        assert result.reason_code is ReasonCode.NO_MATCHING_FACTS

    def test_not_applicable_is_distinguishable_from_pass(
        self, engine: DeterministicRuleEngine
    ) -> None:
        captions = element_scope("CAPTION", "textCase")
        empty = fact_set(
            [], [coverage("ELEMENT", "COMPLETE", element_type="CAPTION", prop="textCase")]
        )
        satisfied = fact_set(
            [string_fact(captions, "SENTENCE", "cap-1")],
            [coverage("ELEMENT", "COMPLETE", element_type="CAPTION", prop="textCase")],
        )
        caption_rule = rule(captions, "EQUALS", {"type": "STRING", "text": "SENTENCE"})

        assert engine.evaluate(empty, caption_rule).outcome is Outcome.NOT_APPLICABLE
        assert engine.evaluate(satisfied, caption_rule).outcome is Outcome.PASS

    def test_no_facts_without_coverage_is_indeterminate_not_not_applicable(
        self, engine: DeterministicRuleEngine
    ) -> None:
        # We do not know whether there are figures.
        captions = element_scope("CAPTION", "textCase")
        facts = fact_set([], [])
        result = engine.evaluate(
            facts, rule(captions, "EQUALS", {"type": "STRING", "text": "SENTENCE"})
        )
        assert result.outcome is Outcome.INDETERMINATE


class TestPresence:
    ABSTRACT = section_scope("ABSTRACT", "wordCount")
    SECTION_COMPLETE: ClassVar = [coverage("SECTION", "COMPLETE", prop="wordCount")]

    def test_exists_passes_when_the_section_is_there(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set(
            [number_fact(self.ABSTRACT, "200", "WORDS", "sect-abstract")], self.SECTION_COMPLETE
        )
        result = engine.evaluate(facts, rule(self.ABSTRACT, "EXISTS", {"type": "NONE"}))
        assert result.outcome is Outcome.PASS

    def test_exists_fails_when_complete_coverage_shows_it_absent(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set([], self.SECTION_COMPLETE)
        result = engine.evaluate(facts, rule(self.ABSTRACT, "EXISTS", {"type": "NONE"}))
        assert result.outcome is Outcome.FAIL
        assert result.reason_code is ReasonCode.REQUIRED_VALUE_MISSING

    def test_exists_is_indeterminate_without_complete_coverage(
        self, engine: DeterministicRuleEngine
    ) -> None:
        # An absence proves nothing if nobody looked.
        facts = fact_set([], [coverage("SECTION", "PARTIAL", prop="wordCount")])
        result = engine.evaluate(facts, rule(self.ABSTRACT, "EXISTS", {"type": "NONE"}))
        assert result.outcome is Outcome.INDETERMINATE
        assert result.reason_code is ReasonCode.NO_COMPLETE_EVIDENCE

    def test_not_exists_passes_when_complete_coverage_shows_it_absent(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set([], self.SECTION_COMPLETE)
        result = engine.evaluate(facts, rule(self.ABSTRACT, "NOT_EXISTS", {"type": "NONE"}))
        assert result.outcome is Outcome.PASS

    def test_not_exists_fails_when_it_is_present(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set(
            [number_fact(self.ABSTRACT, "200", "WORDS", "sect-abstract")], self.SECTION_COMPLETE
        )
        result = engine.evaluate(facts, rule(self.ABSTRACT, "NOT_EXISTS", {"type": "NONE"}))
        assert result.outcome is Outcome.FAIL
        assert result.reason_code is ReasonCode.FORBIDDEN_VALUE_PRESENT

    def test_not_exists_is_indeterminate_without_complete_coverage(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set([], [])
        result = engine.evaluate(facts, rule(self.ABSTRACT, "NOT_EXISTS", {"type": "NONE"}))
        assert result.outcome is Outcome.INDETERMINATE


class TestNonDeterministicRules:
    def test_an_ai_rule_is_never_evaluated_automatically(
        self, engine: DeterministicRuleEngine
    ) -> None:
        # The single most important guarantee of the review model: Phase 4 must
        # not fabricate a verdict for a rule only a model could judge.
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COMPLETE)
        result = engine.evaluate(facts, size_rule(evaluation_mode="AI_ASSISTED"))

        assert result.outcome is Outcome.INDETERMINATE
        assert result.reason_code is ReasonCode.AI_REVIEW_REQUIRED
        assert result.requires_review is True
        assert result.evidence_level is EvidenceLevel.NONE

    def test_a_manual_rule_is_never_evaluated_automatically(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COMPLETE)
        result = engine.evaluate(facts, size_rule(evaluation_mode="MANUAL"))

        assert result.outcome is Outcome.INDETERMINATE
        assert result.reason_code is ReasonCode.MANUAL_REVIEW_REQUIRED
        assert result.requires_review is True

    def test_a_blocking_ai_rule_carries_everything_phase_seven_needs(
        self, engine: DeterministicRuleEngine
    ) -> None:
        # Rule schema v2 makes this representable. The result must preserve
        # blocking and severity so compliance aggregation can refuse to
        # finalise while it is unresolved.
        facts = fact_set([], [coverage("SECTION")])
        ethics = section_scope("ETHICS", "statementText")
        result = engine.evaluate(
            facts,
            rule(
                ethics,
                "EXISTS",
                {"type": "NONE"},
                evaluation_mode="AI_ASSISTED",
                blocking=True,
                severity="CRITICAL",
            ),
        )
        assert result.blocking is True
        assert result.severity.value == "CRITICAL"
        assert result.requires_review is True
        assert result.outcome is Outcome.INDETERMINATE

    def test_a_deterministic_rule_never_requires_review(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COMPLETE)
        result = engine.evaluate(facts, size_rule())
        assert result.requires_review is False
        assert result.evidence_level is EvidenceLevel.DETERMINISTIC


class TestUnsupportedSchemas:
    def test_an_unsupported_rule_schema_is_refused_explicitly(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COMPLETE)
        result = engine.evaluate(facts, size_rule(rule_schema_version=99))
        assert result.outcome is Outcome.INDETERMINATE
        assert result.reason_code is ReasonCode.RULE_SCHEMA_UNSUPPORTED

    def test_an_unsupported_fact_schema_is_refused_explicitly(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COMPLETE, fact_schema_version=99)
        result = engine.evaluate(facts, size_rule())
        assert result.outcome is Outcome.INDETERMINATE
        assert result.reason_code is ReasonCode.FACT_SCHEMA_UNSUPPORTED

    def test_both_v1_and_v2_rules_evaluate(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COMPLETE)
        for version in (1, 2):
            result = engine.evaluate(facts, size_rule(rule_schema_version=version))
            assert result.outcome is Outcome.PASS, version

    def test_an_unsupported_operator_is_indeterminate_never_a_failure(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COMPLETE)
        unknown = RuleDefinition.from_json(
            {
                "ruleCode": "T",
                "scope": SIZE,
                "operator": "TELEPATHY",
                "expected": {"type": "NUMBER", "number": 12},
                "evaluationMode": "DETERMINISTIC",
                "severity": "MAJOR",
                "blocking": False,
                "ruleSchemaVersion": 2,
            }
        )
        result = engine.evaluate(facts, unknown)
        assert result.outcome is Outcome.INDETERMINATE
        assert result.reason_code is ReasonCode.EVALUATOR_NOT_SUPPORTED


class TestScopeSelection:
    def test_a_rule_without_a_level_matches_every_heading(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set(
            [
                number_fact(element_scope("HEADING", "fontSize", 1), "16", "POINT", "h-1", 1, 1),
                number_fact(element_scope("HEADING", "fontSize", 2), "14", "POINT", "h-2", 1, 2),
            ],
            [coverage("ELEMENT", element_type="HEADING", prop="fontSize")],
        )
        result = engine.evaluate(
            facts,
            rule(
                element_scope("HEADING", "fontSize"),
                "GREATER_THAN_OR_EQUAL",
                {"type": "NUMBER", "number": 12},
                unit="POINT",
            ),
        )
        assert result.counts.matched_facts == 2

    def test_a_rule_naming_a_level_matches_only_that_level(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set(
            [
                number_fact(element_scope("HEADING", "fontSize", 1), "16", "POINT", "h-1", 1, 1),
                number_fact(element_scope("HEADING", "fontSize", 2), "14", "POINT", "h-2", 1, 2),
            ],
            [coverage("ELEMENT", element_type="HEADING", prop="fontSize")],
        )
        result = engine.evaluate(
            facts,
            rule(
                element_scope("HEADING", "fontSize", 1),
                "EQUALS",
                {"type": "NUMBER", "number": 16},
                unit="POINT",
            ),
        )
        assert result.counts.matched_facts == 1
        assert result.outcome is Outcome.PASS

    def test_a_different_property_is_not_matched(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set(
            [number_fact(element_scope("PARAGRAPH", "lineSpacing"), "1.5", "LINES")],
            SIZE_COMPLETE,
        )
        result = engine.evaluate(facts, size_rule())
        # No fontSize facts at all; coverage for fontSize is COMPLETE, so this
        # is NOT_APPLICABLE rather than a comparison against a spacing value.
        assert result.counts.matched_facts == 0

    def test_a_different_element_type_is_not_matched(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set(
            [number_fact(element_scope("HEADING", "fontSize"), "16", "POINT")], SIZE_COMPLETE
        )
        assert engine.evaluate(facts, size_rule()).counts.matched_facts == 0


class TestDeterminism:
    def _shuffled_sets(self, count: int = 12) -> list[list[dict[str, object]]]:
        facts = [
            number_fact(
                SIZE, "12" if index % 3 else "11", "POINT", f"p-{index:03d}", 1 + index // 5, index
            )
            for index in range(1, count + 1)
        ]
        variants = []
        generator = random.Random(20260913)  # noqa: S311 - seeded shuffle, not security
        for _ in range(5):
            shuffled = facts[:]
            generator.shuffle(shuffled)
            variants.append(shuffled)
        return variants

    def test_fact_order_does_not_change_the_result(self, engine: DeterministicRuleEngine) -> None:
        serialized = {
            json.dumps(engine.evaluate(fact_set(variant, SIZE_COMPLETE), size_rule()).to_json())
            for variant in self._shuffled_sets()
        }
        assert len(serialized) == 1

    def test_repeated_evaluation_is_byte_identical(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set(self._shuffled_sets()[0], SIZE_COMPLETE)
        outputs = {json.dumps(engine.evaluate(facts, size_rule()).to_json()) for _ in range(5)}
        assert len(outputs) == 1

    def test_violations_are_ordered_by_location(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set(
            [
                number_fact(SIZE, "11", "POINT", "p-c", 3, 3),
                number_fact(SIZE, "11", "POINT", "p-a", 1, 1),
                number_fact(SIZE, "11", "POINT", "p-b", 2, 2),
            ],
            SIZE_COMPLETE,
        )
        result = engine.evaluate(facts, size_rule())
        pages = [entry["location"]["page"] for entry in result.to_json()["violations"]]
        assert pages == [1, 2, 3]

    def test_a_violation_without_a_page_sorts_after_those_with_one(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set(
            [
                {
                    "scope": SIZE,
                    "value": {"type": "NUMBER", "number": "11"},
                    "unit": "POINT",
                    "location": {"locationSchemaVersion": 1, "nodeId": "p-unknown"},
                },
                number_fact(SIZE, "11", "POINT", "p-known", 5, 1),
            ],
            SIZE_COMPLETE,
        )
        result = engine.evaluate(facts, size_rule())
        nodes = [entry["location"]["nodeId"] for entry in result.to_json()["violations"]]
        assert nodes == ["p-known", "p-unknown"]

    def test_the_engine_version_is_recorded(self, engine: DeterministicRuleEngine) -> None:
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COMPLETE)
        engine_info = engine.evaluate(facts, size_rule()).engine
        assert engine_info.engine_name == ENGINE_NAME
        assert engine_info.engine_version == ENGINE_VERSION
        assert engine_info.rule_schema_version == 2
        assert engine_info.fact_schema_version == 1


class TestResourceLimits:
    def test_violations_truncate_while_counts_stay_exact(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set(
            [number_fact(SIZE, "11", "POINT", f"p-{i:04d}", 1, i) for i in range(300)],
            SIZE_COMPLETE,
        )
        result = engine.evaluate(facts, size_rule())

        assert result.total_violation_count == 300
        assert len(result.violations) == 100
        assert result.truncated is True
        assert result.counts.failed_facts == 300

    def test_the_per_rule_cap_is_configurable(self) -> None:
        engine = DeterministicRuleEngine(EvaluationLimits(max_returned_violations_per_rule=5))
        facts = fact_set(
            [number_fact(SIZE, "11", "POINT", f"p-{i:04d}", 1, i) for i in range(20)],
            SIZE_COMPLETE,
        )
        result = engine.evaluate(facts, size_rule())
        assert len(result.violations) == 5
        assert result.total_violation_count == 20

    def test_too_many_facts_is_a_typed_error(self) -> None:
        # Refused, not silently truncated: evaluating the first thousand of a
        # million facts would produce a verdict about a document nobody sent.
        engine = DeterministicRuleEngine(EvaluationLimits(max_facts=3))
        facts = fact_set(
            [number_fact(SIZE, "12", "POINT", f"p-{i}") for i in range(4)], SIZE_COMPLETE
        )
        with pytest.raises(ResourceLimitExceededError) as caught:
            engine.evaluate(facts, size_rule())
        assert caught.value.limit == 3
        assert caught.value.actual == 4

    def test_too_many_rules_is_a_typed_error(self) -> None:
        engine = DeterministicRuleEngine(EvaluationLimits(max_rules=2))
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COMPLETE)
        with pytest.raises(ResourceLimitExceededError):
            engine.evaluate_all(facts, [size_rule()] * 3)

    def test_the_whole_response_violation_budget_is_enforced(self) -> None:
        engine = DeterministicRuleEngine(
            EvaluationLimits(max_returned_violations_per_rule=10, max_returned_violations_total=15)
        )
        facts = fact_set(
            [number_fact(SIZE, "11", "POINT", f"p-{i:04d}", 1, i) for i in range(30)],
            SIZE_COMPLETE,
        )
        results = engine.evaluate_all(facts, [size_rule(code="A"), size_rule(code="B")])

        returned = sum(len(result.violations) for result in results)
        assert returned <= 15
        # Counts are untouched by the budget.
        assert all(result.total_violation_count == 30 for result in results)
        assert results[1].truncated is True


class TestEvaluateAll:
    def test_rule_order_is_preserved(self, engine: DeterministicRuleEngine) -> None:
        # The standard's author chose the order; the report reads in it.
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COMPLETE)
        codes = ["C.THREE", "A.ONE", "B.TWO"]
        results = engine.evaluate_all(facts, [size_rule(code=code) for code in codes])
        assert [result.rule_code for result in results] == codes

    def test_one_indeterminate_rule_does_not_disturb_the_others(
        self, engine: DeterministicRuleEngine
    ) -> None:
        facts = fact_set([number_fact(SIZE, "12", "POINT")], SIZE_COMPLETE)
        results = engine.evaluate_all(
            facts,
            [
                size_rule(code="OK"),
                size_rule(code="AI", evaluation_mode="AI_ASSISTED"),
                size_rule(code="ALSO.OK"),
            ],
        )
        assert [result.outcome for result in results] == [
            Outcome.PASS,
            Outcome.INDETERMINATE,
            Outcome.PASS,
        ]
