"""Tagged structure is used; untagged geometry is never promoted (§124, §125)."""

from __future__ import annotations

import hashlib

import pytest

from app.pdf.analyzer import analyze
from tests.pdf.builder import simple_text_pdf, tagged_pdf


def _analyze(data: bytes) -> dict:
    return analyze(data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d")


def _element_types(artifact: dict) -> set[str]:
    return {
        f["scope"]["elementType"]
        for f in artifact["factSet"]["facts"]
        if f["scope"]["kind"] == "ELEMENT"
    }


def test_tagged_structure_is_read_and_bound_to_content():
    art = _analyze(tagged_pdf())
    tree = art["structuralModel"]["structureTree"]
    assert tree["present"] is True
    assert tree["counts"] == {"HEADING": 1, "PARAGRAPH": 1}

    blocks = art["structuralModel"]["pages"][0]["blocks"]
    roles = {b["structureRole"]: b["text"] for b in blocks}
    # Bound through the marked-content id, not by position or by looking big.
    assert roles["HEADING"] == "Chapter One"
    assert roles["PARAGRAPH"].startswith("Body text")


def test_tagged_document_uses_the_declared_reading_order():
    art = _analyze(tagged_pdf())
    assert art["structuralModel"]["readingOrderSource"] == "TAGGED_STRUCTURE"
    assert "PDF_READING_ORDER_DERIVED" not in {w["code"] for w in art["warnings"]}
    assert "PDF_UNTAGGED" not in {w["code"] for w in art["warnings"]}


def test_tagged_heading_produces_heading_scoped_typography():
    art = _analyze(tagged_pdf())
    heading = [
        f
        for f in art["factSet"]["facts"]
        if f["scope"].get("elementType") == "HEADING" and f["scope"]["property"] == "fontSize"
    ]
    assert heading, "a tagged heading carries its own typography evidence"
    assert heading[0]["value"]["number"] == "18"
    # The evidence is read, not measured: the document declared the size.
    assert heading[0]["provenance"]["sourceKind"] == "PDF_TEXT"


def test_untagged_large_bold_centred_text_is_never_a_heading():
    # The refusal required by §125 and reaffirmed by the Phase 13 decision:
    # geometry is evidence about ink, and no amount of it makes a HEADING.
    art = _analyze(
        simple_text_pdf(
            lines=("CHAPTER ONE INTRODUCTION", "Ordinary body text follows here"), size=28
        )
    )
    assert art["structuralModel"]["structureTree"]["present"] is False
    assert "PDF_UNTAGGED" in {w["code"] for w in art["warnings"]}
    assert _element_types(art) == {"PARAGRAPH"}
    assert all(b["structureRole"] is None for b in art["structuralModel"]["pages"][0]["blocks"])


@pytest.mark.parametrize("element_type", ["HEADING", "TABLE", "FIGURE", "CAPTION", "LIST"])
def test_untagged_document_asserts_no_semantic_element_type(element_type):
    art = _analyze(simple_text_pdf(lines=("Alpha beta gamma", "Delta epsilon zeta"), size=20))
    assert element_type not in _element_types(art)


def test_structure_tree_without_marked_content_binds_nothing():
    # A document that declares structure it cannot point at gets the benefit of
    # neither: the declaration is recorded, and no block wears a role.
    art = _analyze(tagged_pdf(marks=False))
    assert art["structuralModel"]["structureTree"]["present"] is True
    assert all(b["structureRole"] is None for b in art["structuralModel"]["pages"][0]["blocks"])
    assert "HEADING" not in _element_types(art)


def test_blocks_are_called_blocks_and_never_paragraphs():
    # §30: a PDF does not record where the author pressed Enter.
    art = _analyze(simple_text_pdf())
    page = art["structuralModel"]["pages"][0]
    assert "blocks" in page
    assert "paragraphs" not in page
    assert all(b["nodeId"].split("/")[-1].startswith("block:") for b in page["blocks"])


def test_layout_evidence_is_labelled_derived():
    art = _analyze(simple_text_pdf(lines=("One line here", "Another line here")))
    spacing = [f for f in art["factSet"]["facts"] if f["scope"]["property"] == "lineSpacing"]
    assert spacing
    assert spacing[0]["provenance"]["sourceKind"] == "PDF_LAYOUT"
