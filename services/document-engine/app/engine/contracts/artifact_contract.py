"""Validating the analysis artifact against the shared schema (§33, Phase 13 §13).

Phase 6 defined this envelope only in Python, so Node had no choice but to
trust whatever dictionaries arrived. The schema now lives in
``contracts/schemas/analysis-artifact.schema.json`` and both runtimes validate
the same fixtures against it, which turns "the two should agree" into
something CI can prove.

The analyzer validates its own output before an artifact is ever stored: an
artifact that fails the contract is a failed analysis, not a stored record of
one.

It lives under ``app/engine`` rather than under one format because the envelope
is the same envelope for every format. Phase 13 added a PDF analyzer that must
satisfy the identical contract, and a PDF module importing from ``app.docx``
would have been a dependency that says something untrue about the design. The
schema, the validator and the error are unchanged by the move, so DOCX
artifacts validate exactly as before.
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

from app.engine.contracts.citation_integrity import validate_citation_integrity

SCHEMA_FILENAME = "analysis-artifact.schema.json"


@dataclass(frozen=True, slots=True)
class ContractIssue:
    path: str
    message: str
    #: Set for a semantic defect, which reports a stable code of its own; the
    #: structural half has only the schema's message.
    code: str | None = None


@dataclass(frozen=True, slots=True)
class ContractResult:
    valid: bool
    issues: tuple[ContractIssue, ...]


def _find_schema() -> Path:
    """Walk up to the repository's shared contracts directory.

    The same discovery the evaluation contract uses: the schema is repository
    data, not a package resource, because two languages read the one file.
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "contracts" / "schemas" / SCHEMA_FILENAME
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"could not locate contracts/schemas/{SCHEMA_FILENAME}")


@lru_cache(maxsize=1)
def load_schema() -> dict[str, Any]:
    schema: dict[str, Any] = json.loads(_find_schema().read_text(encoding="utf-8"))
    return schema


@lru_cache(maxsize=1)
def _validator() -> Draft202012Validator:
    schema = load_schema()
    resource = DRAFT202012.create_resource(schema)
    registry = Registry().with_resource(uri=schema["$id"], resource=resource)
    return Draft202012Validator(
        {"$ref": f"{schema['$id']}#/$defs/AnalysisArtifact"}, registry=registry
    )


def validate_analysis_artifact_schema(value: Any) -> ContractResult:
    """The structural half only: does this satisfy the JSON Schema?

    Named explicitly because it is *not* the whole contract. It exists so the
    contract suite can prove a fixture is structurally sound and semantically
    broken; production code wants :func:`validate_analysis_artifact`.
    """
    issues = tuple(
        ContractIssue(
            path="/" + "/".join(str(part) for part in error.absolute_path),
            message=error.message,
        )
        for error in sorted(
            _validator().iter_errors(value), key=lambda err: list(err.absolute_path)
        )
    )
    return ContractResult(valid=not issues, issues=issues)


def validate_analysis_artifact(value: Any) -> ContractResult:
    """Validate one artifact completely, collecting every problem.

    Complete means both halves: the JSON Schema, and — when the artifact
    carries citation evidence — that evidence's internal consistency. They were
    two functions when the citation contracts landed, which meant an artifact
    with a corrupt citation graph passed the ordinary contract unless every
    caller remembered a second call. That is not failing closed, so the
    ordinary name now means the whole thing.

    The structural half runs first and alone: the semantic pass assumes the
    shape it is reading, so running it over an artifact that failed the schema
    would report defects that are really the structural failure wearing a
    different name.
    """
    structural = validate_analysis_artifact_schema(value)
    if not structural.valid:
        return structural

    analysis = value.get("citationAnalysis") if isinstance(value, dict) else None
    if analysis is None:
        return structural

    semantic = validate_citation_integrity(analysis)
    issues = tuple(
        ContractIssue(
            path=f"/citationAnalysis{issue.path}",
            message=issue.message,
            code=str(issue.code),
        )
        for issue in semantic.issues
    )
    return ContractResult(valid=not issues, issues=issues)


class AnalysisArtifactContractError(Exception):
    """The artifact does not satisfy the shared contract."""


def assert_analysis_artifact(value: Any) -> None:
    result = validate_analysis_artifact(value)
    if result.valid:
        return
    detail = "; ".join(f"{issue.path}: {issue.message}" for issue in result.issues)
    raise AnalysisArtifactContractError(
        f"analysis artifact does not satisfy the shared contract — {detail}"
    )
