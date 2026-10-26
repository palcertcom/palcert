"""Numbering and lists (§47, §48).

``numbering.xml`` has two levels of indirection that are easy to miss and
impossible to fake. A paragraph names a ``w:numId``; that maps to a ``w:num``;
that points at a ``w:abstractNum``; and the ``w:num`` may *override* any of
the abstract definition's levels — a different start value, a different
format, different indentation.

So two paragraphs referencing the same abstract definition can legitimately be
numbered differently (§48), and an analyzer that resolves only the abstract
definition reports one of them wrongly.

Phase 6 extracts the deterministic facts — level, format, start value,
numbering identity and the level's own indentation — and does **not** attempt
to render the number text. Producing "3.2.1" requires a full counting pass
across the document with restart semantics per level, and a wrong list label
in a report is worse than no label at all (§47).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TypeVar
from xml.etree.ElementTree import Element

from app.docx.limits import AnalyzerLimits, ResourceLimitExceededError
from app.docx.namespaces import Namespaces
from app.docx.rawprops import (
    RawIndentation,
    RawParagraphProperties,
    RawRunProperties,
    parse_paragraph_properties,
    parse_run_properties,
)
from app.docx.units import parse_int
from app.docx.warnings import WarningCode, WarningCollector


@dataclass(frozen=True, slots=True)
class NumberingLevel:
    """One ``w:lvl``."""

    level: int
    number_format: str | None
    start: int | None
    #: The literal ``w:lvlText`` pattern, e.g. "%1.%2.". A pattern, not a
    #: rendered label: PalCert never claims to know the printed number.
    level_text: str | None
    paragraph: RawParagraphProperties = field(default_factory=RawParagraphProperties.empty)
    run: RawRunProperties = field(default_factory=RawRunProperties.empty)
    style_id: str | None = None

    @property
    def indentation(self) -> RawIndentation:
        return self.paragraph.indentation


@dataclass(frozen=True, slots=True)
class AbstractNumbering:
    abstract_id: int
    levels: dict[int, NumberingLevel]
    #: ``w:numStyleLink`` — the definition delegates to a numbering style.
    style_link: str | None = None


@dataclass(frozen=True, slots=True)
class NumberingInstance:
    """A ``w:num``: an abstract definition plus per-level overrides."""

    numbering_id: int
    abstract_id: int | None
    overrides: dict[int, NumberingLevel]
    #: Level start values overridden by ``w:startOverride``.
    start_overrides: dict[int, int]


@dataclass(frozen=True, slots=True)
class ResolvedNumbering:
    """What a paragraph's ``w:numPr`` actually resolves to."""

    numbering_id: int
    level: int
    abstract_id: int | None
    number_format: str | None
    start: int | None
    level_text: str | None
    indentation: RawIndentation


@dataclass(frozen=True, slots=True)
class NumberingCatalogue:
    abstract: dict[int, AbstractNumbering]
    instances: dict[int, NumberingInstance]
    present: bool

    @staticmethod
    def empty() -> NumberingCatalogue:
        return NumberingCatalogue(abstract={}, instances={}, present=False)

    def resolve(
        self, numbering_id: int | None, level: int | None, warnings: WarningCollector
    ) -> ResolvedNumbering | None:
        """Resolve one paragraph's numbering reference.

        A dangling reference is warned about and yields nothing — never a
        substituted definition (§77).
        """
        if numbering_id is None:
            return None
        # An omitted ``w:ilvl`` means level 0; a numbering id of 0 means "no
        # numbering", which is how Word removes a list from a styled paragraph.
        effective_level = 0 if level is None else level
        if numbering_id == 0:
            return None

        instance = self.instances.get(numbering_id)
        if instance is None:
            warnings.add(WarningCode.NUMBERING_REFERENCE_MISSING, numId=str(numbering_id))
            return None

        abstract = (
            self.abstract.get(instance.abstract_id) if instance.abstract_id is not None else None
        )
        if abstract is None:
            warnings.add(
                WarningCode.NUMBERING_REFERENCE_MISSING,
                numId=str(numbering_id),
                abstractNumId=str(instance.abstract_id),
            )
            return None

        base = abstract.levels.get(effective_level)
        override = instance.overrides.get(effective_level)
        # The override wins property by property: a ``w:lvlOverride`` that only
        # changes the start value must not erase the abstract definition's
        # format or indentation (§48).
        number_format = _first(
            override.number_format if override else None, base.number_format if base else None
        )
        level_text = _first(
            override.level_text if override else None, base.level_text if base else None
        )
        start = instance.start_overrides.get(effective_level)
        if start is None:
            start = _first(override.start if override else None, base.start if base else None)
        indentation = _merge_indentation(
            override.indentation if override else None,
            base.indentation if base else None,
        )

        return ResolvedNumbering(
            numbering_id=numbering_id,
            level=effective_level,
            abstract_id=instance.abstract_id,
            number_format=number_format,
            start=start,
            level_text=level_text,
            indentation=indentation,
        )


_T = TypeVar("_T")


def _first(*values: _T | None) -> _T | None:
    """The first value that was actually declared, or None."""
    for value in values:
        if value is not None:
            return value
    return None


def _merge_indentation(
    override: RawIndentation | None, base: RawIndentation | None
) -> RawIndentation:
    if override is None:
        return base or RawIndentation()
    if base is None:
        return override
    return RawIndentation(
        start_twips=(
            override.start_twips if override.start_twips is not None else base.start_twips
        ),
        end_twips=override.end_twips if override.end_twips is not None else base.end_twips,
        first_line_twips=(
            override.first_line_twips
            if override.first_line_twips is not None
            else base.first_line_twips
        ),
        hanging_twips=(
            override.hanging_twips if override.hanging_twips is not None else base.hanging_twips
        ),
    )


def _parse_level(element: Element, namespaces: Namespaces) -> NumberingLevel | None:
    level_index = parse_int(element.get(namespaces.qn("w:ilvl")))
    if level_index is None:
        return None

    def value_of(tag: str) -> str | None:
        found = element.find(namespaces.qn(tag))
        if found is None:
            return None
        value = found.get(namespaces.qn("w:val"))
        return value.strip() if value and value.strip() else None

    start_element = element.find(namespaces.qn("w:start"))
    style = element.find(namespaces.qn("w:pStyle"))

    return NumberingLevel(
        level=level_index,
        number_format=value_of("w:numFmt"),
        start=parse_int(
            start_element.get(namespaces.qn("w:val")) if start_element is not None else None
        ),
        level_text=value_of("w:lvlText"),
        paragraph=parse_paragraph_properties(element.find(namespaces.qn("w:pPr")), namespaces),
        run=parse_run_properties(element.find(namespaces.qn("w:rPr")), namespaces),
        style_id=(style.get(namespaces.qn("w:val")) if style is not None else None),
    )


def parse_numbering(
    root: Element | None,
    namespaces: Namespaces,
    warnings: WarningCollector,
    limits: AnalyzerLimits,
) -> NumberingCatalogue:
    """Read ``numbering.xml``, or return the empty catalogue."""
    if root is None:
        return NumberingCatalogue.empty()

    abstract: dict[int, AbstractNumbering] = {}
    for element in root.findall(namespaces.qn("w:abstractNum")):
        if len(abstract) >= limits.max_numbering_definitions:
            raise ResourceLimitExceededError(
                "max_numbering_definitions", limits.max_numbering_definitions
            )
        abstract_id = parse_int(element.get(namespaces.qn("w:abstractNumId")))
        if abstract_id is None:
            continue
        levels: dict[int, NumberingLevel] = {}
        for level_element in element.findall(namespaces.qn("w:lvl")):
            parsed_level = _parse_level(level_element, namespaces)
            if parsed_level is not None:
                levels[parsed_level.level] = parsed_level
        style_link = element.find(namespaces.qn("w:numStyleLink"))
        abstract[abstract_id] = AbstractNumbering(
            abstract_id=abstract_id,
            levels=levels,
            style_link=(style_link.get(namespaces.qn("w:val")) if style_link is not None else None),
        )

    instances: dict[int, NumberingInstance] = {}
    for element in root.findall(namespaces.qn("w:num")):
        if len(instances) >= limits.max_numbering_definitions:
            raise ResourceLimitExceededError(
                "max_numbering_definitions", limits.max_numbering_definitions
            )
        numbering_id = parse_int(element.get(namespaces.qn("w:numId")))
        if numbering_id is None:
            continue
        abstract_reference = element.find(namespaces.qn("w:abstractNumId"))
        overrides: dict[int, NumberingLevel] = {}
        start_overrides: dict[int, int] = {}
        for override in element.findall(namespaces.qn("w:lvlOverride")):
            level_index = parse_int(override.get(namespaces.qn("w:ilvl")))
            if level_index is None:
                continue
            start_override = override.find(namespaces.qn("w:startOverride"))
            if start_override is not None:
                value = parse_int(start_override.get(namespaces.qn("w:val")))
                if value is not None:
                    start_overrides[level_index] = value
            override_level = override.find(namespaces.qn("w:lvl"))
            if override_level is not None:
                parsed = _parse_level(override_level, namespaces)
                if parsed is not None:
                    overrides[level_index] = parsed

        instances[numbering_id] = NumberingInstance(
            numbering_id=numbering_id,
            abstract_id=parse_int(
                abstract_reference.get(namespaces.qn("w:val"))
                if abstract_reference is not None
                else None
            ),
            overrides=overrides,
            start_overrides=start_overrides,
        )

    return NumberingCatalogue(abstract=abstract, instances=instances, present=True)
