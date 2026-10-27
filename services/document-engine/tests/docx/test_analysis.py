"""Analyzer behaviour: integrity, contracts, catalogue, counts and the API (§5, §41, §59, §110)."""

from __future__ import annotations

import hashlib
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.docx.analyzer import AnalysisRequest, analyze, analyzer_identity, verify_source_integrity
from app.docx.api import DOCUMENT_ID_HEADER, EXPECTED_SHA_HEADER
from app.docx.artifact import ANALYZER_NAME, ANALYZER_VERSION, canonical_json
from app.docx.catalogue import BY_NAME, catalogue_json
from app.docx.errors import DocxAnalysisError, DocxErrorCode
from app.docx.limits import AnalyzerLimits
from app.docx.wordcount import count_characters, count_words
from app.engine.contracts.validation import validate_contract
from app.engine.facts.model import FACT_SCHEMA_VERSION
from app.main import create_app
from tests.docx.builder import (
    DocxBuilder,
    paragraph,
    section_properties,
    style,
    styles_part,
)

NORMAL = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:sz w:val="24"/><w:szCs w:val="24"/>'
STYLES = styles_part(style("Normal", name="Normal", default=True, run_properties=NORMAL))


def _analyze(body: str, **kwargs: Any) -> dict[str, Any]:
    kwargs.setdefault("styles", STYLES)
    content = DocxBuilder(body=body, **kwargs).build()
    outcome = analyze(
        AnalysisRequest(
            document_id="doc",
            content=content,
            expected_sha256=hashlib.sha256(content).hexdigest(),
        )
    )
    envelope = json.loads(outcome.artifact.content)
    assert isinstance(envelope, dict)
    return envelope


def _document_fact(envelope: dict[str, Any], name: str) -> Any:
    for fact in envelope["factSet"]["facts"]:
        scope = fact["scope"]
        if scope["kind"] == "DOCUMENT" and scope.get("property") == name:
            value = fact["value"]
            return value.get("number") or value.get("boolean")
    return None


# --- source integrity (§5) -------------------------------------------------


def test_matching_digest_is_accepted() -> None:
    content = b"some bytes"
    digest = hashlib.sha256(content).hexdigest()
    assert verify_source_integrity(content, digest) == digest
    assert verify_source_integrity(content, digest.upper()) == digest


def test_mismatched_digest_is_fatal_and_not_retryable() -> None:
    with pytest.raises(DocxAnalysisError) as raised:
        verify_source_integrity(b"some bytes", "0" * 64)
    assert raised.value.code is DocxErrorCode.SOURCE_INTEGRITY_FAILED
    assert raised.value.retryable is False


def test_analysis_refuses_bytes_that_do_not_match() -> None:
    content = DocxBuilder(body=paragraph("Hi")).build()
    with pytest.raises(DocxAnalysisError) as raised:
        analyze(AnalysisRequest(document_id="d", content=content, expected_sha256="a" * 64))
    assert raised.value.code is DocxErrorCode.SOURCE_INTEGRITY_FAILED


# --- contract validation (§110) -------------------------------------------


def test_fact_set_validates_against_the_shared_schema() -> None:
    envelope = _analyze(paragraph("Hello world") + section_properties())
    result = validate_contract("DocumentFactSet", envelope["factSet"])
    assert result.valid, [issue.message for issue in result.issues]


def test_fact_set_declares_the_current_schema_version() -> None:
    envelope = _analyze(paragraph("Hi"))
    assert envelope["factSet"]["factSchemaVersion"] == FACT_SCHEMA_VERSION
    assert envelope["factSet"]["extractor"] == {
        "name": ANALYZER_NAME,
        "version": ANALYZER_VERSION,
    }


def test_endnote_facts_require_fact_schema_v2() -> None:
    """The reason v2 exists: v1 cannot express an endnote (§14)."""
    fact_set = {
        "factSchemaVersion": 1,
        "documentId": "d",
        "extractor": {"name": "x", "version": "1"},
        "coverage": [],
        "facts": [
            {
                "scope": {"kind": "ELEMENT", "elementType": "ENDNOTE", "property": "fontSize"},
                "value": {"type": "NUMBER", "number": "12"},
            }
        ],
    }
    assert validate_contract("DocumentFactSet", fact_set).valid is False
    fact_set["factSchemaVersion"] = 2
    assert validate_contract("DocumentFactSet", fact_set).valid is True


# --- no fabrication (§36, §109) -------------------------------------------


def test_application_defaults_are_never_invented() -> None:
    """No font anywhere means no font fact — not Word's Calibri (§36, §109)."""
    envelope = _analyze(paragraph("Bare"), styles=styles_part(""))
    properties = {
        fact["scope"].get("property")
        for fact in envelope["factSet"]["facts"]
        if fact["scope"]["kind"] == "ELEMENT"
    }
    assert "fontFamily" not in properties
    assert "fontSize" not in properties


def test_saved_page_count_never_becomes_a_fact() -> None:
    """Word's stored statistics are hints, not measurements (§3, §62)."""
    envelope = _analyze(
        paragraph("Hi"),
        extended_properties=(
            '<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
            "<Pages>42</Pages><Words>9999</Words></Properties>"
        ),
    )
    assert _document_fact(envelope, "pageCount") is None
    hints = envelope["structuralModel"]["metadata"]["applicationHints"]
    assert hints["pageCount"] == 42
    assert hints["wordCount"] == 9999
    # PalCert's own count is computed, not taken from the hint.
    assert _document_fact(envelope, "wordCount") == "1"


def test_page_coverage_is_unavailable() -> None:
    envelope = _analyze(paragraph("Hi"))
    page_entries = [entry for entry in envelope["factSet"]["coverage"] if entry["kind"] == "PAGE"]
    assert page_entries and all(entry["status"] == "UNAVAILABLE" for entry in page_entries)


# --- word count (§59, §106) ------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Hello world", 2),
        ("state-of-the-art", 1),
        ("don't stop", 2),
        ("3.5 kg", 2),
        ("1,000 items", 2),
        ("End. Start", 2),
        ("مرحبا بالعالم", 2),
        ("السلام عليكم ورحمة الله وبركاته", 5),
        ("Hello مرحبا world", 3),
        ("مُحَمَّد", 1),
        ("٣٫٥ كغم", 2),
        ("", 0),
        ("   ", 0),
    ],
)
def test_documented_word_count(text: str, expected: int) -> None:
    assert count_words(text) == expected


def test_character_counts() -> None:
    assert count_characters("ab cd", include_whitespace=True) == 5
    assert count_characters("ab cd", include_whitespace=False) == 4


def test_word_counts_are_reported_per_story() -> None:
    """Footnote words are never folded into the body count (§53, §59)."""
    notes = (
        '<?xml version="1.0"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:footnote w:id="1"><w:p><w:r><w:t>three words here</w:t></w:r></w:p></w:footnote>'
        "</w:footnotes>"
    )
    envelope = _analyze(paragraph("Two words"), footnotes=notes)
    counts = envelope["structuralModel"]["wordCount"]
    assert counts["body"] == 2
    assert counts["footnotes"] == 3
    assert counts["totalVisible"] == 5
    assert _document_fact(envelope, "bodyWordCount") == "2"


# --- catalogue (§41) -------------------------------------------------------


def test_every_emitted_property_is_documented() -> None:
    envelope = _analyze(
        paragraph("Heading", style="Normal")
        + paragraph("Body مرحبا")
        + "<w:tbl><w:tr><w:tc>"
        + paragraph("Cell")
        + "</w:tc></w:tr></w:tbl>"
        + section_properties()
    )
    for fact in envelope["factSet"]["facts"]:
        scope = fact["scope"]
        name = scope.get("property") or scope.get("field")
        assert name in BY_NAME, f"undocumented property emitted: {name}"


def test_catalogue_is_serializable_and_names_what_docx_cannot_answer() -> None:
    payload = catalogue_json()
    assert payload["properties"]
    unavailable = {entry["name"] for entry in payload["unavailableFromDocx"]}  # type: ignore[union-attr]
    assert "pageCount" in unavailable
    assert "pageNumber" in unavailable


# --- artifact (§85, §87) ---------------------------------------------------


def test_canonical_json_is_key_order_independent() -> None:
    assert canonical_json({"b": 1, "a": 2}) == canonical_json({"a": 2, "b": 1})


def test_artifact_hash_covers_exactly_the_stored_bytes() -> None:
    content = DocxBuilder(body=paragraph("Hi"), styles=STYLES).build()
    outcome = analyze(
        AnalysisRequest(
            document_id="d", content=content, expected_sha256=hashlib.sha256(content).hexdigest()
        )
    )
    assert hashlib.sha256(outcome.artifact.content).hexdigest() == outcome.artifact.sha256


def test_analyzer_identity_is_semantic_not_a_commit() -> None:
    identity = analyzer_identity()
    assert identity["analyzerName"] == "palcert-docx"
    assert identity["analyzerVersion"] == "6"
    assert identity["factSchemaVersion"] == FACT_SCHEMA_VERSION


# --- limits (§80) ----------------------------------------------------------


def test_paragraph_limit_is_enforced() -> None:
    content = DocxBuilder(body=paragraph("x") * 50, styles=STYLES).build()
    with pytest.raises(DocxAnalysisError) as raised:
        analyze(
            AnalysisRequest(
                document_id="d",
                content=content,
                expected_sha256=hashlib.sha256(content).hexdigest(),
                limits=AnalyzerLimits(max_paragraphs=5),
            )
        )
    assert raised.value.code is DocxErrorCode.RESOURCE_LIMIT_EXCEEDED


def test_fact_limit_is_enforced() -> None:
    content = DocxBuilder(body=paragraph("word") * 30, styles=STYLES).build()
    with pytest.raises(DocxAnalysisError) as raised:
        analyze(
            AnalysisRequest(
                document_id="d",
                content=content,
                expected_sha256=hashlib.sha256(content).hexdigest(),
                limits=AnalyzerLimits(max_facts=5),
            )
        )
    assert raised.value.code is DocxErrorCode.RESOURCE_LIMIT_EXCEEDED


# --- privacy (§71, §117) ---------------------------------------------------


def test_summary_carries_counters_only() -> None:
    content = DocxBuilder(
        body=paragraph("Secret manuscript title"),
        styles=STYLES,
        core_properties=(
            '<?xml version="1.0"?><cp:coreProperties '
            'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/">'
            "<dc:title>Confidential Thesis</dc:title><dc:creator>Jane Researcher</dc:creator>"
            "</cp:coreProperties>"
        ),
    ).build()
    outcome = analyze(
        AnalysisRequest(
            document_id="d", content=content, expected_sha256=hashlib.sha256(content).hexdigest()
        )
    )
    serialized = json.dumps(outcome.artifact.summary)
    assert "Confidential" not in serialized
    assert "Jane" not in serialized
    assert all(isinstance(value, int) for value in outcome.artifact.summary.values())


# --- HTTP surface ----------------------------------------------------------


@pytest.fixture(name="client")
def _client() -> TestClient:
    return TestClient(create_app())


def _headers(document_id: str, digest: str) -> dict[str, str]:
    return {
        DOCUMENT_ID_HEADER: document_id,
        EXPECTED_SHA_HEADER: digest,
        "content-type": "application/octet-stream",
    }


def test_http_analysis_returns_artifact_bytes(client: TestClient) -> None:
    content = DocxBuilder(body=paragraph("Hello world"), styles=STYLES).build()
    digest = hashlib.sha256(content).hexdigest()
    response = client.post("/analysis/docx", content=content, headers=_headers("d", digest))

    assert response.status_code == 200
    assert (
        hashlib.sha256(response.content).hexdigest()
        == response.headers["x-palcert-artifact-sha256"]
    )
    assert int(response.headers["x-palcert-fact-count"]) > 0
    assert response.headers["x-palcert-analyzer-name"] == ANALYZER_NAME


def test_http_rejects_a_digest_mismatch(client: TestClient) -> None:
    content = DocxBuilder(body=paragraph("Hi"), styles=STYLES).build()
    response = client.post("/analysis/docx", content=content, headers=_headers("d", "0" * 64))
    assert response.status_code == 422
    assert response.json()["error"]["details"]["analysisError"] == "DOCX_SOURCE_INTEGRITY_FAILED"


def test_http_rejects_a_missing_document_id(client: TestClient) -> None:
    response = client.post("/analysis/docx", content=b"x", headers=_headers("", "0" * 64))
    assert response.status_code == 400


def test_http_reports_an_unsupported_profile(client: TestClient) -> None:
    content = DocxBuilder(
        body="<w:p/>",
        omit_document_part=True,
        raw_parts={
            "word/document.xml": b'<?xml version="1.0"?><w:document xmlns:w="urn:other"><w:body/></w:document>'
        },
    ).build()
    digest = hashlib.sha256(content).hexdigest()
    response = client.post("/analysis/docx", content=content, headers=_headers("d", digest))
    assert response.status_code == 415
    assert response.json()["error"]["details"]["analysisError"] == "DOCX_PROFILE_UNSUPPORTED"


def test_capabilities_endpoint_describes_the_analyzer(client: TestClient) -> None:
    response = client.get("/analysis/docx/capabilities")
    assert response.status_code == 200
    payload = response.json()
    assert payload["analyzerName"] == ANALYZER_NAME
    assert payload["properties"]
