"""Reading one ``w:rPr`` or ``w:pPr`` into declared values (§42, §43).

This layer answers only "what does *this* element declare?". It never
inherits, never defaults and never guesses. Three states are kept strictly
apart, because collapsing them is the single most common way to get DOCX
formatting wrong:

* **declared true** — ``<w:b/>`` or ``<w:b w:val="1"/>``
* **declared false** — ``<w:b w:val="0"/>``, which is a real instruction and
  not the same as silence (§34)
* **absent** — ``None``, meaning "ask the next layer up"

``ST_OnOff`` accepts ``1``/``0``, ``true``/``false``, ``on``/``off``, and an
omitted ``w:val`` means true.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from xml.etree.ElementTree import Element

from app.docx.namespaces import Namespaces
from app.docx.units import parse_int

#: Run properties whose multi-level behaviour is XOR rather than override
#: (ECMA-376 Part 1, §17.7.3). Everything else is last-writer-wins.
TOGGLE_PROPERTIES: frozenset[str] = frozenset(
    {
        "b",
        "bCs",
        "caps",
        "emboss",
        "i",
        "iCs",
        "imprint",
        "outline",
        "shadow",
        "smallCaps",
        "strike",
        "vanish",
    }
)

#: On/off run properties that are *not* toggles: they simply override.
ON_OFF_PROPERTIES: frozenset[str] = frozenset({"rtl", "webHidden", "dstrike", "noProof"})

_TRUE = frozenset({"1", "true", "on"})
_FALSE = frozenset({"0", "false", "off"})


def read_on_off(element: Element | None, namespaces: Namespaces) -> bool | None:
    """``ST_OnOff`` semantics: absent element is None, absent ``w:val`` is True."""
    if element is None:
        return None
    value = element.get(namespaces.qn("w:val"))
    if value is None:
        return True
    normalized = value.strip().lower()
    if normalized in _TRUE:
        return True
    if normalized in _FALSE:
        return False
    return None


@dataclass(frozen=True, slots=True)
class RawFonts:
    """A declared ``w:rFonts``: up to four faces and four theme references."""

    ascii_face: str | None = None
    high_ansi_face: str | None = None
    east_asia_face: str | None = None
    complex_script_face: str | None = None
    ascii_theme: str | None = None
    high_ansi_theme: str | None = None
    east_asia_theme: str | None = None
    complex_script_theme: str | None = None
    hint: str | None = None

    @property
    def empty(self) -> bool:
        return not any(
            (
                self.ascii_face,
                self.high_ansi_face,
                self.east_asia_face,
                self.complex_script_face,
                self.ascii_theme,
                self.high_ansi_theme,
                self.east_asia_theme,
                self.complex_script_theme,
            )
        )

    def face_for(self, slot: str) -> str | None:
        return {
            "ascii": self.ascii_face,
            "hAnsi": self.high_ansi_face,
            "eastAsia": self.east_asia_face,
            "cs": self.complex_script_face,
        }[slot]

    def theme_for(self, slot: str) -> str | None:
        return {
            "ascii": self.ascii_theme,
            "hAnsi": self.high_ansi_theme,
            "eastAsia": self.east_asia_theme,
            "cs": self.complex_script_theme,
        }[slot]


@dataclass(frozen=True, slots=True)
class RawRunProperties:
    """Everything one ``w:rPr`` declares."""

    style_id: str | None = None
    fonts: RawFonts = field(default_factory=RawFonts)
    size_half_points: int | None = None
    complex_size_half_points: int | None = None
    toggles: dict[str, bool] = field(default_factory=dict)
    on_off: dict[str, bool] = field(default_factory=dict)
    underline: str | None = None
    color: str | None = None
    highlight: str | None = None
    vertical_alignment: str | None = None
    language: str | None = None
    complex_language: str | None = None
    east_asian_language: str | None = None
    #: True when the run properties carry an ``w:rPrChange`` (§57).
    has_formatting_revision: bool = False

    @staticmethod
    def empty() -> RawRunProperties:
        return RawRunProperties()


@dataclass(frozen=True, slots=True)
class RawSpacing:
    before_twips: int | None = None
    after_twips: int | None = None
    line: int | None = None
    line_rule: str | None = None
    before_auto: bool | None = None
    after_auto: bool | None = None


@dataclass(frozen=True, slots=True)
class RawIndentation:
    start_twips: int | None = None
    end_twips: int | None = None
    first_line_twips: int | None = None
    hanging_twips: int | None = None


@dataclass(frozen=True, slots=True)
class RawNumbering:
    numbering_id: int | None = None
    level: int | None = None


@dataclass(frozen=True, slots=True)
class RawParagraphProperties:
    """Everything one ``w:pPr`` declares."""

    style_id: str | None = None
    alignment: str | None = None
    spacing: RawSpacing = field(default_factory=RawSpacing)
    indentation: RawIndentation = field(default_factory=RawIndentation)
    numbering: RawNumbering | None = None
    on_off: dict[str, bool] = field(default_factory=dict)
    outline_level: int | None = None
    #: The run properties of the paragraph mark itself.
    mark_run: RawRunProperties = field(default_factory=RawRunProperties.empty)
    has_formatting_revision: bool = False
    has_section_properties: bool = False

    @staticmethod
    def empty() -> RawParagraphProperties:
        return RawParagraphProperties()


def _text_value(parent: Element, namespaces: Namespaces, name: str) -> str | None:
    element = parent.find(namespaces.qn(name))
    if element is None:
        return None
    value = element.get(namespaces.qn("w:val"))
    return value.strip() if value and value.strip() else None


def parse_run_properties(rpr: Element | None, namespaces: Namespaces) -> RawRunProperties:
    """Read one ``w:rPr``."""
    if rpr is None:
        return RawRunProperties.empty()

    fonts_element = rpr.find(namespaces.qn("w:rFonts"))
    fonts = RawFonts()
    if fonts_element is not None:
        fonts = RawFonts(
            ascii_face=fonts_element.get(namespaces.qn("w:ascii")),
            high_ansi_face=fonts_element.get(namespaces.qn("w:hAnsi")),
            east_asia_face=fonts_element.get(namespaces.qn("w:eastAsia")),
            complex_script_face=fonts_element.get(namespaces.qn("w:cs")),
            ascii_theme=fonts_element.get(namespaces.qn("w:asciiTheme")),
            high_ansi_theme=fonts_element.get(namespaces.qn("w:hAnsiTheme")),
            east_asia_theme=fonts_element.get(namespaces.qn("w:eastAsiaTheme")),
            complex_script_theme=fonts_element.get(namespaces.qn("w:cstheme")),
            hint=fonts_element.get(namespaces.qn("w:hint")),
        )

    toggles: dict[str, bool] = {}
    for name in sorted(TOGGLE_PROPERTIES):
        value = read_on_off(rpr.find(namespaces.qn(f"w:{name}")), namespaces)
        if value is not None:
            toggles[name] = value

    on_off: dict[str, bool] = {}
    for name in sorted(ON_OFF_PROPERTIES):
        value = read_on_off(rpr.find(namespaces.qn(f"w:{name}")), namespaces)
        if value is not None:
            on_off[name] = value

    size = rpr.find(namespaces.qn("w:sz"))
    size_cs = rpr.find(namespaces.qn("w:szCs"))
    language = rpr.find(namespaces.qn("w:lang"))

    return RawRunProperties(
        style_id=_text_value(rpr, namespaces, "w:rStyle"),
        fonts=fonts,
        size_half_points=parse_int(size.get(namespaces.qn("w:val")) if size is not None else None),
        complex_size_half_points=parse_int(
            size_cs.get(namespaces.qn("w:val")) if size_cs is not None else None
        ),
        toggles=toggles,
        on_off=on_off,
        underline=_text_value(rpr, namespaces, "w:u"),
        color=_text_value(rpr, namespaces, "w:color"),
        highlight=_text_value(rpr, namespaces, "w:highlight"),
        vertical_alignment=_text_value(rpr, namespaces, "w:vertAlign"),
        language=language.get(namespaces.qn("w:val")) if language is not None else None,
        complex_language=(language.get(namespaces.qn("w:bidi")) if language is not None else None),
        east_asian_language=(
            language.get(namespaces.qn("w:eastAsia")) if language is not None else None
        ),
        has_formatting_revision=rpr.find(namespaces.qn("w:rPrChange")) is not None,
    )


#: Paragraph on/off properties. None is a toggle: they override normally.
PARAGRAPH_ON_OFF: frozenset[str] = frozenset(
    {"keepNext", "keepLines", "widowControl", "pageBreakBefore", "bidi", "suppressLineNumbers"}
)


def parse_paragraph_properties(
    ppr: Element | None, namespaces: Namespaces
) -> RawParagraphProperties:
    """Read one ``w:pPr``."""
    if ppr is None:
        return RawParagraphProperties.empty()

    spacing_element = ppr.find(namespaces.qn("w:spacing"))
    spacing = RawSpacing()
    if spacing_element is not None:
        spacing = RawSpacing(
            before_twips=parse_int(spacing_element.get(namespaces.qn("w:before"))),
            after_twips=parse_int(spacing_element.get(namespaces.qn("w:after"))),
            line=parse_int(spacing_element.get(namespaces.qn("w:line"))),
            line_rule=spacing_element.get(namespaces.qn("w:lineRule")),
            before_auto=_attribute_on_off(
                spacing_element.get(namespaces.qn("w:beforeAutospacing"))
            ),
            after_auto=_attribute_on_off(spacing_element.get(namespaces.qn("w:afterAutospacing"))),
        )

    indentation_element = ppr.find(namespaces.qn("w:ind"))
    indentation = RawIndentation()
    if indentation_element is not None:
        # "start"/"end" are the Strict spellings; "left"/"right" the
        # Transitional ones. Word writes either, sometimes both.
        indentation = RawIndentation(
            start_twips=_first_int(indentation_element, namespaces, ("w:start", "w:left")),
            end_twips=_first_int(indentation_element, namespaces, ("w:end", "w:right")),
            first_line_twips=_first_int(indentation_element, namespaces, ("w:firstLine",)),
            hanging_twips=_first_int(indentation_element, namespaces, ("w:hanging",)),
        )

    numbering_element = ppr.find(namespaces.qn("w:numPr"))
    numbering: RawNumbering | None = None
    if numbering_element is not None:
        num_id = numbering_element.find(namespaces.qn("w:numId"))
        level = numbering_element.find(namespaces.qn("w:ilvl"))
        numbering = RawNumbering(
            numbering_id=parse_int(
                num_id.get(namespaces.qn("w:val")) if num_id is not None else None
            ),
            level=parse_int(level.get(namespaces.qn("w:val")) if level is not None else None),
        )

    on_off: dict[str, bool] = {}
    for name in sorted(PARAGRAPH_ON_OFF):
        value = read_on_off(ppr.find(namespaces.qn(f"w:{name}")), namespaces)
        if value is not None:
            on_off[name] = value

    outline = ppr.find(namespaces.qn("w:outlineLvl"))

    return RawParagraphProperties(
        style_id=_text_value(ppr, namespaces, "w:pStyle"),
        alignment=_text_value(ppr, namespaces, "w:jc"),
        spacing=spacing,
        indentation=indentation,
        numbering=numbering,
        on_off=on_off,
        outline_level=parse_int(
            outline.get(namespaces.qn("w:val")) if outline is not None else None
        ),
        mark_run=parse_run_properties(ppr.find(namespaces.qn("w:rPr")), namespaces),
        has_formatting_revision=ppr.find(namespaces.qn("w:pPrChange")) is not None,
        has_section_properties=ppr.find(namespaces.qn("w:sectPr")) is not None,
    )


def _attribute_on_off(value: str | None) -> bool | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in _TRUE:
        return True
    if normalized in _FALSE:
        return False
    return None


def _first_int(element: Element, namespaces: Namespaces, names: tuple[str, ...]) -> int | None:
    for name in names:
        value = parse_int(element.get(namespaces.qn(name)))
        if value is not None:
            return value
    return None
