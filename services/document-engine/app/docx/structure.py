"""Walking WordprocessingML into the structural model (§22, §23, §55, §58).

This is where the document is actually read. The walker descends every story,
and it descends *through* containers rather than around them: a paragraph
nested in a content control (``w:sdt``), a hyperlink or a custom-XML wrapper
is still a paragraph, and losing it because of its wrapper would silently
shrink a word count and hide a formatting violation (§23).

Three decisions are applied while walking rather than afterwards:

* **The revision view** (§55). The default view is FINAL, so ``w:del`` and
  ``w:moveFrom`` content is recorded with its state and excluded from visible
  text, while ``w:ins`` and ``w:moveTo`` content is ordinary content that
  happens to be marked.
* **Markup compatibility** (§21). ``mc:AlternateContent`` offers the same
  content twice; taking both would double-count it and taking neither would
  lose it. The first ``mc:Choice`` is preferred, ``mc:Fallback`` is used when
  there is no choice, and geometry stays PARTIAL; formatting needs branch equivalence.
* **Hidden text** (§58). A run whose effective properties hide it is kept in
  the model — the document does contain it — but marked, so no count treats it
  as ordinary body text.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from xml.etree.ElementTree import Element

from app.docx.citations.evidence import (
    BIBLIOGRAPHY_KEYWORD,
    CITATION_KEYWORD,
    BibliographyFieldMarker,
    NativeCitationField,
    RenderedReferenceParagraph,
)
from app.docx.limits import AnalyzerLimits, ResourceLimitExceededError
from app.docx.model import (
    EQUATION_FORMAT_LEGACY_OLE,
    DrawingNode,
    EquationNode,
    FieldNode,
    ParagraphNode,
    RevisionState,
    RunNode,
    SegmentNode,
    TableCellNode,
    TableNode,
    TableRowNode,
)
from app.docx.namespaces import NS_MARKUP_COMPATIBILITY, NS_OFFICE_MATH, Namespaces, local_name
from app.docx.nodes import (
    KIND_CELL,
    KIND_DRAWING,
    KIND_EQUATION,
    KIND_FIELD,
    KIND_PARAGRAPH,
    KIND_ROW,
    KIND_RUN,
    KIND_TABLE,
    NodePath,
    Story,
    build_locator,
)
from app.docx.numbering import NumberingCatalogue
from app.docx.properties import (
    PropertyLayer,
    PropertySource,
    resolve_paragraph_properties,
    resolve_run_properties,
)
from app.docx.rawprops import parse_paragraph_properties, parse_run_properties
from app.docx.script import segment as segment_text
from app.docx.settings import DocumentSettings
from app.docx.styles import StyleCatalogue, StyleType
from app.docx.theme import DocumentTheme
from app.docx.units import parse_int
from app.docx.warnings import WarningCode, WarningCollector

#: Wrappers whose children are ordinary content and must be descended into.
_TRANSPARENT_CONTAINERS = frozenset({"sdtContent", "customXml", "smartTag", "bdo", "dir"})


@dataclass(slots=True)
class WalkContext:
    """Everything the walker needs, gathered once."""

    namespaces: Namespaces
    styles: StyleCatalogue
    numbering: NumberingCatalogue
    theme: DocumentTheme
    settings: DocumentSettings
    limits: AnalyzerLimits
    warnings: WarningCollector

    paragraphs: list[ParagraphNode] = field(default_factory=list)
    tables: list[TableNode] = field(default_factory=list)
    fields: list[FieldNode] = field(default_factory=list)
    drawings: list[DrawingNode] = field(default_factory=list)
    equations: list[EquationNode] = field(default_factory=list)
    used_style_ids: set[str] = field(default_factory=set)
    #: Word-native citation evidence (Phase 18). Kept apart from ``fields``
    #: because it carries the citation tag, which is user content and must
    #: reach the artifact only inside the bounded ``citationAnalysis`` section.
    citation_fields: list[NativeCitationField] = field(default_factory=list)
    bibliography_fields: list[BibliographyFieldMarker] = field(default_factory=list)
    reference_paragraphs: list[RenderedReferenceParagraph] = field(default_factory=list)
    #: Optional node id → (part name, element) index, populated only when a
    #: caller asks for one.
    #:
    #: Phase 12 has to edit *exactly* the element a Phase 6 node id names. The
    #: only way to be certain of that is to let the walker that assigns the id
    #: hand back the element it assigned it to; a second walker written to the
    #: same rules would be a second chance to get the rules subtly wrong, and
    #: the cost of being wrong is an edit to the wrong paragraph of somebody's
    #: thesis. Left None during ordinary analysis, so nothing keeps an element
    #: tree alive after the walk.
    elements: dict[str, tuple[str, Element]] | None = None
    insertions: int = 0
    deletions: int = 0
    moves: int = 0
    formatting_changes: int = 0
    #: Paragraph node ids produced by the current story, in document order.
    current_story_paragraphs: list[str] = field(default_factory=list)

    def check_limits(self) -> None:
        if len(self.paragraphs) > self.limits.max_paragraphs:
            raise ResourceLimitExceededError("max_paragraphs", self.limits.max_paragraphs)
        if len(self.tables) > self.limits.max_tables:
            raise ResourceLimitExceededError("max_tables", self.limits.max_tables)
        if len(self.drawings) > self.limits.max_drawings:
            raise ResourceLimitExceededError("max_drawings", self.limits.max_drawings)


@dataclass(slots=True)
class StoryWalk:
    """State for one story being walked."""

    story: Story
    key: str
    path: NodePath
    section_index: int | None
    #: The package part this story's elements live in. Carried so an element
    #: index can say which part to rewrite, not only which element to change.
    part_name: str = ""
    #: Section index for the paragraph currently being read; advances when a
    #: paragraph carries a section-terminating ``w:sectPr``.
    current_section: int = 0
    run_count: int = 0
    cell_count: int = 0
    #: Instruction text accumulated inside a complex field (begin…separate).
    field_instruction: str | None = None
    #: Open complex fields, innermost last: True for a ``BIBLIOGRAPHY`` field.
    #:
    #: A stack rather than a flag or a counter because fields nest. Word puts
    #: a ``HYPERLINK`` inside a bibliography entry routinely, and its ``end``
    #: would close the bibliography if the two were not told apart — which
    #: would silently cut the reference list short at its first linked entry
    #: and leave the rest of the document looking like ordinary prose.
    open_fields: list[bool] = field(default_factory=list)

    @property
    def inside_bibliography(self) -> bool:
        return any(self.open_fields)


def _style_layers(
    context: WalkContext,
    paragraph_style_id: str | None,
    character_style_id: str | None,
    table_style_id: str | None,
) -> tuple[PropertyLayer, ...]:
    """The style hierarchy for one run or paragraph, in application order.

    Order is the specification's (§33): document defaults, table style,
    numbering style, paragraph style chain, character style chain. Direct
    formatting is appended by the caller, because only it knows what was
    declared on the element itself.
    """
    layers: list[PropertyLayer] = [
        PropertyLayer(
            source=PropertySource.DOCUMENT_DEFAULT,
            style_id=None,
            run=context.styles.defaults.run,
            paragraph=context.styles.defaults.paragraph,
        )
    ]

    if table_style_id:
        for style in context.styles.chain(
            table_style_id, context.warnings, context.limits, StyleType.TABLE
        ):
            layers.append(
                PropertyLayer(
                    source=PropertySource.TABLE_STYLE,
                    style_id=style.style_id,
                    run=style.run,
                    paragraph=style.paragraph,
                )
            )

    effective_paragraph_style = paragraph_style_id or context.styles.default_style_ids.get(
        StyleType.PARAGRAPH
    )
    if effective_paragraph_style:
        for style in context.styles.chain(
            effective_paragraph_style, context.warnings, context.limits, StyleType.PARAGRAPH
        ):
            layers.append(
                PropertyLayer(
                    source=PropertySource.PARAGRAPH_STYLE,
                    style_id=style.style_id,
                    run=style.run,
                    paragraph=style.paragraph,
                )
            )

    if character_style_id:
        for style in context.styles.chain(
            character_style_id, context.warnings, context.limits, StyleType.CHARACTER
        ):
            layers.append(
                PropertyLayer(
                    source=PropertySource.CHARACTER_STYLE,
                    style_id=style.style_id,
                    run=style.run,
                    paragraph=style.paragraph,
                )
            )

    return tuple(layers)


def _equivalent_textboxes(element: Element, namespaces: Namespaces) -> bool:
    """Prove identical text-box XML in every alternative before claiming coverage.

    Compare expanded names, attributes and text, not serialized namespace prefixes.
    Different text, formatting, box counts or unknown branches remain uncertain.
    Drawing geometry is deliberately outside this proof.
    """
    branches = list(element)
    allowed = {f"{{{NS_MARKUP_COMPATIBILITY}}}{name}" for name in ("Choice", "Fallback")}
    if (
        len(branches) < 2
        or branches[-1].tag != namespaces.qn("mc:Fallback")
        or any(branch.tag != namespaces.qn("mc:Choice") for branch in branches[:-1])
        or any(branch.tag not in allowed for branch in branches)
    ):
        return False
    boxes = [list(branch.iter(namespaces.qn("w:txbxContent"))) for branch in branches]
    first = boxes[0]
    for alternatives in boxes[1:]:
        if len(first) != len(alternatives):
            return False
        for left, right in zip(first, alternatives, strict=True):
            left_nodes, right_nodes = list(left.iter()), list(right.iter())
            if len(left_nodes) != len(right_nodes):
                return False
            for a, b in zip(left_nodes, right_nodes, strict=True):
                if (a.tag, a.attrib, a.text, len(a)) != (b.tag, b.attrib, b.text, len(b)):
                    return False
    return True


def _branch_placements(branch: Element, namespaces: Namespaces) -> tuple[str, ...] | None:
    """Compare only placement; never infer dimensions from a fallback drawing."""
    placements: list[str] = []
    vml = "urn:schemas-microsoft-com:vml"
    if any(e.tag == f"{{{vml}}}group" for e in branch.iter()):
        return None
    for element in branch.iter():
        if element.tag == namespaces.qn("w:drawing"):
            modes = [
                local_name(c.tag)
                for c in element
                if c.tag in {namespaces.qn("wp:inline"), namespaces.qn("wp:anchor")}
            ]
            if len(modes) != 1:
                return None
            placements.append(modes[0])
        elif element.tag == namespaces.qn("w:pict"):
            shapes = list(element.iter(f"{{{vml}}}shape"))
            if len(shapes) != 1:
                return None
            style = shapes[0].get("style", "")
            pairs = [part.split(":", 1) for part in style.split(";") if part.strip()]
            if any(len(pair) != 2 for pair in pairs):
                return None
            positions = [v.strip().lower() for k, v in pairs if k.strip().lower() == "position"]
            if len(positions) > 1:
                return None
            position = positions[0] if positions else "static"
            if position not in {"static", "absolute"}:
                return None
            placements.append("anchor" if position == "absolute" else "inline")
    return tuple(placements)


def _alternate_branch(element: Element, context: WalkContext) -> Element | None:
    """Which branch of an ``mc:AlternateContent`` to read (§21).

    Exactly one branch is read: taking both would count the same shape twice,
    taking neither would lose it. The richer ``mc:Choice`` is preferred. Either
    way drawing geometry remains PARTIAL. Text-box formatting and placement
    are complete only when their separate branch-equivalence proofs hold.
    """
    context.warnings.add(WarningCode.ALTERNATE_CONTENT_BRANCH_SELECTED)
    if not _equivalent_textboxes(element, context.namespaces):
        context.warnings.add(WarningCode.ALTERNATE_TEXTBOX_CONTENT_UNRESOLVED)
    placements = [_branch_placements(branch, context.namespaces) for branch in element]
    allowed = {context.namespaces.qn("mc:Choice"), context.namespaces.qn("mc:Fallback")}
    if (
        len(placements) < 2
        or element[-1].tag != context.namespaces.qn("mc:Fallback")
        or any(branch.tag != context.namespaces.qn("mc:Choice") for branch in list(element)[:-1])
        or any(branch.tag not in allowed for branch in element)
        or any(p is None or p != placements[0] for p in placements)
    ):
        context.warnings.add(WarningCode.ALTERNATE_DRAWING_PLACEMENT_UNRESOLVED)
    choice: Element | None = None
    fallback: Element | None = None
    for child in element:
        name = local_name(child.tag)
        if name == "Choice" and choice is None:
            choice = child
        elif name == "Fallback":
            fallback = child
    if choice is not None:
        return choice
    if fallback is not None:
        context.warnings.add(WarningCode.ALTERNATE_CONTENT_FALLBACK_USED)
        return fallback
    context.warnings.add(WarningCode.UNSUPPORTED_MARKUP, element="AlternateContent")
    return None


def _iter_content(element: Element, context: WalkContext) -> list[Element]:
    """Children to treat as content, unwrapping transparent containers.

    Content controls, custom XML and smart tags wrap real content; their
    children are the document. ``mc:AlternateContent`` is resolved to one
    branch here so no caller sees both.
    """
    result: list[Element] = []
    for child in element:
        name = local_name(child.tag)
        if child.tag == f"{{{NS_MARKUP_COMPATIBILITY}}}AlternateContent":
            branch = _alternate_branch(child, context)
            if branch is not None:
                result.extend(_iter_content(branch, context))
            continue
        if name == "sdt":
            content = None
            for grandchild in child:
                if local_name(grandchild.tag) == "sdtContent":
                    content = grandchild
                    break
            if content is not None:
                result.extend(_iter_content(content, context))
            continue
        if name in _TRANSPARENT_CONTAINERS:
            result.extend(_iter_content(child, context))
            continue
        result.append(child)
    return result


_REVISION_BY_TAG: dict[str, RevisionState] = {
    "ins": RevisionState.INSERTED,
    "del": RevisionState.DELETED,
    "moveTo": RevisionState.MOVED_TO,
    "moveFrom": RevisionState.MOVED_FROM,
}


def _run_children(run: Element, context: WalkContext) -> list[Element]:
    """A run's children with ``mc:AlternateContent`` resolved to one branch.

    Word puts AlternateContent *inside* a run for shapes and text boxes, not
    only at block level, so resolving it only in block containers would leave
    the common case unhandled — and silently lose whichever branch nobody
    looked at.
    """
    children: list[Element] = []
    for child in run:
        if child.tag == f"{{{NS_MARKUP_COMPATIBILITY}}}AlternateContent":
            branch = _alternate_branch(child, context)
            if branch is not None:
                children.extend(branch)
            continue
        children.append(child)
    return children


def _run_text(run: Element, context: WalkContext) -> str:
    """Visible text of one run under the FINAL view.

    ``w:delText`` holds deleted text and is read only so the model knows it
    exists; it never becomes visible text. ``w:tab`` and ``w:br`` contribute a
    separator so that "a<tab>b" is two words rather than one.
    """
    namespaces = context.namespaces
    pieces: list[str] = []
    for child in _run_children(run, context):
        name = local_name(child.tag)
        if name == "t":
            pieces.append(child.text or "")
        elif name == "delText":
            # Present for accounting only; excluded from the FINAL view.
            continue
        elif name in {"tab", "br", "cr"}:
            pieces.append(" ")
        elif name == "noBreakHyphen":
            pieces.append("-")
        elif name == "softHyphen":
            continue
        elif name == "sym":
            char = child.get(namespaces.qn("w:char"))
            pieces.append(" " if char else "")
    return "".join(pieces)


def _walk_run(
    run: Element,
    context: WalkContext,
    walk: StoryWalk,
    paragraph_style_id: str | None,
    table_style_id: str | None,
    revision: RevisionState,
) -> RunNode:
    namespaces = context.namespaces
    walk.run_count += 1
    if walk.run_count > context.limits.max_runs:
        raise ResourceLimitExceededError("max_runs", context.limits.max_runs)

    direct = parse_run_properties(run.find(namespaces.qn("w:rPr")), namespaces)
    if direct.style_id:
        context.used_style_ids.add(direct.style_id)
    if direct.has_formatting_revision:
        context.formatting_changes += 1

    layers = _style_layers(context, paragraph_style_id, direct.style_id, table_style_id)
    layers = (
        *layers,
        PropertyLayer(source=PropertySource.DIRECT_FORMATTING, style_id=None, run=direct),
    )
    effective = resolve_run_properties(layers, context.theme, context.warnings)

    walk.path.push(KIND_RUN)
    locator = build_locator(walk.story, walk.path.snapshot())
    if locator.truncated:
        context.warnings.add(WarningCode.NODE_ID_TRUNCATED)
    if context.elements is not None and not locator.truncated:
        context.elements[locator.node_id] = (walk.part_name, run)

    text = _run_text(run, context)
    segments: list[SegmentNode] = []
    for piece in segment_text(text):
        font = effective.font_for_slot(piece.slot)
        size = effective.size_for_slot(piece.slot)
        segments.append(
            SegmentNode(
                channel=str(piece.channel),
                slot=str(piece.slot),
                length=piece.length,
                font_family=font.value if font else None,
                font_size_points=size.value if size else None,
            )
        )

    _collect_run_children(run, context, walk)
    walk.path.pop()

    hidden_toggle = effective.toggle("vanish")
    web_hidden = effective.on_off.get("webHidden")
    hidden = bool(hidden_toggle and hidden_toggle.value) or bool(web_hidden and web_hidden.value)

    return RunNode(
        locator=locator,
        text=text,
        revision=revision,
        hidden=hidden,
        effective=effective,
        segments=tuple(segments),
        character_style_id=direct.style_id,
    )


def _collect_run_children(run: Element, context: WalkContext, walk: StoryWalk) -> None:
    """Drawings and equations carried inside a run."""
    for child in _run_children(run, context):
        name = local_name(child.tag)
        if name == "drawing":
            _record_drawing(child, context, walk)
        elif name == "object" and _legacy_equation_class(child) is not None:
            # A legacy equation object (MathType, Equation 3.0): an equation,
            # not a figure. Only the XML around it is read — the embedded
            # binary is never opened here, and ingestion admitted it only
            # after classifying it structurally.
            _record_legacy_equation(child, context, walk)
        elif name in {"object", "pict"}:
            # A legacy VML picture. Recorded as a drawing with no extent: the
            # size lives in a style attribute PalCert does not parse, and an
            # invented size would be worse than none.
            _record_legacy_picture(child, context, walk)
        elif child.tag in {
            f"{{{NS_OFFICE_MATH}}}oMath",
            f"{{{NS_OFFICE_MATH}}}oMathPara",
        }:
            _record_equation(child, context, walk)


def _record_drawing(drawing: Element, context: WalkContext, walk: StoryWalk) -> None:
    namespaces = context.namespaces
    placement = "inline"
    extent: Element | None = None
    for child in drawing:
        name = local_name(child.tag)
        if name in {"inline", "anchor"}:
            placement = name
            for grandchild in child:
                if local_name(grandchild.tag) == "extent":
                    extent = grandchild
                    break
            break

    has_alt = False
    relationship_id: str | None = None
    for element in drawing.iter():
        name = local_name(element.tag)
        if name == "docPr":
            description = element.get("descr")
            title = element.get("title")
            has_alt = bool((description or "").strip() or (title or "").strip())
        elif name == "blip":
            relationship_id = element.get(namespaces.qn("r:embed")) or element.get(
                namespaces.qn("r:link")
            )

    walk.path.push(KIND_DRAWING)
    locator = build_locator(walk.story, walk.path.snapshot())
    walk.path.pop()

    if context.elements is not None and not locator.truncated:
        context.elements[locator.node_id] = (walk.part_name, drawing)

    context.drawings.append(
        DrawingNode(
            locator=locator,
            placement=placement,
            width_emu=parse_int(extent.get("cx")) if extent is not None else None,
            height_emu=parse_int(extent.get("cy")) if extent is not None else None,
            has_alternative_text=has_alt,
            relationship_id=relationship_id,
        )
    )
    context.check_limits()


def _record_legacy_picture(element: Element, context: WalkContext, walk: StoryWalk) -> None:
    has_image = any(local_name(child.tag) in {"imagedata", "shape"} for child in element.iter())
    if not has_image:
        return
    walk.path.push(KIND_DRAWING)
    locator = build_locator(walk.story, walk.path.snapshot())
    walk.path.pop()
    context.drawings.append(
        DrawingNode(
            locator=locator,
            placement="inline",
            width_emu=None,
            height_emu=None,
            has_alternative_text=False,
            relationship_id=None,
        )
    )
    context.check_limits()


#: The legacy equation classes ingestion admits (apps/api embedded-objects.ts).
#: Kept in step with that allow-list; an object of any other class is still a
#: picture here, and never reached this engine unless ingestion accepted it.
LEGACY_EQUATION_CLASSES = frozenset({"Equation.DSMT4", "Equation.3"})


def _legacy_equation_class(element: Element) -> str | None:
    for child in element:
        if local_name(child.tag) == "OLEObject":
            prog_id = child.get("ProgID")
            if prog_id in LEGACY_EQUATION_CLASSES and child.get("Type", "Embed") == "Embed":
                return prog_id
    return None


def _record_legacy_equation(element: Element, context: WalkContext, walk: StoryWalk) -> None:
    legacy_class = _legacy_equation_class(element)
    preview = any(local_name(node.tag) == "imagedata" for node in element.iter())
    walk.path.push(KIND_EQUATION)
    locator = build_locator(walk.story, walk.path.snapshot())
    walk.path.pop()
    context.equations.append(
        EquationNode(
            locator=locator,
            display=False,
            source_format=EQUATION_FORMAT_LEGACY_OLE,
            legacy_class=legacy_class,
            preview_available=preview,
            semantics_available=False,
        )
    )
    context.warnings.add(WarningCode.LEGACY_EQUATION_SEMANTICS_UNAVAILABLE)
    context.check_limits()


def _record_equation(element: Element, context: WalkContext, walk: StoryWalk) -> None:
    display = element.tag == f"{{{NS_OFFICE_MATH}}}oMathPara"
    walk.path.push(KIND_EQUATION)
    locator = build_locator(walk.story, walk.path.snapshot())
    walk.path.pop()
    context.equations.append(EquationNode(locator=locator, display=display))


def _record_field(
    instruction: str,
    context: WalkContext,
    walk: StoryWalk,
    revision: RevisionState = RevisionState.UNCHANGED,
) -> None:
    from app.docx.fields import citation_tag, parse_instruction

    field_type, keyword, sequence_name = parse_instruction(instruction)
    walk.path.push(KIND_FIELD)
    locator = build_locator(walk.story, walk.path.snapshot())
    walk.path.pop()
    context.fields.append(
        FieldNode(
            locator=locator,
            field_type=field_type,
            instruction_keyword=keyword,
            sequence_name=sequence_name,
        )
    )
    if keyword == CITATION_KEYWORD:
        context.citation_fields.append(
            NativeCitationField(
                locator=locator,
                tag=citation_tag(instruction),
                revision=revision,
            )
        )
    elif keyword == BIBLIOGRAPHY_KEYWORD:
        context.bibliography_fields.append(
            BibliographyFieldMarker(locator=locator, revision=revision)
        )


def _heading_level(outline_level: int | None) -> int | None:
    """Outline level 0-8 is heading level 1-9 (§45).

    Level 9 is WordprocessingML's "body text" and is deliberately not a
    heading. Nothing here looks at boldness or font size: a visually large
    paragraph is not structurally a heading, and treating it as one would put
    a guess into a deterministic fact.
    """
    if outline_level is None:
        return None
    if 0 <= outline_level <= 8:
        return outline_level + 1
    return None


def walk_paragraph(
    paragraph: Element,
    context: WalkContext,
    walk: StoryWalk,
    *,
    revision: RevisionState = RevisionState.UNCHANGED,
    table_style_id: str | None = None,
    in_table: bool = False,
) -> ParagraphNode:
    namespaces = context.namespaces
    direct = parse_paragraph_properties(paragraph.find(namespaces.qn("w:pPr")), namespaces)
    if direct.style_id:
        context.used_style_ids.add(direct.style_id)
        if context.styles.present and context.styles.get(direct.style_id) is None:
            context.warnings.add(WarningCode.STYLE_PARENT_MISSING, styleId=direct.style_id)
    if direct.has_formatting_revision:
        context.formatting_changes += 1

    layers = _style_layers(context, direct.style_id, None, table_style_id)
    numbering_layers: list[PropertyLayer] = []
    effective_pre = resolve_paragraph_properties(
        (*layers, PropertyLayer(PropertySource.DIRECT_FORMATTING, None, paragraph=direct))
    )
    resolved_numbering = context.numbering.resolve(
        effective_pre.numbering_id, effective_pre.numbering_level, context.warnings
    )
    if resolved_numbering is not None:
        from app.docx.rawprops import RawParagraphProperties

        numbering_layers.append(
            PropertyLayer(
                source=PropertySource.NUMBERING_STYLE,
                style_id=f"num:{resolved_numbering.numbering_id}",
                paragraph=RawParagraphProperties(indentation=resolved_numbering.indentation),
            )
        )

    # Numbering sits between table and paragraph styles in the hierarchy, so
    # it is spliced in rather than appended (§33).
    ordered = (
        layers[:1]
        + tuple(numbering_layers)
        + layers[1:]
        + (PropertyLayer(PropertySource.DIRECT_FORMATTING, None, paragraph=direct),)
    )
    effective = resolve_paragraph_properties(ordered)

    walk.path.push(KIND_PARAGRAPH)
    locator = build_locator(walk.story, walk.path.snapshot())
    if locator.truncated:
        context.warnings.add(WarningCode.NODE_ID_TRUNCATED)
    if context.elements is not None and not locator.truncated:
        # A truncated id names no single element unambiguously, so it is left
        # out rather than indexed under a name that could collide.
        context.elements[locator.node_id] = (walk.part_name, paragraph)

    runs: list[RunNode] = []
    # A bibliography field's result spans paragraphs: its `separate` is inside
    # the first one and its `end` inside the last, so a paragraph belongs to
    # the region if the field was open when the paragraph started *or* when it
    # finished. Reading the depth only afterwards would drop the last entry.
    opened_before = walk.inside_bibliography
    _walk_paragraph_content(
        paragraph, context, walk, direct.style_id, table_style_id, revision, runs
    )
    walk.path.pop()

    text = "".join(run.text for run in runs if run.visible)
    if len(text) > context.limits.max_retained_text_chars:
        text = text[: context.limits.max_retained_text_chars]

    # After the retention limit, not before: a reference entry is retained
    # text like any other, and citation evidence is not a way around the
    # minimization bound the rest of the model observes.
    if (opened_before or walk.inside_bibliography) and text.strip():
        context.reference_paragraphs.append(
            RenderedReferenceParagraph(locator=locator, text=text, revision=revision)
        )

    node = ParagraphNode(
        locator=locator,
        story=walk.story,
        section_index=walk.current_section if walk.story is Story.MAIN_DOCUMENT else None,
        style_id=direct.style_id,
        effective=effective,
        runs=tuple(runs),
        numbering=resolved_numbering,
        heading_level=_heading_level(
            effective.outline_level.value if effective.outline_level else None
        ),
        revision=revision,
        in_table=in_table,
        has_formatting_revision=direct.has_formatting_revision,
        text=text,
    )
    context.paragraphs.append(node)
    context.check_limits()

    if direct.has_section_properties and walk.story is Story.MAIN_DOCUMENT:
        walk.current_section += 1

    return node


def _walk_paragraph_content(
    parent: Element,
    context: WalkContext,
    walk: StoryWalk,
    paragraph_style_id: str | None,
    table_style_id: str | None,
    revision: RevisionState,
    runs: list[RunNode],
) -> None:
    """Descend a paragraph's children, following revisions and wrappers."""
    namespaces = context.namespaces
    for child in _iter_content(parent, context):
        name = local_name(child.tag)
        if name == "pPr":
            continue
        if name == "r":
            runs.append(
                _walk_run(child, context, walk, paragraph_style_id, table_style_id, revision)
            )
            _read_complex_field(child, context, walk, revision)
            continue
        if name in _REVISION_BY_TAG:
            state = _REVISION_BY_TAG[name]
            _count_revision(context, state)
            _walk_paragraph_content(
                child, context, walk, paragraph_style_id, table_style_id, state, runs
            )
            continue
        if name == "hyperlink":
            _walk_paragraph_content(
                child, context, walk, paragraph_style_id, table_style_id, revision, runs
            )
            continue
        if name == "fldSimple":
            instruction = child.get(namespaces.qn("w:instr")) or ""
            _record_field(instruction, context, walk, revision)
            _walk_paragraph_content(
                child, context, walk, paragraph_style_id, table_style_id, revision, runs
            )
            continue
        if child.tag in {f"{{{NS_OFFICE_MATH}}}oMath", f"{{{NS_OFFICE_MATH}}}oMathPara"}:
            _record_equation(child, context, walk)
            continue
        if name in {
            "bookmarkStart",
            "bookmarkEnd",
            "proofErr",
            "commentRangeStart",
            "commentRangeEnd",
            "lastRenderedPageBreak",
        }:
            continue


def _count_revision(context: WalkContext, state: RevisionState) -> None:
    if state is RevisionState.INSERTED:
        context.insertions += 1
    elif state is RevisionState.DELETED:
        context.deletions += 1
    elif state in {RevisionState.MOVED_TO, RevisionState.MOVED_FROM}:
        context.moves += 1


def _read_complex_field(
    run: Element,
    context: WalkContext,
    walk: StoryWalk,
    revision: RevisionState = RevisionState.UNCHANGED,
) -> None:
    """Complex fields: ``begin``, ``instrText``…, ``separate``, ``end``.

    Word splits one instruction across several runs whenever it feels like it,
    so " SEQ Figure " can arrive as " SEQ ", "Fig", "ure ". Recording each
    fragment as its own field would invent three fields and lose the sequence
    name; the fragments are therefore accumulated between the field
    characters and flushed once.

    A ``BIBLIOGRAPHY`` field is also tracked across its result, because the
    paragraphs Word wrote between ``separate`` and ``end`` are the reference
    list itself.
    """
    namespaces = context.namespaces
    for child in run:
        name = local_name(child.tag)
        if name == "fldChar":
            kind = (child.get(namespaces.qn("w:fldCharType")) or "").strip().lower()
            if kind == "begin":
                walk.field_instruction = ""
                walk.open_fields.append(False)
            elif kind == "separate" and walk.field_instruction is not None:
                instruction = walk.field_instruction.strip()
                walk.field_instruction = None
                if instruction:
                    _record_field(instruction, context, walk, revision)
                    if walk.open_fields and _is_bibliography(instruction):
                        walk.open_fields[-1] = True
            elif kind == "end":
                if walk.field_instruction is not None:
                    instruction = walk.field_instruction.strip()
                    walk.field_instruction = None
                    if instruction:
                        # No separate character: the field has no cached
                        # result, so there is nothing rendered to read.
                        _record_field(instruction, context, walk, revision)
                if walk.open_fields:
                    walk.open_fields.pop()
        elif name == "instrText" and walk.field_instruction is not None:
            walk.field_instruction += child.text or ""


def _is_bibliography(instruction: str) -> bool:
    from app.docx.fields import parse_instruction

    return parse_instruction(instruction)[1] == BIBLIOGRAPHY_KEYWORD


def walk_table(
    table: Element,
    context: WalkContext,
    walk: StoryWalk,
    *,
    depth: int = 0,
    revision: RevisionState = RevisionState.UNCHANGED,
) -> TableNode:
    """One table, its rows, its cells and everything inside them (§49).

    Nested tables are walked recursively and keep their own locators, so a
    paragraph in a table inside a table has an unambiguous address.

    Conditional table-style formatting — first row, last row, banded rows and
    columns — is **not** resolved (§50). The table style's base properties
    apply; its ``w:tblStylePr`` variants do not. That is recorded as a warning
    and drops the affected coverage to PARTIAL, because an honest partial
    answer beats a confident wrong one.
    """
    namespaces = context.namespaces
    properties = table.find(namespaces.qn("w:tblPr"))
    style_id: str | None = None
    alignment: str | None = None
    width_twips: int | None = None
    width_type: str | None = None

    if properties is not None:
        style = properties.find(namespaces.qn("w:tblStyle"))
        if style is not None:
            style_id = style.get(namespaces.qn("w:val"))
        justification = properties.find(namespaces.qn("w:jc"))
        if justification is not None:
            alignment = justification.get(namespaces.qn("w:val"))
        width = properties.find(namespaces.qn("w:tblW"))
        if width is not None:
            width_twips = parse_int(width.get(namespaces.qn("w:w")))
            width_type = width.get(namespaces.qn("w:type"))

    if style_id:
        context.used_style_ids.add(style_id)

    conditional_unresolved = False
    if style_id:
        table_style = context.styles.get(style_id)
        if table_style is not None and table_style.has_conditional_formatting:
            conditional_unresolved = True
            context.warnings.add(WarningCode.TABLE_STYLE_CONDITIONAL_IGNORED, styleId=style_id)

    walk.path.push(KIND_TABLE)
    locator = build_locator(walk.story, walk.path.snapshot())

    rows: list[TableRowNode] = []
    for row_element in _iter_content(table, context):
        if local_name(row_element.tag) != "tr":
            continue
        rows.append(_walk_row(row_element, context, walk, len(rows), style_id, depth, revision))

    walk.path.pop()

    node = TableNode(
        locator=locator,
        story=walk.story,
        style_id=style_id,
        alignment=alignment,
        width_twips=width_twips,
        width_type=width_type,
        rows=tuple(rows),
        depth=depth,
        conditional_formatting_unresolved=conditional_unresolved,
    )
    context.tables.append(node)
    context.check_limits()
    return node


def _walk_row(
    row: Element,
    context: WalkContext,
    walk: StoryWalk,
    index: int,
    table_style_id: str | None,
    depth: int,
    revision: RevisionState,
) -> TableRowNode:
    namespaces = context.namespaces
    walk.path.push(KIND_ROW)
    locator = build_locator(walk.story, walk.path.snapshot())

    properties = row.find(namespaces.qn("w:trPr"))
    is_header = properties is not None and properties.find(namespaces.qn("w:tblHeader")) is not None

    cells: list[TableCellNode] = []
    for cell_element in _iter_content(row, context):
        if local_name(cell_element.tag) != "tc":
            continue
        cells.append(
            _walk_cell(
                cell_element, context, walk, index, len(cells), table_style_id, depth, revision
            )
        )

    walk.path.pop()
    return TableRowNode(locator=locator, index=index, cells=tuple(cells), is_header=is_header)


def _walk_cell(
    cell: Element,
    context: WalkContext,
    walk: StoryWalk,
    row_index: int,
    column_index: int,
    table_style_id: str | None,
    depth: int,
    revision: RevisionState,
) -> TableCellNode:
    namespaces = context.namespaces
    walk.cell_count += 1
    if walk.cell_count > context.limits.max_table_cells:
        raise ResourceLimitExceededError("max_table_cells", context.limits.max_table_cells)

    walk.path.push(KIND_CELL)
    locator = build_locator(walk.story, walk.path.snapshot())

    properties = cell.find(namespaces.qn("w:tcPr"))
    grid_span = 1
    width_twips: int | None = None
    if properties is not None:
        span = properties.find(namespaces.qn("w:gridSpan"))
        if span is not None:
            grid_span = parse_int(span.get(namespaces.qn("w:val"))) or 1
        width = properties.find(namespaces.qn("w:tcW"))
        if width is not None:
            width_twips = parse_int(width.get(namespaces.qn("w:w")))

    paragraph_ids: list[str] = []
    for child in _iter_content(cell, context):
        name = local_name(child.tag)
        if name == "p":
            node = walk_paragraph(
                child,
                context,
                walk,
                revision=revision,
                table_style_id=table_style_id,
                in_table=True,
            )
            paragraph_ids.append(node.locator.node_id)
        elif name == "tbl":
            walk_table(child, context, walk, depth=depth + 1, revision=revision)

    walk.path.pop()
    return TableCellNode(
        locator=locator,
        row_index=row_index,
        column_index=column_index,
        grid_span=grid_span,
        width_twips=width_twips,
        paragraph_ids=tuple(paragraph_ids),
    )


def walk_block_content(
    container: Element,
    context: WalkContext,
    walk: StoryWalk,
) -> tuple[str, ...]:
    """Walk a block-level container: a body, a header, a cell, a note.

    Returns the node ids of the paragraphs produced, in document order, so a
    story can record exactly what it contains.
    """
    paragraph_ids: list[str] = []
    for child in _iter_content(container, context):
        name = local_name(child.tag)
        if name == "p":
            node = walk_paragraph(child, context, walk)
            paragraph_ids.append(node.locator.node_id)
        elif name == "tbl":
            walk_table(child, context, walk)
        elif name in _REVISION_BY_TAG:
            state = _REVISION_BY_TAG[name]
            _count_revision(context, state)
            for nested in _iter_content(child, context):
                if local_name(nested.tag) == "p":
                    node = walk_paragraph(nested, context, walk, revision=state)
                    paragraph_ids.append(node.locator.node_id)
                elif local_name(nested.tag) == "tbl":
                    walk_table(child, context, walk, revision=state)
    return tuple(paragraph_ids)


def find_textbox_contents(root: Element, context: WalkContext) -> list[Element]:
    """Every ``w:txbxContent`` in a tree, in document order (§22).

    Text boxes are a story of their own: their paragraphs are not body
    paragraphs, and a rule about body formatting must not see them. Finding
    them by local name covers both the DrawingML shape form and the legacy
    VML form without needing to know which one this document used.
    """
    found: list[Element] = []
    for element in root.iter():
        if local_name(element.tag) == "txbxContent":
            found.append(element)
    return found
