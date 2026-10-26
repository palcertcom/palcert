"""Active content, attachments, signatures and encryption (§16-§19, §126-§128)."""

from __future__ import annotations

import hashlib

import pytest

from app.pdf.analyzer import analyze
from app.pdf.errors import PdfAnalysisError, PdfFailure
from tests.pdf.builder import (
    acroform_pdf,
    active_content_pdf,
    attachment_pdf,
    encrypted_pdf,
    outline_pdf,
    simple_text_pdf,
)

ATTACHMENT_NAME = "raw-data-confidential.csv"


def _analyze(data: bytes) -> dict:
    return analyze(data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d")


def test_active_content_is_counted_and_never_executed():
    art = _analyze(active_content_pdf())
    features = art["structuralModel"]["features"]
    assert features["javaScriptPresent"] is True
    assert features["launchActionCount"] == 1
    assert features["uriActionCount"] == 1
    assert "PDF_ACTIVE_CONTENT_PRESENT" in {w["code"] for w in art["warnings"]}


def test_the_target_of_an_action_is_never_recorded():
    # §18: PalCert counts active content. It does not follow it, fetch it,
    # launch it or resolve it - and a target it never touches is a target it
    # never needs to store.
    art = _analyze(active_content_pdf())
    serialised = repr(art)
    assert "example.invalid" not in serialised
    assert "/bin/sh" not in serialised
    assert "app.alert" not in serialised


def test_attachment_is_counted_and_its_name_is_not_carried():
    # §127 with §109: an attachment name is user content. It is counted so a
    # rule about attachments can be answered, and the name stays in the file.
    art = _analyze(attachment_pdf(name=ATTACHMENT_NAME))
    assert art["structuralModel"]["features"]["attachmentCount"] == 1
    assert "PDF_ATTACHMENT_PRESENT" in {w["code"] for w in art["warnings"]}
    assert ATTACHMENT_NAME not in repr(art)


def test_attachment_bytes_are_never_opened():
    art = _analyze(attachment_pdf())
    assert "id,value" not in repr(art)
    assert "secret" not in repr(art)


def test_signature_field_is_reported_as_presence_never_as_validity():
    # §16: PalCert is not a signature validator and must never imply it is.
    art = _analyze(acroform_pdf(signature=True))
    features = art["structuralModel"]["features"]
    assert features["signatureFieldCount"] == 1
    assert "PDF_SIGNATURE_PRESENT" in {w["code"] for w in art["warnings"]}

    serialised = repr(art).lower()
    for claim in ("signaturevalid", "signature_valid", "verified", "trusted"):
        assert claim not in serialised


def test_signature_fact_is_a_count_not_a_verdict():
    art = _analyze(acroform_pdf(signature=True))
    facts = {f["scope"]["property"]: f for f in art["factSet"]["facts"]}
    assert facts["signatureFieldCount"]["value"]["number"] == "1"
    assert "boolean" not in facts["signatureFieldCount"]["value"]


def test_xfa_form_is_reported():
    art = _analyze(acroform_pdf(xfa=True))
    assert art["structuralModel"]["features"]["xfaPresent"] is True
    assert "PDF_XFA_PRESENT" in {w["code"] for w in art["warnings"]}


def test_form_fields_and_outline_are_counted():
    assert _analyze(acroform_pdf(fields=3))["structuralModel"]["features"]["formFieldCount"] == 3
    assert _analyze(outline_pdf())["structuralModel"]["features"]["outlineCount"] == 3


def test_bookmark_titles_are_not_carried_into_the_artifact():
    art = _analyze(outline_pdf(titles=("Confidential Annex",)))
    assert "Confidential Annex" not in repr(art)


def test_password_protected_document_fails_without_a_password():
    # §19: required password is a refusal, not a challenge. PalCert does not
    # collect one, does not try the empty string as an owner bypass, and never
    # brute-forces.
    with pytest.raises(PdfAnalysisError) as caught:
        _analyze(encrypted_pdf())
    assert caught.value.code is PdfFailure.PASSWORD_REQUIRED


def test_password_failure_carries_no_password_material():
    with pytest.raises(PdfAnalysisError) as caught:
        _analyze(encrypted_pdf(owner="owner-secret", user="user-secret"))
    detail = f"{caught.value.code} {caught.value.detail}"
    assert "owner-secret" not in detail
    assert "user-secret" not in detail


def test_a_plain_document_reports_no_active_content():
    art = _analyze(simple_text_pdf())
    features = art["structuralModel"]["features"]
    assert features["javaScriptPresent"] is False
    assert features["attachmentCount"] == 0
    assert features["signatureFieldCount"] == 0
    assert "PDF_ACTIVE_CONTENT_PRESENT" not in {w["code"] for w in art["warnings"]}
