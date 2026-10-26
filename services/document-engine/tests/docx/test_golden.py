"""Golden corpus: every fixture against its manifest (§101).

One test per fixture, parameterized by identifier so a failure names the
behaviour that broke rather than an index. Each fixture asserts what it
declares: required facts, forbidden facts, warnings, coverage, or a fatal
error code.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import pytest

from app.docx.analyzer import AnalysisRequest, analyze
from app.docx.errors import DocxAnalysisError
from tests.docx.corpus import CORPUS, Fixture


def _analyze(fixture: Fixture) -> dict[str, Any]:
    content = fixture.build()
    outcome = analyze(
        AnalysisRequest(
            document_id=fixture.identifier,
            content=content,
            expected_sha256=hashlib.sha256(content).hexdigest(),
        )
    )
    envelope = json.loads(outcome.artifact.content)
    assert isinstance(envelope, dict)
    return envelope


def _coverage_status(coverage: list[dict[str, Any]], kind: str, selector: str | None) -> str | None:
    """The most specific coverage entry matching a selector."""
    best: str | None = None
    best_specificity = -1
    for entry in coverage:
        if entry.get("kind") != kind:
            continue
        element_type = entry.get("elementType")
        property_name = entry.get("property")
        specificity = 0
        if selector is None:
            if element_type is not None or property_name is not None:
                continue
        elif element_type == selector or property_name == selector:
            specificity = 1
        else:
            continue
        if specificity >= best_specificity:
            best_specificity = specificity
            best = str(entry["status"])
    return best


@pytest.mark.parametrize("fixture", CORPUS, ids=lambda item: item.identifier)
def test_golden_fixture(fixture: Fixture) -> None:
    if fixture.expected_error is not None:
        with pytest.raises(DocxAnalysisError) as raised:
            _analyze(fixture)
        assert str(raised.value.code) == fixture.expected_error
        return

    envelope = _analyze(fixture)
    fact_set = envelope["factSet"]
    facts: list[dict[str, Any]] = fact_set["facts"]
    warning_codes = {warning["code"] for warning in envelope["warnings"]}

    for expected in fixture.expected_facts:
        assert any(expected.matches(fact) for fact in facts), (
            f"{fixture.identifier}: expected {expected.kind}"
            f"/{expected.element_type or '-'}/{expected.property} = {expected.value}"
        )

    for kind, property_name in fixture.forbidden_facts:
        offending = [
            fact
            for fact in facts
            if fact["scope"].get("kind") == kind
            and (fact["scope"].get("property") or fact["scope"].get("field")) == property_name
        ]
        assert not offending, (
            f"{fixture.identifier}: {kind}/{property_name} must not be emitted, got {offending}"
        )

    assert fixture.expected_warnings <= warning_codes, (
        f"{fixture.identifier}: missing warnings "
        f"{sorted(fixture.expected_warnings - warning_codes)}"
    )

    for kind, selector, status in fixture.expected_coverage:
        actual = _coverage_status(fact_set["coverage"], kind, selector)
        assert actual == status, (
            f"{fixture.identifier}: coverage {kind}/{selector or '-'} "
            f"expected {status}, got {actual}"
        )


@pytest.mark.parametrize("fixture", CORPUS, ids=lambda item: item.identifier)
def test_no_fabricated_page_numbers(fixture: Fixture) -> None:
    """No DOCX fact may ever carry a page number (§2, §108)."""
    if fixture.expected_error is not None:
        return
    envelope = _analyze(fixture)
    for fact in envelope["factSet"]["facts"]:
        location = fact.get("location")
        if location is not None:
            assert "page" not in location, f"{fixture.identifier} fabricated a page number"
        assert fact["scope"]["kind"] != "PAGE"


@pytest.mark.parametrize("fixture", CORPUS, ids=lambda item: item.identifier)
def test_deterministic_across_runs(fixture: Fixture) -> None:
    """The same bytes produce the same artifact bytes (§85, §87)."""
    if fixture.expected_error is not None:
        return
    content = fixture.build()
    digest = hashlib.sha256(content).hexdigest()
    first = analyze(
        AnalysisRequest(document_id="d", content=content, expected_sha256=digest)
    ).artifact
    second = analyze(
        AnalysisRequest(document_id="d", content=content, expected_sha256=digest)
    ).artifact
    assert first.sha256 == second.sha256
    assert first.content == second.content


def test_corpus_manifests_are_complete() -> None:
    """Every fixture documents what it exercises (§99)."""
    for fixture in CORPUS:
        assert fixture.exercises.strip(), f"{fixture.identifier} has no manifest"
        assert fixture.title.strip()
    identifiers = [fixture.identifier for fixture in CORPUS]
    assert len(identifiers) == len(set(identifiers))
