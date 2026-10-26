"""Page geometry against fixtures whose boxes are known by construction (§120)."""

from __future__ import annotations

import hashlib
from decimal import Decimal

import pytest

from app.pdf.analyzer import analyze
from app.pdf.geometry import normalise_rotation, rect_to_bbox, to_display
from tests.pdf.builder import A4, LETTER, document, font, page, serialize, simple_text_pdf, text


def _analyze(data: bytes) -> dict:
    return analyze(data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d")


def test_page_count_is_authoritative():
    # The inversion from DOCX: a PDF's page tree IS the document (§25).
    art = _analyze(simple_text_pdf(pages_count=5))
    assert len(art["structuralModel"]["pages"]) == 5
    facts = {f["scope"].get("property"): f for f in art["factSet"]["facts"]}
    assert facts["pageCount"]["value"]["number"] == "5"
    assert facts["pageCount"]["unit"] == "PAGES"


def test_a4_geometry_is_exact():
    art = _analyze(simple_text_pdf())
    geometry = art["structuralModel"]["pages"][0]["geometry"]
    assert geometry["effectiveWidthPoints"] == "595"
    assert geometry["effectiveHeightPoints"] == "842"
    assert geometry["orientation"] == "PORTRAIT"
    assert geometry["effectiveBox"] == "MediaBox"


def test_letter_geometry_is_exact():
    art = _analyze(simple_text_pdf(media_box=LETTER))
    geometry = art["structuralModel"]["pages"][0]["geometry"]
    assert (geometry["effectiveWidthPoints"], geometry["effectiveHeightPoints"]) == ("612", "792")


def test_mixed_page_sizes_are_reported_per_page():
    pdf = document()
    helvetica = font(pdf)
    pdf.pages.append(page(pdf, text("A4"), media_box=A4, fonts={"F1": helvetica}))
    pdf.pages.append(page(pdf, text("Letter"), media_box=LETTER, fonts={"F1": helvetica}))
    art = _analyze(serialize(pdf))
    sizes = [
        (p["geometry"]["effectiveWidthPoints"], p["geometry"]["effectiveHeightPoints"])
        for p in art["structuralModel"]["pages"]
    ]
    assert sizes == [("595", "842"), ("612", "792")]


@pytest.mark.parametrize(
    ("rotation", "expected"),
    [(0, ("595", "842")), (90, ("842", "595")), (180, ("595", "842")), (270, ("842", "595"))],
)
def test_rotation_swaps_what_the_reader_sees(rotation: int, expected: tuple[str, str]):
    # A rotated page's size is what a reader measures, not what the box says.
    pdf = document()
    helvetica = font(pdf)
    pdf.pages.append(page(pdf, text("Rotated"), rotate=rotation, fonts={"F1": helvetica}))
    art = _analyze(serialize(pdf))
    geometry = art["structuralModel"]["pages"][0]["geometry"]
    assert (geometry["effectiveWidthPoints"], geometry["effectiveHeightPoints"]) == expected
    assert geometry["rotation"] == rotation


def test_crop_box_decides_the_effective_size():
    pdf = document()
    helvetica = font(pdf)
    pdf.pages.append(
        page(
            pdf, text("Cropped"), media_box=A4, crop_box=(50, 50, 545, 792), fonts={"F1": helvetica}
        )
    )
    art = _analyze(serialize(pdf))
    geometry = art["structuralModel"]["pages"][0]["geometry"]
    assert geometry["effectiveBox"] == "CropBox"
    assert (geometry["effectiveWidthPoints"], geometry["effectiveHeightPoints"]) == ("495", "742")
    # The media box is still recorded: both boxes are kept, never conflated (§21).
    assert geometry["mediaBox"]["width"] == "595"


def test_crop_box_outside_media_box_falls_back_and_warns():
    pdf = document()
    helvetica = font(pdf)
    pdf.pages.append(
        page(
            pdf,
            text("Bad crop"),
            media_box=A4,
            crop_box=(-10, -10, 900, 900),
            fonts={"F1": helvetica},
        )
    )
    art = _analyze(serialize(pdf))
    assert art["structuralModel"]["pages"][0]["geometry"]["effectiveBox"] == "MediaBox"
    assert "PDF_PAGE_BOX_INVALID" in {w["code"] for w in art["warnings"]}


def test_rotation_is_normalised():
    assert [normalise_rotation(v) for v in (None, 0, 90, 360, 450, -90, 37)] == [
        0,
        0,
        90,
        0,
        90,
        270,
        0,
    ]


def test_display_coordinates_measure_down_from_the_top():
    # User space measures up from the bottom; a reader measures down from the
    # top. A box near the top of the page must have a small display top (§22).
    page_box = rect_to_bbox((0, 0, 595, 842))
    near_top = rect_to_bbox((72, 800, 200, 820))
    display = to_display(near_top, page=page_box, rotation=0)
    assert display.top == Decimal("22")
    assert display.left == Decimal("72")


def test_geometry_facts_carry_the_page_number():
    art = _analyze(simple_text_pdf(pages_count=2))
    widths = [f for f in art["factSet"]["facts"] if f["scope"].get("property") == "pageWidth"]
    assert [f["location"]["page"] for f in widths] == [1, 2]
    # One-based for display; the model keeps the zero-based index too (§20).
    assert [p["pageIndex"] for p in art["structuralModel"]["pages"]] == [0, 1]
