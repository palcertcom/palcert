"""The parser runs in a bounded child process and nothing it does escapes (§6, §7, §129, §130)."""

from __future__ import annotations

import dataclasses
import hashlib

import pytest

from app.pdf.analyzer import analyze
from app.pdf.errors import PdfAnalysisError, PdfFailure
from app.pdf.isolation import run_isolated
from app.pdf.limits import PdfLimits
from tests.pdf.builder import malformed_pdf, many_pages_pdf, simple_text_pdf, truncated_pdf


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def test_a_good_document_analyzes_in_the_child_process():
    data = simple_text_pdf()
    artifact = run_isolated(data, expected_sha256=_sha(data), document_id="d")
    assert artifact["format"] == "PDF"
    assert artifact["source"]["sha256"] == _sha(data)


def test_the_child_produces_the_same_artifact_as_the_parent_would():
    data = simple_text_pdf(lines=("Isolation must not change the answer",))
    assert run_isolated(data, expected_sha256=_sha(data), document_id="d") == analyze(
        data, expected_sha256=_sha(data), document_id="d"
    )


def test_a_digest_mismatch_is_refused_before_any_parser_sees_the_bytes():
    # §9: the integrity check is first, and it is not advisory. A PDF that is
    # not the PDF PalCert promoted never reaches native code at all.
    data = simple_text_pdf()
    with pytest.raises(PdfAnalysisError) as caught:
        run_isolated(data, expected_sha256="0" * 64, document_id="d")
    assert caught.value.code is PdfFailure.SOURCE_INTEGRITY_FAILED


def test_garbage_that_claims_to_be_a_pdf_fails_cleanly():
    data = malformed_pdf()
    with pytest.raises(PdfAnalysisError) as caught:
        run_isolated(data, expected_sha256=_sha(data), document_id="d")
    assert caught.value.code in {PdfFailure.DOCUMENT_INVALID, PdfFailure.ANALYZER_CRASHED}


def test_a_truncated_document_fails_cleanly_and_the_parent_survives():
    data = truncated_pdf()
    with pytest.raises(PdfAnalysisError):
        run_isolated(data, expected_sha256=_sha(data), document_id="d")
    # §7: a parser crash fails one analysis, not the service. The proof is that
    # the very next analysis in this same parent works.
    good = simple_text_pdf()
    assert run_isolated(good, expected_sha256=_sha(good), document_id="d")["format"] == "PDF"


def test_the_analysis_times_out_rather_than_hanging():
    data = simple_text_pdf(pages_count=8)
    limits = dataclasses.replace(PdfLimits.default(), timeout_ms=1)
    with pytest.raises(PdfAnalysisError) as caught:
        run_isolated(data, expected_sha256=_sha(data), document_id="d", limits=limits)
    assert caught.value.code is PdfFailure.ANALYSIS_TIMEOUT


def test_a_timeout_leaves_no_child_behind():
    # subprocess.run kills and reaps on timeout; the assertion is that the
    # parent is still able to do work afterwards, with no zombie in the way.
    data = simple_text_pdf(pages_count=8)
    limits = dataclasses.replace(PdfLimits.default(), timeout_ms=1)
    with pytest.raises(PdfAnalysisError):
        run_isolated(data, expected_sha256=_sha(data), document_id="d", limits=limits)
    good = simple_text_pdf()
    assert run_isolated(good, expected_sha256=_sha(good), document_id="d")


def test_the_page_limit_is_enforced():
    limits = dataclasses.replace(PdfLimits.default(), max_pages=3)
    data = many_pages_pdf(6)
    with pytest.raises(PdfAnalysisError) as caught:
        run_isolated(data, expected_sha256=_sha(data), document_id="d", limits=limits)
    assert caught.value.code is PdfFailure.LIMIT_EXCEEDED


def test_the_size_limit_is_enforced_before_parsing():
    limits = dataclasses.replace(PdfLimits.default(), max_bytes=64)
    data = simple_text_pdf()
    with pytest.raises(PdfAnalysisError) as caught:
        analyze(data, expected_sha256=_sha(data), document_id="d", limits=limits)
    assert caught.value.code is PdfFailure.LIMIT_EXCEEDED


def test_the_text_budget_truncates_rather_than_growing_without_bound():
    limits = dataclasses.replace(PdfLimits.default(), max_text_chars=10)
    data = simple_text_pdf(pages_count=2)
    artifact = analyze(data, expected_sha256=_sha(data), document_id="d", limits=limits)
    assert "PDF_OBJECT_LIMIT_REACHED" in {w["code"] for w in artifact["warnings"]}


def test_a_failure_detail_carries_no_document_content():
    # §109: nothing from inside the document may reach an error string, because
    # error strings reach logs.
    data = truncated_pdf()
    with pytest.raises(PdfAnalysisError) as caught:
        run_isolated(data, expected_sha256=_sha(data), document_id="d")
    detail = caught.value.detail
    assert "quick brown fox" not in detail
    assert "Helvetica" not in detail
