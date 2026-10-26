"""Reading back the value an action is about.

The planner records, on every action, the effective value it observed. The
mutator re-reads that value before writing and refuses if it has changed —
the document is not the one the user approved a plan for, and applying the
plan anyway would be editing a stranger's file on their behalf.

The same function proves the change afterwards. A manifest built from the plan
would only ever say what PalCert intended; built from this, it says what the
corrected document actually contains (§110).
"""

from __future__ import annotations

from decimal import Decimal
from fractions import Fraction

from app.docx.model import ParagraphNode, RunNode, StructuralModel
from app.docx.properties import LineSpacingMode
from app.smartfix.capability import ActionType, ScriptChannel
from app.smartfix.model import FixAction, FixValue

#: Which ``w:rFonts`` slot each script channel reads. Latin resolves through
#: ``ascii``: Word writes ``hAnsi`` alongside it and the two agree in every
#: document Word produces, so reading one and writing both is the honest
#: pairing rather than a shortcut.
_FONT_SLOT: dict[ScriptChannel, str] = {
    ScriptChannel.LATIN: "ascii",
    ScriptChannel.COMPLEX_SCRIPT: "cs",
    ScriptChannel.EAST_ASIAN: "eastAsia",
}


class NodeLookup:
    """Paragraphs and runs of one model, addressable by node id."""

    __slots__ = ("paragraphs", "runs")

    def __init__(self, model: StructuralModel) -> None:
        self.paragraphs: dict[str, ParagraphNode] = {}
        self.runs: dict[str, RunNode] = {}
        for paragraph in model.paragraphs:
            self.paragraphs[paragraph.locator.node_id] = paragraph
            for run in paragraph.runs:
                self.runs[run.locator.node_id] = run

    def paragraph_of_run(self, node_id: str) -> ParagraphNode | None:
        """The paragraph a run node id belongs to.

        Derived by dropping the final path segment rather than by searching:
        a run id is its paragraph's id plus one segment, by construction.
        """
        parent, separator, _ = node_id.rpartition("/")
        return self.paragraphs.get(parent) if separator else None


def decimal_of(value: Fraction) -> Decimal:
    """An exact rational as a decimal, or its nearest 6-place rendering.

    Every value that reaches here is a length or a multiple that OOXML stored
    as an integer over a power-of-ten-friendly denominator, so the common case
    is exact. The bounded fallback exists so a pathological document cannot
    produce an unbounded string.
    """
    if value.denominator == 1:
        return Decimal(value.numerator)
    quotient = Decimal(value.numerator) / Decimal(value.denominator)
    return quotient.quantize(Decimal("0.000001")).normalize()


def observe(lookup: NodeLookup, action: FixAction, model: StructuralModel) -> FixValue | None:
    """The effective value the action's target currently has, if any.

    ``None`` means no layer of the document declares the property. That is a
    real answer, not a missing one: an absent bold flag is not `false`, and
    the manifest says "(not set)" rather than inventing a prior value.
    """
    kind = action.action_type
    channel = action.script_channel or ScriptChannel.LATIN

    if action.target_scope.value == "RUN_PROPERTIES":
        run = lookup.runs.get(action.node_id)
        if run is None:
            return None
        effective = run.effective
        if kind is ActionType.SET_RUN_FONT_SIZE:
            size = effective.size_for_slot(_FONT_SLOT[channel])
            return None if size is None else FixValue.of_number(decimal_of(size.value), "POINT")
        if kind is ActionType.SET_RUN_FONT_FAMILY:
            font = effective.font_for_slot(_FONT_SLOT[channel])
            return None if font is None else FixValue.of_text(font.value)
        if kind in (ActionType.SET_RUN_BOLD, ActionType.SET_RUN_ITALIC):
            complex_script = channel is ScriptChannel.COMPLEX_SCRIPT
            if kind is ActionType.SET_RUN_BOLD:
                name = "bCs" if complex_script else "b"
            else:
                name = "iCs" if complex_script else "i"
            toggle = effective.toggle(name)
            return None if toggle is None else FixValue.of_flag(toggle.value)
        if kind is ActionType.SET_RUN_UNDERLINE:
            underline = effective.underline
            return None if underline is None else FixValue.of_text(underline.value)
        return None

    if action.target_scope.value == "PARAGRAPH_PROPERTIES":
        paragraph = lookup.paragraphs.get(action.node_id)
        if paragraph is None:
            return None
        properties = paragraph.effective
        if kind is ActionType.SET_PARAGRAPH_ALIGNMENT:
            alignment = properties.alignment
            return None if alignment is None else FixValue.of_text(alignment.value.upper())
        if kind is ActionType.SET_PARAGRAPH_LINE_SPACING:
            spacing = properties.line_spacing
            mode = properties.line_spacing_mode
            if spacing is None or mode is None:
                return None
            unit = "LINES" if mode.value is LineSpacingMode.AUTO else "POINT"
            return FixValue.of_number(decimal_of(spacing.value), unit)
        resolved = {
            ActionType.SET_PARAGRAPH_SPACING_BEFORE: properties.spacing_before_points,
            ActionType.SET_PARAGRAPH_SPACING_AFTER: properties.spacing_after_points,
            ActionType.SET_PARAGRAPH_INDENT_START: properties.indent_start_points,
            ActionType.SET_PARAGRAPH_INDENT_END: properties.indent_end_points,
            ActionType.SET_PARAGRAPH_FIRST_LINE_INDENT: properties.first_line_indent_points,
            ActionType.SET_PARAGRAPH_HANGING_INDENT: properties.hanging_indent_points,
        }.get(kind)
        return None if resolved is None else FixValue.of_number(decimal_of(resolved.value), "POINT")

    if action.section_index is None:
        return None
    if not 0 <= action.section_index < len(model.sections):
        return None
    setup = model.sections[action.section_index].page_setup
    twips = {
        ActionType.SET_SECTION_MARGIN_TOP: setup.margin_top_twips,
        ActionType.SET_SECTION_MARGIN_BOTTOM: setup.margin_bottom_twips,
        ActionType.SET_SECTION_MARGIN_LEFT: setup.margin_left_twips,
        ActionType.SET_SECTION_MARGIN_RIGHT: setup.margin_right_twips,
        ActionType.SET_SECTION_HEADER_DISTANCE: setup.header_distance_twips,
        ActionType.SET_SECTION_FOOTER_DISTANCE: setup.footer_distance_twips,
    }.get(kind)
    if twips is None:
        return None
    from app.docx.units import twips_to_millimetres

    return FixValue.of_number(decimal_of(twips_to_millimetres(twips)), "MILLIMETRE")


def line_rule_for(lookup: NodeLookup, node_id: str) -> str:
    """The ``w:lineRule`` a line-spacing action must keep.

    Line spacing means different things under different rules — a multiple of
    a line under ``auto``, a fixed height under ``exact``. Changing the rule
    while correcting the number would change the paragraph in a way nobody
    asked for, so the document's own rule is carried through.
    """
    paragraph = lookup.paragraphs.get(node_id)
    mode = paragraph.effective.line_spacing_mode if paragraph is not None else None
    if mode is None:
        return "auto"
    return {
        LineSpacingMode.AUTO: "auto",
        LineSpacingMode.EXACT: "exact",
        LineSpacingMode.AT_LEAST: "atLeast",
    }[mode.value]
