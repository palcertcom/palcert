"""Shared machinery for the SmartFix tests.

Every scenario runs the real thing: a package built from the exact OOXML it
exercises, analyzed by the Phase 6 analyzer, planned by the real planner,
mutated by the real mutation engine, then analyzed and evaluated again. There
is no stub in this path, because the property under test — "a corrected
document passes the rules it was corrected for, and nothing else changed" —
is only meaningful end to end.
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass
from typing import Any

from app.docx.document import read_document
from app.docx.facts import build_fact_set
from app.docx.limits import AnalyzerLimits
from app.docx.model import StructuralModel
from app.docx.package import DocxPackage, resolve_namespaces
from app.docx.warnings import WarningCollector
from app.engine.facts.model import FACT_SCHEMA_VERSION, DocumentFactSet
from app.engine.facts.selection import FactIndex
from app.engine.rules.operators import evaluator_for
from app.engine.rules.outcomes import Outcome
from app.smartfix import safety
from app.smartfix.capability import RefusalCode
from app.smartfix.model import PlanSource, SmartFixPlan
from app.smartfix.planner import PlannerRule, plan_corrections
from app.smartfix.service import parse_rules

LIMITS = AnalyzerLimits.default()


@dataclass(frozen=True, slots=True)
class Analysis:
    model: StructuralModel
    fact_set: DocumentFactSet
    refusal: RefusalCode | None
    sha256: str


def analyze(content: bytes) -> Analysis:
    """Read one package exactly the way a check would."""
    warnings = WarningCollector(LIMITS)
    package = DocxPackage.open(io.BytesIO(content), LIMITS, warnings)
    try:
        result = read_document(package, LIMITS, warnings)
        root = package.parse_part(package.main_document_part())
        namespaces = resolve_namespaces(root.tag)
        refusal = safety.assess(package, result.model, namespaces)
        fact_set = DocumentFactSet.from_json(
            build_fact_set(
                model=result.model,
                document_id="doc",
                extractor_name="palcert-docx",
                extractor_version="1.0.0",
                fact_schema_version=FACT_SCHEMA_VERSION,
                limits=LIMITS,
                warnings=warnings,
            )
        )
    finally:
        package.close()
    return Analysis(
        model=result.model,
        fact_set=fact_set,
        refusal=refusal,
        sha256=hashlib.sha256(content).hexdigest(),
    )


def rule(
    code: str,
    scope: dict[str, Any],
    operator: str,
    expected: dict[str, Any],
    *,
    unit: str | None = None,
    autofix: str = "SAFE",
    evaluation_mode: str = "DETERMINISTIC",
    tolerance: float | None = None,
) -> dict[str, Any]:
    """One published rule, in the shape Phase 3 stores it."""
    payload: dict[str, Any] = {
        "ruleCode": code,
        "scope": scope,
        "operator": operator,
        "expected": expected,
        "evaluationMode": evaluation_mode,
        "severity": "MAJOR",
        "blocking": True,
        "ruleSchemaVersion": 1,
        "autofix": autofix,
    }
    if unit is not None:
        payload["unit"] = unit
    if tolerance is not None:
        payload["tolerance"] = tolerance
    return payload


def element(property_name: str, element_type: str = "PARAGRAPH") -> dict[str, Any]:
    return {"kind": "ELEMENT", "elementType": element_type, "property": property_name}


def document(property_name: str) -> dict[str, Any]:
    return {"kind": "DOCUMENT", "property": property_name}


def plan_source(sha256: str) -> PlanSource:
    return PlanSource(
        document_version_id="11111111-1111-4111-8111-111111111111",
        document_sha256=sha256,
        analysis_artifact_sha256="b" * 64,
        standard_version_id="22222222-2222-4222-8222-222222222222",
        standard_content_hash="sha256:" + "c" * 64,
        report_hash="d" * 64,
        rule_schema_version=1,
        fact_schema_version=FACT_SCHEMA_VERSION,
    )


def make_plan(content: bytes, rules: tuple[dict[str, Any], ...]) -> tuple[SmartFixPlan, Analysis]:
    analysis = analyze(content)
    planner_rules: tuple[PlannerRule, ...] = parse_rules(list(rules))
    plan = plan_corrections(
        analysis.model,
        analysis.fact_set,
        planner_rules,
        plan_source(analysis.sha256),
        analysis.refusal,
    )
    return plan, analysis


def outcomes_for(analysis: Analysis, rules: tuple[dict[str, Any], ...]) -> dict[str, set[str]]:
    """Evaluate every rule against an analysis, the way a recheck would.

    Returns the *set* of per-fact outcomes rather than a single verdict, so a
    test can tell "every paragraph passes" from "most of them do" — which is
    the difference between a fix and a fix that missed a run.
    """
    index = FactIndex(analysis.fact_set)
    results: dict[str, set[str]] = {}
    for entry in parse_rules(list(rules)):
        definition = entry.definition
        evaluator = evaluator_for(definition.operator)
        assert evaluator is not None
        verdicts = {
            evaluator.evaluate(
                fact, definition.expected, definition.unit, definition.tolerance
            ).outcome
            for fact in index.select(definition.scope)
        }
        results[definition.rule_code] = {str(verdict) for verdict in verdicts}
    return results


def passed(outcomes: dict[str, set[str]], code: str) -> bool:
    """Whether a rule is satisfied by every fact it addresses."""
    return outcomes.get(code, set()) in ({str(Outcome.PASS)}, set())


def fixability(plan: SmartFixPlan, code: str) -> str:
    for entry in plan.rules:
        if entry.rule_code == code:
            return entry.fixability.value
    raise AssertionError(f"the plan says nothing about {code}")


def reason(plan: SmartFixPlan, code: str) -> str | None:
    for entry in plan.rules:
        if entry.rule_code == code:
            return entry.reason_code.value if entry.reason_code else None
    raise AssertionError(f"the plan says nothing about {code}")


W_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def header_part(body: str) -> str:
    """A header part, with the root element Word expects.

    A header is its own story in its own package part, which is exactly why
    the tests use a real one: a body correction that reached into it would be
    editing text the rule never addressed.
    """
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:hdr xmlns:w="{W_NAMESPACE}">{body}</w:hdr>'
    )
