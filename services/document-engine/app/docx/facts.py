"""Turning the structural model into a Phase 4 ``DocumentFactSet`` (§14, §73, §83-§86).

This is the boundary. Everything before it is OOXML; everything after it is
the rule engine's vocabulary, and the engine must never need to know which
one produced the facts.

Four rules shape what comes out.

**Facts are formatting, not content** (§73). A fact carries a value and a
location. It does not carry the paragraph's text: a STRING fact per paragraph
would turn the fact set into a copy of the document and put user content in
front of every rule that never asked for it.

**One fact per distinct value per paragraph.** A paragraph whose runs are all
12 pt produces one ``fontSize`` fact; a paragraph with a 12 pt run and a 14 pt
run produces two, located at the first run of each. That is what makes "every
body paragraph is 12 pt" evaluate correctly while keeping the fact count
proportional to the formatting actually present rather than to the number of
runs.

**Stories keep their own element types.** A header paragraph is
``ELEMENT/HEADER``, a footnote paragraph is ``ELEMENT/FOOTNOTE``, a text box
is ``ELEMENT/TEXTBOX``. Filing them all under ``PARAGRAPH`` would make a rule
about body text fail because of a page number in a footer (§22).

**Coverage is declared deliberately** (§83). ``PAGE`` is always UNAVAILABLE,
because rendered pagination is not in the file. A domain touched by an
unresolved theme reference, a style cycle or unresolved table-style
conditional formatting is PARTIAL. Nothing is COMPLETE by default.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from app.docx.catalogue import is_documented
from app.docx.citations.projector import citation_coverage_entries, project_citation_facts
from app.docx.limits import AnalyzerLimits, ResourceLimitExceededError
from app.docx.model import (
    FieldType,
    ParagraphNode,
    StructuralModel,
    TableNode,
)
from app.docx.nodes import Story
from app.docx.properties import LineSpacingMode
from app.docx.units import emu_to, twips_to
from app.docx.warnings import WarningCode, WarningCollector
from app.engine.units.registry import Unit, format_exact

LOCATION_SCHEMA_VERSION = 1

#: Which element type a story's paragraphs belong to.
_STORY_ELEMENT_TYPE: dict[Story, str] = {
    Story.MAIN_DOCUMENT: "PARAGRAPH",
    Story.HEADER: "HEADER",
    Story.FOOTER: "FOOTER",
    Story.FOOTNOTE: "FOOTNOTE",
    Story.ENDNOTE: "ENDNOTE",
    Story.TEXTBOX: "TEXTBOX",
}

#: Element types this analyzer emits formatting facts for.
_FORMATTING_ELEMENT_TYPES = (
    "PARAGRAPH",
    "HEADING",
    "HEADER",
    "FOOTER",
    "FOOTNOTE",
    "ENDNOTE",
    "TEXTBOX",
    "CAPTION",
)


@dataclass(slots=True)
class FactBuilder:
    """Accumulates facts under the documented limits and ordering."""

    limits: AnalyzerLimits
    warnings: WarningCollector
    facts: list[dict[str, Any]]

    def __init__(self, limits: AnalyzerLimits, warnings: WarningCollector) -> None:
        self.limits = limits
        self.warnings = warnings
        self.facts = []

    def add(
        self,
        scope: dict[str, Any],
        value: dict[str, Any],
        *,
        unit: Unit | None = None,
        location: dict[str, Any] | None = None,
    ) -> None:
        property_name = scope.get("property") or scope.get("field")
        if isinstance(property_name, str) and not is_documented(property_name):
            # A property invented somewhere in the parser must never reach a
            # standard. Failing here turns that into a test failure (§41).
            raise ValueError(f"undocumented fact property: {property_name}")

        if len(self.facts) >= self.limits.max_facts:
            raise ResourceLimitExceededError("max_facts", self.limits.max_facts)

        fact: dict[str, Any] = {"scope": scope, "value": value}
        if unit is not None:
            fact["unit"] = str(unit)
        if location is not None:
            fact["location"] = location
        # Exact OOXML extraction carries no confidence: a value read from an
        # attribute is not "1.0 confident", it is simply what the file says (§84).
        fact["provenance"] = {"sourceKind": "OOXML"}
        self.facts.append(fact)


def _number(value: Fraction | int) -> dict[str, Any]:
    return {
        "type": "NUMBER",
        "number": format_exact(value if isinstance(value, Fraction) else Fraction(value)),
    }


def _boolean(value: bool) -> dict[str, Any]:
    return {"type": "BOOLEAN", "boolean": value}


def _string(value: str) -> dict[str, Any]:
    return {"type": "STRING", "text": value[:10000]}


def _enum(value: str) -> dict[str, Any]:
    return {"type": "ENUM", "enumValue": value[:200]}


def _document_scope(name: str) -> dict[str, Any]:
    return {"kind": "DOCUMENT", "property": name}


def _metadata_scope(field: str) -> dict[str, Any]:
    return {"kind": "METADATA", "field": field}


def _element_scope(element_type: str, name: str, level: int | None = None) -> dict[str, Any]:
    scope: dict[str, Any] = {"kind": "ELEMENT", "elementType": element_type, "property": name}
    if level is not None:
        scope["level"] = level
    return scope


def _location(
    node_id: str,
    path: tuple[str, ...],
    *,
    element_type: str | None = None,
    ordinal: int | None = None,
) -> dict[str, Any]:
    """A Location with **no page number**.

    Page is omitted, always, for every DOCX fact. WordprocessingML does not
    store where a paragraph lands once it is laid out, and a counted guess
    would be a fabricated fact wearing the clothes of a measured one (§2, §108).
    """
    location: dict[str, Any] = {
        "locationSchemaVersion": LOCATION_SCHEMA_VERSION,
        "nodeId": node_id,
        "path": list(path[:32]),
    }
    if element_type is not None:
        location["elementType"] = element_type
    if ordinal is not None:
        location["ordinal"] = ordinal
    return location


def _paragraph_element_type(paragraph: ParagraphNode, caption_ids: frozenset[str]) -> str:
    if paragraph.locator.node_id in caption_ids:
        return "CAPTION"
    if paragraph.story is Story.MAIN_DOCUMENT and paragraph.heading_level is not None:
        return "HEADING"
    return _STORY_ELEMENT_TYPE.get(paragraph.story, "PARAGRAPH")


def _distinct(values: list[tuple[Any, dict[str, Any]]]) -> list[tuple[Any, dict[str, Any]]]:
    """First location per distinct value, in first-seen order."""
    seen: dict[Any, dict[str, Any]] = {}
    for value, location in values:
        if value not in seen:
            seen[value] = location
    return list(seen.items())


def _paragraph_facts(
    builder: FactBuilder, paragraph: ParagraphNode, caption_ids: frozenset[str]
) -> None:
    element_type = _paragraph_element_type(paragraph, caption_ids)
    level = paragraph.heading_level if element_type == "HEADING" else None
    location = _location(
        paragraph.locator.node_id, paragraph.locator.path, element_type=element_type
    )

    effective = paragraph.effective

    # --- paragraph-level properties ---------------------------------------
    if effective.alignment is not None:
        builder.add(
            _element_scope(element_type, "paragraphAlignment", level),
            _enum(effective.alignment.value.upper()),
            location=location,
        )
    if effective.line_spacing is not None and effective.line_spacing_mode is not None:
        mode = effective.line_spacing_mode.value
        builder.add(
            _element_scope(element_type, "lineSpacingMode", level),
            _enum(str(mode)),
            location=location,
        )
        builder.add(
            _element_scope(element_type, "lineSpacing", level),
            _number(effective.line_spacing.value),
            unit=Unit.LINES if mode is LineSpacingMode.AUTO else Unit.POINT,
            location=location,
        )
    for name, resolved in (
        ("spacingBefore", effective.spacing_before_points),
        ("spacingAfter", effective.spacing_after_points),
        ("firstLineIndent", effective.first_line_indent_points),
        ("hangingIndent", effective.hanging_indent_points),
        ("indentStart", effective.indent_start_points),
        ("indentEnd", effective.indent_end_points),
    ):
        if resolved is not None:
            builder.add(
                _element_scope(element_type, name, level),
                _number(resolved.value),
                unit=Unit.POINT,
                location=location,
            )
    for name, key in (("keepNext", "keepNext"), ("pageBreakBefore", "pageBreakBefore")):
        resolved_flag = effective.on_off.get(key)
        if resolved_flag is not None:
            builder.add(
                _element_scope(element_type, name, level),
                _boolean(resolved_flag.value),
                location=location,
            )
    bidi = effective.on_off.get("bidi")
    if bidi is not None:
        builder.add(
            _element_scope(element_type, "textDirection", level),
            _enum("RTL" if bidi.value else "LTR"),
            location=location,
        )
    if paragraph.style_id:
        builder.add(
            _element_scope(element_type, "styleId", level),
            _string(paragraph.style_id),
            location=location,
        )

    # --- run properties, one fact per distinct value ----------------------
    fonts: dict[str, list[tuple[Any, dict[str, Any]]]] = {
        "fontFamily": [],
        "fontFamilyComplexScript": [],
        "fontFamilyEastAsian": [],
    }
    sizes: dict[str, list[tuple[Any, dict[str, Any]]]] = {
        "fontSize": [],
        "fontSizeComplexScript": [],
    }
    flags: dict[str, list[tuple[Any, dict[str, Any]]]] = {}
    strings: dict[str, list[tuple[Any, dict[str, Any]]]] = {}

    for run in paragraph.runs:
        if not run.visible or not run.text.strip():
            continue
        run_location = _location(run.locator.node_id, run.locator.path, element_type=element_type)
        for piece in run.segments:
            if piece.font_family is not None:
                key = {
                    "cs": "fontFamilyComplexScript",
                    "eastAsia": "fontFamilyEastAsian",
                }.get(piece.slot, "fontFamily")
                fonts[key].append((piece.font_family, run_location))
            if piece.font_size_points is not None:
                key = "fontSizeComplexScript" if piece.slot == "cs" else "fontSize"
                sizes[key].append((piece.font_size_points, run_location))

        for name, toggle_key in (
            ("bold", "b"),
            ("boldComplexScript", "bCs"),
            ("italic", "i"),
            ("italicComplexScript", "iCs"),
        ):
            resolved_toggle = run.effective.toggle(toggle_key)
            if resolved_toggle is not None:
                flags.setdefault(name, []).append((resolved_toggle.value, run_location))

        for name, resolved_text in (
            ("underline", run.effective.underline),
            ("textColor", run.effective.color),
            ("highlight", run.effective.highlight),
            ("language", run.effective.language),
            ("languageComplexScript", run.effective.complex_language),
        ):
            if resolved_text is not None:
                strings.setdefault(name, []).append((resolved_text.value, run_location))

    for name, entries in fonts.items():
        for value, run_location in _distinct(entries):
            builder.add(
                _element_scope(element_type, name, level), _string(value), location=run_location
            )
    for name, entries in sizes.items():
        for value, run_location in _distinct(entries):
            builder.add(
                _element_scope(element_type, name, level),
                _number(value),
                unit=Unit.POINT,
                location=run_location,
            )
    for name, entries in flags.items():
        for value, run_location in _distinct(entries):
            builder.add(
                _element_scope(element_type, name, level),
                _boolean(value),
                location=run_location,
            )
    for name, entries in strings.items():
        for value, run_location in _distinct(entries):
            builder.add(
                _element_scope(element_type, name, level), _string(value), location=run_location
            )

    # --- list facts --------------------------------------------------------
    if paragraph.numbering is not None:
        numbering = paragraph.numbering
        builder.add(
            _element_scope("LIST", "listLevel"),
            _number(numbering.level),
            unit=Unit.COUNT,
            location=location,
        )
        if numbering.number_format:
            builder.add(
                _element_scope("LIST", "numberFormat"),
                _enum(numbering.number_format.upper()),
                location=location,
            )
        if numbering.start is not None:
            builder.add(
                _element_scope("LIST", "listStartValue"),
                _number(numbering.start),
                unit=Unit.COUNT,
                location=location,
            )


def _table_facts(builder: FactBuilder, table: TableNode) -> None:
    location = _location(table.locator.node_id, table.locator.path, element_type="TABLE")
    builder.add(
        _element_scope("TABLE", "rowCount"),
        _number(table.row_count),
        unit=Unit.COUNT,
        location=location,
    )
    builder.add(
        _element_scope("TABLE", "columnCount"),
        _number(table.column_count),
        unit=Unit.COUNT,
        location=location,
    )
    if table.alignment:
        builder.add(
            _element_scope("TABLE", "tableAlignment"),
            _enum(table.alignment.upper()),
            location=location,
        )
    # Only an absolute width is a length. "pct" and "auto" are not, and
    # converting them to millimetres would invent a measurement.
    if table.width_twips is not None and (table.width_type or "dxa").lower() == "dxa":
        builder.add(
            _element_scope("TABLE", "tableWidth"),
            _number(twips_to(table.width_twips, Unit.POINT)),
            unit=Unit.POINT,
            location=location,
        )


def build_fact_set(
    model: StructuralModel,
    document_id: str,
    extractor_name: str,
    extractor_version: str,
    fact_schema_version: int,
    limits: AnalyzerLimits,
    warnings: WarningCollector,
    citation_analysis: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The complete fact set for one analysis.

    ``citation_analysis`` is the validated evidence section, when one was
    produced. Left out, no citation fact is emitted and the citation domains
    report UNAVAILABLE — which is the truth for a caller that never looked,
    and not the same thing as a document without citations.
    """
    builder = FactBuilder(limits, warnings)
    caption_ids = _caption_paragraph_ids(model)

    for paragraph in model.paragraphs:
        if not paragraph.revision.visible_in_final:
            continue
        _paragraph_facts(builder, paragraph, caption_ids)

    for table in model.tables:
        _table_facts(builder, table)

    _figure_facts(builder, model)
    _document_facts(builder, model)
    _metadata_facts(builder, model)
    project_citation_facts(builder, citation_analysis)

    facts = sorted(builder.facts, key=_fact_sort_key)

    return {
        "factSchemaVersion": fact_schema_version,
        "documentId": document_id,
        "extractor": {"name": extractor_name, "version": extractor_version},
        "coverage": build_coverage(model, warnings, citation_analysis),
        "facts": facts,
    }


def _fact_sort_key(fact: dict[str, Any]) -> tuple[str, ...]:
    """Canonical fact ordering (§86).

    Sorted by scope then location then value, so the artifact's bytes never
    depend on dictionary iteration order or on the order the walker happened
    to discover content in.
    """
    scope = fact["scope"]
    location = fact.get("location") or {}
    value = fact["value"]
    return (
        str(scope.get("kind", "")),
        str(scope.get("elementType", "")),
        str(scope.get("level", "")),
        str(scope.get("property") or scope.get("field") or ""),
        str(location.get("nodeId", "")),
        str(value.get("type", "")),
        str(
            value.get("text")
            or value.get("number")
            or value.get("enumValue")
            or value.get("boolean")
            or ""
        ),
    )


def _caption_paragraph_ids(model: StructuralModel) -> frozenset[str]:
    """Paragraphs a ``SEQ Figure``/``SEQ Table`` field marks as captions (§64).

    Conservative on purpose. A caption is recognized only from a sequence
    field, never from "text that looks like it sits under an image", and the
    caption domain is reported PARTIAL because a document using a localized
    sequence name or a caption style alone will not be recognized.
    """
    from app.docx.fields import caption_kind

    caption_nodes: set[str] = set()
    for field_node in model.fields:
        if field_node.field_type is not FieldType.SEQ:
            continue
        if caption_kind(field_node.sequence_name) is None:
            continue
        # The field's locator sits inside the paragraph; the paragraph is its
        # prefix up to and including the "p:N" segment.
        path = field_node.locator.path
        for index in range(len(path) - 1, -1, -1):
            if path[index].startswith("p:"):
                caption_nodes.add("/".join(path[: index + 1]))
                break
    return frozenset(caption_nodes)


def _figure_facts(builder: FactBuilder, model: StructuralModel) -> None:
    for drawing in model.drawings:
        location = _location(drawing.locator.node_id, drawing.locator.path, element_type="FIGURE")
        builder.add(
            _element_scope("FIGURE", "hasAlternativeText"),
            _boolean(drawing.has_alternative_text),
            location=location,
        )
        builder.add(
            _element_scope("FIGURE", "figurePlacement"),
            _enum(drawing.placement.upper()),
            location=location,
        )
        if drawing.width_emu is not None:
            builder.add(
                _element_scope("FIGURE", "figureWidth"),
                _number(emu_to(drawing.width_emu, Unit.MILLIMETRE)),
                unit=Unit.MILLIMETRE,
                location=location,
            )
        if drawing.height_emu is not None:
            builder.add(
                _element_scope("FIGURE", "figureHeight"),
                _number(emu_to(drawing.height_emu, Unit.MILLIMETRE)),
                unit=Unit.MILLIMETRE,
                location=location,
            )


def _document_facts(builder: FactBuilder, model: StructuralModel) -> None:
    from app.docx.document import user_notes

    # --- per section, never averaged (§29) --------------------------------
    for section in model.sections:
        setup = section.page_setup
        location = _location(
            f"main/section:{section.index + 1}",
            ("main", f"section:{section.index + 1}"),
            ordinal=section.index + 1,
        )
        for name, twips in (
            ("pageWidth", setup.width_twips),
            ("pageHeight", setup.height_twips),
            ("marginTop", setup.margin_top_twips),
            ("marginBottom", setup.margin_bottom_twips),
            ("marginLeft", setup.margin_left_twips),
            ("marginRight", setup.margin_right_twips),
            ("headerDistance", setup.header_distance_twips),
            ("footerDistance", setup.footer_distance_twips),
            ("gutter", setup.gutter_twips),
        ):
            if twips is None:
                continue
            builder.add(
                _document_scope(name),
                _number(twips_to(twips, Unit.MILLIMETRE)),
                unit=Unit.MILLIMETRE,
                location=location,
            )
        if setup.orientation:
            builder.add(
                _document_scope("pageOrientation"),
                _enum(setup.orientation.upper()),
                location=location,
            )
        if setup.section_break_type:
            builder.add(
                _document_scope("sectionBreakType"),
                _enum(setup.section_break_type.upper()),
                location=location,
            )
        if setup.column_count is not None:
            builder.add(
                _document_scope("sectionColumnCount"),
                _number(setup.column_count),
                unit=Unit.COUNT,
                location=location,
            )
        builder.add(
            _document_scope("headerPresent"),
            _boolean(bool(section.headers)),
            location=location,
        )
        builder.add(
            _document_scope("footerPresent"),
            _boolean(bool(section.footers)),
            location=location,
        )

    # --- counts ------------------------------------------------------------
    body_paragraphs = [
        paragraph
        for paragraph in model.paragraphs
        if paragraph.story is Story.MAIN_DOCUMENT and paragraph.revision.visible_in_final
    ]
    footnotes = user_notes(model.notes, Story.FOOTNOTE)
    endnotes = user_notes(model.notes, Story.ENDNOTE)

    for name, count in (
        ("sectionCount", len(model.sections)),
        ("paragraphCount", len(body_paragraphs)),
        (
            "tableCount",
            len([table for table in model.tables if table.story is Story.MAIN_DOCUMENT]),
        ),
        ("figureCount", len(model.drawings)),
        ("equationCount", len(model.equations)),
        ("footnoteCount", len(footnotes)),
        ("endnoteCount", len(endnotes)),
        ("commentCount", model.comment_count),
        ("trackedInsertionCount", model.revisions.insertions),
        ("trackedDeletionCount", model.revisions.deletions),
    ):
        builder.add(_document_scope(name), _number(count), unit=Unit.COUNT)

    counts = model.word_count
    for name, words in (
        ("wordCount", counts.body_words),
        ("bodyWordCount", counts.body_words),
        ("footnoteWordCount", counts.footnote_words),
        ("endnoteWordCount", counts.endnote_words),
        ("totalVisibleWordCount", counts.total_visible_words),
    ):
        builder.add(_document_scope(name), _number(words), unit=Unit.WORDS)
    builder.add(
        _document_scope("characterCount"),
        _number(counts.body_characters),
        unit=Unit.CHARACTERS,
    )
    builder.add(
        _document_scope("characterCountNoWhitespace"),
        _number(counts.body_characters_no_spaces),
        unit=Unit.CHARACTERS,
    )

    # --- presence flags ----------------------------------------------------
    has_toc = any(field_node.field_type is FieldType.TOC for field_node in model.fields)
    hidden_present = any(run.hidden for paragraph in model.paragraphs for run in paragraph.runs)
    if model.mirror_margins:
        builder.warnings.add(WarningCode.MIRRORED_MARGINS_PAGE_SIDE_UNKNOWN)

    for name, flag in (
        ("trackedChangesPresent", model.revisions.present),
        ("trackedFormattingChangesPresent", model.revisions.formatting_changes > 0),
        ("commentsPresent", model.comment_count > 0),
        ("tableOfContentsPresent", has_toc),
        ("hiddenTextPresent", hidden_present),
        ("mirrorMargins", model.mirror_margins),
    ):
        builder.add(_document_scope(name), _boolean(flag))


def _metadata_facts(builder: FactBuilder, model: StructuralModel) -> None:
    metadata = model.metadata
    for field_name, value in (
        ("title", metadata.title),
        ("subject", metadata.subject),
        ("creator", metadata.creator),
        ("keywords", metadata.keywords),
        ("description", metadata.description),
        ("language", metadata.language),
        ("created", metadata.created),
        ("modified", metadata.modified),
    ):
        if value:
            builder.add(_metadata_scope(field_name), _string(value))


def build_coverage(
    model: StructuralModel,
    warnings: WarningCollector,
    citation_analysis: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Declare what the analyzer could and could not see (§83).

    Written out deliberately rather than defaulted, because the default in the
    rule engine is UNAVAILABLE and a domain that really was read completely
    has to say so for a rule to produce a verdict at all.
    """
    entries: list[dict[str, Any]] = []

    # Rendered layout is not in the file. Not "we did not look" — not there.
    entries.append(
        {
            "kind": "PAGE",
            "status": "UNAVAILABLE",
            "note": "WordprocessingML does not store rendered pagination",
        }
    )

    theme_partial = warnings.has(WarningCode.THEME_MISSING) or warnings.has(
        WarningCode.THEME_REFERENCE_UNRESOLVED
    )
    style_partial = (
        warnings.has(WarningCode.STYLE_CYCLE)
        or warnings.has(WarningCode.STYLE_PARENT_MISSING)
        or warnings.has(WarningCode.STYLE_CHAIN_TOO_DEEP)
    )
    markup_partial = warnings.has(WarningCode.UNSUPPORTED_MARKUP)
    # An unread AlternateContent branch could have declared a different shape
    # or text box; it cannot have declared different paragraph formatting.
    alternate_branch = warnings.has(WarningCode.ALTERNATE_CONTENT_BRANCH_SELECTED) or warnings.has(
        WarningCode.ALTERNATE_CONTENT_FALLBACK_USED
    )
    numbering_partial = warnings.has(WarningCode.NUMBERING_REFERENCE_MISSING)
    table_partial = warnings.has(WarningCode.TABLE_STYLE_CONDITIONAL_IGNORED)

    formatting_status = "PARTIAL" if (style_partial or markup_partial) else "COMPLETE"
    font_status = "PARTIAL" if (theme_partial or style_partial or markup_partial) else "COMPLETE"

    for element_type in _FORMATTING_ELEMENT_TYPES:
        base = "PARTIAL" if element_type == "CAPTION" else formatting_status
        if element_type == "TEXTBOX" and alternate_branch:
            base = "PARTIAL"
        entries.append(
            {
                "kind": "ELEMENT",
                "elementType": element_type,
                "status": base,
                **(
                    {"note": "captions are recognized from SEQ fields only"}
                    if element_type == "CAPTION"
                    else {}
                ),
            }
        )
        for property_name in (
            "fontFamily",
            "fontFamilyComplexScript",
            "fontSize",
            "fontSizeComplexScript",
        ):
            entries.append(
                {
                    "kind": "ELEMENT",
                    "elementType": element_type,
                    "property": property_name,
                    "status": "PARTIAL" if element_type == "CAPTION" else font_status,
                }
            )

    entries.append(
        {
            "kind": "ELEMENT",
            "elementType": "TABLE",
            "status": "PARTIAL" if table_partial else "COMPLETE",
            **(
                {"note": "conditional table-style formatting is not resolved"}
                if table_partial
                else {}
            ),
        }
    )
    entries.append(
        {
            "kind": "ELEMENT",
            "elementType": "LIST",
            "status": "PARTIAL" if numbering_partial else "COMPLETE",
        }
    )
    entries.append(
        {
            "kind": "ELEMENT",
            "elementType": "FIGURE",
            "status": "PARTIAL" if (markup_partial or alternate_branch) else "COMPLETE",
            "note": "legacy VML pictures carry no extent",
        }
    )
    entries.append({"kind": "ELEMENT", "elementType": "EQUATION", "status": "COMPLETE"})
    # Citations, from Phase 18. A Word-native CITATION field is structural, so
    # it is now covered; a rendered reference entry is still identified by
    # classification and is still UNAVAILABLE. The entries are computed from
    # the citation evidence rather than written out here, because what they
    # may claim depends on what that evidence established.
    entries.extend(citation_coverage_entries(citation_analysis))

    entries.append({"kind": "DOCUMENT", "status": "COMPLETE"})
    entries.append(
        {
            "kind": "DOCUMENT",
            "property": "pageCount",
            "status": "UNAVAILABLE",
            "note": "a saved page count is a stale application hint, not a measurement",
        }
    )
    for property_name in ("marginLeft", "marginRight"):
        entries.append(
            {
                "kind": "DOCUMENT",
                "property": property_name,
                "status": "PARTIAL" if model_has_mirrored_margins(model) else "COMPLETE",
                **(
                    {"note": "mirrored margins depend on page parity"}
                    if model_has_mirrored_margins(model)
                    else {}
                ),
            }
        )

    entries.append(
        {
            "kind": "METADATA",
            "status": "COMPLETE" if _metadata_present(model) else "UNAVAILABLE",
        }
    )
    return entries


def model_has_mirrored_margins(model: StructuralModel) -> bool:
    """Mirrored margins make "left" mean "inside", which needs page parity."""
    return model.mirror_margins


def _metadata_present(model: StructuralModel) -> bool:
    metadata = model.metadata
    return any(
        (
            metadata.title,
            metadata.subject,
            metadata.creator,
            metadata.created,
            metadata.modified,
        )
    )
