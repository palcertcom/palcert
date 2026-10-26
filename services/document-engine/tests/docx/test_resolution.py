"""Style resolution, units, script handling and locators (§126)."""

from __future__ import annotations

from fractions import Fraction

import pytest

from app.docx.limits import AnalyzerLimits
from app.docx.namespaces import Namespaces, OoxmlProfile, detect_profile, relationship_kind
from app.docx.nodes import NodePath, Story, build_locator, story_prefix
from app.docx.properties import (
    PropertyLayer,
    PropertySource,
    resolve_fonts,
    resolve_run_properties,
    resolve_toggles,
)
from app.docx.rawprops import RawFonts, RawRunProperties, parse_run_properties
from app.docx.script import ScriptChannel, classify, segment
from app.docx.styles import StyleType, parse_styles
from app.docx.theme import DocumentTheme, parse_theme
from app.docx.units import (
    auto_line_to_lines,
    eighth_points_to_points,
    emu_to,
    half_points_to_points,
    parse_int,
    twips_to,
)
from app.docx.warnings import WarningCode, WarningCollector
from app.docx.xmlsafe import parse_xml_bytes
from app.engine.units.registry import Unit, format_exact
from tests.docx.builder import W, style, styles_part, theme_part

NS = Namespaces.for_profile(OoxmlProfile.TRANSITIONAL)
LIMITS = AnalyzerLimits.default()


def _layer(source: PropertySource, style_id: str | None = None, **kwargs: object) -> PropertyLayer:
    return PropertyLayer(
        source=source,
        style_id=style_id,
        run=RawRunProperties(**kwargs),  # type: ignore[arg-type]
    )


# --- exact measurement conversion (§104) ----------------------------------


@pytest.mark.parametrize(
    ("twips", "unit", "expected"),
    [
        (1440, Unit.INCH, "1"),
        (1440, Unit.MILLIMETRE, "25.4"),
        (1440, Unit.POINT, "72"),
        (720, Unit.POINT, "36"),
        (1701, Unit.MILLIMETRE, "30.00375"),
        (0, Unit.MILLIMETRE, "0"),
    ],
)
def test_twips_convert_exactly(twips: int, unit: Unit, expected: str) -> None:
    assert format_exact(twips_to(twips, unit)) == expected


def test_half_points_and_eighth_points() -> None:
    assert half_points_to_points(24) == Fraction(12)
    assert half_points_to_points(23) == Fraction(23, 2)
    assert eighth_points_to_points(4) == Fraction(1, 2)


@pytest.mark.parametrize(
    ("line", "expected"), [(240, "1"), (360, "1.5"), (480, "2"), (276, "1.15")]
)
def test_auto_line_spacing_is_exact(line: int, expected: str) -> None:
    """1.15 spacing is 276/240 exactly; binary floating point cannot say that."""
    assert format_exact(auto_line_to_lines(line)) == expected


def test_emu_conversion_is_exact() -> None:
    assert format_exact(emu_to(914400, Unit.INCH)) == "1"
    assert format_exact(emu_to(2743200, Unit.MILLIMETRE)) == "76.2"


@pytest.mark.parametrize(
    ("value", "expected"),
    [("12", 12), (" 12 ", 12), ("-5", -5), ("abc", None), ("", None), (None, None)],
)
def test_malformed_integers_are_absent_not_zero(value: str | None, expected: int | None) -> None:
    assert parse_int(value) == expected


# --- profiles and relationships -------------------------------------------


def test_profile_detection() -> None:
    assert (
        detect_profile("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}document")
        is OoxmlProfile.TRANSITIONAL
    )
    assert (
        detect_profile("{http://purl.oclc.org/ooxml/wordprocessingml/main}document")
        is OoxmlProfile.STRICT
    )
    assert detect_profile("{urn:something:else}document") is None


def test_relationship_kind_is_profile_independent() -> None:
    transitional = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
    strict = "http://purl.oclc.org/ooxml/officeDocument/relationships/styles"
    assert relationship_kind(transitional) == relationship_kind(strict) == "styles"


# --- script classification (§39, §103) ------------------------------------


@pytest.mark.parametrize(
    ("character", "channel"),
    [
        ("A", ScriptChannel.LATIN),
        ("é", ScriptChannel.LATIN),
        ("ا", ScriptChannel.COMPLEX_SCRIPT),
        ("ي", ScriptChannel.COMPLEX_SCRIPT),
        ("ﻻ", ScriptChannel.COMPLEX_SCRIPT),
        ("א", ScriptChannel.COMPLEX_SCRIPT),
        ("中", ScriptChannel.EAST_ASIAN),
        ("あ", ScriptChannel.EAST_ASIAN),
        ("한", ScriptChannel.EAST_ASIAN),
        (" ", ScriptChannel.NEUTRAL),
    ],
)
def test_script_classification(character: str, channel: ScriptChannel) -> None:
    assert classify(character) is channel


def test_arabic_is_not_classified_by_ascii_range() -> None:
    """The failure mode §39 forbids: guessing script from byte ranges."""
    assert classify("ا") is not ScriptChannel.LATIN


def test_mixed_run_segments_by_script() -> None:
    segments = segment("Hello مرحبا world")
    assert [piece.channel for piece in segments] == [
        ScriptChannel.LATIN,
        ScriptChannel.COMPLEX_SCRIPT,
        ScriptChannel.LATIN,
    ]
    assert [piece.slot for piece in segments] == ["ascii", "cs", "ascii"]


def test_neutral_characters_extend_rather_than_split() -> None:
    assert len(segment("Hello world")) == 1
    assert len(segment("  Hello")) == 1


# --- toggle semantics (§34, §102) -----------------------------------------


def test_two_style_levels_xor_to_off() -> None:
    layers = (
        _layer(PropertySource.DOCUMENT_DEFAULT),
        _layer(PropertySource.PARAGRAPH_STYLE, "Base", toggles={"b": True}),
        _layer(PropertySource.PARAGRAPH_STYLE, "Leaf", toggles={"b": True}),
    )
    assert resolve_toggles(layers)["b"].value is False


def test_one_style_level_is_on() -> None:
    layers = (
        _layer(PropertySource.DOCUMENT_DEFAULT),
        _layer(PropertySource.PARAGRAPH_STYLE, "Base", toggles={"b": True}),
    )
    assert resolve_toggles(layers)["b"].value is True


def test_three_style_levels_xor_back_on() -> None:
    layers = tuple(
        _layer(PropertySource.PARAGRAPH_STYLE, name, toggles={"b": True})
        for name in ("A", "B", "C")
    )
    assert resolve_toggles(layers)["b"].value is True


def test_direct_formatting_is_absolute() -> None:
    layers = (
        _layer(PropertySource.PARAGRAPH_STYLE, "A", toggles={"b": True}),
        _layer(PropertySource.CHARACTER_STYLE, "B", toggles={"b": True}),
        _layer(PropertySource.DIRECT_FORMATTING, None, toggles={"b": False}),
    )
    resolved = resolve_toggles(layers)
    assert resolved["b"].value is False
    assert resolved["b"].source is PropertySource.DIRECT_FORMATTING


def test_absent_is_not_false() -> None:
    """Silence and an explicit false are different instructions (§42)."""
    declared = parse_run_properties(
        parse_xml_bytes(f'<w:rPr {_W}><w:b w:val="0"/></w:rPr>'.encode()), NS
    )
    silent = parse_run_properties(parse_xml_bytes(f"<w:rPr {_W}/>".encode()), NS)
    assert declared.toggles == {"b": False}
    assert "b" not in silent.toggles


_W = f'xmlns:w="{W}"'


# --- fonts and theme (§37) -------------------------------------------------


def test_font_slots_inherit_independently() -> None:
    """A layer setting the Latin face must not erase an inherited cs face."""
    layers = (
        PropertyLayer(
            PropertySource.DOCUMENT_DEFAULT,
            None,
            run=RawRunProperties(fonts=RawFonts(ascii_face="Georgia", complex_script_face="Amiri")),
        ),
        PropertyLayer(
            PropertySource.PARAGRAPH_STYLE,
            "Body",
            run=RawRunProperties(fonts=RawFonts(ascii_face="Calibri")),
        ),
    )
    resolved = resolve_fonts(layers, DocumentTheme.absent(), WarningCollector())
    assert resolved["ascii"].value == "Calibri"
    assert resolved["cs"].value == "Amiri"


def test_theme_tokens_resolve_to_typefaces() -> None:
    theme = parse_theme(parse_xml_bytes(theme_part().encode()), NS)
    warnings = WarningCollector()
    assert theme.resolve("minorHAnsi", warnings) == "Calibri"
    assert theme.resolve("majorHAnsi", warnings) == "Calibri Light"
    assert theme.resolve("minorBidi", warnings) == "Arial"
    assert theme.resolve("majorBidi", warnings) == "Times New Roman"


def test_missing_theme_leaves_the_font_unresolved() -> None:
    warnings = WarningCollector()
    layers = (
        PropertyLayer(
            PropertySource.DOCUMENT_DEFAULT,
            None,
            run=RawRunProperties(fonts=RawFonts(ascii_theme="minorHAnsi")),
        ),
    )
    resolved = resolve_fonts(layers, DocumentTheme.absent(), warnings)
    assert "ascii" not in resolved
    assert warnings.has(WarningCode.THEME_MISSING)


def test_complex_script_size_is_separate_from_latin_size() -> None:
    layers = (
        PropertyLayer(
            PropertySource.DIRECT_FORMATTING,
            None,
            run=RawRunProperties(size_half_points=24, complex_size_half_points=32),
        ),
    )
    effective = resolve_run_properties(layers, DocumentTheme.absent(), WarningCollector())
    assert effective.size_for_slot("ascii") is not None
    assert effective.size_for_slot("ascii").value == Fraction(12)  # type: ignore[union-attr]
    assert effective.size_for_slot("cs").value == Fraction(16)  # type: ignore[union-attr]


# --- style chains (§32, §76) ----------------------------------------------


def _catalogue(body: str, defaults: str = ""):  # type: ignore[no-untyped-def]
    return parse_styles(
        parse_xml_bytes(styles_part(body, defaults).encode()), NS, WarningCollector(), LIMITS
    )


def test_chain_is_root_first() -> None:
    catalogue = _catalogue(
        style("Root", name="Root")
        + style("Middle", name="Middle", based_on="Root")
        + style("Leaf", name="Leaf", based_on="Middle")
    )
    chain = catalogue.chain("Leaf", WarningCollector(), LIMITS, StyleType.PARAGRAPH)
    assert [item.style_id for item in chain] == ["Root", "Middle", "Leaf"]


def test_cycle_is_detected_and_bounded() -> None:
    catalogue = _catalogue(style("A", name="A", based_on="B") + style("B", name="B", based_on="A"))
    warnings = WarningCollector()
    chain = catalogue.chain("A", warnings, LIMITS, StyleType.PARAGRAPH)
    assert len(chain) == 2
    assert warnings.has(WarningCode.STYLE_CYCLE)
    assert catalogue.has_cycle_for("A", LIMITS) is True


def test_missing_parent_ends_the_chain_with_a_warning() -> None:
    catalogue = _catalogue(style("Orphan", name="Orphan", based_on="Nope"))
    warnings = WarningCollector()
    chain = catalogue.chain("Orphan", warnings, LIMITS, StyleType.PARAGRAPH)
    assert [item.style_id for item in chain] == ["Orphan"]
    assert warnings.has(WarningCode.STYLE_PARENT_MISSING)


def test_long_chain_is_cut_at_the_limit() -> None:
    body = "".join(
        style(f"S{index}", name=f"S{index}", based_on=f"S{index + 1}") for index in range(60)
    )
    catalogue = _catalogue(body + style("S60", name="S60"))
    warnings = WarningCollector()
    catalogue.chain("S0", warnings, AnalyzerLimits(max_style_chain_depth=10), StyleType.PARAGRAPH)
    assert warnings.has(WarningCode.STYLE_CHAIN_TOO_DEEP)


def test_wrong_style_type_is_ignored_not_coerced() -> None:
    catalogue = _catalogue(style("Char", style_type="character", name="Char"))
    warnings = WarningCollector()
    chain = catalogue.chain("Char", warnings, LIMITS, StyleType.PARAGRAPH)
    assert chain == ()


def test_default_style_is_recorded() -> None:
    catalogue = _catalogue(style("Normal", name="Normal", default=True))
    assert catalogue.default_for(StyleType.PARAGRAPH) is not None
    assert catalogue.default_for(StyleType.PARAGRAPH).style_id == "Normal"  # type: ignore[union-attr]


# --- locators (§24, §105) --------------------------------------------------


def test_node_ids_are_structural_and_stable() -> None:
    def build() -> list[str]:
        path = NodePath()
        path.push_literal(story_prefix(Story.MAIN_DOCUMENT))
        path.push_literal("body")
        ids: list[str] = []
        for _ in range(3):
            path.push("p")
            ids.append(build_locator(Story.MAIN_DOCUMENT, path.snapshot()).node_id)
            path.pop()
        return ids

    assert build() == ["main/body/p:1", "main/body/p:2", "main/body/p:3"]
    assert build() == build()


def test_ordinals_are_per_kind_within_a_parent() -> None:
    path = NodePath()
    path.push_literal("main")
    path.push_literal("body")
    path.push("p")
    path.pop()
    path.push("tbl")
    path.pop()
    path.push("p")
    assert build_locator(Story.MAIN_DOCUMENT, path.snapshot()).node_id == "main/body/p:2"


def test_stories_do_not_collide() -> None:
    prefixes = {
        story_prefix(Story.MAIN_DOCUMENT),
        story_prefix(Story.HEADER, key="default:1"),
        story_prefix(Story.FOOTER, key="default:1"),
        story_prefix(Story.FOOTNOTE, key="1"),
        story_prefix(Story.ENDNOTE, key="1"),
        story_prefix(Story.TEXTBOX, key="1"),
        story_prefix(Story.COMMENT, key="1"),
    }
    assert len(prefixes) == 7


def test_over_long_paths_are_truncated_and_flagged() -> None:
    deep = tuple(["main"] + [f"p:{index}" for index in range(80)])
    locator = build_locator(Story.MAIN_DOCUMENT, deep)
    assert locator.truncated is True
    assert len(locator.node_id) <= 200
    assert locator.node_id.startswith("main/")
