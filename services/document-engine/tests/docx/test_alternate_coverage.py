"""Equivalent compatibility branches prove formatting, never image geometry."""

from __future__ import annotations

import pytest

from app.engine.evaluation.engine import DeterministicRuleEngine
from app.smartfix.service import parse_rules
from tests.docx.builder import DocxBuilder
from tests.smartfix.support import analyze, element, rule

BOX = '<w:txbxContent><w:p><w:r><w:rPr><w:sz w:val="{size}"/></w:rPr><w:t>Box</w:t></w:r></w:p></w:txbxContent>'


def content(fallback_size: int = 24, style: str = "", unknown: bool = False) -> bytes:
    native = (
        '<w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><a:graphic><a:graphicData>'
        + BOX.format(size=24)
        + "</a:graphicData></a:graphic></wp:inline></w:drawing>"
    )
    fallback = (
        '<w:pict><v:shape style="'
        + style
        + '"><v:textbox>'
        + BOX.format(size=fallback_size)
        + "</v:textbox></v:shape></w:pict>"
    )
    tag = "w:unknown" if unknown else "mc:Fallback"
    return DocxBuilder(
        body='<w:p><w:r><mc:AlternateContent><mc:Choice Requires="a">'
        + native
        + "</mc:Choice><"
        + tag
        + ">"
        + fallback
        + "</"
        + tag
        + "></mc:AlternateContent></w:r></w:p>"
    ).build()


def verdict(
    data: bytes,
    property_name: str,
    element_type: str,
    expected: dict[str, object],
    unit: str | None = None,
) -> str:
    definition = parse_rules(
        [rule("R", element(property_name, element_type), "EQUALS", expected, unit=unit)]
    )[0].definition
    return str(DeterministicRuleEngine().evaluate(analyze(data).fact_set, definition).outcome)


def test_identical_textboxes_are_complete_but_figure_dimensions_remain_unknown() -> None:
    data = content()
    assert verdict(data, "fontSize", "TEXTBOX", {"type": "NUMBER", "number": 12}, "POINT") == "PASS"
    assert (
        verdict(data, "figurePlacement", "FIGURE", {"type": "STRING", "text": "INLINE"}) == "PASS"
    )
    assert (
        verdict(data, "figureWidth", "FIGURE", {"type": "NUMBER", "number": 25.4}, "MILLIMETRE")
        == "INDETERMINATE"
    )


def test_different_fallback_formatting_remains_unknown() -> None:
    assert (
        verdict(content(28), "fontSize", "TEXTBOX", {"type": "NUMBER", "number": 12}, "POINT")
        != "PASS"
    )
    coverage = analyze(content(28)).fact_set.coverage
    assert any(str(c.element_type) == "TEXTBOX" and str(c.status) == "PARTIAL" for c in coverage)


@pytest.mark.parametrize(
    "style",
    ["position:absolute", "position:relative", "position:absolute;position:static", "unparsed"],
)
def test_different_or_unsupported_placement_remains_unknown(style: str) -> None:
    assert (
        verdict(
            content(style=style), "figurePlacement", "FIGURE", {"type": "STRING", "text": "INLINE"}
        )
        == "INDETERMINATE"
    )


def test_unknown_alternative_branch_never_proves_coverage() -> None:
    data = content(unknown=True)
    assert (
        verdict(data, "fontSize", "TEXTBOX", {"type": "NUMBER", "number": 12}, "POINT")
        == "INDETERMINATE"
    )
    assert (
        verdict(data, "figurePlacement", "FIGURE", {"type": "STRING", "text": "INLINE"})
        == "INDETERMINATE"
    )
