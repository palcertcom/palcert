"""The two things SmartFix does, as plain functions.

`plan_for_document` reads a DOCX and decides what could be corrected.
`apply_plan` takes an approved plan and produces the corrected bytes with a
manifest. The HTTP layer above is a thin wrapper: keeping the work here means
the engine can be exercised in tests without a server, which is what makes the
golden correction corpus possible.

Planning is free and writes nothing. Applying writes a new document and never
touches the original — the original `DocumentVersion` is immutable, and the
corrected document is a new version with its own lineage.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import Any

from app.docx.analyzer import verify_source_integrity
from app.docx.artifact import ANALYZER_NAME, ANALYZER_VERSION
from app.docx.document import read_document
from app.docx.facts import build_fact_set
from app.docx.limits import AnalyzerLimits
from app.docx.model import ANALYSIS_SCHEMA_VERSION
from app.docx.package import DocxPackage, resolve_namespaces
from app.docx.warnings import WarningCollector
from app.engine.evaluation.engine import RuleDefinition
from app.engine.facts.model import FACT_SCHEMA_VERSION, DocumentFactSet
from app.smartfix import safety
from app.smartfix.capability import (
    CAPABILITY_REGISTRY_VERSION,
    SMARTFIX_ENGINE_NAME,
    SMARTFIX_ENGINE_VERSION,
)
from app.smartfix.contracts import SmartFixContract, assert_contract
from app.smartfix.model import PlanSource, SmartFixPlan
from app.smartfix.mutate import FixError, FixErrorCode, FixOutcome, apply_docx_fix_plan
from app.smartfix.planner import PlannerRule, plan_corrections


@dataclass(frozen=True, slots=True)
class PlanRequest:
    document_id: str
    content: bytes
    expected_sha256: str
    rules: tuple[PlannerRule, ...]
    source: PlanSource
    limits: AnalyzerLimits = field(default_factory=AnalyzerLimits.default)


def parse_rules(payload: list[dict[str, Any]]) -> tuple[PlannerRule, ...]:
    """Read the published rules the plan will be computed against.

    ``autofix`` is read separately from the rule definition because the
    evaluation engine has no use for it: it is the standard author's statement
    about *correction*, and it belongs to this phase.
    """
    return tuple(
        PlannerRule(
            definition=RuleDefinition.from_json(entry),
            autofix=str(entry.get("autofix", "NONE")),
        )
        for entry in payload
    )


def plan_for_document(request: PlanRequest) -> SmartFixPlan:
    """Decide what SmartFix would change in one document. Writes nothing."""
    verify_source_integrity(request.content, request.expected_sha256)

    warnings = WarningCollector(request.limits)
    package = DocxPackage.open(io.BytesIO(request.content), request.limits, warnings)
    try:
        result = read_document(package, request.limits, warnings)
        root = package.parse_part(package.main_document_part())
        namespaces = resolve_namespaces(root.tag)
        refusal = safety.assess(package, result.model, namespaces)
        fact_set = DocumentFactSet.from_json(
            build_fact_set(
                model=result.model,
                document_id=request.document_id,
                extractor_name=ANALYZER_NAME,
                extractor_version=ANALYZER_VERSION,
                fact_schema_version=FACT_SCHEMA_VERSION,
                limits=request.limits,
                warnings=warnings,
            )
        )
        plan = plan_corrections(result.model, fact_set, request.rules, request.source, refusal)
    finally:
        package.close()

    # A plan that does not satisfy its own contract is a planning failure, not
    # a plan somebody gets to approve.
    assert_contract(SmartFixContract.SMART_FIX_PLAN, plan.to_json())
    return plan


def apply_plan(
    content: bytes,
    expected_source_sha256: str,
    plan_payload: dict[str, Any],
    plan_hash: str,
    limits: AnalyzerLimits | None = None,
) -> FixOutcome:
    """Apply an approved plan to the document it was computed for.

    The plan arrives as JSON and is validated before it is read, and its hash
    is recomputed rather than trusted: the engine applies the plan the user
    approved or it applies nothing.
    """
    try:
        assert_contract(SmartFixContract.SMART_FIX_PLAN, plan_payload)
    except ValueError as error:
        raise FixError(FixErrorCode.PLAN_INVALID, str(error)) from error

    plan = SmartFixPlan.from_json(plan_payload)
    if plan.hash_hex() != plan_hash.lower():
        raise FixError(
            FixErrorCode.PLAN_INVALID,
            "the plan does not hash to the value the caller recorded",
        )
    return apply_docx_fix_plan(content, expected_source_sha256, plan, limits)


def engine_identity() -> dict[str, Any]:
    """What produced a plan or a manifest, for the database row and telemetry."""
    return {
        "fixEngineName": SMARTFIX_ENGINE_NAME,
        "fixEngineVersion": SMARTFIX_ENGINE_VERSION,
        "capabilityRegistryVersion": CAPABILITY_REGISTRY_VERSION,
        "analysisSchemaVersion": ANALYSIS_SCHEMA_VERSION,
        "factSchemaVersion": FACT_SCHEMA_VERSION,
    }
