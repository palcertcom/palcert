"""Metadata, its two sources, and what PalCert refuses to conclude from it (§71-§77)."""

from __future__ import annotations

import hashlib

from app.pdf.analyzer import analyze
from tests.pdf.builder import metadata_pdf, simple_text_pdf

XMP_TITLE = "The XMP Title"
INFO_TITLE = "The DocumentInfo Title"


def _analyze(data: bytes) -> dict:
    return analyze(data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d")


def _disagreeing() -> dict:
    return _analyze(
        metadata_pdf(
            xmp={"dc:title": XMP_TITLE, "dc:creator": "XMP Author"},
            doc_info={"/Title": INFO_TITLE, "/Author": "Info Author"},
        )
    )


def test_both_sources_are_retained_when_they_disagree():
    # The Phase 13 decision: do not collapse the two sources irreversibly.
    metadata = _disagreeing()["structuralModel"]["metadata"]
    assert metadata["xmp"]["title"] == XMP_TITLE
    assert metadata["documentInfo"]["title"] == INFO_TITLE


def test_disagreement_raises_a_structured_warning():
    art = _disagreeing()
    assert "PDF_METADATA_CONFLICT" in {w["code"] for w in art["warnings"]}
    assert set(art["structuralModel"]["metadata"]["conflicts"]) == {"title", "creator"}


def test_precedence_is_deterministic_and_documented_in_the_model():
    metadata = _disagreeing()["structuralModel"]["metadata"]
    # XMP wins, and the model says so per field rather than leaving a reader to
    # infer it from which value happens to be present.
    assert metadata["effective"]["title"] == XMP_TITLE
    assert metadata["chosenSource"] == {"title": "xmp", "creator": "xmp"}


def test_the_chosen_source_survives_into_fact_provenance():
    art = _disagreeing()
    title = next(f for f in art["factSet"]["facts"] if f["scope"].get("field") == "title")
    assert title["value"]["text"] == XMP_TITLE
    assert title["provenance"]["note"] == "from xmp"


def test_document_info_alone_is_used_and_labelled():
    art = _analyze(metadata_pdf(doc_info={"/Title": INFO_TITLE}))
    metadata = art["structuralModel"]["metadata"]
    assert metadata["effective"]["title"] == INFO_TITLE
    assert metadata["chosenSource"]["title"] == "documentInfo"
    assert metadata["conflicts"] == []
    assert "PDF_METADATA_CONFLICT" not in {w["code"] for w in art["warnings"]}


def test_agreeing_sources_are_not_a_conflict():
    art = _analyze(metadata_pdf(xmp={"dc:title": XMP_TITLE}, doc_info={"/Title": XMP_TITLE}))
    assert art["structuralModel"]["metadata"]["conflicts"] == []


def test_a_claimed_pdfa_part_is_recorded_and_never_asserted():
    # §17: pdfaid:part in the metadata is the document's claim about itself.
    # PalCert is not a PDF/A validator, and must not repeat the claim as a
    # finding.
    art = _analyze(metadata_pdf(xmp={"pdfaid:part": "2", "pdfaid:conformance": "B"}))
    metadata = art["structuralModel"]["metadata"]
    assert metadata["claimedPdfAPart"] == "2"
    assert metadata["claimedPdfAConformance"] == "B"

    facts = {f["scope"].get("property") for f in art["factSet"]["facts"]}
    assert "claimedPdfAPart" in facts
    # The property is named for what it is. Nothing anywhere claims compliance.
    assert "pdfaCompliant" not in facts
    assert "pdfaConformant" not in facts


def test_a_document_without_metadata_reports_none_rather_than_guesses():
    art = _analyze(simple_text_pdf())
    metadata = art["structuralModel"]["metadata"]
    assert metadata["effective"] == {}
    assert metadata["conflicts"] == []
    assert metadata["language"] is None


def test_metadata_values_never_appear_in_warnings():
    # §73, §107: a warning carries a code and identifiers. The values the two
    # sources disagreed about stay in the artifact, which is stored in
    # palcert-derived; the warning names the fields and nothing else, because
    # warnings reach logs and the report UI.
    art = _disagreeing()
    conflict = next(w for w in art["warnings"] if w["code"] == "PDF_METADATA_CONFLICT")
    assert conflict["detail"] == {"fields": "creator,title"}
    for warning in art["warnings"]:
        serialised = repr(warning)
        assert XMP_TITLE not in serialised
        assert INFO_TITLE not in serialised
