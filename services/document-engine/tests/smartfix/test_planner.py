"""The planner's decisions, beyond what the corpus covers end to end.

The corpus proves that a plan works. These prove that a plan is *honest*: that
it says which rules it will not touch and why, that it never plans a change it
cannot verify, and that it never consults anything but the document and the
rules.
"""

from __future__ import annotations

import pytest

from app.smartfix.capability import CAPABILITY_REGISTRY_VERSION, SMARTFIX_ENGINE_VERSION
from app.smartfix.contracts import SmartFixContract, validate_contract
from tests.docx.builder import DocxBuilder, section_properties
from tests.smartfix.support import document, element, fixability, make_plan, reason, rule

SECTION = section_properties()


def _document(body: str, **kwargs: object) -> bytes:
    return DocxBuilder(body=body, **kwargs).build()


def _paragraph(size_half_points: int = 20, text: str = "Body text") -> str:
    return (
        f'<w:p><w:r><w:rPr><w:sz w:val="{size_half_points}"/></w:rPr>'
        f'<w:t xml:space="preserve">{text}</w:t></w:r></w:p>'
    )


SIZE_RULE = rule(
    "SIZE", element("fontSize"), "EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT"
)


def test_a_plan_always_satisfies_its_contract() -> None:
    plan, _ = make_plan(_document(_paragraph() + SECTION), (SIZE_RULE,))
    assert validate_contract(SmartFixContract.SMART_FIX_PLAN, plan.to_json()).issues == ()


def test_a_plan_stamps_the_engine_and_registry_it_came_from() -> None:
    plan, _ = make_plan(_document(_paragraph() + SECTION), (SIZE_RULE,))
    assert plan.engine_version == SMARTFIX_ENGINE_VERSION
    assert plan.capability_registry_version == CAPABILITY_REGISTRY_VERSION


def test_a_plan_is_bound_to_the_document_it_read() -> None:
    content = _document(_paragraph() + SECTION)
    plan, analysis = make_plan(content, (SIZE_RULE,))
    assert plan.source.document_sha256 == analysis.sha256


def test_action_ids_are_positional_and_stable() -> None:
    content = _document(_paragraph() + _paragraph(18) + SECTION)
    first, _ = make_plan(content, (SIZE_RULE,))
    second, _ = make_plan(content, (SIZE_RULE,))
    # A plan is hashed. Random identifiers would make two identical plans look
    # like two different intentions.
    assert [action.action_id for action in first.actions] == ["a-0001", "a-0002"]
    assert first.hash_hex() == second.hash_hex()


def test_rules_are_reported_in_a_stable_order() -> None:
    content = _document(_paragraph() + SECTION)
    rules = (
        rule("ZULU", element("fontSize"), "EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT"),
        rule(
            "ALPHA", element("fontSize"), "EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT"
        ),
    )
    plan, _ = make_plan(content, rules)
    assert [entry.rule_code for entry in plan.rules] == ["ALPHA", "ZULU"]


@pytest.mark.parametrize(
    ("operator", "expected", "status", "code"),
    [
        (
            "NOT_EQUALS",
            {"type": "NUMBER", "number": 10},
            "AMBIGUOUS_TARGET",
            "SMARTFIX_OPERATOR_AMBIGUOUS",
        ),
        (
            "GREATER_THAN",
            {"type": "NUMBER", "number": 12},
            "AMBIGUOUS_TARGET",
            "SMARTFIX_OPERATOR_AMBIGUOUS",
        ),
        (
            "LESS_THAN",
            {"type": "NUMBER", "number": 8},
            "AMBIGUOUS_TARGET",
            "SMARTFIX_OPERATOR_AMBIGUOUS",
        ),
        (
            "NOT_IN",
            {"type": "NUMBER_LIST", "values": [10]},
            "AMBIGUOUS_TARGET",
            "SMARTFIX_OPERATOR_AMBIGUOUS",
        ),
    ],
)
def test_an_operator_without_a_single_target_is_never_acted_on(
    operator: str, expected: dict[str, object], status: str, code: str
) -> None:
    content = _document(_paragraph() + SECTION)
    plan, _ = make_plan(
        content, (rule("R", element("fontSize"), operator, expected, unit="POINT"),)
    )
    assert fixability(plan, "R") == status
    assert reason(plan, "R") == code
    assert plan.actions == ()


def test_not_exists_never_deletes_content() -> None:
    content = _document(_paragraph() + SECTION)
    plan, _ = make_plan(
        content,
        (
            rule(
                "NO_COMMENTS",
                document("commentsPresent"),
                "NOT_EXISTS",
                {"type": "NONE"},
            ),
        ),
    )
    assert fixability(plan, "NO_COMMENTS") == "MANUAL_ACTION_REQUIRED"
    assert reason(plan, "NO_COMMENTS") == "SMARTFIX_CONTENT_CHANGE_REQUIRED"
    assert plan.actions == ()


def test_a_metadata_rule_is_not_corrected_in_this_phase() -> None:
    content = _document(
        _paragraph() + SECTION,
        core_properties=(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            "<cp:coreProperties "
            'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/">'
            "<dc:title>Untitled</dc:title></cp:coreProperties>"
        ),
    )
    plan, _ = make_plan(
        content,
        (
            rule(
                "TITLE",
                {"kind": "METADATA", "field": "title"},
                "EQUALS",
                {"type": "STRING", "text": "A thesis"},
            ),
        ),
    )
    assert reason(plan, "TITLE") == "SMARTFIX_METADATA_NOT_SUPPORTED"


def test_a_property_the_engine_cannot_write_is_named_as_such() -> None:
    content = _document(
        '<w:p><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr>'
        '<w:t xml:space="preserve">Body text</w:t></w:r></w:p>' + SECTION
    )
    plan, _ = make_plan(
        content,
        (
            rule(
                "COLOUR",
                element("textColor"),
                "EQUALS",
                {"type": "STRING", "text": "000000"},
            ),
        ),
    )
    assert reason(plan, "COLOUR") == "SMARTFIX_PROPERTY_NOT_SUPPORTED"


def test_a_rule_that_already_passes_is_not_planned() -> None:
    content = _document(_paragraph(24) + SECTION)
    plan, _ = make_plan(content, (SIZE_RULE,))
    assert [entry.rule_code for entry in plan.rules] == []
    assert plan.actions == ()


def test_every_action_records_the_value_it_expects_to_find() -> None:
    plan, _ = make_plan(_document(_paragraph() + SECTION), (SIZE_RULE,))
    # Without this the mutator could not tell a document that moved from one
    # that did not, and would edit a stranger's file on the user's behalf.
    assert all(action.before is not None for action in plan.actions)


def test_a_refused_document_reports_every_rule_as_unsafe_to_edit() -> None:
    content = _document(
        '<w:p><w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">'
        '<w:r><w:t xml:space="preserve">New</w:t></w:r></w:ins></w:p>' + _paragraph() + SECTION
    )
    plan, _ = make_plan(content, (SIZE_RULE,))
    assert plan.refusal is not None
    assert fixability(plan, "SIZE") == "SOURCE_DOCUMENT_UNSAFE_TO_EDIT"
    assert plan.actions == ()


def test_a_target_in_an_incompatible_unit_is_refused_rather_than_converted() -> None:
    """Words are not points, and no conversion between them would be honest.

    The check engine already reports such a rule INDETERMINATE, so it never
    reaches the planner in practice — but the planner converts units itself,
    and a conversion that silently produced a number would be worse than one
    that refuses.
    """
    from fractions import Fraction

    from app.engine.facts.model import DocumentFact, FactScope, FactValue, FactValueType, ScopeKind
    from app.engine.units.registry import Unit
    from app.smartfix.planner import _to_capability_unit

    fact = DocumentFact(
        scope=FactScope(kind=ScopeKind.ELEMENT, property="fontSize"),
        value=FactValue(type=FactValueType.NUMBER),
        unit=Unit.WORDS,
    )
    assert _to_capability_unit(Fraction(12), Unit.WORDS, fact, "POINT") is None
    assert _to_capability_unit(Fraction(1), Unit.INCH, fact, "POINT") == Fraction(72)


def test_a_scope_with_no_single_element_to_edit_is_refused() -> None:
    """A PAGE-scoped rule addresses a region, not an element.

    The DOCX analyzer emits no page-scoped facts, so this branch cannot be
    reached through a real document — which is exactly why it is exercised
    directly rather than left to be discovered by the first extractor that
    does emit them.
    """
    from app.engine.facts.model import DocumentFactSet
    from app.smartfix.model import PlanSource
    from app.smartfix.planner import plan_corrections
    from app.smartfix.service import parse_rules
    from tests.smartfix.support import analyze, plan_source

    content = _document(_paragraph() + SECTION)
    analysis = analyze(content)
    synthetic = DocumentFactSet.from_json(
        {
            "factSchemaVersion": analysis.fact_set.fact_schema_version,
            "documentId": "doc",
            "extractor": {"name": "synthetic", "version": "1.0.0"},
            "coverage": [{"kind": "PAGE", "property": "marginTop", "status": "COMPLETE"}],
            "facts": [
                {
                    "scope": {"kind": "PAGE", "pages": "FIRST", "property": "marginTop"},
                    "value": {"type": "NUMBER", "number": "25.4"},
                    "unit": "MILLIMETRE",
                    "location": {"nodeId": "main/section:1", "ordinal": 1},
                }
            ],
        }
    )
    rules = parse_rules(
        [
            rule(
                "PAGE_RULE",
                {"kind": "PAGE", "pages": "FIRST", "property": "marginTop"},
                "EQUALS",
                {"type": "NUMBER", "number": 30},
                unit="MILLIMETRE",
            )
        ]
    )
    plan = plan_corrections(analysis.model, synthetic, rules, plan_source(analysis.sha256))
    assert reason(plan, "PAGE_RULE") == "SMARTFIX_SCOPE_NOT_SUPPORTED"
    assert plan.actions == ()
    assert isinstance(plan.source, PlanSource)


# ---------------------------------------------------------------------------
# The element-type guard (Phase 18 Checkpoint 1)
# ---------------------------------------------------------------------------
#
# Capability matching is ``(scope kind, property)`` and knows nothing about
# element types, and ``_expand`` resolves its targets from the fact's node id
# alone. So nothing in the capability table stops a formatting fix reaching a
# citation once Phase 18 starts emitting ELEMENT/CITATION and
# ELEMENT/REFERENCE_ENTRY facts: a standard saying "reference entries are
# single-spaced" with ``autofix: SAFE`` would plan real edits to somebody's
# bibliography through a capability written for body paragraphs.
#
# These fact sets are synthetic because Phase 18 has not started: no analyzer
# emits a REFERENCE_ENTRY fact yet. That is the point — the guard lands before
# the facts do, so the hole is never open.


def _element_fact_set(
    node_id: str,
    element_type: str | None,
    property_name: str,
    value: dict[str, object],
    unit: str | None = None,
) -> object:
    """One failing ELEMENT fact at a real node, with complete coverage.

    Everything a plan needs is deliberately present: a resolvable node id, a
    capability that is genuinely supported for the property, and coverage that
    does not excuse anything. If the guard is removed, this plans actions.
    """
    from app.engine.facts.model import DocumentFactSet

    scope: dict[str, object] = {"kind": "ELEMENT", "property": property_name}
    coverage: dict[str, object] = {"kind": "ELEMENT", "property": property_name}
    if element_type is not None:
        scope["elementType"] = element_type
        coverage["elementType"] = element_type
    coverage["status"] = "COMPLETE"

    fact: dict[str, object] = {
        "scope": scope,
        "value": value,
        "location": {"nodeId": node_id},
    }
    if unit is not None:
        fact["unit"] = unit
    return DocumentFactSet.from_json(
        {
            "factSchemaVersion": 2,
            "documentId": "doc",
            "extractor": {"name": "synthetic", "version": "1.0.0"},
            "coverage": [coverage],
            "facts": [fact],
        }
    )


def _plan_element_rule(
    element_type: str | None,
    property_name: str,
    expected: dict[str, object],
    *,
    unit: str | None = None,
    observed: dict[str, object],
) -> object:
    from app.smartfix.planner import plan_corrections
    from app.smartfix.service import parse_rules
    from tests.smartfix.support import analyze, plan_source

    content = _document(_paragraph() + SECTION)
    analysis = analyze(content)
    node_id = analysis.model.paragraphs[0].locator.node_id

    scope: dict[str, object] = {"kind": "ELEMENT", "property": property_name}
    if element_type is not None:
        scope["elementType"] = element_type

    rules = parse_rules([rule("GUARDED", scope, "EQUALS", expected, unit=unit)])
    facts = _element_fact_set(node_id, element_type, property_name, observed, unit)
    return plan_corrections(analysis.model, facts, rules, plan_source(analysis.sha256))


def test_a_reference_entry_is_not_re_spaced_however_safe_the_rule_claims_to_be() -> None:
    plan = _plan_element_rule(
        "REFERENCE_ENTRY",
        "lineSpacing",
        {"type": "NUMBER", "number": 1.5},
        observed={"type": "NUMBER", "number": "1"},
    )
    assert fixability(plan, "GUARDED") == "NOT_SUPPORTED"
    assert reason(plan, "GUARDED") == "SMARTFIX_ELEMENT_TYPE_NOT_EDITABLE"
    assert plan.actions == ()


def test_a_citation_is_not_resized() -> None:
    plan = _plan_element_rule(
        "CITATION",
        "fontSize",
        {"type": "NUMBER", "number": 12},
        unit="POINT",
        observed={"type": "NUMBER", "number": "10"},
    )
    assert fixability(plan, "GUARDED") == "NOT_SUPPORTED"
    assert reason(plan, "GUARDED") == "SMARTFIX_ELEMENT_TYPE_NOT_EDITABLE"
    assert plan.actions == ()


@pytest.mark.parametrize("property_name", ["indentStart", "hangingIndent"])
def test_a_citation_is_not_re_indented(property_name: str) -> None:
    # Indentation is the fix a bibliography would attract first, and it is the
    # one that would most look like a formatting nicety while changing how the
    # reference list reads.
    plan = _plan_element_rule(
        "CITATION",
        property_name,
        {"type": "NUMBER", "number": 12.7},
        unit="MILLIMETRE",
        observed={"type": "NUMBER", "number": "0"},
    )
    assert fixability(plan, "GUARDED") == "NOT_SUPPORTED"
    assert reason(plan, "GUARDED") == "SMARTFIX_ELEMENT_TYPE_NOT_EDITABLE"
    assert plan.actions == ()


def test_an_element_rule_naming_no_element_type_fails_closed() -> None:
    # An unnamed element type must not inherit a generic ELEMENT capability.
    # "Probably a paragraph" is a guess about somebody's document.
    plan = _plan_element_rule(
        None,
        "lineSpacing",
        {"type": "NUMBER", "number": 1.5},
        observed={"type": "NUMBER", "number": "1"},
    )
    assert fixability(plan, "GUARDED") == "NOT_SUPPORTED"
    assert reason(plan, "GUARDED") == "SMARTFIX_ELEMENT_TYPE_NOT_EDITABLE"
    assert plan.actions == ()


def test_an_ordinary_paragraph_rule_is_still_fixable() -> None:
    """The guard is about the rule's element identity, nothing else.

    Run through the real analyzer rather than a synthetic fact set, so this
    says "body paragraphs are corrected exactly as they were before the guard
    existed" rather than "a fabricated fact survived it".
    """
    plan, _ = make_plan(_document(_paragraph(18) + SECTION), (SIZE_RULE,))
    assert fixability(plan, "SIZE") == "FIXABLE"
    assert plan.actions != ()
    assert reason(plan, "SIZE") is None


def test_no_executed_action_ever_targets_a_guarded_element_type() -> None:
    """The manifest-level statement, over every forbidden type and property.

    The per-case tests above prove the refusal; this proves the *absence* of
    actions across the whole matrix, which is what a reviewer actually wants
    to know: nothing SmartFix executes can have come from a citation rule.
    """
    from app.smartfix.capability import CAPABILITIES, FORBIDDEN_ELEMENT_TYPES

    element_properties = sorted(
        {
            capability.property
            for capability in CAPABILITIES
            if "ELEMENT" in capability.scopes and capability.value_kind == "NUMBER"
        }
    )
    assert element_properties, "the registry should still support element properties"

    for element_type in sorted(FORBIDDEN_ELEMENT_TYPES):
        for property_name in element_properties:
            plan = _plan_element_rule(
                element_type,
                property_name,
                {"type": "NUMBER", "number": 1},
                observed={"type": "NUMBER", "number": "999"},
            )
            assert plan.actions == (), f"{element_type}/{property_name} planned an action"
            assert reason(plan, "GUARDED") == "SMARTFIX_ELEMENT_TYPE_NOT_EDITABLE"
