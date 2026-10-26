"""The Phase 18 architecture, stated once and proved (Checkpoint 16).

Five checkpoints built heuristic citation discovery and two more decided what
it is allowed to say. The result is a two-class model, and the whole phase
rests on the classes never merging:

    EXACT evidence      -> authoritative facts -> authoritative compliance
    HEURISTIC evidence  -> advisory facts      -> advisory observations only

This file is the consolidated proof of that, kept apart from the per-checkpoint
suites so the final shape is readable in one place rather than inferred from
seven. It also holds the backward-compatibility audit: an artifact written
before any of this must still be readable under its documented contract, and an
optional field added later must still be optional.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from app.engine.contracts.artifact_contract import validate_analysis_artifact
from app.engine.contracts.citation_projection import (
    PROJECTED_PROPERTIES,
    CoveragePolicy,
    EvidenceClass,
    fact_coverage_for,
)
from app.pdf.analyzer import analyze
from app.pdf.support import Format, Support, support_for
from tests.pdf.builder import (
    multi_region_pdf,
    scanned_pdf,
    simple_text_pdf,
    tagged_citation_pdf,
    vancouver_references_pdf,
)

FIXTURES = Path(__file__).resolve().parents[4] / "contracts" / "fixtures" / "analysis"

EXACT_PROPERTIES = (
    "nativeCitationCount",
    "nativeBibliographySourceCount",
    "nativeSourceResolved",
    "referenceRegionPresent",
    "citationTargetResolved",
)
ADVISORY_PROPERTIES = (
    "observedCitationCount",
    "observedReferenceCount",
    "observedReferenceRegionPresent",
)


def analyzed(data: bytes) -> dict[str, Any]:
    artifact: dict[str, Any] = analyze(
        data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d"
    )
    return artifact


def facts(artifact: dict[str, Any], name: str) -> list[dict[str, Any]]:
    return [f for f in artifact["factSet"]["facts"] if f["scope"].get("property") == name]


def coverage(artifact: dict[str, Any], name: str) -> dict[str, Any] | None:
    for entry in artifact["factSet"]["coverage"]:
        if entry.get("property") == name:
            return dict(entry)
    return None


# --- the two classes, and the wall between them ------------------------------


def test_the_allow_list_holds_exactly_two_evidence_classes() -> None:
    assert {entry.evidence_class for entry in PROJECTED_PROPERTIES} == {
        EvidenceClass.EXACT,
        EvidenceClass.HEURISTIC,
    }


def test_the_exact_five_are_final() -> None:
    """Frozen at Checkpoint 9 and unchanged by everything since."""
    exact = {entry.property for entry in PROJECTED_PROPERTIES if not entry.advisory}
    assert exact == set(EXACT_PROPERTIES)


def test_the_advisory_three_are_final() -> None:
    """Frozen at Checkpoint 15. Checkpoint 16 adds none."""
    advisory = {entry.property for entry in PROJECTED_PROPERTIES if entry.advisory}
    assert advisory == set(ADVISORY_PROPERTIES)


def test_no_element_level_advisory_property_exists() -> None:
    """Deliberately deferred: observed citation-target resolution is not here."""
    assert all(entry.scope_kind == "DOCUMENT" for entry in PROJECTED_PROPERTIES if entry.advisory)


@pytest.mark.parametrize("name", EXACT_PROPERTIES)
def test_an_exact_property_never_accepts_heuristic_projection(name: str) -> None:
    """Proved from the document rather than from the registry.

    A file with six recognized reference entries, three recognized citations
    and two recognized regions declares nothing, so every exact property stays
    empty. That is the projection gate working on real evidence, not a
    restatement of the table that configures it.
    """
    artifact = analyzed(multi_region_pdf())
    assert facts(artifact, name) == []
    for fmt in (Format.PDF, Format.DOCX):
        assert support_for(fmt, name) is not Support.ADVISORY


@pytest.mark.parametrize("name", ADVISORY_PROPERTIES)
def test_an_advisory_fact_keeps_its_heuristic_provenance(name: str) -> None:
    artifact = analyzed(multi_region_pdf())
    for fact in facts(artifact, name):
        assert fact["provenance"]["sourceKind"] == "HEURISTIC"


@pytest.mark.parametrize("name", EXACT_PROPERTIES)
def test_an_exact_fact_carries_no_confidence(name: str) -> None:
    """A confidence on an exact fact would dress a certainty as a measurement."""
    for build in (tagged_citation_pdf, multi_region_pdf, simple_text_pdf):
        for fact in facts(analyzed(build()), name):
            assert "confidence" not in fact.get("provenance", {}), name


def test_an_advisory_property_never_reports_complete_coverage() -> None:
    """Across every document shape, and at the policy itself.

    Both halves matter. The policy check is the invariant; the document check
    is the proof that the projector actually goes through it.
    """
    for status in ("COMPLETE", "PARTIAL", "UNAVAILABLE"):
        assert fact_coverage_for(CoveragePolicy.ADVISORY_PARTIAL_ONLY, status) != "COMPLETE"
    for build in (multi_region_pdf, vancouver_references_pdf, tagged_citation_pdf, scanned_pdf):
        artifact = analyzed(build())
        for name in ADVISORY_PROPERTIES:
            entry = coverage(artifact, name)
            assert entry is not None, name
            assert entry["status"] in {"PARTIAL", "UNAVAILABLE"}, (build.__name__, name)


def test_advisory_absence_never_proves_real_world_absence() -> None:
    """A readable document whose citations the detector did not recognize.

    No advisory fact, and coverage that refuses to let the absence be read as
    an answer. `NOT_EXISTS` on any of these cannot pass, which is what stops
    "PalCert recognized none" becoming "the document contains none".
    """
    artifact = analyzed(simple_text_pdf())
    for name in ADVISORY_PROPERTIES:
        assert facts(artifact, name) == [], name
        assert (coverage(artifact, name) or {})["status"] != "COMPLETE", name


# --- backward compatibility --------------------------------------------------


HISTORICAL = (
    "citation-v1-artifact-without-citation-analysis.json",
    "citation-v2-artifact-docx.json",
    "citation-v2-artifact-pdf.json",
    "citation-v2-artifact-unavailable.json",
    "citation-v2-artifact-arabic.json",
    "citation-v2-artifact-pdf-internal-destination.json",
)


@pytest.mark.parametrize("name", HISTORICAL)
def test_an_artifact_written_before_checkpoint_10_still_validates(name: str) -> None:
    """Every field Checkpoints 13 to 15 added is optional, and stays optional.

    These fixtures predate citation identifiers, reference regions, region
    ordinals and advisory projection. None of them is rewritten to satisfy the
    current analyzer, and all of them must still be readable — a stored
    artifact is interpreted through its contract for ever, not through the
    latest one.
    """
    artifact = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    result = validate_analysis_artifact(artifact)
    assert result.valid, [issue.message for issue in result.issues]


@pytest.mark.parametrize("name", HISTORICAL)
def test_a_historical_artifact_is_not_rewritten_by_reading_it(name: str) -> None:
    """Validation is a read. It must not normalize, default or repair."""
    raw = (FIXTURES / name).read_text(encoding="utf-8")
    artifact = json.loads(raw)
    validate_analysis_artifact(artifact)
    assert json.dumps(artifact, sort_keys=True) == json.dumps(json.loads(raw), sort_keys=True), name


def test_the_fields_the_later_checkpoints_added_are_absent_from_history() -> None:
    """The premise the compatibility claim rests on, stated explicitly."""
    artifact = json.loads((FIXTURES / "citation-v2-artifact-pdf.json").read_text(encoding="utf-8"))
    analysis = artifact["citationAnalysis"]
    assert "referenceRegions" not in analysis
    for reference in analysis["references"]:
        assert "regionOrdinal" not in reference
    for citation in analysis["citations"]:
        assert "identifiers" not in citation


def test_the_citation_analysis_schema_version_never_moved() -> None:
    """Three additive changes, one version.

    `identifiers` (13), `referenceRegions` and `regionOrdinal` (14) are each
    optional, so every artifact written under version 1 is still a valid
    version 1 artifact. A bump would have invalidated nothing and forced every
    stored artifact to be reinterpreted.
    """
    for name in ("citation-v2-artifact-docx.json", "citation-v2-artifact-pdf.json"):
        artifact = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
        assert artifact["citationAnalysis"]["citationAnalysisSchemaVersion"] == 1
    assert analyzed(multi_region_pdf())["citationAnalysis"]["citationAnalysisSchemaVersion"] == 1


# --- determinism -------------------------------------------------------------


@pytest.mark.parametrize(
    "build", [multi_region_pdf, vancouver_references_pdf, tagged_citation_pdf, simple_text_pdf]
)
def test_the_whole_artifact_is_deterministic(build: Any) -> None:
    data = build()
    assert analyzed(data) == analyzed(data)
