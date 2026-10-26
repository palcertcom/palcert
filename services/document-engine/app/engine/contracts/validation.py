"""Validation against the shared JSON Schema.

Python reads `contracts/schemas/evaluation.schema.json` — the same file the
TypeScript side generates its types from and validates with Ajv. Neither
language owns a private copy, so the two cannot drift silently. The
cross-language tests run identical fixtures through both and require them to
agree; a fixture accepted by one and rejected by the other fails CI.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry
from referencing.jsonschema import DRAFT202012

from app.engine.facts.model import element_types_for_fact_schema

_SCHEMA_RELATIVE = Path("contracts") / "schemas" / "evaluation.schema.json"


def _find_schema() -> Path:
    """Locate the shared schema by walking up to the repository root.

    Searched rather than hard-coded to a parent depth, so moving this module
    one package deeper does not silently break validation. Resolved from the
    repository rather than from an environment variable, because a misconfigured
    variable would disable validation in exactly the deployment where it
    matters most.
    """
    for directory in Path(__file__).resolve().parents:
        candidate = directory / _SCHEMA_RELATIVE
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        f"Could not find {_SCHEMA_RELATIVE} above {__file__}. The Python engine and the "
        f"TypeScript API must share one schema file; there is no fallback copy."
    )


class ContractName:
    """The definitions a caller may validate against."""

    DOCUMENT_FACT_SET = "DocumentFactSet"
    DOCUMENT_FACT = "DocumentFact"
    FACT_SCOPE = "FactScope"
    FACT_VALUE = "FactValue"
    LOCATION = "Location"
    COVERAGE_ENTRY = "CoverageEntry"
    VIOLATION = "Violation"
    RULE_EVALUATION_RESULT = "RuleEvaluationResult"
    EVALUATION_REQUEST = "EvaluationRequest"
    EVALUATION_RESPONSE = "EvaluationResponse"


@dataclass(frozen=True, slots=True)
class ContractIssue:
    path: str
    message: str


@dataclass(frozen=True, slots=True)
class ContractResult:
    valid: bool
    issues: tuple[ContractIssue, ...]


class ContractViolationError(ValueError):
    """Data crossing a service boundary did not satisfy its contract."""


@lru_cache(maxsize=1)
def load_schema() -> dict[str, Any]:
    """The evaluation schema, read from the single source of truth."""
    with _find_schema().open(encoding="utf-8") as handle:
        schema: dict[str, Any] = json.load(handle)
    return schema


@lru_cache(maxsize=32)
def _validator_for(contract: str) -> Draft202012Validator:
    schema = load_schema()
    if contract not in schema["$defs"]:
        raise KeyError(f"No such evaluation contract: {contract}")

    # The sub-schema is validated in the context of the whole document so that
    # internal "#/$defs/..." references still resolve.
    resource = DRAFT202012.create_resource(schema)
    registry = Registry().with_resource(uri=schema["$id"], resource=resource)
    return Draft202012Validator(
        {"$ref": f"{schema['$id']}#/$defs/{contract}"},
        registry=registry,
    )


def _vocabulary_issues(value: Any) -> tuple[ContractIssue, ...]:
    """Element types a fact set may use, by the version it declares.

    JSON Schema could express this only with conditionals that both runtimes
    would have to interpret identically, so it lives here instead. Rules stay
    unrestricted: a rule naming an element type the extractor never emits
    selects nothing, which is already a meaningful answer.
    """
    if not isinstance(value, dict):
        return ()
    version = value.get("factSchemaVersion")
    if not isinstance(version, int):
        return ()
    allowed = element_types_for_fact_schema(version)
    facts = value.get("facts")
    if not allowed or not isinstance(facts, list):
        return ()

    issues: list[ContractIssue] = []
    for index, fact in enumerate(facts):
        scope = fact.get("scope") if isinstance(fact, dict) else None
        element_type = scope.get("elementType") if isinstance(scope, dict) else None
        if not isinstance(element_type, str) or element_type in allowed:
            continue
        issues.append(
            ContractIssue(
                path=f"/facts/{index}/scope/elementType",
                message=(
                    f"element type {element_type} was introduced after "
                    f"fact schema version {version}"
                ),
            )
        )
    return tuple(issues)


def validate_contract(contract: str, value: Any) -> ContractResult:
    """Validate a value, collecting every problem rather than the first."""
    validator = _validator_for(contract)
    issues = tuple(
        ContractIssue(
            path="/" + "/".join(str(part) for part in error.absolute_path),
            message=error.message,
        )
        for error in sorted(validator.iter_errors(value), key=lambda err: list(err.absolute_path))
    )
    if contract == "DocumentFactSet":
        issues = issues + _vocabulary_issues(value)
    return ContractResult(valid=not issues, issues=issues)


def assert_contract(contract: str, value: Any) -> None:
    """Validate, or raise with every problem listed."""
    result = validate_contract(contract, value)
    if result.valid:
        return
    detail = "; ".join(f"{issue.path}: {issue.message}" for issue in result.issues)
    raise ContractViolationError(f"{contract} does not satisfy the evaluation contract — {detail}")
