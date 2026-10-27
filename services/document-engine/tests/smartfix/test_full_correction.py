"""One approved plan resolves dependent formatting without weakening rules."""

from __future__ import annotations

import hashlib
import io
import zipfile
from typing import Any

import pytest

from app.docx.xmlsafe import parse_xml_bytes
from app.engine.evaluation.engine import DeterministicRuleEngine
from app.engine.rules.outcomes import Outcome
from app.smartfix.capability import Fixability
from app.smartfix.model import SmartFixPlan
from app.smartfix.mutate import FixError, FixErrorCode, apply_docx_fix_plan
from app.smartfix.service import PlanRequest, parse_rules, plan_for_document
from tests.docx.builder import DocxBuilder, W, section_properties, styles_part
from tests.smartfix.support import LIMITS, analyze, document, element, make_plan, plan_source, rule


def preview(content: bytes, rules: list[dict[str, Any]]) -> SmartFixPlan:
    digest = hashlib.sha256(content).hexdigest()
    return plan_for_document(
        PlanRequest("doc", content, digest, parse_rules(rules), plan_source(digest))
    )


def correct(content: bytes, rules: list[dict[str, Any]]) -> tuple[bytes, SmartFixPlan]:
    plan = preview(content, rules)
    assert plan.rules and all(r.fixability is Fixability.FIXABLE for r in plan.rules)
    outcome = apply_docx_fix_plan(content, hashlib.sha256(content).hexdigest(), plan, LIMITS)
    assert outcome.manifest.integrity.mismatches() == ()
    facts = analyze(outcome.content).fact_set
    engine = DeterministicRuleEngine()
    assert [engine.evaluate(facts, r.definition).outcome for r in parse_rules(rules)] == [
        Outcome.PASS
    ] * len(rules)
    return outcome.content, plan


def test_style_change_exposes_indent_and_both_are_in_the_one_approved_plan() -> None:
    content = DocxBuilder(
        body='<w:p><w:pPr><w:pStyle w:val="Old"/></w:pPr><w:r><w:t>Heading</w:t></w:r></w:p>'
        + section_properties(),
        styles=styles_part(
            '<w:style w:type="paragraph" w:styleId="Old"><w:pPr><w:outlineLvl w:val="1"/><w:ind w:left="720"/></w:pPr></w:style>'
            '<w:style w:type="paragraph" w:styleId="Heading2"><w:pPr><w:outlineLvl w:val="1"/><w:ind w:left="0"/></w:pPr></w:style>'
        ),
    ).build()
    scope = {"kind": "ELEMENT", "elementType": "HEADING", "level": 2}
    rules = [
        rule(
            "STYLE",
            {**scope, "property": "styleId"},
            "EQUALS",
            {"type": "STRING", "text": "Heading2"},
        ),
        rule(
            "INDENT",
            {**scope, "property": "indentStart"},
            "EQUALS",
            {"type": "NUMBER", "number": 36},
            unit="POINT",
        ),
        rule(
            "INDENT.SAME",
            {**scope, "property": "indentStart"},
            "EQUALS",
            {"type": "NUMBER", "number": 36},
            unit="POINT",
        ),
    ]
    output, plan = correct(content, rules)
    assert len(plan.actions) == 3
    assert {a.rule_code for a in plan.actions} == {"STYLE", "INDENT", "INDENT.SAME"}
    assert plan.source.document_sha256 == hashlib.sha256(content).hexdigest()
    assert all(r.action_ids for r in plan.rules)
    assert preview(content, rules).hash_hex() == plan.hash_hex()
    assert apply_docx_fix_plan(content, plan.source.document_sha256, plan).content == output
    assert preview(output, rules).actions == ()


def test_conflicting_values_are_not_offered_as_a_successful_plan() -> None:
    content = DocxBuilder(
        body='<w:p><w:r><w:rPr><w:sz w:val="20"/><w:lang w:val="fr-FR"/></w:rPr><w:t>Text</w:t></w:r></w:p>'
    ).build()
    rules = [
        rule(str(n), element("fontSize"), "EQUALS", {"type": "NUMBER", "number": n}, unit="POINT")
        for n in (12, 14)
    ]
    with pytest.raises(FixError):
        preview(content, rules)


def test_language_channels_and_color_are_corrected_without_rewriting_text() -> None:
    content = DocxBuilder(
        body='<w:p><w:r><w:rPr><w:lang w:val="fr-FR" w:bidi="ar-EG"/><w:color w:val="FF0000" w:themeColor="accent1" w:themeTint="99"/></w:rPr><w:t>Hello مرحبا</w:t></w:r></w:p>'
    ).build()
    rules = [
        rule(prop, element(prop), "EQUALS", {"type": "STRING", "text": value})
        for prop, value in (
            ("language", "en-US"),
            ("languageComplexScript", "ar-SA"),
            ("textColor", "000000"),
        )
    ]
    output, _ = correct(content, rules)
    with zipfile.ZipFile(io.BytesIO(output)) as z:
        xml = z.read("word/document.xml")
    assert b"themeColor=" not in xml and b"themeTint=" not in xml
    assert b"en-US" in xml and b"ar-SA" in xml


def test_exact_twip_distance_is_not_rounded_into_an_unrepresentable_target() -> None:
    content = DocxBuilder(body="<w:p/>" + section_properties()).build()
    correct(
        content,
        [
            rule(
                "HEADER",
                document("headerDistance"),
                "EQUALS",
                {"type": "NUMBER", "number": 12.505972222222},
                unit="MILLIMETRE",
            )
        ],
    )


def test_unapproved_rule_and_unknown_evidence_remain_blockers() -> None:
    content = DocxBuilder(
        body='<w:p><w:r><w:rPr><w:sz w:val="20"/><w:lang w:val="fr-FR"/></w:rPr><w:t>Text</w:t></w:r></w:p>'
    ).build()
    plan = preview(
        content,
        [
            rule(
                "SIZE",
                element("fontSize"),
                "EQUALS",
                {"type": "NUMBER", "number": 12},
                unit="POINT",
            ),
            rule(
                "FONT.UNKNOWN", element("fontFamily"), "EQUALS", {"type": "STRING", "text": "Arial"}
            ),
            rule(
                "LANG",
                element("language"),
                "EQUALS",
                {"type": "STRING", "text": "en-US"},
                autofix="NONE",
            ),
        ],
    )
    assert {r.rule_code for r in plan.rules if r.fixability is not Fixability.FIXABLE} == {
        "FONT.UNKNOWN",
        "LANG",
    }


def test_list_start_clones_one_instance_without_restarting_every_item() -> None:
    numbering = f'<w:numbering xmlns:w="{W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="6"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
    paragraph = '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Item</w:t></w:r></w:p>'
    content = DocxBuilder(body=paragraph * 3, numbering=numbering).build()
    output, _ = correct(
        content,
        [
            rule(
                "START",
                element("listStartValue", "LIST"),
                "EQUALS",
                {"type": "NUMBER", "number": 1},
                unit="COUNT",
            )
        ],
    )
    with zipfile.ZipFile(io.BytesIO(output)) as z:
        root = parse_xml_bytes(z.read("word/numbering.xml"))
        body = parse_xml_bytes(z.read("word/document.xml"))
    assert len(root.findall(f"{{{W}}}num")) == 2
    assert root.find(f"{{{W}}}num").get(f"{{{W}}}numId") == "1"  # type: ignore[union-attr]
    assert {n.get(f"{{{W}}}val") for n in body.iter(f"{{{W}}}numId")} == {"2"}


WP14 = "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
DRAWING = '<w:p><w:r><w:drawing><wp:anchor distL="0"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture"/><a:graphic><a:graphicData/></a:graphic>{extra}</wp:anchor></w:drawing></w:r></w:p>'
FIGURE = rule(
    "INLINE", element("figurePlacement", "FIGURE"), "EQUALS", {"type": "STRING", "text": "INLINE"}
)


def test_inline_conversion_keeps_graphic_and_explicit_dimensions() -> None:
    extra = f'<x:sizeRelH xmlns:x="{WP14}" relativeFrom="margin"><x:pctWidth>0</x:pctWidth></x:sizeRelH>'
    content = DocxBuilder(body=DRAWING.format(extra=extra)).build()
    output, _ = correct(content, [FIGURE])
    assert (
        analyze(output).model.drawings[0].width_emu == analyze(content).model.drawings[0].width_emu
    )


@pytest.mark.parametrize(
    "extra",
    [
        "<w:unknown/>",
        f'<x:sizeRelH xmlns:x="{WP14}" relativeFrom="margin"><x:pctWidth>50000</x:pctWidth></x:sizeRelH>',
    ],
)
def test_unknown_or_relative_drawing_geometry_is_not_discarded(extra: str) -> None:
    with pytest.raises(FixError):
        preview(DocxBuilder(body=DRAWING.format(extra=extra)).build(), [FIGURE])


def test_missing_target_style_is_refused_during_free_preview() -> None:
    content = DocxBuilder(
        body='<w:p><w:pPr><w:pStyle w:val="Old"/></w:pPr><w:r><w:t>Text</w:t></w:r></w:p>',
        styles=styles_part('<w:style w:type="paragraph" w:styleId="Old"/>'),
    ).build()
    with pytest.raises(FixError):
        preview(
            content,
            [rule("STYLE", element("styleId"), "EQUALS", {"type": "STRING", "text": "Missing"})],
        )


@pytest.mark.parametrize("property_name", ["vanish", "webHidden"])
@pytest.mark.parametrize("inherited", [False, True])
def test_style_change_cannot_hide_visible_content(property_name: str, inherited: bool) -> None:
    hidden_properties = f"<w:rPr><w:{property_name}/></w:rPr>"
    target = '<w:basedOn w:val="HiddenBase"/>' if inherited else hidden_properties
    content = DocxBuilder(
        body='<w:p><w:pPr><w:pStyle w:val="Old"/></w:pPr><w:r><w:t>Visible thesis text</w:t></w:r></w:p>',
        styles=styles_part(
            '<w:style w:type="paragraph" w:styleId="Old"/>'
            f'<w:style w:type="paragraph" w:styleId="HiddenBase">{hidden_properties}</w:style>'
            f'<w:style w:type="paragraph" w:styleId="Target">{target}</w:style>'
        ),
    ).build()
    rules = [rule("STYLE", element("styleId"), "EQUALS", {"type": "STRING", "text": "Target"})]
    plan, original = make_plan(content, tuple(rules))
    assert original.model.paragraphs[0].visible_text == "Visible thesis text"
    assert plan.actions
    # Both the preview and an already-approved/AI plan use the same mutator.
    with pytest.raises(FixError) as execution:
        apply_docx_fix_plan(content, original.sha256, plan)
    assert execution.value.code is FixErrorCode.INTEGRITY_PROOF_FAILED
    with pytest.raises(FixError) as planning:
        preview(content, rules)
    assert planning.value.code is FixErrorCode.INTEGRITY_PROOF_FAILED


@pytest.mark.parametrize("property_name", ["vanish", "webHidden"])
def test_style_change_preserves_direct_visibility_override(property_name: str) -> None:
    content = DocxBuilder(
        body=f'<w:p><w:pPr><w:pStyle w:val="Old"/></w:pPr><w:r><w:rPr><w:{property_name} w:val="0"/></w:rPr><w:t>Still visible</w:t></w:r></w:p>',
        styles=styles_part(
            '<w:style w:type="paragraph" w:styleId="Old"/>'
            f'<w:style w:type="paragraph" w:styleId="Target"><w:rPr><w:{property_name}/></w:rPr></w:style>'
        ),
    ).build()
    output, _ = correct(
        content,
        [rule("STYLE", element("styleId"), "EQUALS", {"type": "STRING", "text": "Target"})],
    )
    assert analyze(output).model.paragraphs[0].visible_text == "Still visible"
