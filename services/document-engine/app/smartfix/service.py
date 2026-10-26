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
from dataclasses import dataclass, field, replace
from typing import Any

from app.docx.analyzer import verify_source_integrity
from app.docx.artifact import ANALYZER_NAME, ANALYZER_VERSION
from app.docx.document import read_document
from app.docx.facts import build_fact_set
from app.docx.limits import AnalyzerLimits
from app.docx.model import ANALYSIS_SCHEMA_VERSION, StructuralModel
from app.docx.package import DocxPackage, resolve_namespaces
from app.docx.warnings import WarningCollector
from app.engine.evaluation.engine import DeterministicRuleEngine, RuleDefinition
from app.engine.facts.model import FACT_SCHEMA_VERSION, DocumentFactSet
from app.engine.rules.outcomes import Outcome
from app.smartfix import safety
from app.smartfix.capability import (
    CAPABILITY_REGISTRY_VERSION,
    SMARTFIX_ENGINE_NAME,
    SMARTFIX_ENGINE_VERSION,
    Fixability,
    ReasonCode,
)
from app.smartfix.contracts import SmartFixContract, assert_contract
from app.smartfix.model import FixAction, PlanSource, SmartFixPlan
from app.smartfix.mutate import FixError, FixErrorCode, FixOutcome, apply_docx_fix_plan
from app.smartfix.observe import NodeLookup, observe
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
    """Preview a bounded correction before offering one source-bound plan.

    A paragraph style can expose another formatting mismatch. Simulate, recheck
    and merge those dependent changes, always reapplying to the original bytes.
    No intermediate document is stored or delivered and no approved plan grows
    during execution. Remaining failures/unknowns are explicit plan blockers.
    """
    plan, original, _ = _plan_once(request)
    if plan.refusal is not None or not plan.actions:
        return plan
    lookup = NodeLookup(original)
    # Detect conflicting values in the initial batch too, before simulation.
    plan = _merge_plans(plan, plan, original, lookup)
    for _ in range(3):
        corrected = apply_docx_fix_plan(
            request.content, request.expected_sha256, plan, request.limits
        )
        simulated = replace(
            request,
            content=corrected.content,
            expected_sha256=corrected.sha256,
            source=replace(request.source, document_sha256=corrected.sha256),
        )
        additional, _, facts = _plan_once(simulated)
        if not additional.actions:
            return _verified_plan(plan, additional, facts, request)
        updated = _merge_plans(plan, additional, original, lookup)
        if updated.actions == plan.actions:
            return _verified_plan(plan, additional, facts, request)
        plan = updated
    # Verify the final merged plan too; the bound must not leave an unchecked
    # last batch looking executable.
    corrected = apply_docx_fix_plan(request.content, request.expected_sha256, plan, request.limits)
    additional, _, facts = _plan_once(
        replace(
            request,
            content=corrected.content,
            expected_sha256=corrected.sha256,
            source=replace(request.source, document_sha256=corrected.sha256),
        )
    )
    return _verified_plan(plan, additional, facts, request)


def _merge_plans(
    plan: SmartFixPlan, additional: SmartFixPlan, original: StructuralModel, lookup: NodeLookup
) -> SmartFixPlan:
    combined: dict[tuple[str, str, str | None, int | None, str], FixAction] = {}
    edits: dict[tuple[str, str, str | None, int | None], FixAction] = {}
    for action in (*plan.actions, *additional.actions):
        key = (
            action.node_id,
            action.action_type.value,
            action.script_channel,
            action.section_index,
        )
        previous = edits.get(key)
        if previous is not None and not previous.after.matches(action.after):
            raise FixError(FixErrorCode.PLAN_INVALID, "correction rules require conflicting values")
        edits[key] = action
        owned_key = (*key, action.rule_code)
        if owned_key not in combined:
            combined[owned_key] = replace(action, before=observe(lookup, action, original))
    actions = tuple(
        replace(a, action_id=f"a-{i:04d}") for i, a in enumerate(combined.values(), start=1)
    )
    rows = {r.rule_code: r for r in (*plan.rules, *additional.rules)}
    for code, row in tuple(rows.items()):
        ids = tuple(a.action_id for a in actions if a.rule_code == code)
        rows[code] = replace(
            row,
            action_ids=ids,
            target_count=max(row.target_count, len(ids)),
            fixable_target_count=len(ids),
        )
    return replace(plan, actions=actions, rules=tuple(rows[c] for c in sorted(rows)))


def _verified_plan(
    plan: SmartFixPlan, remaining: SmartFixPlan, facts: DocumentFactSet, request: PlanRequest
) -> SmartFixPlan:
    engine = DeterministicRuleEngine()
    outcomes = {
        r.definition.rule_code: engine.evaluate(facts, r.definition).outcome for r in request.rules
    }
    rows = {r.rule_code: r for r in (*remaining.rules, *plan.rules)}
    for code, row in tuple(rows.items()):
        if outcomes[code] in {Outcome.PASS, Outcome.NOT_APPLICABLE}:
            if row.action_ids:
                rows[code] = replace(row, fixability=Fixability.FIXABLE, reason_code=None)
            else:
                del rows[code]
        else:
            rows[code] = replace(
                row,
                fixability=Fixability.NOT_SUPPORTED,
                reason_code=row.reason_code or ReasonCode.LOCATION_EVIDENCE_MISSING,
            )
    verified = replace(plan, rules=tuple(rows[c] for c in sorted(rows)))
    assert_contract(SmartFixContract.SMART_FIX_PLAN, verified.to_json())
    return verified


def _plan_once(request: PlanRequest) -> tuple[SmartFixPlan, StructuralModel, DocumentFactSet]:
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
    return plan, result.model, fact_set


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
