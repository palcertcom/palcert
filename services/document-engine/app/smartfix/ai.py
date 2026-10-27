"""Formatting-only AI boundary. No document text, XML or executable model output."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import replace
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from app.engine.evaluation.engine import DeterministicRuleEngine
from app.engine.facts.model import ScopeKind
from app.engine.facts.selection import FactIndex
from app.engine.rules.outcomes import EvaluationMode, Outcome
from app.smartfix.capability import (
    CONTENT_CHANGE_OPERATORS,
    Fixability,
    capability_for,
    element_type_is_fixable,
)
from app.smartfix.model import FixValue, SmartFixPlan
from app.smartfix.mutate import FixError, FixErrorCode, apply_docx_fix_plan
from app.smartfix.planner import PlannerRule

if TYPE_CHECKING:
    from app.smartfix.service import PlanRequest

MAX_RULES = 512


def initial_ai_plan(request: PlanRequest) -> SmartFixPlan:
    """Show original violations before choosing any values, including conflicts.

    Single-value defaults can conflict with another rule's inclusive bound.
    AI must see those rules before any candidate is simulated, so it can choose
    a common satisfying value. This draft is never offered for execution.
    """
    from app.smartfix.service import _plan_once

    plan, _, _ = _plan_once(request)
    return replace(
        plan,
        actions=(),
        rules=tuple(
            replace(r, fixability=Fixability.NOT_SUPPORTED, action_ids=(), fixable_target_count=0)
            for r in plan.rules
        ),
    )


def editable(rule: PlannerRule) -> bool:
    definition = rule.definition
    scope = definition.scope
    return (
        rule.autofix == "SAFE"
        and definition.evaluation_mode is EvaluationMode.DETERMINISTIC
        and definition.operator not in CONTENT_CHANGE_OPERATORS
        and scope.kind in {ScopeKind.DOCUMENT, ScopeKind.ELEMENT}
        and (
            scope.kind is ScopeKind.DOCUMENT
            or element_type_is_fixable(scope.element_type.value if scope.element_type else None)
        )
        and capability_for(scope.kind.value, scope.property or "") is not None
    )


def attach_targets(rules: tuple[PlannerRule, ...], payload: Any) -> tuple[PlannerRule, ...]:
    """AI may choose values, never rule scopes, permissions, thresholds or node IDs."""
    if not isinstance(payload, list) or len(payload) > MAX_RULES:
        raise ValueError("invalid formatting proposals")
    by_code = {r.definition.rule_code: r for r in rules}
    if len(by_code) != len(rules):
        raise ValueError("duplicate source rule")
    targets: dict[str, FixValue] = {}
    for entry in payload:
        if not isinstance(entry, dict) or set(entry) != {"ruleCode", "kind", "value"}:
            raise ValueError("invalid formatting proposal fields")
        code, kind, value = entry["ruleCode"], entry["kind"], entry["value"]
        if (
            not isinstance(code, str)
            or code not in by_code
            or code in targets
            or not editable(by_code[code])
            or not isinstance(value, str)
            or not 1 <= len(value) <= 256
            or re.search(r"[\x00-\x1f]", value)
        ):
            raise ValueError("unavailable formatting target")
        scope = by_code[code].definition.scope
        capability = capability_for(scope.kind.value, scope.property or "")
        if capability is None or kind != capability.value_kind:
            raise ValueError("incorrect formatting value kind")
        if kind == "NUMBER":
            if re.fullmatch(r"-?\d{1,12}(?:\.\d{1,12})?", value) is None:
                raise ValueError("invalid formatting number")
            target = FixValue.of_number(Decimal(value), capability.unit)
        elif kind == "BOOLEAN":
            if value not in {"true", "false"}:
                raise ValueError("invalid formatting boolean")
            target = FixValue.of_flag(value == "true")
        else:
            target = FixValue.of_text(value)
        targets[code] = target
    return tuple(replace(r, ai_target=targets.get(r.definition.rule_code)) for r in rules)


def formatting_context(
    request: PlanRequest, plan: SmartFixPlan, payload: list[dict[str, Any]]
) -> dict[str, Any]:
    """All-rule preview results; bounded formatting observations, never prose.

    The provider sees sampled DISTINCT formatting values with explicit counts.
    The evaluator and planner still inspect every matching fact and every rule.
    Unsupported/content rules disclose only their code and outcome.
    """
    from app.smartfix.service import _plan_once

    if len(request.rules) > MAX_RULES:
        raise FixError(FixErrorCode.PLAN_INVALID, "AI formatting rule limit exceeded")
    preview = request
    if plan.actions and plan.refusal is None:
        corrected = apply_docx_fix_plan(
            request.content, request.expected_sha256, plan, request.limits
        )
        preview = replace(
            request,
            content=corrected.content,
            expected_sha256=corrected.sha256,
            source=replace(request.source, document_sha256=corrected.sha256),
        )
    _, _, facts = _plan_once(preview)
    results = DeterministicRuleEngine().evaluate_all(facts, [r.definition for r in request.rules])
    index = FactIndex(facts)
    entries = {entry["ruleCode"]: entry for entry in payload}
    planned = {r.rule_code: r for r in plan.rules}
    output: list[dict[str, Any]] = []
    for rule, result in zip(request.rules, results, strict=True):
        code = rule.definition.rule_code
        row: dict[str, Any] = {
            "ruleCode": code,
            "outcome": result.outcome.value,
            "reason": result.reason_code.value,
            "counts": result.counts.to_json(),
            "editable": editable(rule) and plan.refusal is None,
        }
        if code in planned and planned[code].reason_code:
            row["planningReason"] = str(planned[code].reason_code)
        if row["editable"]:
            source = entries[code]
            for key in ("scope", "operator", "expected", "unit", "tolerance"):
                if key in source:
                    row[key] = source[key]
            cap = capability_for(
                rule.definition.scope.kind.value, rule.definition.scope.property or ""
            )
            if cap is None:  # defensive: editable() checked the same registry
                raise ValueError("formatting capability disappeared")
            row["targetKind"] = cap.value_kind
            row["targetUnit"] = cap.unit
            values = Counter(
                (f.value.display(), str(f.unit or "")) for f in index.select(rule.definition.scope)
            )
            row["observedValues"] = [
                {"value": value[:256], "unit": unit, "count": count}
                for (value, unit), count in values.most_common(8)
            ]
            row["observationsTruncated"] = len(values) > 8 or any(len(v[0]) > 256 for v in values)
        output.append(row)
    return {
        "schemaVersion": 1,
        "rules": output,
        "complete": bool(results)
        and all(r.outcome in {Outcome.PASS, Outcome.NOT_APPLICABLE} for r in results),
    }
