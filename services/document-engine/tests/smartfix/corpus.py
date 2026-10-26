"""The golden correction corpus (§155–§160).

Each case is a document built from the OOXML it exercises, a small set of
published rules, and a statement of what SmartFix must do about them. The
statement is the point: "the plan has some actions" is not a test, while "the
complex-script size is corrected on w:szCs, the Latin size is left alone, and
the recheck passes both" is.

Every case is executed end to end — analyze, plan, mutate, analyze again,
evaluate again — so a case that claims a rule is fixed has to prove it against
the corrected document rather than against the plan's own optimism.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from tests.docx.builder import DocxBuilder, section_properties, settings_part, style, styles_part
from tests.smartfix.support import document, element, header_part, rule


@dataclass(frozen=True, slots=True)
class Case:
    """One correction scenario, and what must come of it."""

    name: str
    why: str
    build: Callable[[], bytes]
    rules: tuple[dict[str, Any], ...]
    #: Rules that must read FIXABLE and must PASS after the correction.
    fixed: tuple[str, ...] = ()
    #: Rules that must not be acted on, with the reason the user is shown.
    refused: tuple[tuple[str, str, str], ...] = ()
    #: Rules that must not appear in the plan at all, because a correction has
    #: nothing to say about them.
    absent: tuple[str, ...] = ()
    #: Rules that must still PASS afterwards — the regression guard.
    unchanged: tuple[str, ...] = ()
    expected_actions: int | None = None
    #: A document-level refusal, when the source cannot be edited at all.
    refusal: str | None = None
    notes: dict[str, Any] = field(default_factory=dict)


def _docx(body: str, **kwargs: Any) -> Callable[[], bytes]:
    def build() -> bytes:
        return DocxBuilder(body=body, **kwargs).build()

    return build


def _run(text: str, properties: str = "") -> str:
    rpr = f"<w:rPr>{properties}</w:rPr>" if properties else ""
    return f'<w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r>'


SECTION = section_properties()

FONT_SIZE_RULE = rule(
    "BODY_FONT_SIZE", element("fontSize"), "EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT"
)
CS_SIZE_RULE = rule(
    "BODY_FONT_SIZE_CS",
    element("fontSizeComplexScript"),
    "EQUALS",
    {"type": "NUMBER", "number": 14},
    unit="POINT",
)
FONT_FAMILY_RULE = rule(
    "BODY_FONT_FAMILY",
    element("fontFamily"),
    "EQUALS",
    {"type": "STRING", "text": "Times New Roman"},
)
ALIGNMENT_RULE = rule(
    "BODY_ALIGNMENT", element("paragraphAlignment"), "EQUALS", {"type": "STRING", "text": "BOTH"}
)
LINE_SPACING_RULE = rule(
    "LINE_SPACING",
    element("lineSpacing"),
    "EQUALS",
    {"type": "NUMBER", "number": 1.5},
    unit="LINES",
)
MARGIN_RULE = rule(
    "MARGIN_LEFT",
    document("marginLeft"),
    "GREATER_THAN_OR_EQUAL",
    {"type": "NUMBER", "number": 30},
    unit="MILLIMETRE",
)
SPACING_AFTER_RULE = rule(
    "SPACING_AFTER",
    element("spacingAfter"),
    "EQUALS",
    {"type": "NUMBER", "number": 0},
    unit="POINT",
)
INDENT_RULE = rule(
    "FIRST_LINE_INDENT",
    element("firstLineIndent"),
    "EQUALS",
    {"type": "NUMBER", "number": 36},
    unit="POINT",
)
BOLD_RULE = rule("BODY_NOT_BOLD", element("bold"), "EQUALS", {"type": "BOOLEAN", "boolean": False})
UNDERLINE_RULE = rule(
    "NO_UNDERLINE", element("underline"), "EQUALS", {"type": "STRING", "text": "none"}
)


def build_corpus() -> tuple[Case, ...]:
    return (
        Case(
            name="one-run-font-size",
            why="The simplest correction there is: a single run two points too small.",
            build=_docx(_paragraph(_run("Body text", '<w:sz w:val="20"/>')) + SECTION),
            rules=(FONT_SIZE_RULE,),
            fixed=("BODY_FONT_SIZE",),
            expected_actions=1,
        ),
        Case(
            name="every-run-in-the-paragraph",
            why=(
                "The extractor emits one fact per distinct value per paragraph, so three "
                "11 pt runs produce one fact. Correcting only the run the fact points at "
                "would leave two behind and fail the recheck for reasons the manifest "
                "could not explain."
            ),
            build=_docx(
                _paragraph(
                    _run("One", '<w:sz w:val="22"/>')
                    + _run(" two", '<w:sz w:val="22"/>')
                    + _run(" three", '<w:sz w:val="22"/>')
                )
                + SECTION
            ),
            rules=(FONT_SIZE_RULE,),
            fixed=("BODY_FONT_SIZE",),
            expected_actions=3,
        ),
        Case(
            name="two-wrong-sizes-in-one-paragraph",
            why="Two distinct wrong values are two facts, and both have to be corrected.",
            build=_docx(
                _paragraph(
                    _run("Ten", '<w:sz w:val="20"/>') + _run(" eleven", '<w:sz w:val="22"/>')
                )
                + SECTION
            ),
            rules=(FONT_SIZE_RULE,),
            fixed=("BODY_FONT_SIZE",),
            expected_actions=2,
        ),
        Case(
            name="complex-script-size-is-its-own-channel",
            why=(
                "Arabic text is sized by w:szCs. Writing w:sz would change nothing a "
                "reader sees while the manifest claimed the size was corrected — the "
                "single most dangerous way for this engine to be wrong."
            ),
            build=_docx(
                _paragraph(_run("مرحبا بالعالم", '<w:sz w:val="24"/><w:szCs w:val="20"/>'))
                + SECTION
            ),
            rules=(CS_SIZE_RULE, FONT_SIZE_RULE),
            fixed=("BODY_FONT_SIZE_CS",),
            unchanged=("BODY_FONT_SIZE",),
            expected_actions=1,
            notes={"channel": "COMPLEX_SCRIPT"},
        ),
        Case(
            name="font-family-through-a-theme",
            why=(
                "A theme reference outranks an explicit face, so correcting the face "
                "without removing the theme attribute would write a font nobody sees."
            ),
            build=_docx(
                _paragraph(
                    _run(
                        "Body text",
                        '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/>',
                    )
                )
                + SECTION,
                theme=_THEME,
            ),
            rules=(FONT_FAMILY_RULE,),
            fixed=("BODY_FONT_FAMILY",),
            expected_actions=1,
        ),
        Case(
            name="font-family-from-a-style",
            why=(
                "The wrong face comes from the paragraph style. SmartFix writes direct "
                "formatting on the run rather than editing the style, because a style is "
                "shared and correcting one paragraph must not restyle the whole thesis."
            ),
            build=_docx(
                _paragraph(_run("Body text"), style_id="Body") + SECTION,
                styles=styles_part(
                    style("Body", run_properties='<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>')
                ),
            ),
            rules=(FONT_FAMILY_RULE,),
            fixed=("BODY_FONT_FAMILY",),
            expected_actions=1,
            notes={"stylesUntouched": True},
        ),
        Case(
            name="paragraph-alignment",
            why="A paragraph-level property, written into w:pPr at its schema position.",
            build=_docx(_paragraph(_run("Body text"), properties='<w:jc w:val="left"/>') + SECTION),
            rules=(ALIGNMENT_RULE,),
            fixed=("BODY_ALIGNMENT",),
            expected_actions=1,
        ),
        Case(
            name="line-spacing-keeps-its-rule",
            why=(
                "Line spacing means a multiple of a line under lineRule=auto and a fixed "
                "height under exact. Correcting the number while changing the rule would "
                "change the paragraph in a way nobody asked for."
            ),
            build=_docx(
                _paragraph(
                    _run("Body text"), properties='<w:spacing w:line="240" w:lineRule="auto"/>'
                )
                + SECTION
            ),
            rules=(LINE_SPACING_RULE,),
            fixed=("LINE_SPACING",),
            expected_actions=1,
        ),
        Case(
            name="spacing-after",
            why="A twips-valued paragraph property that lands exactly on zero.",
            build=_docx(
                _paragraph(_run("Body text"), properties='<w:spacing w:after="200"/>') + SECTION
            ),
            rules=(SPACING_AFTER_RULE,),
            fixed=("SPACING_AFTER",),
            expected_actions=1,
        ),
        Case(
            name="first-line-indent-clears-hanging",
            why=(
                "firstLine and hanging are mutually exclusive in effect, and this "
                "paragraph declares both. Correcting the first-line indent without "
                "clearing the hanging one would leave the paragraph's first line "
                "ambiguous, so the correction removes it."
            ),
            build=_docx(
                _paragraph(
                    _run("Body text"), properties='<w:ind w:hanging="720" w:firstLine="240"/>'
                )
                + SECTION
            ),
            rules=(INDENT_RULE,),
            fixed=("FIRST_LINE_INDENT",),
            expected_actions=1,
        ),
        Case(
            name="bold-toggle-off",
            why="A toggle property, written as w:b w:val=0 rather than removed.",
            build=_docx(_paragraph(_run("Body text", "<w:b/>")) + SECTION),
            rules=(BOLD_RULE,),
            fixed=("BODY_NOT_BOLD",),
            expected_actions=1,
        ),
        Case(
            name="underline-off",
            why=(
                "A string-valued run property: the underline style is a name, not a "
                "flag, so the correction writes w:u/@w:val rather than removing it."
            ),
            build=_docx(_paragraph(_run("Body text", '<w:u w:val="single"/>')) + SECTION),
            rules=(UNDERLINE_RULE,),
            fixed=("NO_UNDERLINE",),
            expected_actions=1,
        ),
        Case(
            name="page-margin-rounded-to-twips",
            why=(
                "30 mm is 1700.79 twips, and a document can only hold 1701. The planner "
                "records the value the document will really have, and the rule's "
                "inclusive bound still passes — which is why this margin may be fixed at "
                "all."
            ),
            build=_docx(_paragraph(_run("Body text")) + section_properties(left=1440)),
            rules=(MARGIN_RULE,),
            fixed=("MARGIN_LEFT",),
            expected_actions=1,
        ),
        Case(
            name="margin-equals-is-not-representable",
            why=(
                "The same margin under EQUALS with no tolerance cannot be satisfied: the "
                "nearest twip is 30.004 mm. SmartFix refuses rather than making a change "
                "that would look like a fix and fail the recheck."
            ),
            build=_docx(_paragraph(_run("Body text")) + section_properties(left=1440)),
            rules=(
                rule(
                    "MARGIN_LEFT_EXACT",
                    document("marginLeft"),
                    "EQUALS",
                    {"type": "NUMBER", "number": 30},
                    unit="MILLIMETRE",
                ),
            ),
            refused=(
                (
                    "MARGIN_LEFT_EXACT",
                    "NOT_SUPPORTED",
                    "SMARTFIX_TARGET_NOT_REPRESENTABLE",
                ),
            ),
        ),
        Case(
            name="margin-equals-with-tolerance",
            why="With a tolerance the rounded value satisfies the rule, so it is fixed.",
            build=_docx(_paragraph(_run("Body text")) + section_properties(left=1440)),
            rules=(
                rule(
                    "MARGIN_LEFT_TOLERANT",
                    document("marginLeft"),
                    "EQUALS",
                    {"type": "NUMBER", "number": 30},
                    unit="MILLIMETRE",
                    tolerance=0.1,
                ),
            ),
            fixed=("MARGIN_LEFT_TOLERANT",),
            expected_actions=1,
        ),
        Case(
            name="between-picks-the-nearer-bound",
            why=(
                "A document slightly under the minimum is moved to the minimum, not "
                "dragged to the other end of the permitted range."
            ),
            build=_docx(_paragraph(_run("Body text", '<w:sz w:val="20"/>')) + SECTION),
            rules=(
                rule(
                    "SIZE_RANGE",
                    element("fontSize"),
                    "BETWEEN",
                    {"type": "NUMBER_RANGE", "min": 11, "max": 14},
                    unit="POINT",
                ),
            ),
            fixed=("SIZE_RANGE",),
            expected_actions=1,
            notes={"target": "11"},
        ),
        Case(
            name="font-in-a-set-is-ambiguous",
            why=(
                "IN names a set. Choosing a member would be PalCert deciding what the "
                "author's document should say."
            ),
            build=_docx(
                _paragraph(
                    _run("Body text", '<w:rFonts w:ascii="Comic Sans MS" w:hAnsi="Comic Sans MS"/>')
                )
                + SECTION
            ),
            rules=(
                rule(
                    "FONT_SET",
                    element("fontFamily"),
                    "IN",
                    {"type": "STRING_LIST", "values": ["Arial", "Times New Roman"]},
                ),
            ),
            refused=(("FONT_SET", "AMBIGUOUS_TARGET", "SMARTFIX_OPERATOR_AMBIGUOUS"),),
        ),
        Case(
            name="forbidden-formatting-is-manual-work",
            why=(
                "NOT_EXISTS fails because something is present, and the only way to "
                "satisfy it is to remove it. PalCert does not delete from a thesis, "
                "even when what it would delete is a highlight."
            ),
            build=_docx(_paragraph(_run("Body text", '<w:highlight w:val="yellow"/>')) + SECTION),
            rules=(
                rule(
                    "NO_HIGHLIGHTING",
                    element("highlight"),
                    "NOT_EXISTS",
                    {"type": "NONE"},
                ),
            ),
            refused=(
                (
                    "NO_HIGHLIGHTING",
                    "MANUAL_ACTION_REQUIRED",
                    "SMARTFIX_CONTENT_CHANGE_REQUIRED",
                ),
            ),
        ),
        Case(
            name="a-word-count-is-an-outcome",
            why="A word count is what the author wrote. Nothing here edits it.",
            build=_docx(_paragraph(_run("Body text")) + SECTION),
            rules=(
                rule(
                    "WORD_COUNT",
                    document("wordCount"),
                    "GREATER_THAN_OR_EQUAL",
                    {"type": "NUMBER", "number": 5000},
                    unit="WORDS",
                ),
            ),
            refused=(("WORD_COUNT", "NOT_SUPPORTED", "SMARTFIX_COUNT_NOT_EDITABLE"),),
        ),
        Case(
            name="an-advanced-rule-is-never-executed",
            why=(
                "autofix: SAFE is the standard author's ceiling. ADVANCED is a statement "
                "that the change needs judgement, and this phase has none."
            ),
            build=_docx(_paragraph(_run("Body text", '<w:sz w:val="20"/>')) + SECTION),
            rules=(
                rule(
                    "ADVANCED_SIZE",
                    element("fontSize"),
                    "EQUALS",
                    {"type": "NUMBER", "number": 12},
                    unit="POINT",
                    autofix="ADVANCED",
                ),
            ),
            refused=(("ADVANCED_SIZE", "NOT_SUPPORTED", "SMARTFIX_AUTOFIX_NOT_SAFE"),),
        ),
        Case(
            name="an-ai-assisted-rule-is-never-executed",
            why=(
                "No model decides or performs a document change. An AI-assisted rule "
                "is an explicit unresolved blocker. No change is offered for it."
            ),
            build=_docx(_paragraph(_run("Body text", '<w:sz w:val="20"/>')) + SECTION),
            rules=(
                rule(
                    "AI_SIZE",
                    element("fontSize"),
                    "EQUALS",
                    {"type": "NUMBER", "number": 12},
                    unit="POINT",
                    evaluation_mode="AI_ASSISTED",
                ),
            ),
            refused=(("AI_SIZE", "NOT_SUPPORTED", "SMARTFIX_LOCATION_EVIDENCE_MISSING"),),
            expected_actions=0,
        ),
        Case(
            name="tracked-changes-refuse-the-whole-document",
            why=(
                "A document under revision marks is a conversation between an author and "
                "a supervisor. PalCert does not join it and does not bypass it."
            ),
            build=_docx(
                '<w:p><w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">'
                + _run("Inserted", '<w:sz w:val="20"/>')
                + "</w:ins></w:p>"
                + _paragraph(_run("Body text", '<w:sz w:val="20"/>'))
                + SECTION
            ),
            rules=(FONT_SIZE_RULE,),
            refusal="SMARTFIX_TRACKED_CHANGES_UNSUPPORTED",
        ),
        Case(
            name="a-protected-document-is-refused",
            why="The author asked Word to forbid editing, and PalCert honours that.",
            build=_docx(
                _paragraph(_run("Body text", '<w:sz w:val="20"/>')) + SECTION,
                settings=settings_part(
                    '<w:documentProtection w:edit="readOnly" w:enforcement="1"/>'
                ),
            ),
            rules=(FONT_SIZE_RULE,),
            refusal="SMARTFIX_DOCUMENT_PROTECTED",
        ),
        Case(
            name="several-rules-at-once",
            why=(
                "A real correction is never one property. Size, family, alignment and "
                "margin are planned together, applied in one pass, and all pass the "
                "recheck."
            ),
            build=_docx(
                _paragraph(
                    _run(
                        "Body text", '<w:sz w:val="20"/><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>'
                    ),
                    properties='<w:jc w:val="left"/>',
                )
                + section_properties(left=1440)
            ),
            rules=(FONT_SIZE_RULE, FONT_FAMILY_RULE, ALIGNMENT_RULE, MARGIN_RULE),
            fixed=("BODY_FONT_SIZE", "BODY_FONT_FAMILY", "BODY_ALIGNMENT", "MARGIN_LEFT"),
            expected_actions=4,
        ),
        Case(
            name="a-compliant-document-is-left-alone",
            why=(
                "Nothing to do is a complete answer. A rule the document already "
                "satisfies has no place in a list of intended changes, and the engine "
                "refuses to execute an empty plan rather than producing an identical "
                "'corrected' copy the user would be charged for."
            ),
            build=_docx(_paragraph(_run("Body text", '<w:sz w:val="24"/>')) + SECTION),
            rules=(FONT_SIZE_RULE,),
            unchanged=("BODY_FONT_SIZE",),
            absent=("BODY_FONT_SIZE",),
            expected_actions=0,
        ),
        Case(
            name="headers-are-their-own-story",
            why=(
                "A header paragraph is not body text. Correcting a body rule must not "
                "touch it, and a header's own node id addresses a different part."
            ),
            build=_docx(
                _paragraph(_run("Body text", '<w:sz w:val="20"/>'))
                + section_properties(
                    extra='<w:headerReference w:type="default" r:id="rIdHeaderdefault"/>'
                ),
                headers={
                    "default": header_part(_paragraph(_run("Running head", '<w:sz w:val="20"/>')))
                },
            ),
            rules=(
                FONT_SIZE_RULE,
                rule(
                    "HEADER_FONT_SIZE",
                    element("fontSize", "HEADER"),
                    "EQUALS",
                    {"type": "NUMBER", "number": 10},
                    unit="POINT",
                ),
            ),
            fixed=("BODY_FONT_SIZE",),
            unchanged=("HEADER_FONT_SIZE",),
            expected_actions=1,
        ),
    )


_THEME = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">'
    '<a:themeElements><a:fontScheme name="Office">'
    '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/>'
    '<a:cs typeface="Times New Roman"/></a:majorFont>'
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/>'
    '<a:cs typeface="Arial"/></a:minorFont>'
    "</a:fontScheme></a:themeElements></a:theme>"
)


def _paragraph(body: str, *, style_id: str | None = None, properties: str = "") -> str:
    style_xml = f'<w:pStyle w:val="{style_id}"/>' if style_id else ""
    ppr = f"<w:pPr>{style_xml}{properties}</w:pPr>" if (style_xml or properties) else ""
    return f"<w:p>{ppr}{body}</w:p>"
