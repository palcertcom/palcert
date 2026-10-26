"""The analysis artifact: envelope, canonical bytes and hash (§11, §85-§88).

One analysis produces one artifact holding two layers: the rich
``DocxStructuralModel`` for SmartFix and debugging, and the
``DocumentFactSet`` the rule engine consumes. They travel together in a
versioned envelope so that a Phase 7 check can point at exactly the bytes
that produced its verdict.

**Serialization is canonical.** Keys are sorted, separators are fixed, and
nothing floating-point ever appears — every number is either an integer or a
decimal string produced by exact arithmetic. Two analyses of the same bytes by
the same analyzer version therefore produce byte-identical artifacts, which is
what makes ``artifactSha256`` a meaningful integrity check rather than a
timestamp in disguise (§85, §87).

**No compression ambiguity** (§88). The artifact is stored exactly as
serialized here, and the hash is over exactly those stored bytes. There is no
second "uncompressed canonical form" to argue about later.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from app.docx.limits import AnalyzerLimits, ResourceLimitExceededError
from app.docx.model import (
    ParagraphNode,
    RunNode,
    StructuralModel,
)
from app.docx.nodes import Story
from app.docx.warnings import AnalysisWarning
from app.engine.units.registry import format_exact

#: The analyzer's semantic version (§15). Not a git commit and not the
#: application's version: it changes when *extraction behaviour* changes, and
#: only then, because a stored analysis is interpreted through it for ever.
ANALYZER_NAME = "palcert-docx"
#: Phase 18 moved it three times, and every move is the same rule.
#:
#: Version 2 read Word's citation evidence into the artifact. Version 3
#: projects four properties of it into facts, so a check run against a version
#: 2 analysis finds no citation facts and reports nothing about citations —
#: silently, because an artifact without them is a valid artifact. Reuse is
#: decided by analyzer name and version, so the only thing that can stop that
#: is this number.
#:
#: Version 4 emits no new fact: it adds the coverage entry that says DOCX
#: cannot answer `citationTargetResolved` at all. That entry is what stops a
#: rule on the new property being read under the COMPLETE coverage this
#: format's CITATION scope can otherwise reach — so a version 3 analysis is
#: not merely missing something, it would be read wrongly, and this number is
#: the only thing that stops it being reused.
#:
#: It moves rather than being left where it was because the previous value was
#: already pushed: an analysis produced by it may exist, and "probably nobody
#: ran it" is not a property a stored record can be checked against.
#:
#: Version 5 recognizes legacy equation objects (MathType ``Equation.DSMT4``,
#: Microsoft Equation 3.0). Version 4 counted such an object as a picture:
#: its ``figureCount`` was one too many and its ``equationCount`` one too few,
#: so a version 4 analysis of a document with legacy equations would be read
#: wrongly, and this number is what stops it being reused.
#: Version 6 resolves supplemental theme fonts using themeFontLang and scopes
#: font coverage to visible evidence, independently for family and size.
#: Old global PARTIAL coverage and unresolved overrides must not be reused.
ANALYZER_VERSION = "6"

#: The *envelope's* version, which is not the structural model's.
#:
#: They were one constant while they agreed. Version 2 of the envelope is the
#: one that carries `citationAnalysis`, and the structural model did not
#: change at all — so bumping the model's version to say so would be a second
#: statement, and a false one. The contract treats them as separate fields;
#: they are now separate constants.
ENVELOPE_SCHEMA_VERSION = 2


@dataclass(frozen=True, slots=True)
class AnalysisArtifact:
    """The serialized artifact plus the metadata the database keeps."""

    content: bytes
    sha256: str
    fact_count: int
    warning_count: int
    summary: dict[str, int]

    @property
    def size_bytes(self) -> int:
        return len(self.content)


def canonical_json(payload: dict[str, Any]) -> bytes:
    """Deterministic JSON bytes.

    ``sort_keys`` removes dictionary ordering from the output, the compact
    separators remove whitespace choices, and ``ensure_ascii=False`` keeps
    Arabic readable rather than escaping it into unreadable sequences — all
    three fixed so the bytes depend only on the content (§85).
    """
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def _run_json(run: RunNode) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "locator": run.locator.to_json(),
        "revision": str(run.revision),
        "hidden": run.hidden,
        "length": len(run.text),
        "segments": [segment.to_json() for segment in run.segments],
    }
    if run.character_style_id:
        payload["characterStyleId"] = run.character_style_id

    effective = run.effective
    properties: dict[str, Any] = {}
    for slot, resolved in sorted(effective.fonts.items()):
        properties[f"font.{slot}"] = {"value": resolved.value, **resolved.to_json()}
    if effective.size_points is not None:
        properties["fontSize"] = {
            "value": format_exact(effective.size_points.value),
            **effective.size_points.to_json(),
        }
    if effective.complex_size_points is not None:
        properties["fontSizeComplexScript"] = {
            "value": format_exact(effective.complex_size_points.value),
            **effective.complex_size_points.to_json(),
        }
    for name, resolved_toggle in sorted(effective.toggles.items()):
        properties[name] = {"value": resolved_toggle.value, **resolved_toggle.to_json()}
    for name, resolved_flag in sorted(effective.on_off.items()):
        properties[name] = {"value": resolved_flag.value, **resolved_flag.to_json()}
    for name, resolved_text in (
        ("underline", effective.underline),
        ("color", effective.color),
        ("highlight", effective.highlight),
        ("verticalAlignment", effective.vertical_alignment),
        ("language", effective.language),
        ("languageComplexScript", effective.complex_language),
    ):
        if resolved_text is not None:
            properties[name] = {"value": resolved_text.value, **resolved_text.to_json()}

    payload["effective"] = properties
    return payload


def _paragraph_json(paragraph: ParagraphNode, retain_text: bool) -> dict[str, Any]:
    effective = paragraph.effective
    properties: dict[str, Any] = {}
    for name, resolved in (
        ("alignment", effective.alignment),
        ("lineSpacingMode", effective.line_spacing_mode),
    ):
        if resolved is not None:
            properties[name] = {"value": str(resolved.value), **resolved.to_json()}
    for name, measured in (
        ("lineSpacing", effective.line_spacing),
        ("spacingBefore", effective.spacing_before_points),
        ("spacingAfter", effective.spacing_after_points),
        ("indentStart", effective.indent_start_points),
        ("indentEnd", effective.indent_end_points),
        ("firstLineIndent", effective.first_line_indent_points),
        ("hangingIndent", effective.hanging_indent_points),
    ):
        if measured is not None:
            properties[name] = {"value": format_exact(measured.value), **measured.to_json()}
    if effective.outline_level is not None:
        properties["outlineLevel"] = {
            "value": effective.outline_level.value,
            **effective.outline_level.to_json(),
        }
    for name, resolved_flag in sorted(effective.on_off.items()):
        properties[name] = {"value": resolved_flag.value, **resolved_flag.to_json()}

    payload: dict[str, Any] = {
        "locator": paragraph.locator.to_json(),
        "story": str(paragraph.story),
        "revision": str(paragraph.revision),
        "inTable": paragraph.in_table,
        "effective": properties,
        "runs": [_run_json(run) for run in paragraph.runs],
    }
    if paragraph.section_index is not None:
        payload["sectionIndex"] = paragraph.section_index
    if paragraph.style_id:
        payload["styleId"] = paragraph.style_id
    if paragraph.heading_level is not None:
        payload["headingLevel"] = paragraph.heading_level
    if paragraph.has_formatting_revision:
        payload["hasFormattingRevision"] = True
    if paragraph.numbering is not None:
        payload["numbering"] = {
            "numId": paragraph.numbering.numbering_id,
            "level": paragraph.numbering.level,
            "abstractNumId": paragraph.numbering.abstract_id,
            "numberFormat": paragraph.numbering.number_format,
            "start": paragraph.numbering.start,
        }
    if retain_text and paragraph.text:
        # Retained deliberately and documented (§72): headings and body text
        # are what Phase 7 report localization and Phase 12 SmartFix need to
        # anchor an edit. The artifact is private, encrypted and retained
        # under the source document's own policy.
        payload["text"] = paragraph.text
    return payload


def _section_json(model: StructuralModel) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    for section in model.sections:
        setup = section.page_setup
        sections.append(
            {
                "index": section.index,
                "isFinal": section.is_final,
                "pageSetup": {
                    "widthTwips": setup.width_twips,
                    "heightTwips": setup.height_twips,
                    "orientation": setup.orientation,
                    "marginTopTwips": setup.margin_top_twips,
                    "marginBottomTwips": setup.margin_bottom_twips,
                    "marginLeftTwips": setup.margin_left_twips,
                    "marginRightTwips": setup.margin_right_twips,
                    "headerDistanceTwips": setup.header_distance_twips,
                    "footerDistanceTwips": setup.footer_distance_twips,
                    "gutterTwips": setup.gutter_twips,
                    "columnCount": setup.column_count,
                    "sectionBreakType": setup.section_break_type,
                    "titlePage": setup.title_page,
                    "bidi": setup.bidi,
                },
                "headers": [
                    {"type": reference.reference_type, "relationshipId": reference.relationship_id}
                    for reference in section.headers
                ],
                "footers": [
                    {"type": reference.reference_type, "relationshipId": reference.relationship_id}
                    for reference in section.footers
                ],
            }
        )
    return sections


def structural_model_json(model: StructuralModel, retain_text: bool = True) -> dict[str, Any]:
    """The structural layer of the artifact."""
    return {
        "analysisSchemaVersion": model.analysis_schema_version,
        "profile": model.profile,
        "sections": _section_json(model),
        "stories": [
            {
                "story": str(story.story),
                "key": story.key,
                "reference": story.reference,
                "partName": story.part_name,
                "sectionIndex": story.section_index,
                "paragraphIds": list(story.paragraph_ids),
            }
            for story in model.stories
        ],
        "paragraphs": [_paragraph_json(paragraph, retain_text) for paragraph in model.paragraphs],
        "tables": [
            {
                "locator": table.locator.to_json(),
                "story": str(table.story),
                "styleId": table.style_id,
                "alignment": table.alignment,
                "widthTwips": table.width_twips,
                "widthType": table.width_type,
                "depth": table.depth,
                "rowCount": table.row_count,
                "columnCount": table.column_count,
                "conditionalFormattingUnresolved": table.conditional_formatting_unresolved,
                "rows": [
                    {
                        "index": row.index,
                        "isHeader": row.is_header,
                        "cells": [
                            {
                                "locator": cell.locator.to_json(),
                                "rowIndex": cell.row_index,
                                "columnIndex": cell.column_index,
                                "gridSpan": cell.grid_span,
                                "widthTwips": cell.width_twips,
                                "paragraphIds": list(cell.paragraph_ids),
                            }
                            for cell in row.cells
                        ],
                    }
                    for row in table.rows
                ],
            }
            for table in model.tables
        ],
        "notes": [
            {
                "noteId": note.note_id,
                "noteType": note.note_type,
                "story": str(note.story),
                "paragraphIds": list(note.paragraph_ids),
            }
            for note in model.notes
        ],
        "fields": [field_node.to_json() for field_node in model.fields],
        "drawings": [drawing.to_json() for drawing in model.drawings],
        "equations": [equation.to_json() for equation in model.equations],
        "revisions": {
            "insertions": model.revisions.insertions,
            "deletions": model.revisions.deletions,
            "moves": model.revisions.moves,
            "formattingChanges": model.revisions.formatting_changes,
            "present": model.revisions.present,
        },
        "wordCount": {
            "body": model.word_count.body_words,
            "footnotes": model.word_count.footnote_words,
            "endnotes": model.word_count.endnote_words,
            "headersAndFooters": model.word_count.header_footer_words,
            "textboxes": model.word_count.textbox_words,
            "totalVisible": model.word_count.total_visible_words,
            "bodyCharacters": model.word_count.body_characters,
            "bodyCharactersNoWhitespace": model.word_count.body_characters_no_spaces,
        },
        "metadata": {
            "title": model.metadata.title,
            "subject": model.metadata.subject,
            "creator": model.metadata.creator,
            "keywords": model.metadata.keywords,
            "description": model.metadata.description,
            "language": model.metadata.language,
            "created": model.metadata.created,
            "modified": model.metadata.modified,
            "lastModifiedBy": model.metadata.last_modified_by,
            "applicationHints": {
                "pageCount": model.metadata.application_page_count,
                "wordCount": model.metadata.application_word_count,
                "characterCount": model.metadata.application_character_count,
                "application": model.metadata.application_name,
            },
        },
        "commentCount": model.comment_count,
        "mirrorMargins": model.mirror_margins,
        "usedStyleIds": list(model.used_style_ids),
    }


def summarize(model: StructuralModel, fact_count: int, warning_count: int) -> dict[str, int]:
    """Small counters for the database row (§113). Never any text."""
    return {
        "factCount": fact_count,
        "warningCount": warning_count,
        "paragraphCount": len(model.paragraphs),
        "runCount": sum(len(paragraph.runs) for paragraph in model.paragraphs),
        "tableCount": len(model.tables),
        "sectionCount": len(model.sections),
        "figureCount": len(model.drawings),
        "equationCount": len(model.equations),
        "noteCount": len(model.notes),
        "commentCount": model.comment_count,
        "bodyWordCount": model.word_count.body_words,
        "headingCount": sum(
            1
            for paragraph in model.paragraphs
            if paragraph.story is Story.MAIN_DOCUMENT and paragraph.heading_level is not None
        ),
    }


def build_artifact(
    model: StructuralModel,
    fact_set: dict[str, Any],
    warnings: tuple[AnalysisWarning, ...],
    source_sha256: str,
    document_id: str,
    limits: AnalyzerLimits,
    citation_analysis: dict[str, Any],
) -> AnalysisArtifact:
    """Serialize the envelope and hash exactly what will be stored.

    ``citation_analysis`` is required rather than optional: at envelope
    version 2 the section is part of the contract, and a caller that could
    leave it out would be a caller that can produce a v2 artifact advertising
    citation evidence and carrying none.
    """
    envelope: dict[str, Any] = {
        "analysisSchemaVersion": ENVELOPE_SCHEMA_VERSION,
        "analyzer": {"name": ANALYZER_NAME, "version": ANALYZER_VERSION},
        "source": {"documentId": document_id, "sha256": source_sha256},
        "factSchemaVersion": fact_set["factSchemaVersion"],
        "structuralModel": structural_model_json(model),
        "factSet": fact_set,
        "citationAnalysis": citation_analysis,
        "warnings": [warning.to_json() for warning in warnings],
    }

    content = canonical_json(envelope)
    if len(content) > limits.max_artifact_bytes:
        raise ResourceLimitExceededError("max_artifact_bytes", limits.max_artifact_bytes)

    return AnalysisArtifact(
        content=content,
        sha256=hashlib.sha256(content).hexdigest(),
        fact_count=len(fact_set["facts"]),
        warning_count=len(warnings),
        summary=summarize(model, len(fact_set["facts"]), len(warnings)),
    )
