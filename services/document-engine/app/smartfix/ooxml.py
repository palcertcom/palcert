"""Writing one formatting property into WordprocessingML.

Everything here is a *targeted direct-formatting* edit: the property is written
on the run, the paragraph or the section that the plan named, and nowhere else.
SmartFix does not rewrite a style, because a style is shared — correcting one
paragraph's font by editing `Normal` would silently restyle the whole thesis,
including the parts that were already right (§39, §40).

Two OOXML facts shape this module.

**Order matters.** ``CT_RPr``, ``CT_PPr`` and ``CT_SectPr`` are sequences, not
bags. A ``w:sz`` appended after ``w:lang`` produces a document Word will open
and a validator will reject, so every element is inserted at its declared
position rather than at the end.

**Script channels are separate.** Latin, complex-script and East Asian
typography live in different attributes and different elements. Writing
``w:sz`` for an Arabic paragraph changes nothing a reader can see, while the
manifest would claim the size was corrected — so the channel is carried on the
action and never guessed here.
"""

from __future__ import annotations

from decimal import Decimal
from fractions import Fraction
from xml.etree.ElementTree import Element

from app.docx.namespaces import Namespaces, OoxmlProfile
from app.docx.units import TWIPS_PER_INCH
from app.engine.units.registry import Unit, convert
from app.smartfix.capability import ActionType, ScriptChannel
from app.smartfix.model import FixAction, FixValue

#: ``CT_RPr`` child order (ECMA-376 Part 1, §17.3.2.28).
RUN_PROPERTY_ORDER: tuple[str, ...] = (
    "rStyle",
    "rFonts",
    "b",
    "bCs",
    "i",
    "iCs",
    "caps",
    "smallCaps",
    "strike",
    "dstrike",
    "outline",
    "shadow",
    "emboss",
    "imprint",
    "noProof",
    "snapToGrid",
    "vanish",
    "webHidden",
    "color",
    "spacing",
    "w",
    "kern",
    "position",
    "sz",
    "szCs",
    "highlight",
    "u",
    "effect",
    "bdr",
    "shd",
    "fitText",
    "vertAlign",
    "rtl",
    "cs",
    "em",
    "lang",
    "eastAsianLayout",
    "specVanish",
    "oMath",
    "rPrChange",
)

#: ``CT_PPr`` child order (ECMA-376 Part 1, §17.3.1.26).
PARAGRAPH_PROPERTY_ORDER: tuple[str, ...] = (
    "pStyle",
    "keepNext",
    "keepLines",
    "pageBreakBefore",
    "framePr",
    "widowControl",
    "numPr",
    "suppressLineNumbers",
    "pBdr",
    "shd",
    "tabs",
    "suppressAutoHyphens",
    "kinsoku",
    "wordWrap",
    "overflowPunct",
    "topLinePunct",
    "autoSpaceDE",
    "autoSpaceDN",
    "bidi",
    "adjustRightInd",
    "snapToGrid",
    "spacing",
    "ind",
    "contextualSpacing",
    "mirrorIndents",
    "suppressOverlap",
    "jc",
    "textDirection",
    "textAlignment",
    "textboxTightWrap",
    "outlineLvl",
    "divId",
    "cnfStyle",
    "rPr",
    "sectPr",
    "pPrChange",
)

#: ``CT_SectPr`` child order (ECMA-376 Part 1, §17.6.17).
SECTION_PROPERTY_ORDER: tuple[str, ...] = (
    "footnotePr",
    "endnotePr",
    "type",
    "pgSz",
    "pgMar",
    "paperSrc",
    "pgBorders",
    "lnNumType",
    "pgNumType",
    "cols",
    "formProt",
    "vAlign",
    "noEndnote",
    "titlePg",
    "textDirection",
    "bidi",
    "rtlGutter",
    "docGrid",
    "printerSettings",
    "sectPrChange",
)

#: Which rFonts attributes a channel governs. Latin text is addressed by two
#: attributes at once because Word splits the ASCII and high-ANSI ranges, and
#: setting only one leaves accented Latin on the old face.
_FONT_ATTRIBUTES: dict[ScriptChannel, tuple[str, ...]] = {
    ScriptChannel.LATIN: ("ascii", "hAnsi"),
    ScriptChannel.COMPLEX_SCRIPT: ("cs",),
    ScriptChannel.EAST_ASIAN: ("eastAsia",),
}

#: The theme attribute that would otherwise win over an explicit face.
_FONT_THEME_ATTRIBUTES: dict[ScriptChannel, tuple[str, ...]] = {
    ScriptChannel.LATIN: ("asciiTheme", "hAnsiTheme"),
    ScriptChannel.COMPLEX_SCRIPT: ("cstheme",),
    ScriptChannel.EAST_ASIAN: ("eastAsiaTheme",),
}


class UnwritableValueError(ValueError):
    """The value cannot be expressed in OOXML without inventing precision."""


def _local(tag: str) -> str:
    return tag.rpartition("}")[2]


def ensure_child(
    parent: Element, name: str, namespaces: Namespaces, order: tuple[str, ...]
) -> Element:
    """Find or create ``parent``'s ``w:name`` child at its schema position."""
    qualified = namespaces.qn(f"w:{name}")
    existing = parent.find(qualified)
    if existing is not None:
        return existing

    position = order.index(name)
    insert_at = len(parent)
    for index, child in enumerate(parent):
        local = _local(child.tag)
        if local in order and order.index(local) > position:
            insert_at = index
            break
    element = Element(qualified)
    parent.insert(insert_at, element)
    return element


def ensure_run_properties(run: Element, namespaces: Namespaces) -> Element:
    """A run's ``w:rPr``, created as its first child if it has none."""
    qualified = namespaces.qn("w:rPr")
    existing = run.find(qualified)
    if existing is not None:
        return existing
    element = Element(qualified)
    run.insert(0, element)
    return element


def ensure_paragraph_properties(paragraph: Element, namespaces: Namespaces) -> Element:
    """A paragraph's ``w:pPr``, created as its first child if it has none."""
    qualified = namespaces.qn("w:pPr")
    existing = paragraph.find(qualified)
    if existing is not None:
        return existing
    element = Element(qualified)
    paragraph.insert(0, element)
    return element


def _set_val(element: Element, namespaces: Namespaces, value: str) -> None:
    element.set(namespaces.qn("w:val"), value)


def _exact_integer(value: Fraction, what: str) -> int:
    if value.denominator != 1:
        raise UnwritableValueError(f"{what} is not a whole number of OOXML units")
    return int(value)


def half_points(points: Decimal) -> int:
    """Points as ``w:sz``'s half-points, exactly or not at all.

    A half point is the finest size WordprocessingML can express. Rounding
    12.3 pt to 12.5 pt would be PalCert choosing a size nobody asked for, so
    an inexpressible size is refused and the rule reported as unfixable.
    """
    return _exact_integer(Fraction(points) * 2, "a font size in half-points")


def twips_from(value: Decimal, unit: str) -> int:
    """A length as whole twips, rounded to the nearest.

    Twips are integral, and a length in millimetres almost never lands on a
    whole one, so rounding is unavoidable here. It is safe only because the
    planner converts the rounded value *back* and re-evaluates the rule
    against it: a target that would not actually pass after rounding is never
    planned in the first place.
    """
    inches = convert(Fraction(value), Unit(unit), Unit.INCH)
    exact = inches * TWIPS_PER_INCH
    return round(exact)


def length_from_twips(twips: int, unit: str) -> Fraction:
    """The exact length a whole number of twips represents."""
    return convert(Fraction(twips, TWIPS_PER_INCH), Unit.INCH, Unit(unit))


def _on_off(value: bool) -> str:
    return "1" if value else "0"


def _indent_attribute(element: Element, namespaces: Namespaces, preferred: str, legacy: str) -> str:
    """Which of the two spellings of an indent attribute this document uses.

    OOXML Strict renamed ``w:left``/``w:right`` to ``w:start``/``w:end``, and
    Word still writes the old names in Transitional packages. Following the
    element's existing spelling keeps one ``w:ind`` from carrying both, which
    would leave the reader to decide which one meant it.
    """
    if element.get(namespaces.qn(f"w:{legacy}")) is not None:
        return legacy
    if element.get(namespaces.qn(f"w:{preferred}")) is not None:
        return preferred
    return preferred if namespaces.profile is OoxmlProfile.STRICT else legacy


def apply_run_action(run: Element, action: FixAction, namespaces: Namespaces) -> None:
    """Write one run-level property onto one run."""
    rpr = ensure_run_properties(run, namespaces)
    channel = action.script_channel or ScriptChannel.LATIN
    value = action.after

    if action.action_type is ActionType.SET_RUN_FONT_SIZE:
        name = "szCs" if channel is ScriptChannel.COMPLEX_SCRIPT else "sz"
        element = ensure_child(rpr, name, namespaces, RUN_PROPERTY_ORDER)
        _set_val(element, namespaces, str(half_points(_number_of(value))))
        return

    if action.action_type is ActionType.SET_RUN_FONT_FAMILY:
        fonts = ensure_child(rpr, "rFonts", namespaces, RUN_PROPERTY_ORDER)
        for attribute in _FONT_ATTRIBUTES[channel]:
            fonts.set(namespaces.qn(f"w:{attribute}"), _text_of(value))
        for attribute in _FONT_THEME_ATTRIBUTES[channel]:
            # A theme reference on the same slot outranks the explicit face,
            # so leaving it in place would write a font the reader never sees.
            fonts.attrib.pop(namespaces.qn(f"w:{attribute}"), None)
        return

    if action.action_type in (ActionType.SET_RUN_BOLD, ActionType.SET_RUN_ITALIC):
        bold = action.action_type is ActionType.SET_RUN_BOLD
        complex_script = channel is ScriptChannel.COMPLEX_SCRIPT
        name = ("bCs" if complex_script else "b") if bold else ("iCs" if complex_script else "i")
        element = ensure_child(rpr, name, namespaces, RUN_PROPERTY_ORDER)
        _set_val(element, namespaces, _on_off(_flag_of(value)))
        return

    if action.action_type is ActionType.SET_RUN_UNDERLINE:
        element = ensure_child(rpr, "u", namespaces, RUN_PROPERTY_ORDER)
        _set_val(element, namespaces, _text_of(value))
        return

    raise UnwritableValueError(f"{action.action_type} is not a run-level action")


def apply_paragraph_action(
    paragraph: Element, action: FixAction, namespaces: Namespaces, *, line_rule: str
) -> None:
    """Write one paragraph-level property onto one paragraph."""
    ppr = ensure_paragraph_properties(paragraph, namespaces)
    value = action.after
    kind = action.action_type

    if kind is ActionType.SET_PARAGRAPH_ALIGNMENT:
        element = ensure_child(ppr, "jc", namespaces, PARAGRAPH_PROPERTY_ORDER)
        _set_val(element, namespaces, _text_of(value).lower())
        return

    if kind is ActionType.SET_PARAGRAPH_LINE_SPACING:
        spacing = ensure_child(ppr, "spacing", namespaces, PARAGRAPH_PROPERTY_ORDER)
        if line_rule == "auto":
            # ``w:line`` under lineRule="auto" is in 240ths of a line, so 1.5
            # spacing is exactly 360 and needs no rounding.
            units = _exact_integer(Fraction(_number_of(value)) * 240, "a line spacing")
        else:
            units = twips_from(_number_of(value), "POINT")
        spacing.set(namespaces.qn("w:line"), str(units))
        spacing.set(namespaces.qn("w:lineRule"), line_rule)
        return

    if kind in (ActionType.SET_PARAGRAPH_SPACING_BEFORE, ActionType.SET_PARAGRAPH_SPACING_AFTER):
        spacing = ensure_child(ppr, "spacing", namespaces, PARAGRAPH_PROPERTY_ORDER)
        attribute = "before" if kind is ActionType.SET_PARAGRAPH_SPACING_BEFORE else "after"
        spacing.set(namespaces.qn(f"w:{attribute}"), str(twips_from(_number_of(value), "POINT")))
        # An "auto" spacing flag tells Word to ignore the number entirely.
        spacing.attrib.pop(namespaces.qn(f"w:{attribute}Autospacing"), None)
        return

    if kind in (
        ActionType.SET_PARAGRAPH_INDENT_START,
        ActionType.SET_PARAGRAPH_INDENT_END,
        ActionType.SET_PARAGRAPH_FIRST_LINE_INDENT,
        ActionType.SET_PARAGRAPH_HANGING_INDENT,
    ):
        indent = ensure_child(ppr, "ind", namespaces, PARAGRAPH_PROPERTY_ORDER)
        twips = twips_from(_number_of(value), "POINT")
        if kind is ActionType.SET_PARAGRAPH_INDENT_START:
            name = _indent_attribute(indent, namespaces, "start", "left")
        elif kind is ActionType.SET_PARAGRAPH_INDENT_END:
            name = _indent_attribute(indent, namespaces, "end", "right")
        elif kind is ActionType.SET_PARAGRAPH_FIRST_LINE_INDENT:
            name = "firstLine"
            # firstLine and hanging are mutually exclusive; leaving the other
            # in place makes the paragraph's first line ambiguous.
            indent.attrib.pop(namespaces.qn("w:hanging"), None)
        else:
            name = "hanging"
            indent.attrib.pop(namespaces.qn("w:firstLine"), None)
        indent.set(namespaces.qn(f"w:{name}"), str(twips))
        return

    raise UnwritableValueError(f"{kind} is not a paragraph-level action")


_SECTION_MARGIN_ATTRIBUTES: dict[ActionType, str] = {
    ActionType.SET_SECTION_MARGIN_TOP: "top",
    ActionType.SET_SECTION_MARGIN_BOTTOM: "bottom",
    ActionType.SET_SECTION_MARGIN_LEFT: "left",
    ActionType.SET_SECTION_MARGIN_RIGHT: "right",
    ActionType.SET_SECTION_HEADER_DISTANCE: "header",
    ActionType.SET_SECTION_FOOTER_DISTANCE: "footer",
}


def apply_section_action(sect_pr: Element, action: FixAction, namespaces: Namespaces) -> None:
    """Write one page-geometry property onto one section."""
    attribute = _SECTION_MARGIN_ATTRIBUTES.get(action.action_type)
    if attribute is None:
        raise UnwritableValueError(f"{action.action_type} is not a section-level action")

    margins = ensure_child(sect_pr, "pgMar", namespaces, SECTION_PROPERTY_ORDER)
    twips = twips_from(_number_of(action.after), action.after.unit or "MILLIMETRE")
    margins.set(namespaces.qn(f"w:{attribute}"), str(twips))


def _number_of(value: FixValue) -> Decimal:
    if value.kind != "NUMBER" or value.number is None:
        raise UnwritableValueError("a numeric action carried no number")
    return value.number


def _text_of(value: FixValue) -> str:
    if value.kind != "STRING" or value.text is None:
        raise UnwritableValueError("a textual action carried no text")
    return value.text


def _flag_of(value: FixValue) -> bool:
    if value.kind != "BOOLEAN" or value.flag is None:
        raise UnwritableValueError("a boolean action carried no flag")
    return bool(value.flag)


__all__ = [
    "PARAGRAPH_PROPERTY_ORDER",
    "RUN_PROPERTY_ORDER",
    "SECTION_PROPERTY_ORDER",
    "UnwritableValueError",
    "apply_paragraph_action",
    "apply_run_action",
    "apply_section_action",
    "ensure_child",
    "ensure_paragraph_properties",
    "ensure_run_properties",
    "half_points",
    "length_from_twips",
    "twips_from",
]
