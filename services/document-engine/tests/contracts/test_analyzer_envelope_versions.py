"""The envelope version, the analyzer version and the citation section.

Checkpoint 2 pinned all three still: the contracts described a v2 envelope and
neither analyzer produced one. Checkpoint 3 moves the DOCX analyzer, and what
has to be asserted is no longer "nothing moved" but "the things that must move
together did".

The failure this guards against is quiet. Reuse of a stored analysis is
decided by the analyzer's name and version, not by the envelope version, so a
DOCX analyzer that started emitting citation evidence without its version
moving would let an analysis produced before Phase 18 be served to a caller
that expects the section — and the caller cannot tell, because a v1 artifact
is a perfectly valid artifact.

The PDF analyzer is held still, because it genuinely has not moved.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from app.docx.analyzer import AnalysisRequest, analyzer_identity
from app.docx.analyzer import analyze as analyze_docx
from app.docx.artifact import ANALYZER_VERSION as DOCX_ANALYZER_VERSION
from app.docx.artifact import ENVELOPE_SCHEMA_VERSION
from app.docx.model import ANALYSIS_SCHEMA_VERSION
from app.pdf.analyzer import ANALYZER_VERSION as PDF_ANALYZER_VERSION
from app.pdf.analyzer import analyze as analyze_pdf
from tests.docx.builder import DocxBuilder, paragraph, style, styles_part
from tests.pdf.builder import simple_text_pdf

NORMAL = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:sz w:val="24"/>'
STYLES = styles_part(style("Normal", name="Normal", default=True, run_properties=NORMAL))


def _docx_artifact() -> dict[str, Any]:
    content = DocxBuilder(body=paragraph("A cited claim."), styles=STYLES).build()
    outcome = analyze_docx(
        AnalysisRequest(
            document_id="doc",
            content=content,
            expected_sha256=hashlib.sha256(content).hexdigest(),
        )
    )
    envelope: dict[str, Any] = json.loads(outcome.artifact.content)
    return envelope


def _pdf_artifact() -> dict[str, Any]:
    data = simple_text_pdf()
    artifact: dict[str, Any] = analyze_pdf(
        data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d"
    )
    return artifact


def test_the_docx_analyzer_emits_a_v2_envelope_carrying_citation_evidence() -> None:
    artifact = _docx_artifact()
    assert artifact["analysisSchemaVersion"] == 2
    assert "citationAnalysis" in artifact


def test_the_docx_analyzer_version_moved_with_it() -> None:
    """Version 4: the analyzer that declares what DOCX cannot answer.

    Version 2 read the evidence and projected none of it; version 3 projected
    four properties; version 4 adds the coverage entry saying DOCX cannot
    answer `citationTargetResolved` at all. That last one is the strongest
    reason of the three to refuse reuse: without the entry, a rule about the
    new property would be read under this format's COMPLETE citation coverage
    rather than being refused. Only this number stops that analysis being
    reused.
    """
    artifact = _docx_artifact()
    assert artifact["analyzer"]["version"] == "5"
    assert DOCX_ANALYZER_VERSION == "5"
    assert analyzer_identity()["analysisSchemaVersion"] == ENVELOPE_SCHEMA_VERSION


def test_the_structural_model_version_did_not_move() -> None:
    """The envelope grew a section; the structural model did not change.

    They were one constant while they agreed. Bumping the model's version to
    describe an envelope change would be a second statement about the model,
    and a false one. The same split now holds on the PDF side.
    """
    artifact = _docx_artifact()
    assert ANALYSIS_SCHEMA_VERSION == 1
    assert artifact["structuralModel"]["analysisSchemaVersion"] == 1
    assert _pdf_artifact()["structuralModel"]["analysisSchemaVersion"] == 1


def test_the_pdf_analyzer_moved_to_the_v2_envelope_too() -> None:
    """Phase 18 moved DOCX first and PDF later, and both moves are the rule.

    A check run against an analysis from the previous version finds no
    citation section and reports nothing about citations, silently, because an
    artifact without it is a valid artifact. Reuse is decided by analyzer name
    and version, so only the version stops that.
    """
    artifact = _pdf_artifact()
    assert artifact["analysisSchemaVersion"] == 2
    assert "citationAnalysis" in artifact
    assert PDF_ANALYZER_VERSION == "11.0.0"


def test_a_document_with_no_citations_still_states_its_exact_count() -> None:
    """Zero is an answer, and a different one from "we did not look".

    The fixture has no CITATION field and no source store, both established
    exactly, so the two counts are emitted as zero under COMPLETE coverage —
    which is what lets a rule about citation counts return a verdict instead
    of INDETERMINATE.
    """
    artifact = _docx_artifact()
    assert artifact["citationAnalysis"]["citations"] == []

    counts = {
        fact["scope"]["property"]: fact["value"]["number"]
        for fact in artifact["factSet"]["facts"]
        if fact["scope"].get("property") in {"nativeCitationCount", "nativeBibliographySourceCount"}
    }
    assert counts == {"nativeCitationCount": "0", "nativeBibliographySourceCount": "0"}

    properties = {fact["scope"].get("property") for fact in artifact["factSet"]["facts"]}
    # Nothing proved a reference region, and a positive-only marker is never
    # emitted as false.
    assert "referenceRegionPresent" not in properties
    element_types = {fact["scope"].get("elementType") for fact in artifact["factSet"]["facts"]}
    assert element_types.isdisjoint({"CITATION", "REFERENCE_ENTRY"})


def test_an_untagged_pdf_projects_no_citation_facts() -> None:
    """The fixture declares no citation structure, so nothing crosses.

    Not because the PDF analyzer projects nothing — since Checkpoint 8 it
    projects `referenceRegionPresent`, and since Checkpoint 9
    `citationTargetResolved` — but because neither can be proven here.
    """
    artifact = _pdf_artifact()
    properties = {fact["scope"].get("property") for fact in artifact["factSet"]["facts"]}
    assert properties.isdisjoint(
        {
            "nativeCitationCount",
            "nativeBibliographySourceCount",
            "nativeSourceResolved",
            "referenceRegionPresent",
            "citationTargetResolved",
        }
    )
    element_types = {fact["scope"].get("elementType") for fact in artifact["factSet"]["facts"]}
    assert element_types.isdisjoint({"CITATION", "REFERENCE_ENTRY"})
