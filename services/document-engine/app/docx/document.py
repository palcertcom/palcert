"""Reading one package into the structural model (§22, §51, §53, §54).

The order here is the order the document forces: the main part first (it names
the styles, numbering, theme and settings that everything else is resolved
against), then the sections (they name the headers and footers), then the
independent stories.

Each story gets its own walk with its own locator root, which is what keeps a
header paragraph from ever being mistaken for a body paragraph (§22).
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, replace
from xml.etree.ElementTree import Element

from app.docx.errors import DocxAnalysisError, DocxErrorCode
from app.docx.limits import AnalyzerLimits
from app.docx.metadata import merge_extended_properties, parse_core_properties
from app.docx.model import (
    ANALYSIS_SCHEMA_VERSION,
    DocumentMetadata,
    EquationNode,
    NoteNode,
    ParagraphNode,
    RevisionSummary,
    StoryNode,
    StructuralModel,
    WordCount,
)
from app.docx.namespaces import Namespaces
from app.docx.nodes import NodePath, Story, story_prefix
from app.docx.numbering import parse_numbering
from app.docx.package import (
    REL_COMMENTS,
    REL_CORE_PROPERTIES,
    REL_ENDNOTES,
    REL_EXTENDED_PROPERTIES,
    REL_FOOTNOTES,
    REL_NUMBERING,
    REL_SETTINGS,
    REL_STYLES,
    REL_THEME,
    DocxPackage,
    resolve_namespaces,
)
from app.docx.sections import DocumentSection, collect_sections, inherit_references
from app.docx.settings import parse_settings
from app.docx.structure import (
    StoryWalk,
    WalkContext,
    find_textbox_contents,
    walk_block_content,
)
from app.docx.styles import parse_styles
from app.docx.theme import parse_theme
from app.docx.warnings import WarningCode, WarningCollector
from app.docx.wordcount import count_characters, count_words

#: Note types that are Word's own furniture rather than a user's note (§53).
_SYSTEM_NOTE_TYPES = frozenset({"separator", "continuationSeparator", "continuationNotice"})


@dataclass(slots=True)
class ReadResult:
    model: StructuralModel
    context: WalkContext


def read_document(
    package: DocxPackage,
    limits: AnalyzerLimits,
    warnings: WarningCollector,
    *,
    index_elements: bool = False,
) -> ReadResult:
    """Read one package into the structural model.

    ``index_elements`` asks the walker to record, for every paragraph and run
    it names, the element that node id belongs to. Phase 12 needs it so a
    correction lands on exactly the element the plan named; ordinary analysis
    leaves it off and keeps nothing alive after the walk.
    """
    main_part = package.main_document_part()
    root = package.parse_part(main_part)
    namespaces = resolve_namespaces(root.tag)

    body = root.find(namespaces.qn("w:body"))
    if body is None:
        raise DocxAnalysisError(DocxErrorCode.STRUCTURE_INVALID, "the document has no body")

    styles = parse_styles(
        _related_root(package, main_part, REL_STYLES), namespaces, warnings, limits
    )
    # An absent numbering part is legal and common; it is only a problem when
    # content references it, which the numbering resolver reports per reference.
    numbering_root = _related_root(package, main_part, REL_NUMBERING)
    numbering = parse_numbering(numbering_root, namespaces, warnings, limits)
    settings = parse_settings(_related_root(package, main_part, REL_SETTINGS), namespaces)
    theme = parse_theme(
        _related_root(package, main_part, REL_THEME), namespaces, settings.theme_font_languages
    )

    context = WalkContext(
        namespaces=namespaces,
        styles=styles,
        numbering=numbering,
        theme=theme,
        settings=settings,
        limits=limits,
        warnings=warnings,
        elements={} if index_elements else None,
    )

    sections = inherit_references(collect_sections(body, namespaces, limits))
    stories: list[StoryNode] = []

    # --- main document -----------------------------------------------------
    main_walk = StoryWalk(
        story=Story.MAIN_DOCUMENT,
        key="",
        path=_root_path(Story.MAIN_DOCUMENT, "body"),
        section_index=None,
        part_name=main_part,
    )
    main_paragraphs = walk_block_content(body, context, main_walk)
    stories.append(
        StoryNode(
            story=Story.MAIN_DOCUMENT,
            key="main",
            reference=None,
            part_name=main_part,
            section_index=None,
            paragraph_ids=main_paragraphs,
        )
    )

    # --- text boxes --------------------------------------------------------
    # Walked from the main part, but recorded as their own story: text-box
    # content is not body text and must not answer a body rule (§22).
    _walk_textboxes(package, main_part, root, context, stories, Story.TEXTBOX)

    # --- headers and footers ----------------------------------------------
    _walk_headers_and_footers(package, main_part, sections, context, stories)

    # --- notes -------------------------------------------------------------
    notes = _walk_notes(package, main_part, context, stories, namespaces)

    # --- comments ----------------------------------------------------------
    comment_count = _count_comments(package, main_part, namespaces)

    metadata = _read_metadata(package)
    word_count = _count_words(context)

    model = StructuralModel(
        analysis_schema_version=ANALYSIS_SCHEMA_VERSION,
        profile=str(namespaces.profile),
        sections=sections,
        stories=tuple(stories),
        paragraphs=tuple(context.paragraphs),
        tables=tuple(context.tables),
        notes=tuple(notes),
        fields=tuple(context.fields),
        drawings=tuple(context.drawings),
        equations=place_equations(context.equations, context.paragraphs),
        revisions=RevisionSummary(
            insertions=context.insertions,
            deletions=context.deletions,
            moves=context.moves,
            formatting_changes=context.formatting_changes,
        ),
        metadata=metadata,
        word_count=word_count,
        comment_count=comment_count,
        mirror_margins=settings.mirror_margins,
        used_style_ids=tuple(sorted(context.used_style_ids)),
    )
    return ReadResult(model=model, context=context)


def _root_path(story: Story, *extra: str) -> NodePath:
    path = NodePath()
    path.push_literal(story_prefix(story))
    for segment in extra:
        path.push_literal(segment)
    return path


def _story_path(story: Story, key: str, *extra: str) -> NodePath:
    path = NodePath()
    path.push_literal(story_prefix(story, key=key))
    for segment in extra:
        path.push_literal(segment)
    return path


def _related_root(package: DocxPackage, source: str, kind: str) -> Element | None:
    relationship = package.relationships_of(source).first_of_kind(kind)
    if relationship is None:
        return None
    return package.parse_optional_part(relationship.part_name)


def _walk_textboxes(
    package: DocxPackage,
    part_name: str,
    root: Element,
    context: WalkContext,
    stories: list[StoryNode],
    story: Story,
) -> None:
    del package
    for index, content in enumerate(find_textbox_contents(root, context), start=1):
        walk = StoryWalk(
            story=story,
            key=str(index),
            path=_story_path(story, str(index)),
            section_index=None,
            part_name=part_name,
        )
        paragraph_ids = walk_block_content(content, context, walk)
        stories.append(
            StoryNode(
                story=story,
                key=str(index),
                reference=None,
                part_name=part_name,
                section_index=None,
                paragraph_ids=paragraph_ids,
            )
        )


def _walk_headers_and_footers(
    package: DocxPackage,
    main_part: str,
    sections: tuple[DocumentSection, ...],
    context: WalkContext,
    stories: list[StoryNode],
) -> None:
    """Walk each section's headers and footers (§51).

    A part referenced by several sections is walked once per section, because
    the *facts* differ: the same header used by two sections with different
    page geometry is two structural contexts, and a finding must say which.
    Inheritance was already resolved, so a section that inherited its header
    reports the same part as the one it inherited from.
    """
    seen: set[tuple[Story, int, str]] = set()
    for section in sections:
        for story, references in (
            (Story.HEADER, section.headers),
            (Story.FOOTER, section.footers),
        ):
            for reference in references:
                if (
                    story is Story.HEADER
                    and reference.reference_type == "even"
                    and not context.settings.even_and_odd_headers
                ):
                    # Declared but unused: Word ignores an even-page header
                    # unless the document opts in.
                    continue
                if reference.reference_type == "first" and not section.page_setup.title_page:
                    continue

                key = f"{reference.reference_type}:{section.index + 1}"
                if (story, section.index, reference.reference_type) in seen:
                    continue
                seen.add((story, section.index, reference.reference_type))

                part = package.part_for_relationship(main_part, reference.relationship_id)
                if part is None:
                    continue
                root = package.parse_optional_part(part)
                if root is None:
                    continue

                walk = StoryWalk(
                    story=story,
                    key=key,
                    path=_story_path(story, key),
                    section_index=section.index,
                    part_name=part,
                )
                paragraph_ids = walk_block_content(root, context, walk)
                stories.append(
                    StoryNode(
                        story=story,
                        key=key,
                        reference=reference.relationship_id,
                        part_name=part,
                        section_index=section.index,
                        paragraph_ids=paragraph_ids,
                    )
                )


def _walk_notes(
    package: DocxPackage,
    main_part: str,
    context: WalkContext,
    stories: list[StoryNode],
    namespaces: Namespaces,
) -> list[NoteNode]:
    """Footnotes and endnotes, separators excluded from user counts (§53)."""
    notes: list[NoteNode] = []
    for kind, story, element_name in (
        (REL_FOOTNOTES, Story.FOOTNOTE, "w:footnote"),
        (REL_ENDNOTES, Story.ENDNOTE, "w:endnote"),
    ):
        relationship = package.relationships_of(main_part).first_of_kind(kind)
        if relationship is None:
            continue
        note_part = relationship.part_name
        root = package.parse_optional_part(note_part)
        if root is None:
            continue
        for element in root.findall(namespaces.qn(element_name)):
            note_id = element.get(namespaces.qn("w:id")) or ""
            note_type = (element.get(namespaces.qn("w:type")) or "normal").strip()
            key = note_id or "0"
            walk = StoryWalk(
                story=story,
                key=key,
                path=_story_path(story, key),
                section_index=None,
                part_name=note_part,
            )
            paragraph_ids = walk_block_content(element, context, walk)
            notes.append(
                NoteNode(
                    note_id=note_id,
                    note_type=note_type,
                    story=story,
                    paragraph_ids=paragraph_ids,
                )
            )
            stories.append(
                StoryNode(
                    story=story,
                    key=key,
                    reference=note_id,
                    part_name=None,
                    section_index=None,
                    paragraph_ids=paragraph_ids,
                )
            )
    return notes


def _count_comments(package: DocxPackage, main_part: str, namespaces: Namespaces) -> int:
    """How many comments the document carries (§54).

    Presence and count only. Comment *text* is never extracted into facts and
    never logged: it is the most sensitive content in a manuscript under
    review.
    """
    relationship = package.relationships_of(main_part).first_of_kind(REL_COMMENTS)
    if relationship is None:
        return 0
    root = package.parse_optional_part(relationship.part_name)
    if root is None:
        return 0
    return len(root.findall(namespaces.qn("w:comment")))


def _read_metadata(package: DocxPackage) -> DocumentMetadata:
    core_relationship = package.relationships_of("").first_of_kind(REL_CORE_PROPERTIES)
    extended_relationship = package.relationships_of("").first_of_kind(REL_EXTENDED_PROPERTIES)
    core_root = (
        package.parse_optional_part(core_relationship.part_name)
        if core_relationship is not None
        else None
    )
    extended_root = (
        package.parse_optional_part(extended_relationship.part_name)
        if extended_relationship is not None
        else None
    )
    if core_root is None and extended_root is None:
        package.warnings.add(WarningCode.METADATA_PART_MISSING)
    return merge_extended_properties(parse_core_properties(core_root), extended_root)


def _count_words(context: WalkContext) -> WordCount:
    """Apply the documented word-count definition per story (§59)."""
    per_story: dict[Story, int] = {}
    body_text: list[str] = []

    for paragraph in context.paragraphs:
        if not paragraph.revision.visible_in_final:
            continue
        text = " ".join(run.text for run in paragraph.runs if run.visible)
        per_story[paragraph.story] = per_story.get(paragraph.story, 0) + count_words(text)
        if paragraph.story is Story.MAIN_DOCUMENT:
            body_text.append(text)

    joined = "\n".join(body_text)
    return WordCount(
        body_words=per_story.get(Story.MAIN_DOCUMENT, 0),
        footnote_words=per_story.get(Story.FOOTNOTE, 0),
        endnote_words=per_story.get(Story.ENDNOTE, 0),
        header_footer_words=per_story.get(Story.HEADER, 0) + per_story.get(Story.FOOTER, 0),
        textbox_words=per_story.get(Story.TEXTBOX, 0),
        body_characters=count_characters(joined, include_whitespace=True),
        body_characters_no_spaces=count_characters(joined, include_whitespace=False),
    )


def user_notes(notes: tuple[NoteNode, ...], story: Story) -> tuple[NoteNode, ...]:
    """Only a user's own notes: Word's separators are not notes (§53)."""
    return tuple(
        note for note in notes if note.story is story and note.note_type not in _SYSTEM_NOTE_TYPES
    )


#: A number written beside an equation: "(3.1)", "(12)", "(2-4)", and Arabic-Indic digits too.
_EQUATION_NUMBER = re.compile(r"\(\s*(\d+(?:\s*[.\-\u2010\u2013]\s*\d+)*)\s*\)")


def place_equations(
    equations: Sequence[EquationNode], paragraphs: Sequence[ParagraphNode]
) -> tuple[EquationNode, ...]:
    """Give each equation its reading order, its paragraph and its number.

    Rules about equations ask where they are and how they are numbered —
    "(3.1) sits in chapter 3", "numbering is sequential" — so the model keeps
    both. The number is the last "(n.m)" written in the equation's own
    paragraph, which is where Word, MathType and every thesis template put it;
    nothing is inferred from a different paragraph.
    """
    by_id = {paragraph.locator.node_id: paragraph for paragraph in paragraphs}
    placed: list[EquationNode] = []
    for index, equation in enumerate(equations, start=1):
        paragraph: ParagraphNode | None = None
        segments = equation.locator.node_id.split("/")
        for end in range(len(segments) - 1, 0, -1):
            paragraph = by_id.get("/".join(segments[:end]))
            if paragraph is not None:
                break
        number: str | None = None
        if paragraph is not None:
            matches = _EQUATION_NUMBER.findall(paragraph.visible_text)
            if matches:
                number = re.sub(r"\s+", "", matches[-1]).translate(_DASHES)
        placed.append(
            replace(
                equation,
                order=index,
                paragraph_node_id=paragraph.locator.node_id if paragraph is not None else None,
                number=number,
            )
        )
    return tuple(placed)


_DASHES = str.maketrans({"\u2010": "-", "\u2013": "-"})
