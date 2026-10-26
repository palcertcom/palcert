"""Grouping spans into lines and blocks, deterministically and visibly (§31-§33, §58-§60).

PDFium gives characters and boxes. It does not give words, lines, paragraphs or
reading order, so anything shaped like a paragraph in a PDF report was computed
by PalCert and must say so. Everything in this module is therefore:

* **explicit** - written out here rather than borrowed from a library whose
  behaviour could change under us;
* **versioned** - ``LAYOUT_ALGORITHM_VERSION`` changes whenever the same bytes
  would group differently, because a stored artifact is interpreted through it;
* **deterministic** - sorting is total, with the node id as the final key, so
  two runs never disagree about order;
* **labelled** - the objects it produces carry PDF_LAYOUT provenance, never the
  PDF_TEXT provenance of the spans they were built from.

A block is called a block, never a paragraph. The distinction is the whole
point: a PDF does not record where the author pressed Enter, and a measured gap
between lines is evidence about ink, not about authoring (§30).

What this module deliberately does *not* do is promote anything it finds into a
semantic role. A large bold line at the top of a page is a line that happens to
be large and bold; it becomes a HEADING only if the structure tree says so
(§35). The same applies to tables and figures.
"""

from __future__ import annotations

from decimal import Decimal
from itertools import pairwise

from app.pdf.model import BBox, ImageObject, LayoutBlock, LayoutLine, TextSpan
from app.pdf.numbers import quantise

#: Baselines within this many points are the same line. Chosen rather than
#: derived from font size because a line mixing 10pt body text with a 7pt
#: superscript shares one baseline, and scaling the tolerance by the larger
#: size would swallow the line below it.
BASELINE_TOLERANCE = Decimal("1.5")

#: Two lines belong to the same block when the gap between them is no more than
#: this multiple of the line height. 1.6 admits ordinary single and 1.5 spacing
#: and rejects the larger gap that separates blocks; a document that sets
#: double spacing produces one block per line, which is honest rather than
#: wrong - PalCert did not see a paragraph mark.
BLOCK_GAP_FACTOR = Decimal("1.6")

#: Blocks must also overlap horizontally to be joined, so two columns of text
#: at the same height do not become one block.
MIN_HORIZONTAL_OVERLAP = Decimal("0.25")


def _union(boxes: list[BBox]) -> BBox:
    return BBox(
        left=min(b.left for b in boxes),
        top=min(b.top for b in boxes),
        right=max(b.right for b in boxes),
        bottom=max(b.bottom for b in boxes),
    )


def _overlap_ratio(a: BBox, b: BBox) -> Decimal:
    left = max(a.left, b.left)
    right = min(a.right, b.right)
    if right <= left:
        return Decimal(0)
    narrower = min(a.width, b.width)
    if narrower <= 0:
        return Decimal(0)
    return quantise((right - left) / narrower, 4)


def build_lines(spans: tuple[TextSpan, ...], *, page_index: int) -> tuple[LayoutLine, ...]:
    """Spans sharing a baseline, in reading order across the line.

    Ordering is by display position, which is what a reader sees. For Arabic the
    characters arrive from PDFium in logical order within each span, so the
    spans are placed left to right by geometry and the text inside them is left
    exactly as the document stored it - reversing it here would corrupt it.
    """
    if not spans:
        return ()

    ordered = sorted(
        spans,
        key=lambda s: (s.display_bbox.top, s.display_bbox.left, s.node_id),
    )
    groups: list[list[TextSpan]] = []
    for span in ordered:
        placed = False
        for group in groups:
            if abs(group[0].display_bbox.bottom - span.display_bbox.bottom) <= BASELINE_TOLERANCE:
                group.append(span)
                placed = True
                break
        if not placed:
            groups.append([span])

    lines: list[LayoutLine] = []
    for group in sorted(groups, key=lambda g: (g[0].display_bbox.top, g[0].display_bbox.left)):
        across = sorted(group, key=lambda s: (s.display_bbox.left, s.node_id))
        box = _union([s.display_bbox for s in across])
        lines.append(
            LayoutLine(
                node_id=f"page:{page_index + 1}/line:{len(lines) + 1}",
                span_ids=tuple(s.node_id for s in across),
                text="".join(s.text for s in across),
                display_bbox=box,
                baseline=box.bottom,
                marked_content_ids=tuple(
                    sorted({s.marked_content_id for s in across if s.marked_content_id is not None})
                ),
            )
        )
    return tuple(lines)


def build_blocks(
    lines: tuple[LayoutLine, ...],
    *,
    page_index: int,
    roles: dict[str, str] | None = None,
) -> tuple[LayoutBlock, ...]:
    """Lines joined into blocks by vertical proximity and horizontal overlap.

    ``roles`` maps a line's node id to a semantic role, and is supplied only
    when a tagged structure tree vouched for it. An untagged document passes
    nothing, and every block comes out with ``structure_role`` of None - which
    is what makes a heading rule INDETERMINATE rather than guessed (§35).
    """
    if not lines:
        return ()

    blocks: list[LayoutBlock] = []
    current: list[LayoutLine] = []

    def flush() -> None:
        if not current:
            return
        box = _union([line.display_bbox for line in current])
        role = None
        if roles is not None:
            found = {roles[line.node_id] for line in current if line.node_id in roles}
            # Only an unambiguous role transfers: lines with two different tags
            # are not one semantic thing.
            role = found.pop() if len(found) == 1 else None
        blocks.append(
            LayoutBlock(
                node_id=f"page:{page_index + 1}/block:{len(blocks) + 1}",
                line_ids=tuple(line.node_id for line in current),
                text="\n".join(line.text for line in current),
                display_bbox=box,
                page_index=page_index,
                reading_index=len(blocks),
                structure_role=role,
            )
        )
        current.clear()

    for line in lines:
        if not current:
            current.append(line)
            continue
        previous = current[-1]
        gap = line.display_bbox.top - previous.display_bbox.bottom
        height = max(previous.display_bbox.height, Decimal("1"))
        overlap = _overlap_ratio(previous.display_bbox, line.display_bbox)
        same_block = gap <= height * BLOCK_GAP_FACTOR and overlap >= MIN_HORIZONTAL_OVERLAP
        if same_block:
            current.append(line)
        else:
            flush()
            current.append(line)
    flush()
    return tuple(blocks)


def baseline_distances(lines: tuple[LayoutLine, ...]) -> tuple[Decimal, ...]:
    """Gaps between consecutive baselines, as measured (§58).

    This is rendered geometry and nothing else. It is emphatically not Word's
    line-spacing setting: a document set to "1.5 lines" and one set to "exactly
    18pt" can produce identical baselines, and PalCert cannot tell them apart
    from the PDF because the PDF does not record which was asked for.
    """
    if len(lines) < 2:
        return ()
    gaps: list[Decimal] = []
    for previous, line in pairwise(lines):
        gaps.append(quantise(line.baseline - previous.baseline))
    return tuple(gaps)


def content_inset(
    lines: tuple[LayoutLine, ...],
    images: tuple[ImageObject, ...],
    *,
    page_width: Decimal,
    page_height: Decimal,
) -> dict[str, Decimal] | None:
    """How far the rendered content sits from each edge of the page (§56).

    This is *not* a margin. A margin is an instruction an author gave; this is
    a measurement of where ink happens to start, and a page whose first line is
    indented reports a larger left inset than the margin the author set. The
    registry keeps the two as separate properties for exactly that reason, and
    a DOCX margin rule is never satisfied by this number (§55, §62).
    """
    boxes = [line.display_bbox for line in lines]
    boxes.extend(image.display_bbox for image in images)
    if not boxes:
        return None
    union = _union(boxes)
    return {
        "left": quantise(union.left),
        "right": quantise(page_width - union.right),
        "top": quantise(union.top),
        "bottom": quantise(page_height - union.bottom),
    }
