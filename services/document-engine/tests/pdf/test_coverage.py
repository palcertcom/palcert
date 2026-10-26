"""Coverage, property support, and the refusal to pass on missing evidence (§61-§70)."""

from __future__ import annotations

import hashlib

import pytest

from app.pdf.analyzer import analyze
from app.pdf.support import (
    Format,
    Support,
    distinct_semantics,
    entry_for,
    properties,
    supported_pdf_properties,
)
from tests.pdf.builder import scanned_pdf, simple_text_pdf, tagged_pdf


def _analyze(data: bytes) -> dict:
    return analyze(data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d")


def _coverage(artifact: dict) -> dict:
    return {(row["kind"], row.get("elementType")): row for row in artifact["factSet"]["coverage"]}


def test_a_searchable_document_reports_complete_element_coverage():
    coverage = _coverage(_analyze(simple_text_pdf()))
    assert coverage[("ELEMENT", None)]["status"] == "COMPLETE"


def test_a_scan_reports_unavailable_rather_than_complete():
    # §69: absent evidence is INDETERMINATE, never PASS. Coverage is how the
    # rule engine is told that, so a scan must never claim COMPLETE.
    coverage = _coverage(_analyze(scanned_pdf()))
    assert coverage[("ELEMENT", None)]["status"] == "UNAVAILABLE"


def test_one_scanned_page_degrades_coverage_to_partial():
    # §80: a partial issue degrades coverage; it does not fail the analysis,
    # and it does not average away.
    row = _coverage(_analyze(scanned_pdf(with_text_page=True)))[("ELEMENT", None)]
    assert row["status"] == "PARTIAL"
    assert "1 of 2 pages" in row["note"]
    assert "no OCR" in row["note"]


def test_an_untagged_document_declares_semantics_unavailable():
    row = _coverage(_analyze(simple_text_pdf()))[("ELEMENT", "HEADING")]
    assert row["status"] == "UNAVAILABLE"
    assert "untagged" in row["note"]
    assert "does not infer them from appearance" in row["note"]


def test_a_tagged_document_declares_semantics_available():
    row = _coverage(_analyze(tagged_pdf()))[("ELEMENT", "HEADING")]
    assert row["status"] == "PARTIAL"
    assert "structure tree" in row["note"]


def test_metadata_coverage_names_the_source_it_used():
    from tests.pdf.builder import metadata_pdf

    row = _coverage(_analyze(metadata_pdf(doc_info={"/Title": "T"})))[("METADATA", None)]
    assert row["status"] == "COMPLETE"
    assert "documentInfo" in row["note"]


def test_a_document_without_metadata_reports_metadata_unavailable():
    row = _coverage(_analyze(simple_text_pdf()))[("METADATA", None)]
    assert row["status"] == "UNAVAILABLE"


def test_no_fact_is_emitted_for_a_property_pdf_cannot_answer():
    # The registry is the single source of truth (§61): the analyzer must not
    # emit a property it declares unsupported, or the preview a user paid on
    # would understate what they got - and, worse, the reverse could happen.
    art = _analyze(tagged_pdf())
    allowed = supported_pdf_properties()
    for fact in art["factSet"]["facts"]:
        name = fact["scope"].get("property")
        if name is not None:
            assert name in allowed, name


@pytest.mark.parametrize("name", ["marginLeft", "styleId", "textColor", "trackedInsertionCount"])
def test_docx_only_properties_are_declared_unsupported_for_pdf(name):
    entry = entry_for(name)
    assert entry is not None
    assert entry.support(Format.PDF) is Support.UNSUPPORTED
    assert entry.pdf_note


def test_similar_measurements_with_different_meanings_stay_separate():
    # §62: the temptation is to satisfy a margin rule with an ink measurement.
    # The registry records the pair so the refusal is data rather than lore.
    pairs = set(distinct_semantics())
    assert ("marginLeft", "observedContentInsetLeft") in pairs
    assert entry_for("marginLeft").support(Format.PDF) is Support.UNSUPPORTED
    assert entry_for("observedContentInsetLeft").support(Format.DOCX) is Support.UNSUPPORTED


def test_every_property_declares_both_formats():
    for entry in properties():
        assert entry.support(Format.PDF) in set(Support)
        assert entry.support(Format.DOCX) in set(Support)
        # A support level without a reason is an assertion nobody can check.
        assert entry.pdf_note
        assert entry.docx_note


def test_page_count_is_authoritative_from_pdf_and_absent_from_docx():
    # §25: the PDF states its page count; a DOCX does not, and pretending
    # otherwise is how a page-count rule gets answered from a stale field.
    entry = entry_for("pageCount")
    assert entry.support(Format.PDF) is Support.EXACT
    assert entry.support(Format.DOCX) is Support.UNSUPPORTED
