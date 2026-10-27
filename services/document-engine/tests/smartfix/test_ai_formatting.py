"""General AI values -> real OOXML edits -> independent whole-standard recheck."""

from __future__ import annotations

import hashlib
from dataclasses import replace
from typing import Any

import pytest

from app.engine.evaluation.engine import DeterministicRuleEngine
from app.engine.rules.outcomes import Outcome
from app.smartfix.ai import attach_targets, formatting_context, initial_ai_plan
from app.smartfix.capability import Fixability
from app.smartfix.model import SmartFixPlan
from app.smartfix.mutate import FixError
from app.smartfix.service import PlanRequest, apply_plan, parse_rules, plan_for_document
from tests.docx.builder import DocxBuilder, section_properties
from tests.smartfix.support import analyze, element, plan_source, rule


def doc(text: str = "Research stays unchanged. البحث يبقى كما هو") -> bytes:
    return DocxBuilder(
        body='<w:p><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>'
        '<w:sz w:val="16"/></w:rPr><w:t>' + text + "</w:t></w:r></w:p>" + section_properties()
    ).build()


def request(
    content: bytes, rules: list[dict[str, Any]], targets: list[dict[str, str]]
) -> PlanRequest:
    digest = hashlib.sha256(content).hexdigest()
    return PlanRequest(
        "doc", content, digest, attach_targets(parse_rules(rules), targets), plan_source(digest)
    )


def size(code: str, operator: str, expected: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    return rule(code, element("fontSize"), operator, expected, unit="POINT", **kwargs)


@pytest.mark.parametrize(
    ("code", "operator", "expected", "chosen"),
    [
        ("SIZE.MIN", "GREATER_THAN", {"type": "NUMBER", "number": 10}, "12"),
        ("TAMANHO", "NOT_EQUALS", {"type": "NUMBER", "number": 8}, "11"),
        ("حجم.الخط", "IN", {"type": "NUMBER_LIST", "values": [11, 12]}, "12"),
    ],
)
def test_arbitrary_standard_codes_and_numeric_choices(
    code: str, operator: str, expected: dict[str, Any], chosen: str
) -> None:
    content = doc()
    rules = [size(code, operator, expected)]
    req = request(content, rules, [{"ruleCode": code, "kind": "NUMBER", "value": chosen}])
    plan = plan_for_document(req)
    assert all(r.fixability is Fixability.FIXABLE for r in plan.rules)
    result = apply_plan(content, req.expected_sha256, plan.to_json(), plan.hash_hex())
    assert result.manifest.integrity.mismatches() == ()
    assert (
        DeterministicRuleEngine()
        .evaluate(analyze(result.content).fact_set, parse_rules(rules)[0].definition)
        .outcome
        is Outcome.PASS
    )


def test_font_choice_and_all_runs_are_corrected_without_content_changes() -> None:
    content = DocxBuilder(
        body="<w:p>"
        + "".join(
            '<w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr>'
            f"<w:t>{text}</w:t></w:r>"
            for text in ("First ", "second ", "ثالث")
        )
        + "</w:p>"
    ).build()
    rules = [
        rule(
            "STYLE.TEXT.FONT",
            element("fontFamily"),
            "IN",
            {"type": "STRING_LIST", "values": ["Arial", "Times New Roman"]},
        )
    ]
    req = request(
        content, rules, [{"ruleCode": "STYLE.TEXT.FONT", "kind": "STRING", "value": "Arial"}]
    )
    plan = plan_for_document(req)
    assert len(plan.actions) == 3
    result = apply_plan(content, req.expected_sha256, plan.to_json(), plan.hash_hex())
    assert result.manifest.integrity.mismatches() == ()
    assert formatting_context(req, plan, rules)["complete"] is True


def test_ai_can_choose_common_value_before_conflicting_default_targets_are_simulated() -> None:
    rules = [
        size("EXACT", "EQUALS", {"type": "NUMBER", "number": 12}),
        size("MIN", "GREATER_THAN_OR_EQUAL", {"type": "NUMBER", "number": 10}),
    ]
    req = request(doc(), rules, [])
    with pytest.raises(FixError):
        plan_for_document(req)
    initial = initial_ai_plan(req)
    assert initial.actions == ()
    assert [r["outcome"] for r in formatting_context(req, initial, rules)["rules"]] == [
        "FAIL",
        "FAIL",
    ]
    updated = replace(
        req,
        rules=attach_targets(
            req.rules,
            [{"ruleCode": code, "kind": "NUMBER", "value": "12"} for code in ("EXACT", "MIN")],
        ),
    )
    plan = plan_for_document(updated)
    assert formatting_context(updated, plan, rules)["complete"] is True


def test_incorrect_target_cannot_relax_a_published_requirement() -> None:
    rules = [size("SIZE", "EQUALS", {"type": "NUMBER", "number": 12})]
    req = request(doc(), rules, [{"ruleCode": "SIZE", "kind": "NUMBER", "value": "9"}])
    plan = plan_for_document(req)
    assert not plan.actions
    assert plan.rules[0].fixability is not Fixability.FIXABLE
    assert formatting_context(req, plan, rules)["complete"] is False
    assert req.rules[0].definition.expected.number == 12


@pytest.mark.parametrize(
    "target",
    [
        {"ruleCode": "OTHER", "kind": "NUMBER", "value": "12"},
        {"ruleCode": "SIZE", "kind": "NUMBER", "value": "NaN"},
        {"ruleCode": "SIZE", "kind": "STRING", "value": "12"},
        {"ruleCode": "SIZE", "kind": "NUMBER", "value": "12", "scope": "DOCUMENT"},
        {"ruleCode": "SIZE", "kind": "NUMBER", "value": "12", "nodeId": "main/body/p:1"},
    ],
)
def test_untrusted_proposal_fields_and_types_are_rejected(target: dict[str, str]) -> None:
    with pytest.raises(ValueError):
        request(doc(), [size("SIZE", "EQUALS", {"type": "NUMBER", "number": 12})], [target])


@pytest.mark.parametrize("overrides", [{"autofix": "NONE"}, {"evaluation_mode": "AI_ASSISTED"}])
def test_ai_cannot_grant_itself_edit_permissions(overrides: dict[str, str]) -> None:
    with pytest.raises(ValueError):
        request(
            doc(),
            [size("SIZE", "EQUALS", {"type": "NUMBER", "number": 12}, **overrides)],
            [{"ruleCode": "SIZE", "kind": "NUMBER", "value": "12"}],
        )


def test_formatting_context_contains_no_document_prose_or_content_rule_values() -> None:
    private_sentence = "Do not disclose this unpublished sentence."
    rules = [
        size("SIZE", "IN", {"type": "NUMBER_LIST", "values": [11, 12]}),
        rule(
            "CONTENT",
            {"kind": "METADATA", "fieldName": "title"},
            "EQUALS",
            {"type": "STRING", "text": "PRIVATE CONTENT RULE"},
        ),
    ]
    req = request(doc(private_sentence), rules, [])
    context = formatting_context(req, initial_ai_plan(req), rules)
    assert len(context["rules"]) == 2
    assert private_sentence not in str(context) and "PRIVATE CONTENT RULE" not in str(context)
    assert context["complete"] is False


def test_ai_provenance_survives_plan_hash_and_execution() -> None:
    rules = [size("SIZE", "EQUALS", {"type": "NUMBER", "number": 12})]
    req = request(doc(), rules, [])
    plan = replace(
        plan_for_document(req),
        ai_planning={
            "provider": "test",
            "model": "test-model",
            "rounds": 1,
            "stopReason": "VERIFIED",
            "inputTokens": 100,
            "outputTokens": 30,
        },
    )
    assert SmartFixPlan.from_json(plan.to_json()).hash_hex() == plan.hash_hex()
    result = apply_plan(req.content, req.expected_sha256, plan.to_json(), plan.hash_hex())
    assert result.manifest.integrity.mismatches() == ()
