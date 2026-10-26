"""The normalized structural model (§11, §12, §111).

Two artifacts come out of an analysis and they have different jobs. The
``DocumentFactSet`` is the Phase 4 contract: small, evaluation-shaped, only
what a rule needs. *This* model is the other one — the structural record that
keeps OOXML provenance so Phase 12 SmartFix can find the exact element that
produced a finding, and so a support engineer can answer "why did it say
that?" a year later.

Keeping them separate is deliberate (§12). Pouring style ids, part names and
relationship ids into facts would make the rule engine's input balloon and
tempt rules into depending on OOXML implementation details, which is exactly
what the fact/rule boundary exists to prevent.

Nothing here is a loose dictionary (§111): every node is a typed dataclass
with a declared JSON shape, because this structure has to stay interpretable
across analyzer versions.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from fractions import Fraction

from app.docx.nodes import NodeLocator, Story
from app.docx.numbering import ResolvedNumbering
from app.docx.properties import (
    EffectiveParagraphProperties,
    EffectiveRunProperties,
    Resolved,
)
from app.docx.sections import DocumentSection
from app.engine.units.registry import format_exact

#: The structural model's own schema version (§13). Bumped when this shape
#: changes, independently of the analyzer's behavioural version.
ANALYSIS_SCHEMA_VERSION = 1


class RevisionState(StrEnum):
    """How a piece of content relates to tracked changes (§55).

    The default analysis view is FINAL: insertions and moved-in content are
    part of the document, deletions and moved-out content are not.
    """

    UNCHANGED = "UNCHANGED"
    INSERTED = "INSERTED"
    DELETED = "DELETED"
    MOVED_TO = "MOVED_TO"
    MOVED_FROM = "MOVED_FROM"

    @property
    def visible_in_final(self) -> bool:
        return self in {
            RevisionState.UNCHANGED,
            RevisionState.INSERTED,
            RevisionState.MOVED_TO,
        }


class FieldType(StrEnum):
    """Field instructions PalCert recognizes (§61)."""

    PAGE = "PAGE"
    NUMPAGES = "NUMPAGES"
    TOC = "TOC"
    SEQ = "SEQ"
    CITATION = "CITATION"
    REF = "REF"
    STYLEREF = "STYLEREF"
    HYPERLINK = "HYPERLINK"
    OTHER = "OTHER"


@dataclass(frozen=True, slots=True)
class SegmentNode:
    """One script-homogeneous stretch of a run (§39)."""

    channel: str
    slot: str
    length: int
    font_family: str | None
    font_size_points: Fraction | None

    def to_json(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "channel": self.channel,
            "slot": self.slot,
            "length": self.length,
        }
        if self.font_family is not None:
            payload["fontFamily"] = self.font_family
        if self.font_size_points is not None:
            payload["fontSizePoints"] = format_exact(self.font_size_points)
        return payload


@dataclass(frozen=True, slots=True)
class FieldNode:
    locator: NodeLocator
    field_type: FieldType
    #: The first token of the instruction, e.g. "SEQ". Never the whole
    #: instruction, which can carry bookmark names and citation keys.
    instruction_keyword: str
    #: For SEQ, the sequence name ("Figure", "Table"): caption evidence (§64).
    sequence_name: str | None = None

    def to_json(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "locator": self.locator.to_json(),
            "fieldType": str(self.field_type),
            "keyword": self.instruction_keyword,
        }
        if self.sequence_name is not None:
            payload["sequenceName"] = self.sequence_name
        return payload


@dataclass(frozen=True, slots=True)
class DrawingNode:
    locator: NodeLocator
    #: "inline" or "anchor".
    placement: str
    width_emu: int | None
    height_emu: int | None
    has_alternative_text: bool
    relationship_id: str | None

    def to_json(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "locator": self.locator.to_json(),
            "placement": self.placement,
            "hasAlternativeText": self.has_alternative_text,
        }
        if self.width_emu is not None:
            payload["widthEmu"] = self.width_emu
        if self.height_emu is not None:
            payload["heightEmu"] = self.height_emu
        if self.relationship_id is not None:
            payload["relationshipId"] = self.relationship_id
        return payload


#: Where an equation's content came from.
EQUATION_FORMAT_OMML = "omml"
EQUATION_FORMAT_LEGACY_OLE = "legacy-ole"


@dataclass(frozen=True, slots=True)
class EquationNode:
    locator: NodeLocator
    #: True for a display equation (``m:oMathPara``), false for inline.
    display: bool
    #: ``omml`` (Office Math markup) or ``legacy-ole`` (MathType / Equation 3.0).
    source_format: str = EQUATION_FORMAT_OMML
    #: The legacy object's ProgID, e.g. ``Equation.DSMT4``. Never resolved to a
    #: program: it is a label from the allow-list, nothing more.
    legacy_class: str | None = None
    #: A legacy object's rendered picture is in the package.
    preview_available: bool = False
    #: False when PalCert knows an equation is here but cannot read its maths
    #: (a legacy object's native data is never parsed, let alone executed).
    semantics_available: bool = True
    #: 1-based position among the document's equations, in reading order.
    order: int = 0
    #: The paragraph the equation sits in.
    paragraph_node_id: str | None = None
    #: A number written beside it in that paragraph, e.g. ``3.1`` for "(3.1)".
    number: str | None = None

    def to_json(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "locator": self.locator.to_json(),
            "display": self.display,
            "sourceFormat": self.source_format,
            "semanticsAvailable": self.semantics_available,
            "order": self.order,
        }
        if self.legacy_class is not None:
            payload["legacyClass"] = self.legacy_class
            payload["previewAvailable"] = self.preview_available
        if self.paragraph_node_id is not None:
            payload["paragraphNodeId"] = self.paragraph_node_id
        if self.number is not None:
            payload["number"] = self.number
        return payload


@dataclass(frozen=True, slots=True)
class RunNode:
    locator: NodeLocator
    text: str
    revision: RevisionState
    hidden: bool
    effective: EffectiveRunProperties
    segments: tuple[SegmentNode, ...]
    character_style_id: str | None = None

    @property
    def visible(self) -> bool:
        """Visible in the FINAL view: not deleted, not moved out, not hidden."""
        return self.revision.visible_in_final and not self.hidden


@dataclass(frozen=True, slots=True)
class ParagraphNode:
    locator: NodeLocator
    story: Story
    #: Index into the document's section list; None outside the main story.
    section_index: int | None
    style_id: str | None
    effective: EffectiveParagraphProperties
    runs: tuple[RunNode, ...]
    numbering: ResolvedNumbering | None
    #: Resolved heading level (1-9) from the effective outline level (§45).
    heading_level: int | None
    revision: RevisionState
    #: True when the paragraph sits inside a table cell.
    in_table: bool
    has_formatting_revision: bool
    #: Retained text, bounded and kept only for the reasons documented in the
    #: privacy policy (§72).
    text: str

    @property
    def visible_text(self) -> str:
        return "".join(run.text for run in self.runs if run.visible)


@dataclass(frozen=True, slots=True)
class TableCellNode:
    locator: NodeLocator
    row_index: int
    column_index: int
    grid_span: int
    width_twips: int | None
    paragraph_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class TableRowNode:
    locator: NodeLocator
    index: int
    cells: tuple[TableCellNode, ...]
    is_header: bool


@dataclass(frozen=True, slots=True)
class TableNode:
    locator: NodeLocator
    story: Story
    style_id: str | None
    alignment: str | None
    width_twips: int | None
    width_type: str | None
    rows: tuple[TableRowNode, ...]
    #: Nesting depth: 0 for a top-level table.
    depth: int
    #: True when the table's style carries conditional formatting that Phase 6
    #: does not resolve (§50).
    conditional_formatting_unresolved: bool

    @property
    def row_count(self) -> int:
        return len(self.rows)

    @property
    def column_count(self) -> int:
        """The widest row's column count, spans included.

        A table with merged cells has rows of different lengths; the widest is
        the only defensible single answer, and the per-row detail is kept.
        """
        return max((sum(cell.grid_span for cell in row.cells) for row in self.rows), default=0)


@dataclass(frozen=True, slots=True)
class NoteNode:
    """A footnote or endnote (§53)."""

    note_id: str
    #: "normal", "separator" or "continuationSeparator". Only normal notes are
    #: a user's notes; the separators are Word's own furniture.
    note_type: str
    story: Story
    paragraph_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class StoryNode:
    """One independent flow of content (§22)."""

    story: Story
    key: str
    #: Relationship id for a header or footer; note id for a note.
    reference: str | None
    part_name: str | None
    section_index: int | None
    paragraph_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class RevisionSummary:
    """Tracked-change presence, counted rather than interpreted (§56)."""

    insertions: int = 0
    deletions: int = 0
    moves: int = 0
    formatting_changes: int = 0

    @property
    def present(self) -> bool:
        return bool(self.insertions or self.deletions or self.moves)


@dataclass(frozen=True, slots=True)
class DocumentMetadata:
    """Core and extended properties (§68, §69).

    Values are carried in the private artifact and never logged. ``creator``
    and ``last_modified_by`` are personal data and are treated as such.
    """

    title: str | None = None
    subject: str | None = None
    creator: str | None = None
    keywords: str | None = None
    description: str | None = None
    language: str | None = None
    created: str | None = None
    modified: str | None = None
    last_modified_by: str | None = None
    #: Word's own saved statistics. Hints, never authoritative (§3, §60).
    application_page_count: int | None = None
    application_word_count: int | None = None
    application_character_count: int | None = None
    application_name: str | None = None


@dataclass(frozen=True, slots=True)
class WordCount:
    """PalCert's own counts, defined in docs/architecture/docx-analysis.md."""

    body_words: int = 0
    footnote_words: int = 0
    endnote_words: int = 0
    header_footer_words: int = 0
    textbox_words: int = 0
    body_characters: int = 0
    body_characters_no_spaces: int = 0

    @property
    def total_visible_words(self) -> int:
        return (
            self.body_words
            + self.footnote_words
            + self.endnote_words
            + self.header_footer_words
            + self.textbox_words
        )


@dataclass(frozen=True, slots=True)
class StructuralModel:
    """The complete structural record of one DOCX."""

    analysis_schema_version: int
    profile: str
    sections: tuple[DocumentSection, ...]
    stories: tuple[StoryNode, ...]
    paragraphs: tuple[ParagraphNode, ...]
    tables: tuple[TableNode, ...]
    notes: tuple[NoteNode, ...]
    fields: tuple[FieldNode, ...]
    drawings: tuple[DrawingNode, ...]
    equations: tuple[EquationNode, ...]
    revisions: RevisionSummary
    metadata: DocumentMetadata
    word_count: WordCount
    comment_count: int
    #: ``w:mirrorMargins``: left and right become inside and outside, so the
    #: physical side of a margin depends on page parity, which structural
    #: analysis does not know (§30).
    mirror_margins: bool = False
    #: Style ids actually used by content, for SmartFix and debugging.
    used_style_ids: tuple[str, ...] = field(default_factory=tuple)

    def paragraphs_in(self, story: Story) -> tuple[ParagraphNode, ...]:
        return tuple(paragraph for paragraph in self.paragraphs if paragraph.story is story)


def resolved_to_json(resolved: Resolved[object] | None) -> dict[str, object] | None:
    """Compact provenance for the artifact (§75): source, style, theme token."""
    return None if resolved is None else resolved.to_json()
