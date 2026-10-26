"""Validation against the shared JSON Schema.

The TypeScript side runs the same fixtures through Ajv against the same file.
A payload accepted by one runtime and rejected by the other fails CI, which is
the property that makes one schema better than two hand-written models.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.engine.contracts.validation import (
    ContractName,
    ContractViolationError,
    assert_contract,
    load_schema,
    validate_contract,
)
from app.engine.facts.model import ElementType, ScopeKind
from app.engine.rules.operators import Operator
from app.engine.rules.outcomes import EvidenceLevel, Outcome, ReasonCode
from app.engine.units.registry import Unit


def _repo_root() -> Path:
    for directory in Path(__file__).resolve().parents:
        if (directory / "contracts" / "schemas").is_dir():
            return directory
    raise FileNotFoundError("Could not locate the contracts directory")


REJECTED_DIR = _repo_root() / "contracts" / "fixtures" / "invalid"


class TestSchemaLoading:
    def test_the_schema_is_draft_2020_12(self) -> None:
        assert load_schema()["$schema"] == "https://json-schema.org/draft/2020-12/schema"

    def test_the_schema_is_shared_not_copied(self) -> None:
        # There is exactly one file. If this ever finds a second copy inside the
        # Python package, the single-source-of-truth guarantee is gone.
        engine_root = Path(__file__).resolve().parents[2] / "app"
        assert not list(engine_root.rglob("evaluation.schema.json"))


class TestVocabularyParity:
    """The Python enums must match the schema exactly.

    The schema is the contract; a Python enum that has drifted from it would
    accept a fact the TypeScript side rejects, or silently drop one it sends.
    """

    def _enum(self, name: str) -> set[str]:
        return set(load_schema()["$defs"][name]["enum"])

    def test_units_match(self) -> None:
        assert {unit.value for unit in Unit} == self._enum("Unit")

    def test_scope_kinds_match(self) -> None:
        assert {kind.value for kind in ScopeKind} == self._enum("RuleScopeKind")

    def test_element_types_match(self) -> None:
        assert {element.value for element in ElementType} == self._enum("RuleElementType")

    def test_outcomes_match(self) -> None:
        assert {outcome.value for outcome in Outcome} == self._enum("EvaluationOutcome")

    def test_evidence_levels_match(self) -> None:
        assert {level.value for level in EvidenceLevel} == self._enum("EvidenceLevel")

    def test_reason_codes_match(self) -> None:
        assert {reason.value for reason in ReasonCode} == self._enum("ReasonCode")

    def test_the_operator_vocabulary_is_the_phase_three_one(self) -> None:
        # Fourteen operators, not a second near-miss vocabulary.
        assert len(list(Operator)) == 14


class TestAcceptance:
    def test_a_minimal_fact_set_is_valid(self) -> None:
        assert validate_contract(
            ContractName.DOCUMENT_FACT_SET,
            {
                "factSchemaVersion": 1,
                "documentId": "d",
                "extractor": {"name": "synthetic", "version": "1"},
                "coverage": [],
                "facts": [],
            },
        ).valid

    def test_a_location_without_a_page_is_valid(self) -> None:
        # Page is frequently unknown during structural extraction; requiring it
        # would force extractors to invent one.
        assert validate_contract(
            ContractName.LOCATION, {"locationSchemaVersion": 1, "nodeId": "p-1"}
        ).valid

    def test_provenance_without_confidence_is_valid(self) -> None:
        # Exact extraction has no probability to report, and inventing 1.0
        # would dress a certainty up as a measurement.
        assert validate_contract(
            ContractName.DOCUMENT_FACT,
            {
                "scope": {"kind": "DOCUMENT", "property": "pageCount"},
                "value": {"type": "NUMBER", "number": "120"},
                "provenance": {"sourceKind": "OOXML"},
            },
        ).valid


class TestRejection:
    @pytest.mark.parametrize(
        ("contract", "payload", "why"),
        [
            (
                ContractName.FACT_VALUE,
                {"type": "NUMBER", "number": 11},
                "a JSON number instead of a decimal string",
            ),
            (
                ContractName.FACT_VALUE,
                {"type": "NUMBER", "number": "1.2.3"},
                "a malformed decimal string",
            ),
            (
                ContractName.FACT_VALUE,
                {"type": "NUMBER"},
                "the discriminated field is missing",
            ),
            (
                ContractName.FACT_SCOPE,
                {"kind": "ELEMENT", "property": "fontSize"},
                "an ELEMENT scope without an element type",
            ),
            (
                ContractName.FACT_SCOPE,
                {"kind": "SECTION", "property": "wordCount"},
                "a SECTION scope without a section key",
            ),
            (
                ContractName.FACT_SCOPE,
                {"kind": "DOCUMENT", "property": "font size"},
                "a property that is not an identifier",
            ),
            (
                ContractName.LOCATION,
                {"locationSchemaVersion": 1, "nodeId": "p", "page": 0},
                "page zero, which is not a page",
            ),
            (
                ContractName.LOCATION,
                {"locationSchemaVersion": 1, "nodeId": "p", "unexpected": 1},
                "an unknown field, which must not be silently dropped",
            ),
            (
                ContractName.LOCATION,
                {"nodeId": "p"},
                "no schema version",
            ),
            (
                ContractName.COVERAGE_ENTRY,
                {"kind": "ELEMENT", "status": "MAYBE"},
                "a coverage status outside the vocabulary",
            ),
        ],
    )
    def test_invalid_payloads_are_rejected(
        self, contract: str, payload: dict[str, Any], why: str
    ) -> None:
        assert not validate_contract(contract, payload).valid, why

    def test_an_oversized_string_is_rejected(self) -> None:
        assert not validate_contract(
            ContractName.FACT_VALUE, {"type": "STRING", "text": "x" * 10_001}
        ).valid

    def test_an_oversized_list_is_rejected(self) -> None:
        assert not validate_contract(
            ContractName.FACT_VALUE, {"type": "STRING_LIST", "values": ["x"] * 1001}
        ).valid

    def test_every_problem_is_reported_not_only_the_first(self) -> None:
        result = validate_contract(
            ContractName.LOCATION, {"locationSchemaVersion": 1, "nodeId": "", "page": 0}
        )
        assert len(result.issues) >= 2

    def test_assert_contract_raises_with_detail(self) -> None:
        with pytest.raises(ContractViolationError) as caught:
            assert_contract(ContractName.FACT_VALUE, {"type": "NUMBER", "number": 11})
        assert "FactValue" in str(caught.value)


class TestSharedRejectionFixtures:
    """Payloads both runtimes must refuse.

    Committed so the TypeScript validator runs the identical list. A payload
    one language rejects and the other accepts is a contract that has already
    drifted.
    """

    def test_the_rejection_fixtures_exist(self) -> None:
        assert REJECTED_DIR.is_dir()
        assert list(REJECTED_DIR.glob("*.json"))

    def test_every_rejection_fixture_is_rejected(self) -> None:
        for path in sorted(REJECTED_DIR.glob("*.json")):
            fixture = json.loads(path.read_text(encoding="utf-8"))
            result = validate_contract(fixture["contract"], fixture["payload"])
            assert not result.valid, f"{path.name} was accepted but must be rejected"
