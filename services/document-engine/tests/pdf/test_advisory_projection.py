"""Advisory projection, and why it cannot certify anything (Checkpoint 15).

Checkpoints 10 to 14 built heuristic citation discovery and projected none of
it. The reason was not caution for its own sake: the deterministic engine
checks ``failed > 0`` before it looks at coverage, so PARTIAL prevents a false
pass and does nothing whatever about a false failure. A heuristic count
projected as an ordinary fact could therefore fail a compliant document
outright, and no coverage status would intervene.

Checkpoint 15 makes the projection safe by changing the evaluator rather than
by trusting the number: a fact whose provenance is ``HEURISTIC`` is reported
and never decides. That is what lets three observed counters become public
without any of them being able to reach a verdict.

Two questions run through this file. *Is the observation there?* — because an
advisory path nobody can see is not worth a contract. And *can it possibly
decide anything?* — asked from both directions, because the dangerous failure
is not only a false pass.
"""

from __future__ import annotations

import hashlib
from typing import Any

import pytest

from app.engine.contracts.artifact_contract import validate_analysis_artifact
from app.engine.evaluation.engine import DeterministicRuleEngine
from app.engine.facts.model import DocumentFactSet
from app.engine.rules.outcomes import EvidenceLevel, Outcome, ReasonCode
from app.pdf.analyzer import analyze
from app.pdf.support import Format, Support, support_for
from tests.engine.conftest import document_scope, rule
from tests.pdf.builder import (
    multi_region_pdf,
    numbered_references_pdf,
    scanned_pdf,
    simple_text_pdf,
    tagged_citation_pdf,
    vancouver_references_pdf,
)

ADVISORY = ("observedCitationCount", "observedReferenceCount", "observedReferenceRegionPresent")
EXACT = (
    "nativeCitationCount",
    "nativeBibliographySourceCount",
    "nativeSourceResolved",
    "referenceRegionPresent",
    "citationTargetResolved",
)


def analyzed(data: bytes) -> dict[str, Any]:
    artifact: dict[str, Any] = analyze(
        data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d"
    )
    return artifact


def facts_for(artifact: dict[str, Any], name: str) -> list[dict[str, Any]]:
    return [fact for fact in artifact["factSet"]["facts"] if fact["scope"].get("property") == name]


def coverage_for(artifact: dict[str, Any], name: str) -> dict[str, Any] | None:
    for entry in artifact["factSet"]["coverage"]:
        if entry.get("property") == name and entry.get("kind") == "DOCUMENT":
            return dict(entry)
    return None


def evaluate(artifact: dict[str, Any], prop: str, operator: str, expected: dict[str, Any]) -> Any:
    engine = DeterministicRuleEngine()
    fact_set = DocumentFactSet.from_json(artifact["factSet"])
    return engine.evaluate(fact_set, rule(document_scope(prop), operator, expected, blocking=True))


# --- the observation is there ------------------------------------------------


def test_a_heuristic_only_pdf_produces_advisory_facts() -> None:
    """The document Checkpoint 15 exists for: real citation structure, nothing declared."""
    artifact = analyzed(multi_region_pdf())
    (citations,) = facts_for(artifact, "observedCitationCount")
    (references,) = facts_for(artifact, "observedReferenceCount")
    (region,) = facts_for(artifact, "observedReferenceRegionPresent")

    assert citations["value"] == {"type": "NUMBER", "number": "3"}
    assert citations["unit"] == "COUNT"
    assert references["value"] == {"type": "NUMBER", "number": "6"}
    assert region["value"] == {"type": "BOOLEAN", "boolean": True}
    for fact in (citations, references, region):
        assert fact["provenance"]["sourceKind"] == "HEURISTIC"


def test_a_heuristic_only_pdf_produces_no_new_exact_fact() -> None:
    """Everything the quarantine protected stays protected.

    A document with six recognized reference entries and three recognized
    citations proves nothing about structure, so none of the five exact
    properties gains a value from it.
    """
    artifact = analyzed(multi_region_pdf())
    for name in EXACT:
        assert facts_for(artifact, name) == [], name


def test_an_exact_only_pdf_is_semantically_unchanged() -> None:
    """A tagged document emits exactly the facts it emitted before.

    Advisory counters are positive-only for this reason among others: a zero
    from a lower-bound detector restates the fact's own absence, and emitting
    it would change the fact set of every declared document to report on a
    detector that found nothing in it.
    """
    artifact = analyzed(tagged_citation_pdf())
    for name in ADVISORY:
        assert facts_for(artifact, name) == [], name
    assert facts_for(artifact, "referenceRegionPresent")
    assert facts_for(artifact, "citationTargetResolved")


def test_an_image_only_pdf_observes_nothing_at_all() -> None:
    """Discovery was never attempted, which is not the same as finding none."""
    artifact = analyzed(scanned_pdf())
    for name in ADVISORY:
        assert facts_for(artifact, name) == [], name
        assert (coverage_for(artifact, name) or {}).get("status") == "UNAVAILABLE", name


# --- it cannot decide anything ----------------------------------------------


@pytest.mark.parametrize(
    ("operator", "expected"),
    [
        ("EQUALS", {"type": "NUMBER", "number": "3"}),
        ("EQUALS", {"type": "NUMBER", "number": "999"}),
        ("GREATER_THAN_OR_EQUAL", {"type": "NUMBER", "number": "1"}),
        ("GREATER_THAN_OR_EQUAL", {"type": "NUMBER", "number": "500"}),
    ],
)
def test_an_advisory_rule_can_neither_pass_nor_fail(
    operator: str, expected: dict[str, Any]
) -> None:
    """Both directions, because both are dangerous.

    A rule that matched the observation would be a false pass; one that did not
    would be a false failure on a document whose detector simply missed
    something. Neither happens: the outcome is INDETERMINATE and the evidence
    level says why.
    """
    artifact = analyzed(multi_region_pdf())
    result = evaluate(artifact, "observedCitationCount", operator, expected)
    assert result.outcome is Outcome.INDETERMINATE
    assert result.reason_code is ReasonCode.ADVISORY_EVIDENCE_ONLY
    assert result.evidence_level is EvidenceLevel.ADVISORY


def test_an_advisory_result_is_never_labelled_deterministic() -> None:
    """The label is what the certificate gate and the report both read.

    A PASS or FAIL stamped DETERMINISTIC means every fact behind it came out of
    the document's own markup. An advisory result must not be able to claim
    that, or the distinction stops existing anywhere downstream.
    """
    artifact = analyzed(multi_region_pdf())
    for name in ADVISORY:
        result = evaluate(artifact, name, "EXISTS", {"type": "NONE"})
        assert result.evidence_level is not EvidenceLevel.DETERMINISTIC, name


def test_absence_of_heuristic_evidence_never_proves_absence() -> None:
    """`NOT_EXISTS` on an advisory property does not pass.

    Without an explicit coverage entry the property would inherit the DOCUMENT
    default of COMPLETE, and NOT_EXISTS would then assert that the document
    contains no citations — from a detector that merely did not recognize any.
    """
    artifact = analyzed(simple_text_pdf())
    assert facts_for(artifact, "observedCitationCount") == []
    result = evaluate(artifact, "observedCitationCount", "NOT_EXISTS", {"type": "NONE"})
    assert result.outcome is not Outcome.PASS


def test_an_exact_rule_is_unaffected_by_the_advisory_gate() -> None:
    """The gate keys on provenance, so exact evaluation is untouched.

    A tagged document's reference-region marker still passes an EXISTS rule
    exactly as it did, with DETERMINISTIC evidence.
    """
    artifact = analyzed(tagged_citation_pdf())
    result = evaluate(artifact, "referenceRegionPresent", "EXISTS", {"type": "NONE"})
    assert result.outcome is Outcome.PASS
    assert result.evidence_level is EvidenceLevel.DETERMINISTIC


# --- counts are observed counts ---------------------------------------------


def test_the_advisory_coverage_is_partial_and_never_complete() -> None:
    """Even on a document PalCert read end to end.

    "We read the whole file" still does not mean "we recognized everything in
    it": the detector knows some styles and not others, so COMPLETE would
    claim an exhaustiveness the contract cannot prove.
    """
    for build in (multi_region_pdf, numbered_references_pdf, vancouver_references_pdf):
        artifact = analyzed(build())
        for name in ADVISORY:
            assert (coverage_for(artifact, name) or {}).get("status") == "PARTIAL", name


def test_a_mixed_document_counts_only_what_it_recognized() -> None:
    """Exact and heuristic objects in one document, counted once each.

    The advisory count is over HEURISTIC objects alone. The declared ones are
    already answered by the exact properties, and a number mixing both could
    carry neither provenance honestly. Nothing is double-counted because the
    analyzer suppresses any heuristic object overlapping a declared span.
    """
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("[1]",),
            entries=(("[1]", "Smith, J. Water rights."),),
            heading="References",
            untagged_citations=("A later claim [2] and another [3].",),
            untagged_entries=("[2] Khatib, A. Contested basins.", "[3] Nasser, L. A survey."),
        )
    )
    analysis = artifact["citationAnalysis"]
    exact_citations = [c for c in analysis["citations"] if c["sourceKind"] == "PDF_TEXT"]
    heuristic_citations = [c for c in analysis["citations"] if c["sourceKind"] == "HEURISTIC"]
    # The fixture is genuinely mixed, or the test proves nothing.
    assert len(exact_citations) == 1
    assert len(heuristic_citations) == 2
    assert len(analysis["citations"]) == 3

    (citations,) = facts_for(artifact, "observedCitationCount")
    (references,) = facts_for(artifact, "observedReferenceCount")
    # Two, not three: the declared citation is already answered by the exact
    # properties and is not restated here under a weaker provenance.
    assert citations["value"] == {"type": "NUMBER", "number": "2"}
    assert references["value"] == {"type": "NUMBER", "number": "2"}

    # And the exact side is untouched.
    assert facts_for(artifact, "referenceRegionPresent")
    assert facts_for(artifact, "citationTargetResolved")


def test_no_advisory_fact_is_emitted_for_a_span_the_author_declared() -> None:
    """The disjointness the count relies on, asserted at the artifact level."""
    artifact = analyzed(
        tagged_citation_pdf(
            heading="References",
            untagged_entries=("[2] Khatib, A. Contested basins.", "[3] Nasser, L. A survey."),
        )
    )
    analysis = artifact["citationAnalysis"]
    exact_spans = {
        span
        for item in analysis["citations"] + analysis["references"]
        if item["sourceKind"] == "PDF_TEXT"
        for span in [item["location"]["nodeId"]]
    }
    heuristic_spans = {
        item["location"]["nodeId"]
        for item in analysis["citations"] + analysis["references"]
        if item["sourceKind"] == "HEURISTIC"
    }
    assert exact_spans.isdisjoint(heuristic_spans)


# --- confidence --------------------------------------------------------------


def test_a_count_carries_no_confidence() -> None:
    """There is no honest aggregate, so none is invented.

    Several observations with their own confidences contribute to one number.
    A single figure beside "6" would have to mean confidence that there are
    six, which is not what any per-object number measured.
    """
    artifact = analyzed(multi_region_pdf())
    for name in ("observedCitationCount", "observedReferenceCount"):
        (fact,) = facts_for(artifact, name)
        assert "confidence" not in fact["provenance"], name


def test_the_region_marker_carries_a_confidence_that_came_from_a_region() -> None:
    """A selection, not a computation.

    The claim is existential — at least one region was recognized — so the
    region that best supports it is the strongest one, and its own
    analyzer-produced confidence is copied across unchanged.
    """
    artifact = analyzed(multi_region_pdf())
    (fact,) = facts_for(artifact, "observedReferenceRegionPresent")
    stated = fact["provenance"]["confidence"]
    region_confidences = {
        region["confidence"] for region in artifact["citationAnalysis"]["referenceRegions"]
    }
    assert stated in region_confidences
    assert stated == max(region_confidences)


def test_no_confidence_reaches_an_exact_fact() -> None:
    artifact = analyzed(tagged_citation_pdf())
    for name in EXACT:
        for fact in facts_for(artifact, name):
            assert "confidence" not in fact.get("provenance", {}), name


# --- the support registry ----------------------------------------------------


@pytest.mark.parametrize("name", ADVISORY)
def test_advisory_support_is_distinguishable_from_exact(name: str) -> None:
    assert support_for(Format.PDF, name) is Support.ADVISORY
    assert support_for(Format.PDF, name) is not Support.EXACT
    assert support_for(Format.DOCX, name) is Support.UNSUPPORTED


@pytest.mark.parametrize("name", EXACT)
def test_no_exact_property_became_advisory(name: str) -> None:
    for fmt in (Format.PDF, Format.DOCX):
        assert support_for(fmt, name) is not Support.ADVISORY


# --- the contract and determinism -------------------------------------------


@pytest.mark.parametrize(
    "build", [multi_region_pdf, tagged_citation_pdf, vancouver_references_pdf, simple_text_pdf]
)
def test_the_fact_set_still_satisfies_the_shared_contract(build: Any) -> None:
    validate_analysis_artifact(analyzed(build()))


@pytest.mark.parametrize("build", [multi_region_pdf, vancouver_references_pdf])
def test_advisory_projection_is_deterministic(build: Any) -> None:
    data = build()
    assert analyzed(data)["factSet"] == analyzed(data)["factSet"]


# --- the invariant the empty case rests on ----------------------------------


def test_the_advisory_coverage_policy_can_never_yield_complete() -> None:
    """Tested directly, because a second safety property depends on it.

    When a rule matches *no* advisory fact the provenance gate cannot fire —
    there is nothing to inspect — and the engine falls through to its presence
    logic, where `EXISTS` with no facts FAILs **if coverage is COMPLETE**. A
    heuristic detector that recognized nothing would then fail the document,
    which is precisely what this checkpoint forbids.

    What stops that is `ADVISORY_PARTIAL_ONLY` never returning COMPLETE for any
    input. That is a small function and an easy one to loosen by accident, so
    it is pinned here rather than left as a consequence of the projector.
    """
    from app.engine.contracts.citation_projection import CoveragePolicy, fact_coverage_for

    for domain_status in ("COMPLETE", "PARTIAL", "UNAVAILABLE", "ANYTHING_ELSE"):
        assert (
            fact_coverage_for(CoveragePolicy.ADVISORY_PARTIAL_ONLY, domain_status) != "COMPLETE"
        ), domain_status


def test_requiring_an_advisory_observation_never_fails_a_document() -> None:
    """`EXISTS` on a property PalCert recognized nothing for.

    The document has a reference list that the detector did not recognize —
    which is an ordinary outcome, not a defect in the document. The rule must
    not fail it.
    """
    artifact = analyzed(simple_text_pdf())
    for name in ADVISORY:
        assert facts_for(artifact, name) == [], name
        result = evaluate(artifact, name, "EXISTS", {"type": "NONE"})
        assert result.outcome is not Outcome.FAIL, name
        assert result.outcome is Outcome.INDETERMINATE, name
