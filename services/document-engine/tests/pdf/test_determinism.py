"""The same bytes always produce the same artifact (§97-§102)."""

from __future__ import annotations

import hashlib
import json
from decimal import Decimal

from app.pdf.analyzer import ANALYZER_NAME, ANALYZER_VERSION, analyze, engine_identity
from app.pdf.numbers import decimal_string, quantise
from tests.pdf.builder import (
    arabic_pdf,
    metadata_pdf,
    scanned_pdf,
    simple_text_pdf,
    tagged_pdf,
)

CORPUS = {
    "simple": simple_text_pdf(),
    "multi-page": simple_text_pdf(pages_count=3),
    "tagged": tagged_pdf(),
    "scanned": scanned_pdf(),
    "hybrid": scanned_pdf(with_text_page=True),
    "arabic": arabic_pdf(),
    "metadata": metadata_pdf(xmp={"dc:title": "T"}, doc_info={"/Author": "A"}),
}


def _analyze(data: bytes) -> dict:
    return analyze(data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d")


def _canonical(artifact: dict) -> str:
    return json.dumps(artifact, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def test_every_corpus_document_analyzes_identically_twice():
    for name, data in CORPUS.items():
        first, second = _analyze(data), _analyze(data)
        assert _canonical(first) == _canonical(second), name


def test_the_artifact_digest_is_stable_across_runs():
    data = CORPUS["tagged"]
    digests = {
        hashlib.sha256(_canonical(_analyze(data)).encode("utf-8")).hexdigest() for _ in range(3)
    }
    assert len(digests) == 1


def test_fonts_are_emitted_in_a_canonical_order():
    # §99: never a dictionary's insertion order. The same document analyzed
    # twice must list its fonts identically, and sorted is the only ordering
    # that does not depend on which page was read first.
    art = _analyze(simple_text_pdf(lines=("Alpha", "Beta", "Gamma")))
    names = [f["rawFontName"] for f in art["structuralModel"]["fonts"]]
    assert names == sorted(names)


def test_warnings_are_emitted_in_a_canonical_order():
    art = _analyze(scanned_pdf(with_text_page=True))
    codes = [w["code"] for w in art["warnings"]]
    assert codes == sorted(codes)
    assert len(codes) == len(set(codes)), "a warning is raised once, not once per page"


def test_node_ids_are_derived_from_position_not_from_a_counter():
    # §27: no UUID, no database sequence, no timestamp. The same document
    # produces the same ids in a fresh process, which is what lets a stored
    # report keep pointing at the right place.
    art = _analyze(simple_text_pdf(lines=("First line of text", "Second line of text")))
    ids = [s["nodeId"] for s in art["structuralModel"]["pages"][0]["spans"]]
    assert ids == ["page:1/textobj:1", "page:1/textobj:2"]
    assert ids == [
        s["nodeId"]
        for s in _analyze(simple_text_pdf(lines=("First line of text", "Second line of text")))[
            "structuralModel"
        ]["pages"][0]["spans"]
    ]


def test_geometry_is_rounded_to_a_fixed_number_of_places():
    # §23: two floats that differ only in the last bits must serialise the
    # same way, or the artifact hash moves with the C library's mood.
    assert decimal_string(Decimal("595.2755905511812")) == decimal_string(
        Decimal("595.2755905511811")
    )
    assert quantise(Decimal("0.0005")) == quantise(Decimal("0.0004999"))


def test_numbers_are_plain_strings_never_floats():
    art = _analyze(simple_text_pdf())
    geometry = art["structuralModel"]["pages"][0]["geometry"]
    assert isinstance(geometry["effectiveWidthPoints"], str)
    assert "e" not in geometry["effectiveWidthPoints"].lower()
    for fact in art["factSet"]["facts"]:
        number = fact["value"].get("number")
        assert number is None or isinstance(number, str)


def test_the_analyzer_environment_is_recorded_in_the_artifact():
    # §100: an artifact is interpreted through the code and the engines that
    # made it, so both are stored beside it.
    art = _analyze(simple_text_pdf())
    assert art["analyzer"] == {"name": ANALYZER_NAME, "version": ANALYZER_VERSION}
    engine = art["structuralModel"]["engine"]
    identity = engine_identity()
    assert engine["pdfiumVersion"] == identity.pdfium_version
    assert engine["pikepdfVersion"] == identity.pikepdf_version
    assert engine["qpdfVersion"] == identity.qpdf_version


def test_no_fact_carries_a_numeric_confidence_score():
    # §102: PalCert states what it read or says it could not read it. A
    # probability is neither, and would let a 0.7 become a PASS.
    for data in CORPUS.values():
        for fact in _analyze(data)["factSet"]["facts"]:
            assert "confidence" not in fact
            assert "confidence" not in fact["provenance"]
            assert "score" not in fact["provenance"]
