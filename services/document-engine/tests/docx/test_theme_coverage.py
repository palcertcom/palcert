"""Theme-language resolution and aggregate SmartFix recheck regressions."""

from __future__ import annotations

from typing import Any

import pytest

from app.engine.evaluation.engine import DeterministicRuleEngine
from app.smartfix.mutate import apply_docx_fix_plan
from app.smartfix.service import parse_rules
from tests.docx.builder import A, DocxBuilder, paragraph, settings_part, style, styles_part
from tests.smartfix.support import LIMITS, analyze, element, make_plan, rule

THEME = f'''<a:theme xmlns:a="{A}"><a:themeElements><a:fontScheme name="Test">
<a:majorFont><a:latin typeface="Major Latin"/><a:ea typeface=""/><a:cs typeface=""/>
<a:font script="Arab" typeface="Arabic Heading"/>
<a:font script="Jpan" typeface="Japanese Heading"/></a:majorFont>
<a:minorFont><a:latin typeface="Minor Latin"/><a:ea typeface=""/><a:cs typeface=""/>
<a:font script="Arab" typeface="Arabic Body"/><a:font script="Hebr" typeface="Hebrew Body"/>
<a:font script="Hans" typeface="Simplified Chinese"/>
<a:font script="Hant" typeface="Traditional Chinese"/>
</a:minorFont></a:fontScheme></a:themeElements></a:theme>'''

FAMILY = rule(
    "font", element("fontFamily"), "EQUALS", {"type": "STRING", "text": "Times New Roman"}
)
SIZE = rule("size", element("fontSize"), "EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT")
RULES = (FAMILY, SIZE)
GOOD = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/>'


def _doc(
    body: str,
    *,
    defaults: str = "",
    settings: str = "",
    theme: str | None = THEME,
    extra_styles: str = "",
) -> bytes:
    return DocxBuilder(
        body=body,
        theme=theme,
        settings=settings_part(settings),
        styles=styles_part(
            style("Normal", name="Normal", default=True, run_properties=defaults) + extra_styles
        ),
    ).build()


def _run(text: str, properties: str = GOOD) -> str:
    return f"<w:r><w:rPr>{properties}</w:rPr><w:t>{text}</w:t></w:r>"


def _outcomes(content: bytes, rules: tuple[dict[str, Any], ...] = RULES) -> dict[str, str]:
    facts = analyze(content).fact_set
    engine = DeterministicRuleEngine()
    return {
        r.definition.rule_code: str(engine.evaluate(facts, r.definition).outcome)
        for r in parse_rules(list(rules))
    }


def test_smartfix_recheck_passes_with_an_unused_unresolved_theme_channel() -> None:
    source = _doc(
        "<w:p>"
        + _run("Body", '<w:rFonts w:ascii="Arial" w:cstheme="minorBidi"/><w:sz w:val="28"/>')
        + "</w:p>"
    )
    assert _outcomes(source) == {"font": "FAIL", "size": "FAIL"}
    plan, before = make_plan(source, RULES)
    corrected = apply_docx_fix_plan(source, before.sha256, plan, LIMITS)
    assert _outcomes(corrected.content) == {"font": "PASS", "size": "PASS"}
    assert analyze(corrected.content).model.paragraphs[0].visible_text == "Body"


def test_unresolved_used_font_keeps_coverage_partial_but_not_size() -> None:
    source = _doc(
        "<w:p>"
        + _run("Known")
        + _run("Unknown", '<w:rFonts w:asciiTheme="minorBidi"/><w:sz w:val="24"/>')
        + "</w:p>"
    )
    assert _outcomes(source) == {"font": "INDETERMINATE", "size": "PASS"}


def test_smartfix_cannot_turn_a_real_evidence_gap_into_a_pass() -> None:
    source = _doc(
        "<w:p>"
        + _run("Wrong", '<w:rFonts w:ascii="Arial"/><w:sz w:val="28"/>')
        + _run("Unknown", '<w:rFonts w:asciiTheme="minorBidi"/><w:sz w:val="24"/>')
        + "</w:p>"
    )
    assert _outcomes(source) == {"font": "FAIL", "size": "FAIL"}
    plan, before = make_plan(source, RULES)
    corrected = apply_docx_fix_plan(source, before.sha256, plan, LIMITS)
    assert _outcomes(corrected.content) == {"font": "INDETERMINATE", "size": "PASS"}


@pytest.mark.parametrize(
    "text,property_name,size_property,size_xml",
    [
        ("مرحبا", "fontFamilyComplexScript", "fontSizeComplexScript", '<w:szCs w:val="24"/>'),
        ("漢字", "fontFamilyEastAsian", "fontSize", '<w:sz w:val="24"/>'),
        ("é", "fontFamily", "fontSize", '<w:sz w:val="24"/>'),
    ],
)
def test_missing_font_coverage_follows_the_used_script_channel(
    text: str, property_name: str, size_property: str, size_xml: str
) -> None:
    source = _doc("<w:p>" + _run(text, size_xml) + "</w:p>")
    rules = (
        rule("font", element(property_name), "EQUALS", {"type": "STRING", "text": "Known"}),
        rule(
            "size", element(size_property), "EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT"
        ),
    )
    assert _outcomes(source, rules) == {"font": "INDETERMINATE", "size": "PASS"}


def test_missing_size_does_not_undermine_complete_font_evidence() -> None:
    source = _doc(
        "<w:p>"
        + _run("Known")
        + _run("Unknown", '<w:rFonts w:ascii="Times New Roman"/>')
        + "</w:p>"
    )
    assert _outcomes(source) == {"font": "PASS", "size": "INDETERMINATE"}


def test_missing_fonts_are_not_reported_as_not_applicable() -> None:
    source = _doc("<w:p>" + _run("Unknown", '<w:sz w:val="24"/>') + "</w:p>")
    assert _outcomes(source) == {"font": "INDETERMINATE", "size": "PASS"}


def test_a_heading_font_gap_does_not_undermine_body_font_evidence() -> None:
    body = (
        "<w:p>"
        + _run("Body")
        + '</w:p><w:p><w:pPr><w:pStyle w:val="Heading"/></w:pPr>'
        + _run("Heading", '<w:rFonts w:asciiTheme="minorBidi"/>')
        + "</w:p>"
    )
    source = _doc(
        body,
        extra_styles=style(
            "Heading", name="Heading", paragraph_properties='<w:outlineLvl w:val="0"/>'
        ),
    )
    assert _outcomes(source) == {"font": "PASS", "size": "PASS"}


@pytest.mark.parametrize(
    "wrapper,properties", [("{run}", "<w:vanish/>"), ("<w:del>{run}</w:del>", "")]
)
def test_invisible_text_does_not_create_a_font_gap(wrapper: str, properties: str) -> None:
    hidden = wrapper.format(run=_run("Hidden", properties + '<w:rFonts w:asciiTheme="minorBidi"/>'))
    assert _outcomes(_doc("<w:p>" + _run("Visible") + hidden + "</w:p>")) == {
        "font": "PASS",
        "size": "PASS",
    }


def test_unresolved_override_cannot_reuse_a_lower_priority_literal_font() -> None:
    source = _doc(
        "<w:p>" + _run("Body", '<w:rFonts w:asciiTheme="minorBidi"/>') + "</w:p>", defaults=GOOD
    )
    assert _outcomes(source) == {"font": "INDETERMINATE", "size": "PASS"}


def test_direct_font_overrides_an_unresolved_style_theme() -> None:
    source = _doc(
        "<w:p>" + _run("Body") + "</w:p>", defaults='<w:rFonts w:asciiTheme="minorBidi"/>'
    )
    assert _outcomes(source) == {"font": "PASS", "size": "PASS"}


@pytest.mark.parametrize(
    "attribute,language,token,expected",
    [
        ("bidi", "ar-PS", "minorBidi", "Arabic Body"),
        ("bidi", "AR-ps", "majorBidi", "Arabic Heading"),
        ("bidi", "he-IL", "minorBidi", "Hebrew Body"),
        ("eastAsia", "zh-CN", "minorEastAsia", "Simplified Chinese"),
        ("eastAsia", "zh-Hant-TW", "minorEastAsia", "Traditional Chinese"),
        ("val", "ja-JP", "majorHAnsi", "Japanese Heading"),
        ("val", "en-US", "minorHAnsi", "Minor Latin"),
    ],
)
def test_theme_language_selects_the_supplemental_font(
    attribute: str, language: str, token: str, expected: str
) -> None:
    source = _doc(
        paragraph("Text"),
        defaults=f'<w:rFonts w:asciiTheme="{token}"/><w:sz w:val="24"/>',
        settings=f'<w:themeFontLang w:{attribute}="{language}"/>',
    )
    assert analyze(source).model.paragraphs[0].runs[0].segments[0].font_family == expected


def test_supplemental_font_precedes_the_region_default() -> None:
    source = _doc(
        paragraph("Text"),
        defaults='<w:rFonts w:asciiTheme="majorBidi"/>',
        settings='<w:themeFontLang w:bidi="ar-PS"/>',
        theme=THEME.replace('<a:cs typeface=""/>', '<a:cs typeface="Default CS"/>'),
    )
    assert analyze(source).model.paragraphs[0].runs[0].segments[0].font_family == "Arabic Heading"


@pytest.mark.parametrize("language", [None, "zz-ZZ", "zh", "ar-x-Hebr", "und"])
def test_ambiguous_or_absent_language_never_selects_an_arbitrary_supplemental_font(
    language: str | None,
) -> None:
    settings = "" if language is None else f'<w:themeFontLang w:bidi="{language}"/>'
    source = _doc(
        paragraph("Text"),
        defaults='<w:rFonts w:asciiTheme="minorBidi"/><w:sz w:val="24"/>',
        settings=settings,
    )
    # ar-x-Hebr is Arabic with private-use data, not an explicit Hebrew script.
    expected = "Arabic Body" if language == "ar-x-Hebr" else None
    assert analyze(source).model.paragraphs[0].runs[0].segments[0].font_family == expected


def test_conflicting_supplemental_fonts_are_not_arbitrarily_selected() -> None:
    theme = THEME.replace(
        '<a:font script="Arab" typeface="Arabic Body"/>',
        '<a:font script="Arab" typeface="Arabic Body"/><a:font script="Arab" typeface="Other"/>',
    )
    source = _doc(
        paragraph("Text"),
        defaults='<w:rFonts w:asciiTheme="minorBidi"/>',
        settings='<w:themeFontLang w:bidi="ar-PS"/>',
        theme=theme,
    )
    assert analyze(source).model.paragraphs[0].runs[0].segments[0].font_family is None
