"""Effective formatting resolution with provenance (§33, §34, §74, §75).

The question a rule asks is never "what does this paragraph declare?" but
"what formatting does this paragraph *have*?". Answering it means applying
the WordprocessingML style hierarchy in the order the specification gives,
which for run properties is:

    document defaults
      → table style
        → numbering style
          → paragraph style chain (root first)
            → character style chain (root first)
              → direct formatting

and for paragraph properties the same order without the character styles.

Two things make this more than a loop over layers.

**Toggle properties** (§34). ``w:b`` and eleven siblings do not override; they
XOR across the style hierarchy (ECMA-376 Part 1, §17.7.3). A style declaring
``<w:b/>`` based on a style declaring ``<w:b/>`` is *not* bold — naive
last-wins gets that backwards, and gets it backwards on exactly the documents
where a "body text must not be bold" rule matters. Direct formatting is
absolute: ``<w:b w:val="false"/>`` on the run is false, full stop.

**Provenance** (§74). Every resolved value remembers which layer produced it
and, where applicable, which style id. Phase 12 SmartFix cannot safely change
a font without knowing whether it came from direct formatting on one run or
from a style shared by four hundred paragraphs, and asking the document again
later is not the same as knowing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from fractions import Fraction
from typing import Generic, TypeVar

from app.docx.rawprops import (
    RawFonts,
    RawIndentation,
    RawParagraphProperties,
    RawRunProperties,
    RawSpacing,
)
from app.docx.theme import DocumentTheme
from app.docx.units import auto_line_to_lines, half_points_to_points, twips_to_points
from app.docx.warnings import WarningCollector

T = TypeVar("T")

#: The four ``w:rFonts`` slots, in a fixed order so output is deterministic.
FONT_SLOTS: tuple[str, ...] = ("ascii", "hAnsi", "eastAsia", "cs")


class PropertySource(StrEnum):
    """Which layer of the hierarchy produced an effective value (§74)."""

    DIRECT_FORMATTING = "DIRECT_FORMATTING"
    CHARACTER_STYLE = "CHARACTER_STYLE"
    PARAGRAPH_STYLE = "PARAGRAPH_STYLE"
    NUMBERING_STYLE = "NUMBERING_STYLE"
    TABLE_STYLE = "TABLE_STYLE"
    DOCUMENT_DEFAULT = "DOCUMENT_DEFAULT"
    THEME = "THEME"
    OOXML_EXPLICIT_DEFAULT = "OOXML_EXPLICIT_DEFAULT"
    #: The document never says, and OOXML leaves the answer to the
    #: application. PalCert refuses to invent one (§36).
    UNRESOLVED_APPLICATION_DEFAULT = "UNRESOLVED_APPLICATION_DEFAULT"


@dataclass(frozen=True, slots=True)
class Resolved(Generic[T]):
    """A value plus where it came from."""

    value: T
    source: PropertySource
    style_id: str | None = None
    #: Set when a theme reference supplied the value, naming the token used.
    theme_token: str | None = None

    def to_json(self) -> dict[str, object]:
        payload: dict[str, object] = {"source": str(self.source)}
        if self.style_id is not None:
            payload["styleId"] = self.style_id
        if self.theme_token is not None:
            payload["themeToken"] = self.theme_token
        return payload


@dataclass(frozen=True, slots=True)
class PropertyLayer:
    """One level of the hierarchy, already parsed."""

    source: PropertySource
    style_id: str | None
    run: RawRunProperties = field(default_factory=RawRunProperties.empty)
    paragraph: RawParagraphProperties = field(default_factory=RawParagraphProperties.empty)


class LineSpacingMode(StrEnum):
    AUTO = "AUTO"
    EXACT = "EXACT"
    AT_LEAST = "AT_LEAST"


@dataclass(frozen=True, slots=True)
class EffectiveRunProperties:
    """Resolved run formatting.

    Fonts and sizes are kept per script channel rather than collapsed: a run
    holding Arabic and English has two of each, and a single answer would be
    wrong for one of the scripts (§38, §39).
    """

    fonts: dict[str, Resolved[str]] = field(default_factory=dict)
    size_points: Resolved[Fraction] | None = None
    complex_size_points: Resolved[Fraction] | None = None
    toggles: dict[str, Resolved[bool]] = field(default_factory=dict)
    on_off: dict[str, Resolved[bool]] = field(default_factory=dict)
    underline: Resolved[str] | None = None
    color: Resolved[str] | None = None
    highlight: Resolved[str] | None = None
    vertical_alignment: Resolved[str] | None = None
    language: Resolved[str] | None = None
    complex_language: Resolved[str] | None = None

    def toggle(self, name: str) -> Resolved[bool] | None:
        return self.toggles.get(name)

    def font_for_slot(self, slot: str) -> Resolved[str] | None:
        return self.fonts.get(slot)

    def size_for_slot(self, slot: str) -> Resolved[Fraction] | None:
        """``w:szCs`` governs complex script; ``w:sz`` governs the rest."""
        return self.complex_size_points if slot == "cs" else self.size_points


@dataclass(frozen=True, slots=True)
class EffectiveParagraphProperties:
    """Resolved paragraph formatting."""

    style_id: str | None = None
    alignment: Resolved[str] | None = None
    line_spacing: Resolved[Fraction] | None = None
    line_spacing_mode: Resolved[LineSpacingMode] | None = None
    spacing_before_points: Resolved[Fraction] | None = None
    spacing_after_points: Resolved[Fraction] | None = None
    indent_start_points: Resolved[Fraction] | None = None
    indent_end_points: Resolved[Fraction] | None = None
    first_line_indent_points: Resolved[Fraction] | None = None
    hanging_indent_points: Resolved[Fraction] | None = None
    outline_level: Resolved[int] | None = None
    on_off: dict[str, Resolved[bool]] = field(default_factory=dict)
    numbering_id: int | None = None
    numbering_level: int | None = None


def resolve_fonts(
    layers: tuple[PropertyLayer, ...],
    theme: DocumentTheme,
    warnings: WarningCollector,
) -> dict[str, Resolved[str]]:
    """Resolve each ``w:rFonts`` slot independently.

    Per-slot, not per-element: a layer may set the Latin face and say nothing
    about the complex-script face, and the complex-script face must then keep
    inheriting. A theme reference beats a literal face *within the same
    layer*, because that is the attribute Word writes when a theme is in use.
    """
    resolved: dict[str, Resolved[str]] = {}
    for layer in layers:
        fonts: RawFonts = layer.run.fonts
        if fonts.empty:
            continue
        for slot in FONT_SLOTS:
            token = fonts.theme_for(slot)
            if token:
                typeface = theme.resolve(token, warnings)
                if typeface is not None:
                    resolved[slot] = Resolved(
                        value=typeface,
                        source=PropertySource.THEME,
                        style_id=layer.style_id,
                        theme_token=token,
                    )
                    continue
                else:
                    # This layer overrides the slot even when its theme cannot
                    # be resolved. Reusing a lower-priority font would invent
                    # evidence; a later explicit declaration may still resolve it.
                    resolved.pop(slot, None)
                continue
            face = fonts.face_for(slot)
            if face and face.strip():
                resolved[slot] = Resolved(
                    value=face.strip(), source=layer.source, style_id=layer.style_id
                )
    return resolved


def resolve_toggles(layers: tuple[PropertyLayer, ...]) -> dict[str, Resolved[bool]]:
    """OOXML toggle semantics (§34).

    XOR across every style layer; direct formatting is absolute. The recorded
    provenance is the layer that last spoke, which is the one SmartFix would
    have to edit to change the answer.
    """
    accumulated: dict[str, bool] = {}
    provenance: dict[str, Resolved[bool]] = {}

    for layer in layers:
        if layer.source is PropertySource.DIRECT_FORMATTING:
            continue
        for name, declared in sorted(layer.run.toggles.items()):
            current = accumulated.get(name, False)
            accumulated[name] = current != declared  # XOR
            provenance[name] = Resolved(
                value=accumulated[name], source=layer.source, style_id=layer.style_id
            )

    for layer in layers:
        if layer.source is not PropertySource.DIRECT_FORMATTING:
            continue
        for name, declared in sorted(layer.run.toggles.items()):
            accumulated[name] = declared
            provenance[name] = Resolved(
                value=declared, source=PropertySource.DIRECT_FORMATTING, style_id=None
            )

    return {name: provenance[name] for name in sorted(provenance)}


def _resolve_on_off(
    layers: tuple[PropertyLayer, ...], *, paragraph: bool
) -> dict[str, Resolved[bool]]:
    """Plain on/off properties: last writer wins, no XOR."""
    resolved: dict[str, Resolved[bool]] = {}
    for layer in layers:
        source = layer.paragraph.on_off if paragraph else layer.run.on_off
        for name, declared in sorted(source.items()):
            resolved[name] = Resolved(value=declared, source=layer.source, style_id=layer.style_id)
    return {name: resolved[name] for name in sorted(resolved)}


def resolve_run_properties(
    layers: tuple[PropertyLayer, ...],
    theme: DocumentTheme,
    warnings: WarningCollector,
) -> EffectiveRunProperties:
    """Apply the whole hierarchy to one run."""
    size: Resolved[Fraction] | None = None
    complex_size: Resolved[Fraction] | None = None
    underline: Resolved[str] | None = None
    color: Resolved[str] | None = None
    highlight: Resolved[str] | None = None
    vertical_alignment: Resolved[str] | None = None
    language: Resolved[str] | None = None
    complex_language: Resolved[str] | None = None

    for layer in layers:
        run = layer.run
        if run.size_half_points is not None:
            size = Resolved(
                value=half_points_to_points(run.size_half_points),
                source=layer.source,
                style_id=layer.style_id,
            )
        if run.complex_size_half_points is not None:
            complex_size = Resolved(
                value=half_points_to_points(run.complex_size_half_points),
                source=layer.source,
                style_id=layer.style_id,
            )
        if run.underline is not None:
            underline = Resolved(run.underline, layer.source, layer.style_id)
        if run.color is not None:
            color = Resolved(run.color, layer.source, layer.style_id)
        if run.highlight is not None:
            highlight = Resolved(run.highlight, layer.source, layer.style_id)
        if run.vertical_alignment is not None:
            vertical_alignment = Resolved(run.vertical_alignment, layer.source, layer.style_id)
        if run.language is not None:
            language = Resolved(run.language, layer.source, layer.style_id)
        if run.complex_language is not None:
            complex_language = Resolved(run.complex_language, layer.source, layer.style_id)

    return EffectiveRunProperties(
        fonts=resolve_fonts(layers, theme, warnings),
        size_points=size,
        complex_size_points=complex_size,
        toggles=resolve_toggles(layers),
        on_off=_resolve_on_off(layers, paragraph=False),
        underline=underline,
        color=color,
        highlight=highlight,
        vertical_alignment=vertical_alignment,
        language=language,
        complex_language=complex_language,
    )


def _line_spacing(
    spacing: RawSpacing, layer: PropertyLayer
) -> tuple[Resolved[Fraction], Resolved[LineSpacingMode]] | None:
    """``w:spacing/@w:line`` with its rule (§44).

    The three rules are three different measurements and must never collapse
    into one number: ``auto`` is a multiple of a line, ``exact`` and
    ``atLeast`` are physical lengths. A rule comparing "1.5" against a
    document storing "exactly 18 pt" would otherwise silently compare a
    multiplier with a length.
    """
    if spacing.line is None:
        return None
    rule = (spacing.line_rule or "auto").strip().lower()
    if rule == "exact":
        return (
            Resolved(twips_to_points(spacing.line), layer.source, layer.style_id),
            Resolved(LineSpacingMode.EXACT, layer.source, layer.style_id),
        )
    if rule in {"atleast", "at_least"}:
        return (
            Resolved(twips_to_points(spacing.line), layer.source, layer.style_id),
            Resolved(LineSpacingMode.AT_LEAST, layer.source, layer.style_id),
        )
    return (
        Resolved(auto_line_to_lines(spacing.line), layer.source, layer.style_id),
        Resolved(LineSpacingMode.AUTO, layer.source, layer.style_id),
    )


def resolve_paragraph_properties(
    layers: tuple[PropertyLayer, ...],
) -> EffectiveParagraphProperties:
    """Apply the hierarchy to one paragraph."""
    alignment: Resolved[str] | None = None
    line_spacing: Resolved[Fraction] | None = None
    line_mode: Resolved[LineSpacingMode] | None = None
    before: Resolved[Fraction] | None = None
    after: Resolved[Fraction] | None = None
    indent_start: Resolved[Fraction] | None = None
    indent_end: Resolved[Fraction] | None = None
    first_line: Resolved[Fraction] | None = None
    hanging: Resolved[Fraction] | None = None
    outline: Resolved[int] | None = None
    numbering_id: int | None = None
    numbering_level: int | None = None
    style_id: str | None = None

    for layer in layers:
        paragraph = layer.paragraph
        if layer.source is PropertySource.DIRECT_FORMATTING and paragraph.style_id:
            style_id = paragraph.style_id

        spacing: RawSpacing = paragraph.spacing
        if spacing.before_twips is not None:
            before = Resolved(twips_to_points(spacing.before_twips), layer.source, layer.style_id)
        if spacing.after_twips is not None:
            after = Resolved(twips_to_points(spacing.after_twips), layer.source, layer.style_id)
        resolved_line = _line_spacing(spacing, layer)
        if resolved_line is not None:
            line_spacing, line_mode = resolved_line

        indentation: RawIndentation = paragraph.indentation
        if indentation.start_twips is not None:
            indent_start = Resolved(
                twips_to_points(indentation.start_twips), layer.source, layer.style_id
            )
        if indentation.end_twips is not None:
            indent_end = Resolved(
                twips_to_points(indentation.end_twips), layer.source, layer.style_id
            )
        if indentation.first_line_twips is not None:
            first_line = Resolved(
                twips_to_points(indentation.first_line_twips), layer.source, layer.style_id
            )
        if indentation.hanging_twips is not None:
            hanging = Resolved(
                twips_to_points(indentation.hanging_twips), layer.source, layer.style_id
            )

        if paragraph.alignment is not None:
            alignment = Resolved(paragraph.alignment, layer.source, layer.style_id)
        if paragraph.outline_level is not None:
            outline = Resolved(paragraph.outline_level, layer.source, layer.style_id)
        if paragraph.numbering is not None:
            if paragraph.numbering.numbering_id is not None:
                numbering_id = paragraph.numbering.numbering_id
            if paragraph.numbering.level is not None:
                numbering_level = paragraph.numbering.level

    return EffectiveParagraphProperties(
        style_id=style_id,
        alignment=alignment,
        line_spacing=line_spacing,
        line_spacing_mode=line_mode,
        spacing_before_points=before,
        spacing_after_points=after,
        indent_start_points=indent_start,
        indent_end_points=indent_end,
        first_line_indent_points=first_line,
        hanging_indent_points=hanging,
        outline_level=outline,
        on_off=_resolve_on_off(layers, paragraph=True),
        numbering_id=numbering_id,
        numbering_level=numbering_level,
    )
