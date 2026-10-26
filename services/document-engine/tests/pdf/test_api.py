"""The PDF analyzer's HTTP boundary and its capability table (§63, §108, §152)."""

from __future__ import annotations

import hashlib
import json

from fastapi.testclient import TestClient

from app.pdf.support import Format as SupportFormat
from app.pdf.support import Support, registry_version, support_for
from tests.pdf.builder import (
    acroform_pdf,
    arabic_pdf,
    attachment_pdf,
    encrypted_pdf,
    malformed_pdf,
    metadata_pdf,
    scanned_pdf,
    simple_text_pdf,
)

ANALYZE = "/analysis/pdf"
CAPABILITIES = "/analysis/pdf/capabilities"
PRIVATE_TITLE = "Unpublished Thesis On A Sensitive Topic"


def _post(client: TestClient, data: bytes, *, sha: str | None = None, document_id: str = "doc-1"):
    return client.post(
        ANALYZE,
        content=data,
        headers={
            "x-palcert-document-id": document_id,
            "x-palcert-expected-sha256": sha or hashlib.sha256(data).hexdigest(),
            "content-type": "application/pdf",
        },
    )


def test_a_document_is_analyzed_and_the_artifact_is_returned_verbatim(client: TestClient):
    data = simple_text_pdf()
    response = _post(client, data)
    assert response.status_code == 200
    # The hash in the header is the hash of exactly these bytes, so a caller
    # that stores the body can prove later that it stored what it was sent.
    assert (
        response.headers["x-palcert-artifact-sha256"]
        == hashlib.sha256(response.content).hexdigest()
    )
    artifact = json.loads(response.content)
    assert artifact["format"] == "PDF"
    assert artifact["source"]["sha256"] == hashlib.sha256(data).hexdigest()


def test_the_response_headers_are_counters_and_classifications_only(client: TestClient):
    response = _post(client, metadata_pdf(xmp={"dc:title": PRIVATE_TITLE}))
    assert response.headers["x-palcert-document-format"] == "PDF"
    summary = json.loads(response.headers["x-palcert-summary"])
    assert set(summary) == {
        "pageCount",
        "textLayer",
        "tagged",
        "imageOnlyPages",
        "nativeTextPages",
    }
    # §107, §108: the title is in the body, which is stored; it is in no header.
    for name, value in response.headers.items():
        assert PRIVATE_TITLE not in value, name


def test_an_attachment_name_never_reaches_a_header(client: TestClient):
    response = _post(client, attachment_pdf(name="private-appendix.csv"))
    for value in response.headers.values():
        assert "private-appendix" not in value


def test_warning_codes_are_summarised_in_a_header(client: TestClient):
    response = _post(client, scanned_pdf())
    codes = response.headers["x-palcert-warning-codes"].split(",")
    assert "PDF_IMAGE_ONLY_PAGE" in codes
    assert codes == sorted(codes)


def test_a_digest_mismatch_is_rejected(client: TestClient):
    response = _post(client, simple_text_pdf(), sha="0" * 64)
    assert response.status_code == 422
    assert (
        response.json()["error"]["details"]["analysisError"] == "DOCUMENT_SOURCE_INTEGRITY_FAILED"
    )


def test_a_malformed_digest_header_is_a_validation_error(client: TestClient):
    response = _post(client, simple_text_pdf(), sha="not-a-digest")
    assert response.status_code == 400


def test_a_missing_document_id_is_refused(client: TestClient):
    data = simple_text_pdf()
    response = client.post(
        ANALYZE,
        content=data,
        headers={"x-palcert-expected-sha256": hashlib.sha256(data).hexdigest()},
    )
    assert response.status_code == 400


def test_an_empty_body_is_refused(client: TestClient):
    response = client.post(
        ANALYZE,
        content=b"",
        headers={
            "x-palcert-document-id": "d",
            "x-palcert-expected-sha256": "0" * 64,
        },
    )
    assert response.status_code == 400


def test_a_password_protected_document_is_unsupported_not_retryable(client: TestClient):
    # §19, §86: a document that needs a password will still need one on the
    # third attempt, so the status must not invite a retry.
    response = _post(client, encrypted_pdf())
    assert response.status_code == 415
    assert response.json()["error"]["details"]["analysisError"] == "PDF_PASSWORD_REQUIRED"


def test_a_malformed_document_is_the_documents_fault(client: TestClient):
    response = _post(client, malformed_pdf())
    assert response.status_code in {415, 422}
    assert response.status_code != 500


def test_no_pdf_internal_ever_crosses_the_boundary(client: TestClient):
    # §152: no raw PDF dictionaries, no storage keys, no parser handles.
    body = _post(client, acroform_pdf(signature=True)).content.decode("utf-8")
    for leak in ("/AcroForm", "/StructTreeRoot", "objgen", "FPDF", "pikepdf.", "palcert-derived"):
        assert leak not in body


def test_arabic_content_survives_the_boundary(client: TestClient):
    response = _post(client, arabic_pdf())
    artifact = json.loads(response.content)
    text = "".join(span["text"] for span in artifact["structuralModel"]["pages"][0]["spans"])
    assert any("؀" <= character <= "ۿ" for character in text)


def test_capabilities_serves_the_shared_registry(client: TestClient):
    body = client.get(CAPABILITIES).json()
    assert body["propertySupportRegistryVersion"] == registry_version()
    supported = {entry["name"] for entry in body["properties"]}
    unavailable = {entry["name"] for entry in body["unavailable"]}
    assert supported & unavailable == set()
    assert "pageCount" in supported
    # The Phase 13 decision: colour stays honestly unsupported.
    assert "textColor" in unavailable
    # A DOCX authoring property is not answerable from a PDF.
    assert "marginLeft" in unavailable
    assert "styleId" in unavailable


def test_every_unavailable_property_says_why(client: TestClient):
    for entry in client.get(CAPABILITIES).json()["unavailable"]:
        assert entry["reason"], entry["name"]


def test_the_capability_table_agrees_with_the_registry_reader(client: TestClient):
    body = client.get(CAPABILITIES).json()
    for entry in body["properties"]:
        assert support_for(SupportFormat.PDF, entry["name"]) is not Support.UNSUPPORTED
    for entry in body["unavailable"]:
        assert support_for(SupportFormat.PDF, entry["name"]) is Support.UNSUPPORTED


def test_observed_inset_is_not_offered_as_a_margin(client: TestClient):
    # §55, §62: similar measurement, different meaning. The two must never be
    # merged to make coverage look wider than it is.
    body = client.get(CAPABILITIES).json()
    supported = {entry["name"] for entry in body["properties"]}
    assert "observedContentInsetLeft" in supported
    assert "marginLeft" not in supported
