"""Golden evaluation fixtures.

Each fixture in ``contracts/fixtures/evaluation/`` carries a rule, a fact set
and the exact result the engine must produce. They are committed, not
regenerated: a behaviour change shows up as a failing assertion here rather
than as a quietly updated file.

The same fixtures are validated by the TypeScript side, so a shape one runtime
accepts and the other rejects fails CI.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.engine.contracts.validation import ContractName, validate_contract
from app.engine.evaluation.engine import DeterministicRuleEngine, RuleDefinition
from app.engine.facts.model import DocumentFactSet


def _fixture_dir() -> Path:
    for directory in Path(__file__).resolve().parents:
        candidate = directory / "contracts" / "fixtures" / "evaluation"
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError("Could not locate contracts/fixtures/evaluation")


FIXTURE_DIR = _fixture_dir()
FIXTURE_PATHS = sorted(FIXTURE_DIR.glob("*.json"))


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("path", FIXTURE_PATHS, ids=lambda path: path.stem)
class TestGoldenFixtures:
    def test_the_fact_set_satisfies_the_shared_contract(self, path: Path) -> None:
        fixture = _load(path)
        result = validate_contract(ContractName.DOCUMENT_FACT_SET, fixture["factSet"])
        assert result.valid, result.issues

    def test_the_expected_result_satisfies_the_shared_contract(self, path: Path) -> None:
        fixture = _load(path)
        result = validate_contract(ContractName.RULE_EVALUATION_RESULT, fixture["expectedResult"])
        assert result.valid, result.issues

    def test_the_engine_reproduces_the_committed_result(self, path: Path) -> None:
        fixture = _load(path)
        engine = DeterministicRuleEngine()
        produced = engine.evaluate(
            DocumentFactSet.from_json(fixture["factSet"]),
            RuleDefinition.from_json(fixture["rule"]),
        ).to_json()

        assert produced == fixture["expectedResult"]

    def test_the_result_is_reproducible_within_a_run(self, path: Path) -> None:
        fixture = _load(path)
        engine = DeterministicRuleEngine()
        fact_set = DocumentFactSet.from_json(fixture["factSet"])
        rule = RuleDefinition.from_json(fixture["rule"])

        outputs = {json.dumps(engine.evaluate(fact_set, rule).to_json()) for _ in range(3)}
        assert len(outputs) == 1

    def test_the_fixture_explains_itself(self, path: Path) -> None:
        # A golden nobody can interpret is a golden nobody will correctly
        # update when the behaviour genuinely changes.
        fixture = _load(path)
        assert len(fixture.get("description", "")) > 20


class TestFixtureCoverage:
    """The fixture set must actually exercise the interesting cases."""

    def test_there_are_fixtures_at_all(self) -> None:
        assert len(FIXTURE_PATHS) >= 15

    def test_every_outcome_is_represented(self) -> None:
        outcomes = {_load(path)["expectedResult"]["outcome"] for path in FIXTURE_PATHS}
        assert {"PASS", "FAIL", "NOT_APPLICABLE", "INDETERMINATE"} <= outcomes

    def test_the_review_required_cases_are_represented(self) -> None:
        reviewed = [
            _load(path) for path in FIXTURE_PATHS if _load(path)["expectedResult"]["requiresReview"]
        ]
        reasons = {fixture["expectedResult"]["reasonCode"] for fixture in reviewed}
        assert reasons == {"AI_REVIEW_REQUIRED", "MANUAL_REVIEW_REQUIRED"}

    def test_a_blocking_non_deterministic_rule_is_covered(self) -> None:
        # The Phase 3 amendment in action: representable, and unresolved.
        blocking_review = [
            _load(path)["expectedResult"]
            for path in FIXTURE_PATHS
            if _load(path)["expectedResult"]["requiresReview"]
            and _load(path)["expectedResult"]["blocking"]
        ]
        assert blocking_review
        assert all(result["outcome"] == "INDETERMINATE" for result in blocking_review)

    def test_truncation_is_covered_with_an_exact_count(self) -> None:
        truncated = [
            _load(path)["expectedResult"]
            for path in FIXTURE_PATHS
            if _load(path)["expectedResult"]["truncated"]
        ]
        assert truncated
        for result in truncated:
            assert result["totalViolationCount"] > len(result["violations"])

    def test_a_v1_rule_is_covered(self) -> None:
        versions = {_load(path)["rule"].get("ruleSchemaVersion", 1) for path in FIXTURE_PATHS}
        assert 1 in versions
        assert 2 in versions

    def test_no_fixture_carries_natural_language_prose_as_evidence(self) -> None:
        # Violations are machine-readable evidence. Prose belongs to the later
        # report layer, which must not have to re-parse a sentence.
        for path in FIXTURE_PATHS:
            for violation in _load(path)["expectedResult"]["violations"]:
                assert set(violation) <= {
                    "reasonCode",
                    "location",
                    "expected",
                    "actual",
                    "tolerance",
                }
