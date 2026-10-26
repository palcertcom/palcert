"""Reading pages, text and objects out of PDFium (§28, §29, §43, §44, §48).

PDFium hands back characters, not words, lines or paragraphs: for each glyph it
knows the page, the box it occupies, the font it was drawn with and the
effective size after the text and object matrices. That is exactly the right
level for evidence, and exactly the wrong level for a report, which is why
grouping lives in ``layout.py`` and is versioned separately.

Two things are handled carefully here.

**Effective font size.** ``FPDFText_GetFontSize`` returns the *text-state* size
— the number in the content stream — and not the size a reader measures. Text
drawn under a matrix of ``2 0 0 2`` at 10pt is 20pt on the page. The effective
size is therefore the text-state size multiplied by the vertical scale of the
character's own matrix, and both numbers are kept: ``declaredFontSize`` is what
the stream says and ``fontSize`` is what the page shows. A fixture proves the
difference, because getting this wrong silently halves or doubles every
typography finding on transformed text (§43, §44).

**Lines are found from baselines, not boxes.** A glyph box grows downward for a
descender and upward for an ascender, so "same bottom edge" splits ``Body`` into
``Bod`` and ``y``. ``FPDFText_GetCharOrigin`` gives the baseline the glyph was
actually placed on, which is the thing that is genuinely shared across a line.

**Unmapped glyphs.** ``FPDFText_HasUnicodeMapError`` is asked rather than the
decoded character inspected: a document whose text extracts as replacement
characters has no usable text layer, and treating that as "the text says ���"
would be fabrication (§48).

**Generated characters.** PDFium synthesises line and paragraph breaks that are
in no content stream. They are dropped: a span must correspond to ink.
"""

from __future__ import annotations

import ctypes
import math
from decimal import Decimal

import pypdfium2 as pdfium
import pypdfium2.raw as pr

from app.pdf.fonts import build_identity
from app.pdf.geometry import build_geometry, rect_to_bbox, to_display
from app.pdf.limits import PdfLimits
from app.pdf.model import BBox, FontIdentity, ImageObject, PageBox, PageGeometry, TextSpan
from app.pdf.numbers import FONT_SIZE_PLACES, quantise

#: Characters PDFium emits when it cannot map a glyph to Unicode.
_UNMAPPED = frozenset({"\x00", "\ufffd"})


def _page_boxes(page: pdfium.PdfPage) -> dict[str, BBox | None]:
    """Every box the page declares. A box PDFium cannot read is None, not a guess."""
    boxes: dict[str, BBox | None] = {}
    for name, getter in (
        ("media", page.get_mediabox),
        ("crop", page.get_cropbox),
        ("bleed", page.get_bleedbox),
        ("trim", page.get_trimbox),
        ("art", page.get_artbox),
    ):
        try:
            rect = getter()
        except Exception:  # a malformed box is data, not a crash
            rect = None
        boxes[name] = None if rect is None else rect_to_bbox(rect)
    return boxes


def page_geometry(page: pdfium.PdfPage, *, user_unit: float = 1.0) -> tuple[PageGeometry, bool]:
    boxes = _page_boxes(page)
    media = boxes["media"] or rect_to_bbox((0.0, 0.0, 612.0, 792.0))
    return build_geometry(
        media=media,
        crop=boxes["crop"],
        bleed=boxes["bleed"],
        trim=boxes["trim"],
        art=boxes["art"],
        rotation=page.get_rotation(),
        user_unit=user_unit,
    )


def _font_of(textpage: pdfium.PdfTextPage, index: int) -> FontIdentity | None:
    """The font of one character, as the document declares it."""
    flags = ctypes.c_int()
    needed = pr.FPDFText_GetFontInfo(textpage.raw, index, None, 0, ctypes.byref(flags))
    if needed <= 0:
        return None
    buffer = ctypes.create_string_buffer(needed)
    pr.FPDFText_GetFontInfo(textpage.raw, index, buffer, needed, ctypes.byref(flags))
    raw_name = buffer.value.decode("utf-8", "replace")
    if not raw_name:
        return None
    weight = pr.FPDFText_GetFontWeight(textpage.raw, index)
    # PDFium reports -1 when it has no weight for the font; 0 means the same in
    # practice. Either way the document did not say, and neither will PalCert.
    return build_identity(
        raw_name=raw_name,
        # PDFium does not expose embedding through the text API. The structural
        # pass (pikepdf) knows, and reconciles it by base name afterwards.
        embedded=True,
        weight=None if weight is None or weight <= 0 else int(weight),
        flags=int(flags.value),
    )


def _text_state_size(textpage: pdfium.PdfTextPage, index: int) -> Decimal | None:
    size = pr.FPDFText_GetFontSize(textpage.raw, index)
    if size is None or size <= 0:
        return None
    return quantise(size, FONT_SIZE_PLACES)


def _vertical_scale(textpage: pdfium.PdfTextPage, index: int) -> Decimal:
    """The vertical scale factor of one character's matrix.

    The glyph's height on the page scales with the second column of the matrix,
    so the factor is ``hypot(b, d)`` — the length of the transformed unit
    y-vector. A rotated-but-unscaled character therefore still reports 1.
    """
    matrix = pr.FS_MATRIX()
    if not pr.FPDFText_GetMatrix(textpage.raw, index, ctypes.byref(matrix)):
        return Decimal(1)
    factor = math.hypot(float(matrix.b), float(matrix.d))
    if factor <= 0:
        return Decimal(1)
    return quantise(factor, 6)


def _origin_y(textpage: pdfium.PdfTextPage, index: int) -> Decimal | None:
    """The baseline y of one character, in user space."""
    x = ctypes.c_double()
    y = ctypes.c_double()
    if not pr.FPDFText_GetCharOrigin(textpage.raw, index, ctypes.byref(x), ctypes.byref(y)):
        return None
    return quantise(y.value)


def _is_generated(textpage: pdfium.PdfTextPage, index: int) -> bool:
    """True for a break PDFium invented rather than read."""
    try:
        return bool(pr.FPDFText_IsGenerated(textpage.raw, index))
    except Exception:
        return False


def _has_map_error(textpage: pdfium.PdfTextPage, index: int) -> bool:
    try:
        return bool(pr.FPDFText_HasUnicodeMapError(textpage.raw, index))
    except Exception:
        return False


def _marked_content_id(textpage: pdfium.PdfTextPage, index: int) -> int | None:
    """The marked-content id of the text object a character belongs to.

    This is the hinge of tagged-PDF support. The integer here is the same
    integer the structure element names in its /K entry (ISO 32000-2 14.7.4.2),
    so binding the two is an identity, not a resemblance - which is what makes
    a HEADING fact from a tagged document evidence rather than a guess (§34).

    Untagged content is not marked, and PDFium answers -1. That stays None and
    no role is ever attached to it (§35).
    """
    obj = pr.FPDFText_GetTextObject(textpage.raw, index)
    if not obj:
        return None
    mcid = pr.FPDFPageObj_GetMarkedContentID(obj)
    return None if mcid is None or mcid < 0 else int(mcid)


def extract_spans(
    page: pdfium.PdfPage,
    geometry: PageGeometry,
    *,
    page_index: int,
    limits: PdfLimits,
    budget: int,
) -> tuple[tuple[TextSpan, ...], int, int, bool]:
    """Characters grouped into spans of one font, one size and one baseline.

    A span breaks when the font, the effective size or the baseline changes.
    That is the smallest grouping still *read* from the file rather than
    inferred, which is why spans carry PDF_TEXT provenance while the lines and
    blocks built from them in ``layout.py`` carry PDF_LAYOUT.

    Returns the spans, the characters seen, the characters that could not be
    mapped to Unicode, and whether a limit was reached.
    """
    textpage = page.get_textpage()
    try:
        count = textpage.count_chars()
    except Exception:
        return (), 0, 0, True

    page_box = geometry.crop if geometry.effective_box is PageBox.CROP else geometry.media
    page_box = page_box or geometry.media

    spans: list[TextSpan] = []
    chars = 0
    unmapped = 0
    truncated = False

    current: list[str] = []
    cur_font: FontIdentity | None = None
    cur_size: Decimal | None = None
    cur_box: list[Decimal] | None = None
    cur_baseline: Decimal | None = None
    cur_unmapped = 0
    cur_mcid: int | None = None

    def flush() -> None:
        nonlocal current, cur_box, cur_baseline, cur_unmapped
        text = "".join(current)
        if not text.strip() or cur_box is None:
            current, cur_box, cur_baseline, cur_unmapped = [], None, None, 0
            return
        raw = BBox(left=cur_box[0], top=cur_box[1], right=cur_box[2], bottom=cur_box[3])
        spans.append(
            TextSpan(
                node_id=f"page:{page_index + 1}/textobj:{len(spans) + 1}",
                text=text,
                font=cur_font,
                font_size=cur_size,
                raw_bbox=raw,
                display_bbox=to_display(raw, page=page_box, rotation=geometry.rotation),
                page_index=page_index,
                unmapped_characters=cur_unmapped,
                marked_content_id=cur_mcid,
            )
        )
        current, cur_box, cur_baseline, cur_unmapped = [], None, None, 0

    for index in range(count):
        if chars >= budget or chars >= limits.max_text_chars:
            truncated = True
            break
        # A break PDFium invented is in no content stream; a span must be ink.
        if _is_generated(textpage, index):
            continue
        try:
            char = textpage.get_text_range(index, 1)
        except Exception:
            truncated = True
            break
        chars += 1
        mapped_badly = _has_map_error(textpage, index) or char in _UNMAPPED
        if mapped_badly:
            unmapped += 1
        try:
            box = textpage.get_charbox(index)
        except Exception:
            box = None
        if box is None:
            continue
        rect = rect_to_bbox(box)
        font = _font_of(textpage, index)
        declared = _text_state_size(textpage, index)
        size = (
            None
            if declared is None
            else quantise(declared * _vertical_scale(textpage, index), FONT_SIZE_PLACES)
        )
        baseline = _origin_y(textpage, index)
        mcid = _marked_content_id(textpage, index)

        same_run = (
            cur_box is not None
            and cur_size == size
            and (cur_font.raw_name if cur_font else None) == (font.raw_name if font else None)
            # The baseline, not the box edge: a descender moves the box and
            # leaves the baseline exactly where it was.
            and baseline is not None
            and cur_baseline is not None
            and abs(baseline - cur_baseline) <= Decimal("0.5")
            # Two differently tagged runs on one baseline are two spans: a
            # heading and the paragraph beside it must not be merged into
            # something with no single role.
            and cur_mcid == mcid
        )
        if not same_run:
            flush()
            cur_font, cur_size, cur_baseline, cur_mcid = font, size, baseline, mcid
            cur_box = [rect.left, rect.top, rect.right, rect.bottom]
        elif cur_box is not None:
            cur_box[0] = min(cur_box[0], rect.left)
            cur_box[1] = max(cur_box[1], rect.top)
            cur_box[2] = max(cur_box[2], rect.right)
            cur_box[3] = min(cur_box[3], rect.bottom)
        current.append(char)
        if mapped_badly:
            cur_unmapped += 1

    flush()
    return tuple(spans), chars, unmapped, truncated


def extract_images(
    page: pdfium.PdfPage,
    geometry: PageGeometry,
    *,
    page_index: int,
    limits: PdfLimits,
) -> tuple[tuple[ImageObject, ...], int, bool]:
    """Image objects and their bounds, walking into form XObjects (§28).

    The walk is PDFium's own, bounded by ``max_form_depth``: a document that
    nests forms beyond it is a bomb rather than a thesis, and the page is
    reported partial rather than followed. Each object carries the depth it was
    found at, so an image inside a form is never confused with one drawn
    directly on the page.
    """
    page_box = geometry.crop if geometry.effective_box is PageBox.CROP else geometry.media
    page_box = page_box or geometry.media
    images: list[ImageObject] = []
    seen = 0
    partial = False

    try:
        objects = page.get_objects(max_depth=limits.max_form_depth)
    except pdfium.PdfiumError:
        return (), 0, True

    while True:
        try:
            obj = next(objects)
        except StopIteration:
            break
        except pdfium.PdfiumError:
            # One unreadable object does not make the page image-free; it makes
            # the inventory incomplete, and that is what is reported (§52).
            partial = True
            break
        seen += 1
        if seen > limits.max_objects_per_page:
            partial = True
            break
        kind = getattr(obj, "type", None)
        depth = int(getattr(obj, "level", 0) or 0)
        if kind == pr.FPDF_PAGEOBJ_FORM:
            # PDFium stops descending here, so anything inside is unseen.
            if depth >= limits.max_form_depth - 1:
                partial = True
            continue
        if kind != pr.FPDF_PAGEOBJ_IMAGE:
            continue
        if len(images) >= limits.max_images:
            partial = True
            break
        rect = None
        try:
            rect = obj.get_bounds()
        except pdfium.PdfiumError:
            partial = True
        if rect is None:
            continue
        raw = rect_to_bbox(rect)
        images.append(
            ImageObject(
                node_id=f"page:{page_index + 1}/image:{len(images) + 1}",
                display_bbox=to_display(raw, page=page_box, rotation=geometry.rotation),
                page_index=page_index,
                form_depth=depth,
            )
        )

    return tuple(images), seen, partial
