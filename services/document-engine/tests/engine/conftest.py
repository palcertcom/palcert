"""Builders for synthetic facts and rules.

Every test constructs its input through these, so a schema change surfaces in
one place rather than in two hundred literal dictionaries.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.engine.evaluation.engine import DeterministicRuleEngine, RuleDefinition
from app.engine.facts.model import DocumentFactSet


def location(node_id: str, page: int | None = None, ordinal: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"locationSchemaVersion": 1, "nodeId": node_id}
    if page is not None:
        result["page"] = page
    if ordinal is not None:
        result["ordinal"] = ordinal
    return result


def element_scope(element_type: str, prop: str, level: int | None = None) -> dict[str, Any]:
    scope: dict[str, Any] = {"kind": "ELEMENT", "elementType": element_type, "property": prop}
    if level is not None:
        scope["level"] = level
    return scope


def document_scope(prop: str) -> dict[str, Any]:
    return {"kind": "DOCUMENT", "property": prop}


def section_scope(section_key: str, prop: str) -> dict[str, Any]:
    return {"kind": "SECTION", "sectionKey": section_key, "property": prop}


def number_fact(
    scope: dict[str, Any],
    value: str,
    unit: str | None = None,
    node_id: str = "n-1",
    page: int | None = None,
    ordinal: int | None = None,
) -> dict[str, Any]:
    fact: dict[str, Any] = {
        "scope": scope,
        "value": {"type": "NUMBER", "number": value},
        "location": location(node_id, page, ordinal),
    }
    if unit is not None:
        fact["unit"] = unit
    return fact


def string_fact(
    scope: dict[str, Any], text: str, node_id: str = "n-1", page: int | None = None
) -> dict[str, Any]:
    return {
        "scope": scope,
        "value": {"type": "STRING", "text": text},
        "location": location(node_id, page),
    }


def coverage(
    kind: str,
    status: str = "COMPLETE",
    element_type: str | None = None,
    prop: str | None = None,
    section_key: str | None = None,
) -> dict[str, Any]:
    entry: dict[str, Any] = {"kind": kind, "status": status}
    if element_type is not None:
        entry["elementType"] = element_type
    if prop is not None:
        entry["property"] = prop
    if section_key is not None:
        entry["sectionKey"] = section_key
    return entry


def fact_set(
    facts: list[dict[str, Any]],
    coverage_entries: list[dict[str, Any]] | None = None,
    *,
    fact_schema_version: int = 1,
) -> DocumentFactSet:
    return DocumentFactSet.from_json(
        {
            "factSchemaVersion": fact_schema_version,
            "documentId": "synthetic-test-document",
            "extractor": {"name": "synthetic", "version": "1"},
            "coverage": coverage_entries or [],
            "facts": facts,
        }
    )


def rule(
    scope: dict[str, Any],
    operator: str,
    expected: dict[str, Any],
    *,
    code: str = "TEST.RULE",
    unit: str | None = None,
    tolerance: float | int | None = None,
    evaluation_mode: str = "DETERMINISTIC",
    severity: str = "MAJOR",
    blocking: bool = False,
    rule_schema_version: int = 2,
) -> RuleDefinition:
    payload: dict[str, Any] = {
        "ruleCode": code,
        "scope": scope,
        "operator": operator,
        "expected": expected,
        "evaluationMode": evaluation_mode,
        "severity": severity,
        "blocking": blocking,
        "ruleSchemaVersion": rule_schema_version,
    }
    if unit is not None:
        payload["unit"] = unit
    if tolerance is not None:
        payload["tolerance"] = tolerance
    return RuleDefinition.from_json(payload)


@pytest.fixture
def engine() -> DeterministicRuleEngine:
    return DeterministicRuleEngine()
