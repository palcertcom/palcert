"""The golden DOCX corpus (§98, §99, §101).

Forty-six fixtures, each built from the exact OOXML it exercises, each with a
manifest saying what it is for and what the analyzer must produce from it.
The manifest is the point: a regression that changes effective formatting has
to change an expectation in this file, where a reviewer can see it, rather
than silently changing a number inside an opaque binary.

Expectations are deliberately *specific*. "Some facts were produced" is not a
test; "the body paragraph resolves to Calibri 12 pt with complex-script text
at Arial 13 pt" is.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from tests.docx.builder import (
    DocxBuilder,
    paragraph,
    run,
    section_properties,
    settings_part,
    style,
    styles_part,
    theme_part,
)

NORMAL_RUN = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:sz w:val="24"/><w:szCs w:val="26"/>'


@dataclass(frozen=True, slots=True)
class ExpectedFact:
    """One fact the analyzer must emit."""

    kind: str
    property: str
    value: str
    element_type: str | None = None
    unit: str | None = None

    def matches(self, fact: dict[str, object]) -> bool:
        scope = fact["scope"]
        assert isinstance(scope, dict)
        if scope.get("kind") != self.kind:
            return False
        if (scope.get("property") or scope.get("field")) != self.property:
            return False
        if self.element_type is not None and scope.get("elementType") != self.element_type:
            return False
        if self.unit is not None and fact.get("unit") != self.unit:
            return False
        value = fact["value"]
        assert isinstance(value, dict)
        actual = (
            value.get("text")
            if "text" in value
            else value.get("number")
            if "number" in value
            else value.get("enumValue")
            if "enumValue" in value
            else str(value.get("boolean")).lower()
        )
        return str(actual) == self.value


@dataclass(frozen=True, slots=True)
class Fixture:
    """A golden fixture plus its manifest."""

    identifier: str
    title: str
    #: What behaviour this fixture exercises, in one sentence.
    exercises: str
    build: Callable[[], bytes]
    expected_facts: tuple[ExpectedFact, ...] = ()
    #: Facts that must NOT appear, by (kind, property).
    forbidden_facts: tuple[tuple[str, str], ...] = ()
    expected_warnings: frozenset[str] = frozenset()
    #: Analyzer error code, for fixtures that must fail.
    expected_error: str | None = None
    #: Coverage expectations as (kind, elementType|property|None, status).
    expected_coverage: tuple[tuple[str, str | None, str], ...] = ()
    notes: str = ""


def _document(body: str, **kwargs: object) -> Callable[[], bytes]:
    def build() -> bytes:
        return DocxBuilder(body=body, **kwargs).build()  # type: ignore[arg-type]

    return build


def _fact(
    kind: str, prop: str, value: str, element_type: str | None = None, unit: str | None = None
) -> ExpectedFact:
    return ExpectedFact(kind=kind, property=prop, value=value, element_type=element_type, unit=unit)


BASE_STYLES = styles_part(
    style("Normal", name="Normal", default=True, run_properties=NORMAL_RUN),
    doc_defaults='<w:rPrDefault><w:rPr><w:sz w:val="20"/></w:rPr></w:rPrDefault>',
)


def build_corpus() -> tuple[Fixture, ...]:
    """Every fixture, in the documented order."""
    fixtures: list[Fixture] = []
    add = fixtures.append

    # 01 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="01-minimal",
            title="Minimal document",
            exercises="a package with one empty paragraph and one section parses and analyzes",
            build=_document(paragraph() + section_properties()),
            expected_facts=(
                _fact("DOCUMENT", "sectionCount", "1"),
                _fact("DOCUMENT", "paragraphCount", "1"),
                _fact("DOCUMENT", "pageWidth", "210.008611111111", unit="MILLIMETRE"),
            ),
            expected_coverage=(("PAGE", None, "UNAVAILABLE"),),
        )
    )

    # 02 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="02-doc-defaults",
            title="docDefaults formatting",
            exercises="a run with no style and no direct formatting inherits docDefaults",
            build=_document(
                paragraph("Body"),
                styles=styles_part(
                    "",
                    doc_defaults=(
                        '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>'
                        '<w:sz w:val="22"/></w:rPr></w:rPrDefault>'
                    ),
                ),
            ),
            expected_facts=(
                _fact("ELEMENT", "fontFamily", "Georgia", "PARAGRAPH"),
                _fact("ELEMENT", "fontSize", "11", "PARAGRAPH", "POINT"),
            ),
        )
    )

    # 03 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="03-paragraph-style",
            title="Paragraph style",
            exercises="a paragraph style overrides docDefaults for its paragraphs",
            build=_document(
                paragraph("Styled", style="Body"),
                styles=styles_part(
                    style("Normal", name="Normal", default=True, run_properties=NORMAL_RUN)
                    + style(
                        "Body",
                        name="Body Text",
                        based_on="Normal",
                        run_properties='<w:sz w:val="28"/>',
                    ),
                    doc_defaults='<w:rPrDefault><w:rPr><w:sz w:val="20"/></w:rPr></w:rPrDefault>',
                ),
            ),
            expected_facts=(
                _fact("ELEMENT", "fontSize", "14", "PARAGRAPH", "POINT"),
                _fact("ELEMENT", "fontFamily", "Calibri", "PARAGRAPH"),
                _fact("ELEMENT", "styleId", "Body", "PARAGRAPH"),
            ),
        )
    )

    # 04 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="04-based-on-chain",
            title="basedOn style chain",
            exercises="a three-deep basedOn chain resolves root-first, leaf winning",
            build=_document(
                paragraph("Leaf", style="Leaf"),
                styles=styles_part(
                    style(
                        "Root",
                        name="Root",
                        run_properties='<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="20"/>',
                    )
                    + style(
                        "Middle",
                        name="Middle",
                        based_on="Root",
                        run_properties='<w:sz w:val="24"/>',
                    )
                    + style(
                        "Leaf", name="Leaf", based_on="Middle", run_properties='<w:sz w:val="30"/>'
                    ),
                ),
            ),
            expected_facts=(
                # Font from the root, size from the leaf.
                _fact("ELEMENT", "fontFamily", "Georgia", "PARAGRAPH"),
                _fact("ELEMENT", "fontSize", "15", "PARAGRAPH", "POINT"),
            ),
        )
    )

    # 05 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="05-character-style",
            title="Character style",
            exercises="a character style beats the paragraph style for its run",
            build=_document(
                "<w:p>"
                + '<w:pPr><w:pStyle w:val="Body"/></w:pPr>'
                + run("Emphasised", '<w:rStyle w:val="Strong"/>')
                + "</w:p>",
                styles=styles_part(
                    style("Normal", name="Normal", default=True, run_properties=NORMAL_RUN)
                    + style(
                        "Body", name="Body", based_on="Normal", run_properties='<w:sz w:val="24"/>'
                    )
                    + style(
                        "Strong",
                        style_type="character",
                        name="Strong",
                        run_properties='<w:sz w:val="36"/>',
                    ),
                ),
            ),
            expected_facts=(_fact("ELEMENT", "fontSize", "18", "PARAGRAPH", "POINT"),),
        )
    )

    # 06 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="06-direct-run-formatting",
            title="Direct run formatting",
            exercises="direct formatting overrides every style layer",
            build=_document(
                "<w:p>"
                + '<w:pPr><w:pStyle w:val="Body"/></w:pPr>'
                + run(
                    "Direct",
                    '<w:sz w:val="48"/><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>',
                )
                + "</w:p>",
                styles=styles_part(
                    style("Normal", name="Normal", default=True, run_properties=NORMAL_RUN)
                    + style(
                        "Body", name="Body", based_on="Normal", run_properties='<w:sz w:val="24"/>'
                    ),
                ),
            ),
            expected_facts=(
                _fact("ELEMENT", "fontSize", "24", "PARAGRAPH", "POINT"),
                _fact("ELEMENT", "fontFamily", "Courier New", "PARAGRAPH"),
            ),
        )
    )

    # 07 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="07-explicit-formatting-off",
            title="Explicitly disabled formatting",
            exercises='<w:b w:val="0"/> on the run is false, not "inherit"',
            build=_document(
                "<w:p>"
                + '<w:pPr><w:pStyle w:val="Bolded"/></w:pPr>'
                + run("Not bold", '<w:b w:val="0"/>')
                + "</w:p>",
                styles=styles_part(
                    style("Normal", name="Normal", default=True, run_properties=NORMAL_RUN)
                    + style("Bolded", name="Bolded", based_on="Normal", run_properties="<w:b/>"),
                ),
            ),
            expected_facts=(_fact("ELEMENT", "bold", "false", "PARAGRAPH"),),
        )
    )

    # 08 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="08-toggle-inheritance",
            title="Toggle property inheritance",
            exercises="two style levels each declaring <w:b/> XOR to not bold (ECMA 17.7.3)",
            build=_document(
                paragraph("Toggled", style="Leaf"),
                styles=styles_part(
                    style("Normal", name="Normal", default=True, run_properties=NORMAL_RUN)
                    + style("Base", name="Base", based_on="Normal", run_properties="<w:b/>")
                    + style("Leaf", name="Leaf", based_on="Base", run_properties="<w:b/>"),
                ),
            ),
            expected_facts=(_fact("ELEMENT", "bold", "false", "PARAGRAPH"),),
            notes="The case naive last-writer-wins resolution gets backwards.",
        )
    )

    # 09 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="09-theme-fonts",
            title="Theme fonts",
            exercises="asciiTheme and cstheme resolve through the theme font scheme",
            build=_document(
                paragraph("Themed مرحبا"),
                styles=styles_part(
                    style(
                        "Normal",
                        name="Normal",
                        default=True,
                        run_properties=(
                            '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" '
                            'w:cstheme="minorBidi"/><w:sz w:val="24"/><w:szCs w:val="24"/>'
                        ),
                    )
                ),
                theme=theme_part(minor_latin="Aptos", minor_cs="Dubai"),
            ),
            expected_facts=(
                _fact("ELEMENT", "fontFamily", "Aptos", "PARAGRAPH"),
                _fact("ELEMENT", "fontFamilyComplexScript", "Dubai", "PARAGRAPH"),
            ),
        )
    )

    # 10 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="10-missing-theme",
            title="Missing theme",
            exercises="a theme reference with no theme part leaves the font unresolved",
            build=_document(
                paragraph("Themed"),
                styles=styles_part(
                    style(
                        "Normal",
                        name="Normal",
                        default=True,
                        run_properties='<w:rFonts w:asciiTheme="minorHAnsi"/><w:sz w:val="24"/>',
                    )
                ),
            ),
            forbidden_facts=(("ELEMENT", "fontFamily"),),
            expected_warnings=frozenset({"THEME_MISSING"}),
            expected_coverage=(("ELEMENT", "PARAGRAPH", "PARTIAL"),),
            notes="No font is invented; the domain drops to PARTIAL.",
        )
    )

    # 11 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="11-arabic-complex-script",
            title="Arabic complex-script formatting",
            exercises="Arabic text takes w:cs, w:szCs, w:bCs rather than the Latin channel",
            build=_document(
                "<w:p>"
                + run(
                    "مرحبا بالعالم",
                    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Traditional Arabic"/>'
                    '<w:sz w:val="24"/><w:szCs w:val="32"/><w:bCs/>',
                )
                + "</w:p>",
                styles=BASE_STYLES,
            ),
            expected_facts=(
                _fact("ELEMENT", "fontFamilyComplexScript", "Traditional Arabic", "PARAGRAPH"),
                _fact("ELEMENT", "fontSizeComplexScript", "16", "PARAGRAPH", "POINT"),
                _fact("ELEMENT", "boldComplexScript", "true", "PARAGRAPH"),
            ),
            forbidden_facts=(("ELEMENT", "fontFamily"),),
            notes="No Latin font fact: the run contains no Latin text to attach one to.",
        )
    )

    # 12 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="12-mixed-arabic-english",
            title="Mixed Arabic and English in one run",
            exercises="one run yields two fonts and two sizes, split by script channel",
            build=_document(
                "<w:p>"
                + run(
                    "Hello مرحبا",
                    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Traditional Arabic"/>'
                    '<w:sz w:val="24"/><w:szCs w:val="32"/>',
                )
                + "</w:p>",
                styles=BASE_STYLES,
            ),
            expected_facts=(
                _fact("ELEMENT", "fontFamily", "Calibri", "PARAGRAPH"),
                _fact("ELEMENT", "fontFamilyComplexScript", "Traditional Arabic", "PARAGRAPH"),
                _fact("ELEMENT", "fontSize", "12", "PARAGRAPH", "POINT"),
                _fact("ELEMENT", "fontSizeComplexScript", "16", "PARAGRAPH", "POINT"),
            ),
            notes="The case a single effective font per run would get wrong for half the text.",
        )
    )

    # 13 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="13-rtl-paragraph",
            title="Right-to-left paragraph",
            exercises="w:bidi on the paragraph yields textDirection RTL",
            build=_document(
                paragraph("مرحبا", properties="<w:bidi/>"),
                styles=BASE_STYLES,
            ),
            expected_facts=(_fact("ELEMENT", "textDirection", "RTL", "PARAGRAPH"),),
        )
    )

    # 14 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="14-multiple-sections",
            title="Multiple sections",
            exercises="a paragraph-level sectPr closes a section; the body sectPr closes the last",
            build=_document(
                paragraph("One", properties=section_properties(top=1440))
                + paragraph("Two")
                + section_properties(top=2880),
                styles=BASE_STYLES,
            ),
            expected_facts=(_fact("DOCUMENT", "sectionCount", "2"),),
        )
    )

    # 15 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="15-different-section-margins",
            title="Sections with different margins",
            exercises="two margins are two facts, never one average",
            build=_document(
                paragraph(
                    "One",
                    properties=section_properties(top=1701, bottom=1701, left=1701, right=1701),
                )
                + paragraph("Two")
                + section_properties(top=1418, bottom=1418, left=1418, right=1418),
                styles=BASE_STYLES,
            ),
            expected_facts=(
                _fact("DOCUMENT", "marginTop", "30.00375", unit="MILLIMETRE"),
                _fact("DOCUMENT", "marginTop", "25.011944444444", unit="MILLIMETRE"),
            ),
            notes="Both facts must be present so a consistency rule can catch the difference.",
        )
    )

    # 16 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="16-landscape-section",
            title="Landscape section",
            exercises="w:orient is reported as declared and never inferred from dimensions",
            build=_document(
                paragraph("Wide")
                + section_properties(width=16838, height=11906, orientation="landscape"),
                styles=BASE_STYLES,
            ),
            expected_facts=(_fact("DOCUMENT", "pageOrientation", "LANDSCAPE"),),
        )
    )

    # 17-19 line spacing ----------------------------------------------------
    for identifier, rule, line, expected_value, expected_mode, expected_unit in (
        ("17-line-spacing-auto", "auto", 360, "1.5", "AUTO", "LINES"),
        ("18-line-spacing-exact", "exact", 360, "18", "EXACT", "POINT"),
        ("19-line-spacing-at-least", "atLeast", 360, "18", "AT_LEAST", "POINT"),
    ):
        add(
            Fixture(
                identifier=identifier,
                title=f"Line spacing {rule}",
                exercises=f"w:lineRule={rule} produces {expected_mode} with the right unit",
                build=_document(
                    paragraph(
                        "Spaced",
                        properties=f'<w:spacing w:line="{line}" w:lineRule="{rule}"/>',
                    ),
                    styles=BASE_STYLES,
                ),
                expected_facts=(
                    _fact("ELEMENT", "lineSpacing", expected_value, "PARAGRAPH", expected_unit),
                    _fact("ELEMENT", "lineSpacingMode", expected_mode, "PARAGRAPH"),
                ),
                notes="The three rules are three measurements and must not collapse.",
            )
        )

    # 20 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="20-first-line-indent",
            title="First-line indentation",
            exercises="w:firstLine converts exactly from twips to points",
            build=_document(
                paragraph("Indented", properties='<w:ind w:firstLine="720"/>'),
                styles=BASE_STYLES,
            ),
            expected_facts=(_fact("ELEMENT", "firstLineIndent", "36", "PARAGRAPH", "POINT"),),
        )
    )

    # 21 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="21-hanging-indent",
            title="Hanging indentation",
            exercises="w:hanging is reported separately from w:firstLine",
            build=_document(
                paragraph("Hanging", properties='<w:ind w:left="720" w:hanging="360"/>'),
                styles=BASE_STYLES,
            ),
            expected_facts=(
                _fact("ELEMENT", "hangingIndent", "18", "PARAGRAPH", "POINT"),
                _fact("ELEMENT", "indentStart", "36", "PARAGRAPH", "POINT"),
            ),
        )
    )

    # 22 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="22-heading-outline-levels",
            title="Heading outline levels",
            exercises="outlineLvl 0 and 1 become HEADING level 1 and 2",
            build=_document(
                paragraph("Chapter", style="H1") + paragraph("Section", style="H2"),
                styles=styles_part(
                    style("Normal", name="Normal", default=True, run_properties=NORMAL_RUN)
                    + style(
                        "H1",
                        name="heading 1",
                        based_on="Normal",
                        paragraph_properties='<w:outlineLvl w:val="0"/>',
                    )
                    + style(
                        "H2",
                        name="heading 2",
                        based_on="Normal",
                        paragraph_properties='<w:outlineLvl w:val="1"/>',
                    ),
                ),
            ),
            expected_facts=(
                _fact("ELEMENT", "styleId", "H1", "HEADING"),
                _fact("ELEMENT", "styleId", "H2", "HEADING"),
            ),
            notes="Headings are identified structurally; boldness and size play no part.",
        )
    )

    # 23 --------------------------------------------------------------------
    numbering_part = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0">'
        '<w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>'
        '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
        '<w:num w:numId="2"><w:abstractNumId w:val="0"/>'
        '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>'
        "</w:numbering>"
    )
    add(
        Fixture(
            identifier="23-numbered-list",
            title="Numbered list",
            exercises="numPr resolves through num to abstractNum for format and start",
            build=_document(
                paragraph(
                    "Item",
                    properties='<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>',
                ),
                styles=BASE_STYLES,
                numbering=numbering_part,
            ),
            expected_facts=(
                _fact("ELEMENT", "listLevel", "0", "LIST", "COUNT"),
                _fact("ELEMENT", "numberFormat", "DECIMAL", "LIST"),
                _fact("ELEMENT", "listStartValue", "1", "LIST", "COUNT"),
                # The numbering level's indentation reaches the paragraph.
                _fact("ELEMENT", "indentStart", "36", "PARAGRAPH", "POINT"),
            ),
        )
    )

    # 24 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="24-numbering-override",
            title="Numbering start override",
            exercises="two numIds on one abstractNum resolve to different start values",
            build=_document(
                paragraph(
                    "A", properties='<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'
                )
                + paragraph(
                    "B", properties='<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'
                ),
                styles=BASE_STYLES,
                numbering=numbering_part,
            ),
            expected_facts=(
                _fact("ELEMENT", "listStartValue", "1", "LIST", "COUNT"),
                _fact("ELEMENT", "listStartValue", "5", "LIST", "COUNT"),
            ),
            notes="Same abstract definition, different effective numbering.",
        )
    )

    # 25 --------------------------------------------------------------------
    header_part = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:p><w:r><w:t>Running head</w:t></w:r></w:p></w:hdr>"
    )
    footer_part = header_part.replace("w:hdr", "w:ftr").replace("Running head", "Page footer")
    add(
        Fixture(
            identifier="25-header-footer",
            title="Header and footer",
            exercises="header and footer paragraphs are their own element types",
            build=lambda: DocxBuilder(
                body=paragraph("Body")
                + section_properties(
                    extra='<w:headerReference w:type="default" r:id="rIdHeaderdefault"/>'
                    '<w:footerReference w:type="default" r:id="rIdFooterdefault"/>'
                ),
                styles=BASE_STYLES,
                headers={"default": header_part},
                footers={"default": footer_part},
            ).build(),
            expected_facts=(
                _fact("DOCUMENT", "headerPresent", "true"),
                _fact("DOCUMENT", "footerPresent", "true"),
                _fact("ELEMENT", "fontFamily", "Calibri", "HEADER"),
                _fact("ELEMENT", "fontFamily", "Calibri", "FOOTER"),
            ),
            forbidden_facts=(),
            notes="A header must never answer a rule about body paragraphs.",
        )
    )

    # 26 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="26-first-page-header",
            title="First-page header",
            exercises="a first-page header is read only when titlePg is set",
            build=lambda: DocxBuilder(
                body=paragraph("Body")
                + section_properties(
                    extra='<w:titlePg/><w:headerReference w:type="first" r:id="rIdHeaderfirst"/>'
                ),
                styles=BASE_STYLES,
                headers={"first": header_part.replace("Running head", "Title page head")},
            ).build(),
            expected_facts=(_fact("ELEMENT", "fontFamily", "Calibri", "HEADER"),),
        )
    )

    # 27 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="27-even-odd-header",
            title="Even and odd headers",
            exercises="an even-page header is read only when evenAndOddHeaders is set",
            build=lambda: DocxBuilder(
                body=paragraph("Body")
                + section_properties(
                    extra='<w:headerReference w:type="even" r:id="rIdHeadereven"/>'
                ),
                styles=BASE_STYLES,
                settings=settings_part("<w:evenAndOddHeaders/>"),
                headers={"even": header_part.replace("Running head", "Even head")},
            ).build(),
            expected_facts=(_fact("ELEMENT", "fontFamily", "Calibri", "HEADER"),),
        )
    )

    # 28 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="28-nested-table",
            title="Nested table",
            exercises="a table inside a cell keeps its own locator and counts separately",
            build=_document(
                "<w:tbl><w:tr><w:tc>"
                + paragraph("Outer")
                + "<w:tbl><w:tr><w:tc>"
                + paragraph("Inner")
                + "</w:tc></w:tr></w:tbl>"
                + "</w:tc></w:tr></w:tbl>"
                + paragraph("After"),
                styles=BASE_STYLES,
            ),
            expected_facts=(
                _fact("DOCUMENT", "tableCount", "2"),
                _fact("ELEMENT", "rowCount", "1", "TABLE", "COUNT"),
            ),
        )
    )

    # 29 / 30 ---------------------------------------------------------------
    notes_part = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:{root} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:{item} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:{item}>'
        '<w:{item} w:id="1"><w:p><w:r><w:t>A note</w:t></w:r></w:p></w:{item}>'
        "</w:{root}>"
    )
    add(
        Fixture(
            identifier="29-footnotes",
            title="Footnotes",
            exercises="user footnotes are counted; Word's separators are not",
            build=_document(
                paragraph("Body"),
                styles=BASE_STYLES,
                footnotes=notes_part.format(root="footnotes", item="footnote"),
            ),
            expected_facts=(
                _fact("DOCUMENT", "footnoteCount", "1"),
                _fact("ELEMENT", "fontFamily", "Calibri", "FOOTNOTE"),
            ),
        )
    )
    add(
        Fixture(
            identifier="30-endnotes",
            title="Endnotes",
            exercises="endnotes are their own story and element type, not footnotes",
            build=_document(
                paragraph("Body"),
                styles=BASE_STYLES,
                endnotes=notes_part.format(root="endnotes", item="endnote"),
            ),
            expected_facts=(
                _fact("DOCUMENT", "endnoteCount", "1"),
                _fact("ELEMENT", "fontFamily", "Calibri", "ENDNOTE"),
            ),
            notes="Fact schema v2 exists for exactly this: v1 had no ENDNOTE element type.",
        )
    )

    # 31 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="31-comments",
            title="Comments",
            exercises="comment presence and count are extracted; comment text is not",
            build=_document(
                paragraph("Body"),
                styles=BASE_STYLES,
                comments=(
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                    '<w:comment w:id="1" w:author="Reviewer"><w:p><w:r><w:t>Please revise</w:t></w:r></w:p></w:comment>'
                    "</w:comments>"
                ),
            ),
            expected_facts=(
                _fact("DOCUMENT", "commentsPresent", "true"),
                _fact("DOCUMENT", "commentCount", "1"),
            ),
        )
    )

    # 32 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="32-tracked-changes",
            title="Tracked insertion and deletion",
            exercises="the FINAL view keeps insertions and drops deletions, and counts both",
            build=_document(
                "<w:p>"
                + run("Kept ")
                + '<w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">'
                + run("inserted ")
                + "</w:ins>"
                + '<w:del w:id="2" w:author="A" w:date="2026-01-01T00:00:00Z">'
                + "<w:r><w:delText>deleted</w:delText></w:r>"
                + "</w:del>"
                + "</w:p>",
                styles=BASE_STYLES,
            ),
            expected_facts=(
                _fact("DOCUMENT", "trackedChangesPresent", "true"),
                _fact("DOCUMENT", "trackedInsertionCount", "1"),
                _fact("DOCUMENT", "trackedDeletionCount", "1"),
                # "Kept inserted" is two words; the deleted word is excluded.
                _fact("DOCUMENT", "bodyWordCount", "2", unit="WORDS"),
            ),
        )
    )

    # 33 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="33-hidden-text",
            title="Hidden text",
            exercises="w:vanish text is recorded but excluded from the word count",
            build=_document(
                "<w:p>" + run("Visible ") + run("hidden", "<w:vanish/>") + "</w:p>",
                styles=BASE_STYLES,
            ),
            expected_facts=(
                _fact("DOCUMENT", "hiddenTextPresent", "true"),
                _fact("DOCUMENT", "bodyWordCount", "1", unit="WORDS"),
            ),
        )
    )

    # 34 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="34-toc-field",
            title="Table of contents field",
            exercises="a TOC field is detected without any claim that it is up to date",
            build=_document(
                "<w:p>"
                + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
                + '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r>'
                + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
                + run("Contents")
                + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
                + "</w:p>",
                styles=BASE_STYLES,
            ),
            expected_facts=(_fact("DOCUMENT", "tableOfContentsPresent", "true"),),
        )
    )

    # 35 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="35-page-field",
            title="PAGE field",
            exercises="a PAGE field never becomes a page number fact",
            build=_document(
                "<w:p>" + '<w:fldSimple w:instr=" PAGE ">' + run("7") + "</w:fldSimple>" + "</w:p>",
                styles=BASE_STYLES,
            ),
            forbidden_facts=(("PAGE", "pageNumber"), ("DOCUMENT", "pageCount")),
            expected_coverage=(("PAGE", None, "UNAVAILABLE"),),
            notes="The cached result '7' is a stale snapshot, not a measurement.",
        )
    )

    # 36 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="36-seq-caption",
            title="SEQ caption field",
            exercises="a SEQ Figure field marks its paragraph as a caption",
            build=_document(
                "<w:p>"
                + run("Figure ")
                + '<w:fldSimple w:instr=" SEQ Figure \\* ARABIC ">'
                + run("1")
                + "</w:fldSimple>"
                + run(": A chart")
                + "</w:p>",
                styles=BASE_STYLES,
            ),
            expected_facts=(_fact("ELEMENT", "fontFamily", "Calibri", "CAPTION"),),
            expected_coverage=(("ELEMENT", "CAPTION", "PARTIAL"),),
        )
    )

    # 37 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="37-drawing",
            title="Inline image",
            exercises="a DrawingML image yields extent, placement and alt-text facts",
            build=_document(
                "<w:p><w:r><w:drawing>"
                + '<wp:inline><wp:extent cx="2743200" cy="1828800"/>'
                + '<wp:docPr id="1" name="Picture 1" descr="A chart"/>'
                + '<a:graphic><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
                + '<pic:blipFill><a:blip r:embed="rIdImage"/></pic:blipFill></pic:pic>'
                + "</a:graphicData></a:graphic></wp:inline>"
                + "</w:drawing></w:r></w:p>",
                styles=BASE_STYLES,
            ),
            expected_facts=(
                _fact("DOCUMENT", "figureCount", "1"),
                _fact("ELEMENT", "hasAlternativeText", "true", "FIGURE"),
                _fact("ELEMENT", "figurePlacement", "INLINE", "FIGURE"),
                _fact("ELEMENT", "figureWidth", "76.2", "FIGURE", "MILLIMETRE"),
            ),
            notes="2743200 EMU is exactly 3 inches, which is exactly 76.2 mm.",
        )
    )

    # 38 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="38-equation",
            title="Office Math equation",
            exercises="m:oMath is counted without any attempt to interpret it",
            build=_document(
                "<w:p><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>",
                styles=BASE_STYLES,
            ),
            expected_facts=(_fact("DOCUMENT", "equationCount", "1"),),
        )
    )

    # 39 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="39-content-control",
            title="Content control",
            exercises="a paragraph inside w:sdt is still a paragraph",
            build=_document(
                "<w:sdt><w:sdtPr/><w:sdtContent>"
                + paragraph("Inside a control")
                + "</w:sdtContent></w:sdt>",
                styles=BASE_STYLES,
            ),
            expected_facts=(
                _fact("DOCUMENT", "paragraphCount", "1"),
                _fact("DOCUMENT", "bodyWordCount", "3", unit="WORDS"),
            ),
            notes="Text must not be lost because of its wrapper.",
        )
    )

    # 40 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="40-textbox",
            title="Text box",
            exercises="text-box content is its own story, not body text",
            build=_document(
                "<w:p><w:r><w:pict><v:shape><v:textbox><w:txbxContent>"
                + paragraph("Boxed text here")
                + "</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>",
                styles=BASE_STYLES,
            ),
            expected_facts=(
                _fact("ELEMENT", "fontFamily", "Calibri", "TEXTBOX"),
                # The text box's three words are not body words.
                _fact("DOCUMENT", "bodyWordCount", "0", unit="WORDS"),
            ),
            notes="Fact schema v2's other reason: v1 had no TEXTBOX element type.",
        )
    )

    # 41 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="41-alternate-content",
            title="Markup compatibility AlternateContent",
            exercises="one branch is read, never both, and coverage drops to PARTIAL",
            build=_document(
                "<w:p><w:r><mc:AlternateContent>"
                + '<mc:Choice Requires="wps">'
                + "<w:t>Choice</w:t>"
                + "</mc:Choice>"
                + "<mc:Fallback><w:t>Fallback</w:t></mc:Fallback>"
                + "</mc:AlternateContent></w:r></w:p>",
                styles=BASE_STYLES,
            ),
            expected_coverage=(("ELEMENT", "FIGURE", "PARTIAL"),),
        )
    )

    # 42 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="42-missing-style-parent",
            title="Missing style parent",
            exercises="a basedOn naming a style that is not there warns and stops the chain",
            build=_document(
                paragraph("Orphaned", style="Orphan"),
                styles=styles_part(
                    style("Normal", name="Normal", default=True, run_properties=NORMAL_RUN)
                    + style(
                        "Orphan",
                        name="Orphan",
                        based_on="Nonexistent",
                        run_properties='<w:sz w:val="28"/>',
                    ),
                ),
            ),
            expected_facts=(_fact("ELEMENT", "fontSize", "14", "PARAGRAPH", "POINT"),),
            expected_warnings=frozenset({"STYLE_PARENT_MISSING"}),
            expected_coverage=(("ELEMENT", "PARAGRAPH", "PARTIAL"),),
        )
    )

    # 43 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="43-style-cycle",
            title="Style cycle",
            exercises="A basedOn B basedOn A is detected, bounded and reported",
            build=_document(
                paragraph("Cyclic", style="A"),
                styles=styles_part(
                    style("Normal", name="Normal", default=True, run_properties=NORMAL_RUN)
                    + style("A", name="A", based_on="B", run_properties='<w:sz w:val="28"/>')
                    + style("B", name="B", based_on="A", run_properties='<w:sz w:val="20"/>'),
                ),
            ),
            expected_warnings=frozenset({"STYLE_CYCLE"}),
            expected_coverage=(("ELEMENT", "PARAGRAPH", "PARTIAL"),),
            notes="Must terminate. The document is analyzable; the domain is PARTIAL.",
        )
    )

    # 44 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="44-dangling-relationship",
            title="Dangling numbering reference",
            exercises="a numPr naming a numId with no definition warns and yields no list facts",
            build=_document(
                paragraph(
                    "Item",
                    properties='<w:numPr><w:ilvl w:val="0"/><w:numId w:val="99"/></w:numPr>',
                ),
                styles=BASE_STYLES,
            ),
            forbidden_facts=(("ELEMENT", "numberFormat"),),
            expected_warnings=frozenset({"NUMBERING_REFERENCE_MISSING"}),
            expected_coverage=(("ELEMENT", "LIST", "PARTIAL"),),
        )
    )

    # 45 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="45-malformed-xml",
            title="Malformed document XML",
            exercises="unparseable word/document.xml is a fatal, non-retryable failure",
            build=lambda: DocxBuilder(
                body="<w:p>",
                omit_document_part=True,
                raw_parts={"word/document.xml": b'<?xml version="1.0"?><w:document><w:body><w:p>'},
            ).build(),
            expected_error="DOCX_XML_INVALID",
        )
    )

    # 46 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="46-unknown-extension-markup",
            title="Unknown extension markup",
            exercises="unknown namespaced elements are ignored without losing known content",
            build=_document(
                '<w:p xmlns:ext="urn:vendor:extension">'
                + "<ext:thing><ext:inner/></ext:thing>"
                + run("Still counted")
                + "</w:p>",
                styles=BASE_STYLES,
            ),
            expected_facts=(_fact("DOCUMENT", "bodyWordCount", "2", unit="WORDS"),),
        )
    )

    # 47 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="47-application-default-unresolved",
            title="No font declared anywhere",
            exercises="a property absent from direct, style, docDefaults and theme stays unresolved",
            build=_document(paragraph("Bare"), styles=styles_part("")),
            forbidden_facts=(("ELEMENT", "fontFamily"), ("ELEMENT", "fontSize")),
            notes="Word would show Calibri 11 pt. PalCert reports what the document proves.",
        )
    )

    # 48 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="48-strict-profile",
            title="Strict OOXML profile",
            exercises="an ISO Strict package is recognized and analyzed, not read as empty",
            build=lambda: DocxBuilder(
                body="<w:p><w:r><w:t>Strict profile text</w:t></w:r></w:p>",
                strict_profile=True,
            ).build(),
            expected_facts=(_fact("DOCUMENT", "bodyWordCount", "3", unit="WORDS"),),
        )
    )

    # 49 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="49-mirrored-margins",
            title="Mirrored margins",
            exercises="mirrored margins drop the left/right margin domain to PARTIAL",
            build=_document(
                paragraph("Body") + section_properties(),
                styles=BASE_STYLES,
                settings=settings_part("<w:mirrorMargins/>"),
            ),
            expected_facts=(_fact("DOCUMENT", "mirrorMargins", "true"),),
            expected_warnings=frozenset({"MIRRORED_MARGINS_PAGE_SIDE_UNKNOWN"}),
            expected_coverage=(("DOCUMENT", "marginLeft", "PARTIAL"),),
        )
    )

    # 50 --------------------------------------------------------------------
    add(
        Fixture(
            identifier="50-table-conditional-style",
            title="Table style with conditional formatting",
            exercises="unresolved tblStylePr drops the table domain to PARTIAL",
            build=_document(
                '<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/></w:tblPr>'
                + "<w:tr><w:tc>"
                + paragraph("Cell")
                + "</w:tc></w:tr></w:tbl>",
                styles=styles_part(
                    style("Normal", name="Normal", default=True, run_properties=NORMAL_RUN)
                    + style(
                        "Grid",
                        style_type="table",
                        name="Table Grid",
                        extra='<w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr></w:tblStylePr>',
                    ),
                ),
            ),
            expected_warnings=frozenset({"TABLE_STYLE_CONDITIONAL_IGNORED"}),
            expected_coverage=(("ELEMENT", "TABLE", "PARTIAL"),),
            notes="An honest partial answer beats a confident wrong one.",
        )
    )

    return tuple(fixtures)


CORPUS: tuple[Fixture, ...] = build_corpus()
