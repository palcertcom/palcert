"""Scanned, native and hybrid classification, and the refusal to OCR (§122, §123)."""

from __future__ import annotations

import hashlib
import sys

from app.pdf.analyzer import analyze
from tests.pdf.builder import arabic_pdf, scanned_pdf, simple_text_pdf


def _analyze(data: bytes) -> dict:
    return analyze(data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d")


def test_native_text_document_is_searchable():
    art = _analyze(simple_text_pdf())
    assert art["structuralModel"]["documentTextLayer"] == "NATIVE_TEXT"


def test_full_page_image_is_image_only():
    art = _analyze(scanned_pdf())
    assert art["structuralModel"]["documentTextLayer"] == "IMAGE_ONLY"
    assert "PDF_IMAGE_ONLY_PAGE" in {w["code"] for w in art["warnings"]}


def test_one_scanned_page_makes_the_document_hybrid():
    # Not "mostly searchable": coverage is per page so one page's limitation is
    # never averaged away (§52).
    art = _analyze(scanned_pdf(pages_count=1, with_text_page=True))
    assert art["structuralModel"]["documentTextLayer"] == "HYBRID"
    assert "PDF_HYBRID_TEXT_LAYER" in {w["code"] for w in art["warnings"]}


def test_image_only_document_produces_no_text_facts_and_no_ocr():
    # The mandatory no-OCR assertion (§51, §123). Page geometry survives;
    # typography does not; and no text is invented for a page that has none.
    art = _analyze(scanned_pdf())
    facts = art["factSet"]["facts"]
    properties = {f["scope"].get("property") for f in facts}

    assert "pageWidth" in properties, "page geometry is still evaluated"
    assert "pageCount" in properties
    for typography in ("fontFamily", "fontSize", "bold", "italic"):
        assert typography not in properties, f"{typography} must be unavailable without text"

    page = art["structuralModel"]["pages"][0]
    assert page["spans"] == []
    assert page["nativeTextCharacterCount"] == 0

    # Nothing that could OCR was even imported.
    assert not {m for m in sys.modules if "tesseract" in m.lower() or m.startswith("pytesseract")}

    coverage = {(c["kind"], c.get("elementType")): c for c in art["factSet"]["coverage"]}
    element = coverage[("ELEMENT", None)]
    assert element["status"] == "UNAVAILABLE"
    assert "no OCR" in element["note"]


def test_arabic_text_is_extracted_and_not_reversed():
    art = _analyze(arabic_pdf())
    page = art["structuralModel"]["pages"][0]
    assert page["textLayer"] == "NATIVE_TEXT"
    assert page["unmappedCharacterCount"] == 0
    combined = "".join(span["text"] for span in page["spans"])
    # Arabic characters survived the round trip.
    assert any("؀" <= ch <= "ۿ" for ch in combined)


def test_arabic_and_latin_on_one_page():
    art = _analyze(arabic_pdf(with_latin=True))
    page = art["structuralModel"]["pages"][0]
    combined = "".join(span["text"] for span in page["spans"])
    assert any("؀" <= ch <= "ۿ" for ch in combined)
    assert "English" in combined


def test_arabic_without_tounicode_is_unmapped_not_invented():
    # The text layer is present and unusable. PalCert says so rather than
    # reporting the replacement characters as the document's text (§48).
    art = _analyze(arabic_pdf(with_tounicode=False))
    page = art["structuralModel"]["pages"][0]
    assert page["unmappedCharacterCount"] > 0
    assert page["textLayer"] != "NATIVE_TEXT"
    assert "PDF_TEXT_MAPPING_INCOMPLETE" in {w["code"] for w in art["warnings"]}
