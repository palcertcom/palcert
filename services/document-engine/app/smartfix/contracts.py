"""Validation against the shared SmartFix JSON Schema.

Python reads `contracts/schemas/smartfix.schema.json` — the same file the
TypeScript side generates its types from and validates with Ajv. Neither
language owns a private copy, so a plan the API considers well-formed cannot
mean something else by the time it reaches the engine that will apply it to
somebody's thesis.

The fixture parity tests run identical payloads through both runtimes; one
accepted here and rejected there fails CI.
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

_SCHEMA_RELATIVE = Path("contracts") / "schemas" / "smartfix.schema.json"


def _find_schema() -> Path:
    """Locate the shared schema by walking up to the repository root.

    Searched rather than hard-coded to a parent depth, so moving this module
    one package deeper does not silently break validation, and resolved from
    the repository rather than an environment variable, because a
    misconfigured variable would disable validation in exactly the deployment
    where it matters most.
    """
    for directory in Path(__file__).resolve().parents:
        candidate = directory / _SCHEMA_RELATIVE
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        f"Could not find {_SCHEMA_RELATIVE} above {__file__}. The Python engine and the "
        f"TypeScript API must share one schema file; there is no fallback copy."
    )


class SmartFixContract:
    """The definitions a caller may validate against."""

    FIX_ACTION = "FixAction"
    FIX_VALUE = "FixValue"
    PLANNED_RULE = "PlannedRule"
    SMART_FIX_PLAN = "SmartFixPlan"
    CHANGE_MANIFEST_ENTRY = "ChangeManifestEntry"
    CHANGE_MANIFEST = "ChangeManifest"
    INTEGRITY_PROOFS = "IntegrityProofs"
    FIX_ENGINE_REQUEST = "FixEngineRequest"
    FIX_ENGINE_RESPONSE = "FixEngineResponse"


@dataclass(frozen=True, slots=True)
class ContractIssue:
    path: str
    message: str


@dataclass(frozen=True, slots=True)
class ContractResult:
    valid: bool
    issues: tuple[ContractIssue, ...]


class SmartFixContractError(ValueError):
    """Data crossing the SmartFix boundary did not satisfy its contract."""


@lru_cache(maxsize=1)
def load_schema() -> dict[str, Any]:
    """The SmartFix schema, read from the single source of truth."""
    with _find_schema().open(encoding="utf-8") as handle:
        schema: dict[str, Any] = json.load(handle)
    return schema


@lru_cache(maxsize=32)
def _validator_for(contract: str) -> Draft202012Validator:
    schema = load_schema()
    if contract not in schema["$defs"]:
        raise KeyError(f"No such SmartFix contract: {contract}")

    # The sub-schema is validated in the context of the whole document so that
    # internal "#/$defs/..." references still resolve.
    resource = DRAFT202012.create_resource(schema)
    registry = Registry().with_resource(uri=schema["$id"], resource=resource)
    return Draft202012Validator(
        {"$ref": f"{schema['$id']}#/$defs/{contract}"},
        registry=registry,
    )


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
    return ContractResult(valid=not issues, issues=issues)


def assert_contract(contract: str, value: Any) -> None:
    """Validate, or raise with every problem listed."""
    result = validate_contract(contract, value)
    if result.valid:
        return
    detail = "; ".join(f"{issue.path}: {issue.message}" for issue in result.issues)
    raise SmartFixContractError(f"{contract} does not satisfy the SmartFix contract — {detail}")
