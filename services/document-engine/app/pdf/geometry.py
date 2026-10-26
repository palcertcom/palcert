"""Page boxes, rotation, and the two coordinate systems (§20-§24, §57).

PDF user space has its origin at the bottom-left of the page and y increasing
upward. Readers, report locations and every UI that will ever highlight a
finding think top-left with y increasing downward. Both are kept, and which one
a number belongs to is never left to inference.

The effective display geometry follows ISO 32000-2 14.11.2 and 7.7.3.3: the
crop box is the region a viewer displays, it is required to be within the media
box, and a crop box that is absent, degenerate or outside the media box falls
back to the media box with PDF_PAGE_BOX_INVALID recorded. Rotation is applied
after cropping, which is why a 90-degree page reports its width and height
swapped — that is what the reader sees, and a page-size rule means what the
reader sees.

UserUnit scales user space into physical units. It is recorded and applied to
the effective physical size; it is deliberately *not* applied to object
coordinates, which stay in user space so they compose with the matrices that
produced them.
"""

from __future__ import annotations

from decimal import Decimal

from app.pdf.model import BBox, Orientation, PageBox, PageGeometry
from app.pdf.numbers import quantise

_VALID_ROTATIONS = (0, 90, 180, 270)


def normalise_rotation(value: int | None) -> int:
    """/Rotate as one of 0, 90, 180, 270.

    The spec requires a multiple of 90 but files carry negatives and values
    beyond 360, so the modulus is taken rather than the file trusted.
    """
    if value is None:
        return 0
    rotation = int(value) % 360
    if rotation < 0:
        rotation += 360
    return rotation if rotation in _VALID_ROTATIONS else 0


def rect_to_bbox(rect: tuple[float, float, float, float]) -> BBox:
    """A PDF rectangle as a normalised bbox in user space.

    PDF rectangles are two opposite corners in either order, so they are sorted
    rather than assumed (ISO 32000-2 7.9.5).
    """
    x0, y0, x1, y1 = rect
    left, right = (x0, x1) if x0 <= x1 else (x1, x0)
    bottom, top = (y0, y1) if y0 <= y1 else (y1, y0)
    return BBox(
        left=quantise(left), top=quantise(top), right=quantise(right), bottom=quantise(bottom)
    )


def _degenerate(box: BBox) -> bool:
    return box.width <= 0 or box.height <= 0


def _within(inner: BBox, outer: BBox) -> bool:
    return (
        inner.left >= outer.left
        and inner.right <= outer.right
        and inner.bottom >= outer.bottom
        and inner.top <= outer.top
    )


def effective_box(media: BBox, crop: BBox | None) -> tuple[BBox, PageBox, bool]:
    """Which box a reader sees, and whether the file's boxes made sense.

    Returns the box, which box it came from, and whether a problem was found —
    the caller raises PDF_PAGE_BOX_INVALID on the last, rather than this module
    reaching for a warning list it does not own.
    """
    if _degenerate(media):
        return media, PageBox.MEDIA, True
    if crop is None:
        return media, PageBox.MEDIA, False
    # A crop box identical to the media box crops nothing. ISO 32000-2 7.7.3.3
    # defaults CropBox to MediaBox, and PDFium returns that default rather than
    # saying the file was silent, so an equal box is reported as the media box:
    # that is the region the geometry actually came from, and §21 asks which
    # box a measurement is based on, not which key happened to be present.
    if crop == media:
        return media, PageBox.MEDIA, False
    if _degenerate(crop) or not _within(crop, media):
        return media, PageBox.MEDIA, True
    return crop, PageBox.CROP, False


def orientation_of(width: Decimal, height: Decimal) -> Orientation:
    """Orientation from what the reader sees, after rotation (§57)."""
    if width == height:
        return Orientation.SQUARE
    return Orientation.LANDSCAPE if width > height else Orientation.PORTRAIT


def build_geometry(
    *,
    media: BBox,
    crop: BBox | None,
    bleed: BBox | None,
    trim: BBox | None,
    art: BBox | None,
    rotation: int | None,
    user_unit: float = 1.0,
) -> tuple[PageGeometry, bool]:
    """The complete geometry of one page, plus whether its boxes were invalid."""
    box, source, invalid = effective_box(media, crop)
    turns = normalise_rotation(rotation)
    unit = quantise(user_unit)
    width, height = box.width, box.height
    if turns in (90, 270):
        width, height = height, width
    width, height = quantise(width * unit), quantise(height * unit)
    geometry = PageGeometry(
        media=media,
        crop=crop,
        bleed=bleed,
        trim=trim,
        art=art,
        rotation=turns,
        user_unit=unit,
        effective_box=source,
        effective_width=width,
        effective_height=height,
        orientation=orientation_of(width, height),
    )
    return geometry, invalid


def to_display(box: BBox, *, page: BBox, rotation: int) -> BBox:
    """A user-space rectangle in top-left display coordinates (§22).

    ``page`` is the effective (cropped) box, so coordinates are relative to what
    the reader sees rather than to a media box they may never be shown. The
    rotation cases are written out rather than expressed as a matrix: there are
    four of them, they are exact, and a reader can check each one by eye.
    """
    left = box.left - page.left
    right = box.right - page.left
    # Flip y: user space measures up from the bottom, display measures down
    # from the top.
    top = page.top - box.top
    bottom = page.top - box.bottom
    w = page.width
    h = page.height
    if rotation == 90:
        return BBox(
            left=quantise(h - bottom),
            top=quantise(left),
            right=quantise(h - top),
            bottom=quantise(right),
        )
    if rotation == 180:
        return BBox(
            left=quantise(w - right),
            top=quantise(h - bottom),
            right=quantise(w - left),
            bottom=quantise(h - top),
        )
    if rotation == 270:
        return BBox(
            left=quantise(top),
            top=quantise(w - right),
            right=quantise(bottom),
            bottom=quantise(w - left),
        )
    return BBox(
        left=quantise(left), top=quantise(top), right=quantise(right), bottom=quantise(bottom)
    )
