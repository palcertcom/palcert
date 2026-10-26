"""No analyzer may emit an unvalidated fact set (Phase 18, Checkpoint 9 §13).

Checkpoint 8 found two mis-keyed PDF value shapes that had been unreadable by
the rule engine since Phase 13. They survived two phases for one reason: the
PDF analyzer built a fact set and never ran it through the contract that the
rule engine reads it through. The DOCX analyzer always had that gate; the PDF
analyzer now does too.

The fix is one line in each analyzer, which is exactly the kind of line a
later refactor removes without noticing. So it is held two ways here: the gate
is proven to exist in every analyzer that builds a fact set, and it is proven
to *bite* — a fact set the contract rejects fails the analysis rather than
reaching an artifact.
"""

from __future__ import annotations

import hashlib
from typing import Any

import pytest

from app.engine.contracts.validation import validate_contract

#: Every analyzer that builds a ``DocumentFactSet``. A new format added
#: without a gate is a new row here that fails.
ANALYZER_MODULES = ("app.docx.analyzer", "app.pdf.analyzer")


@pytest.mark.parametrize("module_name", ANALYZER_MODULES)
def test_every_analyzer_validates_its_fact_set(module_name: str) -> None:
    import importlib
    import inspect

    source = inspect.getsource(importlib.import_module(module_name))
    assert 'assert_contract("DocumentFactSet"' in source, module_name


def _broken(fact_set: dict[str, Any]) -> dict[str, Any]:
    """The Phase 13 defect's shape, reintroduced deliberately."""
    broken = dict(fact_set)
    broken["facts"] = [dict(fact) for fact in fact_set["facts"]]
    for fact in broken["facts"]:
        if fact["value"]["type"] == "BOOLEAN":
            fact["value"] = {"type": "BOOLEAN", "bool": fact["value"]["boolean"]}
            return broken
    raise AssertionError("the fixture must emit at least one boolean fact")


def test_the_contract_rejects_a_mis_keyed_value() -> None:
    """The gate is only worth having if the contract it calls would catch this."""
    from app.pdf.analyzer import analyze
    from tests.pdf.builder import tagged_citation_pdf

    data = tagged_citation_pdf()
    artifact = analyze(data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d")
    assert validate_contract("DocumentFactSet", artifact["factSet"]).valid
    assert not validate_contract("DocumentFactSet", _broken(artifact["factSet"])).valid


def test_a_pdf_whose_fact_set_fails_the_contract_fails_the_analysis(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A contract defect is a failed analysis, never a stored artifact.

    Proven by making the builder produce something invalid: the analyzer must
    raise rather than return an artifact carrying it.
    """
    import app.pdf.analyzer as analyzer
    from app.pdf.errors import PdfAnalysisError, PdfFailure
    from tests.pdf.builder import tagged_citation_pdf

    real = analyzer.build_fact_set

    def broken_builder(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return _broken(real(*args, **kwargs))

    monkeypatch.setattr(analyzer, "build_fact_set", broken_builder)

    data = tagged_citation_pdf()
    with pytest.raises(PdfAnalysisError) as raised:
        analyzer.analyze(data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d")
    assert raised.value.code is PdfFailure.DOCUMENT_INVALID
