"""The Phase 18 citation contracts, from the Python side.

The TypeScript suite validates these same fixture files against the same
schema, the same integrity rules and the same projection registry. Running
both over one fixture set is what turns "the two runtimes should agree" into
something CI proves, which is the whole reason the contracts live in
``contracts/`` rather than in either runtime.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.engine.contracts.artifact_contract import (
    AnalysisArtifactContractError,
    assert_analysis_artifact,
    load_schema,
    validate_analysis_artifact,
    validate_analysis_artifact_schema,
)
from app.engine.contracts.citation_integrity import (
    CitationIntegrityCode,
    validate_citation_integrity,
)
from app.engine.contracts.citation_projection import (
    CITATION_PROJECTION_REGISTRY_VERSION,
    PROJECTED_PROPERTIES,
    CoveragePolicy,
    ProjectionKind,
    is_projectable,
    projection_for,
)

FIXTURES = Path(__file__).resolve().parents[4] / "contracts" / "fixtures" / "analysis"
INTEGRITY = FIXTURES / "citation-integrity"

VALID_ENVELOPES = (
    "citation-v1-artifact-without-citation-analysis.json",
    "citation-v2-artifact-docx.json",
    "citation-v2-artifact-pdf.json",
    "citation-v2-artifact-unavailable.json",
    "citation-v2-artifact-arabic.json",
    "citation-v2-artifact-pdf-internal-destination.json",
)


def _load(path: Path) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return loaded


def _structural() -> list[str]:
    return sorted(path.name for path in FIXTURES.glob("invalid-citation-*.json"))


def _broken_graphs() -> list[str]:
    return sorted(path.name for path in INTEGRITY.glob("invalid-*.json"))


@pytest.mark.parametrize("name", VALID_ENVELOPES)
def test_accepts_the_valid_envelopes(name: str) -> None:
    result = validate_analysis_artifact(_load(FIXTURES / name))
    assert result.valid, [issue.message for issue in result.issues]


def test_a_historical_v1_artifact_carries_no_citation_evidence() -> None:
    artifact = _load(FIXTURES / "citation-v1-artifact-without-citation-analysis.json")
    assert artifact["analysisSchemaVersion"] == 1
    assert "citationAnalysis" not in artifact


def test_the_envelope_version_and_the_section_move_together() -> None:
    """Neither half can arrive without the other.

    A v2 artifact that forgot the section would advertise Phase 18 capability
    and carry none; a v1 that grew one would be a historical record edited
    after the fact.
    """
    v1 = _load(FIXTURES / "citation-v1-artifact-without-citation-analysis.json")
    v2 = _load(FIXTURES / "citation-v2-artifact-docx.json")

    assert (
        validate_analysis_artifact({**v1, "citationAnalysis": v2["citationAnalysis"]}).valid
        is False
    )
    without_section = {key: value for key, value in v2.items() if key != "citationAnalysis"}
    assert validate_analysis_artifact(without_section).valid is False


def test_the_citation_analysis_schema_version_is_pinned_at_one() -> None:
    artifact = _load(FIXTURES / "citation-v2-artifact-docx.json")
    assert artifact["citationAnalysis"]["citationAnalysisSchemaVersion"] == 1


def test_structural_rejection_fixtures_exist() -> None:
    assert len(_structural()) >= 8


@pytest.mark.parametrize("name", _structural())
def test_rejects_structural_fixtures_at_the_schema(name: str) -> None:
    assert validate_analysis_artifact(_load(FIXTURES / name)).valid is False


def test_graph_rejection_fixtures_exist() -> None:
    assert len(_broken_graphs()) >= 25


@pytest.mark.parametrize(
    "name",
    [
        "valid-consistent-graph.json",
        "valid-doi-identity-link.json",
        "valid-doi-ambiguous-over-a-cross-method-union.json",
    ],
)
def test_accepts_a_consistent_graph(name: str) -> None:
    artifact = _load(INTEGRITY / name)
    assert validate_analysis_artifact(artifact).valid
    assert validate_citation_integrity(artifact["citationAnalysis"]).issues == ()


def test_a_doi_candidate_may_rest_on_another_method_when_methods_disagree() -> None:
    """The one place the check stops, and why it stops there.

    When two exact methods resolve to different entries the frozen rule makes
    every row AMBIGUOUS over the *union* of what they found — the contract's
    way of saying "the document points at either of these and PalCert will not
    choose". So a DOI row's candidate may be there on the other method's
    evidence, and demanding a shared DOI for it would silently prioritize one
    method over the other.

    A *resolved* DOI link is different: it names one entry outright, and that
    entry must state the same identity.
    """
    artifact = _load(INTEGRITY / "valid-doi-ambiguous-over-a-cross-method-union.json")
    analysis = artifact["citationAnalysis"]
    identities = {
        entry["id"]: [item.get("normalized") for item in entry.get("identifiers", [])]
        for entry in analysis["references"]
    }
    assert identities["r9"] == ["10.9999/other"], "the candidate states a different DOI"
    assert validate_citation_integrity(analysis).valid


def test_a_doi_link_must_be_backed_on_both_sides() -> None:
    """The one method whose evidence is written down on both sides.

    Every other link method rests on something the artifact does not record —
    a tag comparison, a label match, a destination lookup — so a row claiming
    it can only be trusted. `DOI_IDENTITY` names an identity that is *in* the
    artifact on the citation and on each entry it points at, which makes it
    the one method whose rows can be checked rather than believed.
    """
    for name in (
        "invalid-doi-link-without-citation-identity.json",
        "invalid-doi-link-identities-differ.json",
        "invalid-doi-link-on-boundary-ambiguous-identity.json",
    ):
        artifact = _load(INTEGRITY / name)
        result = validate_citation_integrity(artifact["citationAnalysis"])
        assert result.valid is False, name
        assert CitationIntegrityCode.DOI_LINK_WITHOUT_SHARED_IDENTITY in {
            issue.code for issue in result.issues
        }, name


@pytest.mark.parametrize("name", _broken_graphs())
def test_graph_fixtures_pass_the_schema_and_fail_the_integrity_check(name: str) -> None:
    artifact = _load(INTEGRITY / name)
    # Both halves matter: a fixture the schema already rejected would prove
    # nothing about the integrity pass it was written for. This is the one
    # place that wants the schema-only path — everywhere else, and in
    # production, ``validate_analysis_artifact`` means the complete contract.
    assert validate_analysis_artifact_schema(artifact).valid, "fixture must be structurally valid"
    assert validate_citation_integrity(artifact["citationAnalysis"]).valid is False


@pytest.mark.parametrize(
    ("name", "code"),
    [
        ("invalid-duplicate-citation-id.json", CitationIntegrityCode.DUPLICATE_CITATION_ID),
        ("invalid-link-citation-unknown.json", CitationIntegrityCode.LINK_CITATION_UNKNOWN),
        ("invalid-link-target-unknown.json", CitationIntegrityCode.LINK_TARGET_UNKNOWN),
        ("invalid-link-candidate-unknown.json", CitationIntegrityCode.LINK_CANDIDATE_UNKNOWN),
        ("invalid-duplicate-of-self.json", CitationIntegrityCode.DUPLICATE_OF_SELF),
        (
            "invalid-candidate-count-mismatch.json",
            CitationIntegrityCode.LINK_CANDIDATE_COUNT_MISMATCH,
        ),
        (
            "invalid-target-count-mismatch.json",
            CitationIntegrityCode.CITATION_TARGET_COUNT_MISMATCH,
        ),
        (
            "invalid-unresolved-link-claiming-target.json",
            CitationIntegrityCode.LINK_TARGET_NOT_ALLOWED,
        ),
        ("invalid-linked-without-target.json", CitationIntegrityCode.LINK_TARGET_MISSING),
        ("invalid-coverage-domain-repeated.json", CitationIntegrityCode.COVERAGE_DOMAIN_REPEATED),
        # A confidence is a graded answer. Beside an exact read there is
        # nothing to grade, so the number could only have been invented.
        ("invalid-confidence-on-ooxml.json", CitationIntegrityCode.CONFIDENCE_NOT_ALLOWED),
        ("invalid-confidence-on-pdf-text.json", CitationIntegrityCode.CONFIDENCE_NOT_ALLOWED),
        # Each link status has exactly one legal shape.
        ("invalid-linked-with-candidates.json", CitationIntegrityCode.LINK_CANDIDATES_NOT_ALLOWED),
        (
            "invalid-unresolved-with-candidates.json",
            CitationIntegrityCode.LINK_CANDIDATES_NOT_ALLOWED,
        ),
        (
            "invalid-ambiguous-without-candidates.json",
            CitationIntegrityCode.LINK_CANDIDATES_INSUFFICIENT,
        ),
        (
            "invalid-ambiguous-with-one-candidate.json",
            CitationIntegrityCode.LINK_CANDIDATES_INSUFFICIENT,
        ),
        (
            "invalid-ambiguous-with-repeated-candidate.json",
            CitationIntegrityCode.LINK_CANDIDATE_REPEATED,
        ),
        # The citation's own status is a summary of its links, and a summary
        # that disagrees with them leaves a reader unable to say which half is
        # the mistake.
        (
            "invalid-citation-linked-but-link-unresolved.json",
            CitationIntegrityCode.CITATION_RESOLUTION_STATUS_MISMATCH,
        ),
        (
            "invalid-citation-not-attempted-with-link.json",
            CitationIntegrityCode.CITATION_RESOLUTION_STATUS_MISMATCH,
        ),
        (
            "invalid-duplicate-confirmed-without-target.json",
            CitationIntegrityCode.DUPLICATE_OF_MISSING,
        ),
        # The same invariants over the method added in Checkpoint 7. A PDF
        # link gets no weaker graph rules than a Word one: where the evidence
        # came from does not change what a link row may say.
        (
            "invalid-internal-destination-target-missing.json",
            CitationIntegrityCode.LINK_TARGET_UNKNOWN,
        ),
        (
            "invalid-internal-destination-linked-with-candidates.json",
            CitationIntegrityCode.LINK_CANDIDATES_NOT_ALLOWED,
        ),
        (
            "invalid-internal-destination-ambiguous-with-one-candidate.json",
            CitationIntegrityCode.LINK_CANDIDATES_INSUFFICIENT,
        ),
        (
            "invalid-internal-destination-repeated-candidate.json",
            CitationIntegrityCode.LINK_CANDIDATE_REPEATED,
        ),
        (
            "invalid-internal-destination-unresolved-with-target.json",
            CitationIntegrityCode.LINK_TARGET_NOT_ALLOWED,
        ),
        (
            "invalid-internal-destination-resolution-status-mismatch.json",
            CitationIntegrityCode.CITATION_RESOLUTION_STATUS_MISMATCH,
        ),
    ],
)
def test_names_the_defect_rather_than_shrugging(name: str, code: CitationIntegrityCode) -> None:
    result = validate_citation_integrity(_load(INTEGRITY / name)["citationAnalysis"])
    assert code in [issue.code for issue in result.issues]


def test_there_is_no_link_method_for_not_having_linked() -> None:
    """A link row exists only when linking was attempted.

    So every method names a real attempt, and a citation nobody tried to link
    has no row at all rather than a row saying NONE.
    """
    schema = load_schema()
    methods = schema["$defs"]["CitationReferenceLink"]["properties"]["linkMethod"]["enum"]
    assert methods == [
        "NATIVE_TAG",
        "DOI_IDENTITY",
        "NUMERIC_LABEL",
        "AUTHOR_YEAR_UNIQUE",
        "STRUCTURED_TUPLE",
        # Added in Checkpoint 7, for an exact relationship the first five could
        # not describe: a document-native link whose internal destination
        # resolves to a declared reference entry.
        "INTERNAL_DESTINATION",
    ]


def test_the_ordinary_contract_rejects_a_broken_citation_graph() -> None:
    """The runtime-safety test: one name, the whole contract.

    These were two functions when the citation contracts landed, which meant an
    artifact whose citation graph was corrupt satisfied the ordinary contract
    unless every caller remembered a second call. The caller who forgets is the
    one that stores the artifact.
    """
    artifact = _load(INTEGRITY / "invalid-citation-linked-but-link-unresolved.json")
    assert validate_analysis_artifact_schema(artifact).valid

    result = validate_analysis_artifact(artifact)
    assert result.valid is False
    assert CitationIntegrityCode.CITATION_RESOLUTION_STATUS_MISMATCH in [
        issue.code for issue in result.issues
    ]
    # Reported where the defect is, not at the root.
    assert all(issue.path.startswith("/citationAnalysis/") for issue in result.issues)

    with pytest.raises(AnalysisArtifactContractError, match="citationAnalysis"):
        assert_analysis_artifact(artifact)


def test_a_historical_v1_artifact_is_unaffected_by_the_complete_contract() -> None:
    v1 = _load(FIXTURES / "citation-v1-artifact-without-citation-analysis.json")
    assert validate_analysis_artifact(v1).valid
    assert validate_analysis_artifact_schema(v1).valid


def test_the_graph_check_does_not_run_over_a_structurally_invalid_artifact() -> None:
    """The semantic pass assumes the shape it reads.

    Running it anyway would report the structural failure a second time under a
    semantic name, which is a worse error message, not a stricter check.
    """
    v2 = _load(FIXTURES / "citation-v2-artifact-docx.json")
    without_section = {key: value for key, value in v2.items() if key != "citationAnalysis"}
    result = validate_analysis_artifact(without_section)
    assert result.valid is False
    assert all(issue.code is None for issue in result.issues)


def _key(entry: Any) -> str:
    return "/".join((entry.scope_kind, entry.element_type or "", entry.property))


def test_the_projection_registry_is_at_version_four() -> None:
    """Version 4 opened the advisory path beside the exact one.

    Version 2 recorded that one row is projectable from PDF as well; version 3
    added a format-independent citation-resolution property; version 4 admits
    a second *class* of row, which is the largest of the three changes. Which
    formats may project a row, which rows exist at all, and what a row is
    allowed to assert are each part of what the registry authorizes, so any of
    them is a version change rather than a data edit.
    """
    assert CITATION_PROJECTION_REGISTRY_VERSION == 4


def test_the_allow_list_holds_exactly_the_approved_properties() -> None:
    """Pinned as an exact set, on both sides.

    A ninth property cannot arrive without breaking a test that names all
    eight, which is the point: growing what citation evidence may assert about
    a document is a decision, not a convenience.
    """
    assert sorted(_key(entry) for entry in PROJECTED_PROPERTIES) == [
        "DOCUMENT//nativeBibliographySourceCount",
        "DOCUMENT//nativeCitationCount",
        "DOCUMENT//observedCitationCount",
        "DOCUMENT//observedReferenceCount",
        "DOCUMENT//observedReferenceRegionPresent",
        "DOCUMENT//referenceRegionPresent",
        "ELEMENT/CITATION/citationTargetResolved",
        "ELEMENT/CITATION/nativeSourceResolved",
    ]


def test_the_exact_allow_list_is_exactly_what_it_was_before_checkpoint_15() -> None:
    """The five authoritative rows, unchanged and named again here.

    Checkpoint 15 added advisory rows beside them and touched none of them.
    This test exists separately from the one above so that adding a *ninth*
    advisory row cannot quietly be mistaken for an exact one: the exact set is
    pinned on its own and is not allowed to grow at all.
    """
    exact = [entry for entry in PROJECTED_PROPERTIES if not entry.advisory]
    assert sorted(_key(entry) for entry in exact) == [
        "DOCUMENT//nativeBibliographySourceCount",
        "DOCUMENT//nativeCitationCount",
        "DOCUMENT//referenceRegionPresent",
        "ELEMENT/CITATION/citationTargetResolved",
        "ELEMENT/CITATION/nativeSourceResolved",
    ]
    assert all(entry.projection_kind.value.startswith("EXACT_") for entry in exact)


def test_an_advisory_row_is_document_scoped_partial_and_pdf_only() -> None:
    """Every constraint an advisory row carries, in one place.

    Document-scoped because Checkpoint 15 deliberately starts with counters
    rather than element-level assertions; PARTIAL-only because a heuristic
    population is a lower bound by construction; PDF-only because heuristic
    discovery is implemented for PDF alone.
    """
    advisory = [entry for entry in PROJECTED_PROPERTIES if entry.advisory]
    assert advisory
    for entry in advisory:
        assert entry.scope_kind == "DOCUMENT"
        assert entry.element_type is None
        assert entry.projection_kind.value.startswith("ADVISORY_")
        assert entry.coverage_policy is CoveragePolicy.ADVISORY_PARTIAL_ONLY
        assert entry.formats == ("PDF",)


def test_no_row_is_both_exact_and_advisory() -> None:
    """The projection kind and the evidence class must agree.

    They are separate fields on purpose — the class says which objects a row
    may read, the kind says what it may assert — and a row where one said
    EXACT and the other ADVISORY would be a row nobody could interpret.
    """
    for entry in PROJECTED_PROPERTIES:
        exact_kind = entry.projection_kind.value.startswith("EXACT_")
        assert exact_kind is not entry.advisory


def test_an_advisory_property_never_shares_a_name_with_an_exact_one() -> None:
    """Renaming an exact property to make it heuristic is the thing to prevent.

    `referenceRegionPresent` means "proven by structure". The advisory
    recognition is `observedReferenceRegionPresent`, a different row with a
    different name, so a reader cannot mistake a recognition for a proof.
    """
    exact = {entry.property for entry in PROJECTED_PROPERTIES if not entry.advisory}
    advisory = {entry.property for entry in PROJECTED_PROPERTIES if entry.advisory}
    assert exact & advisory == set()
    assert "referenceRegionPresent" in exact
    assert "observedReferenceRegionPresent" in advisory


def test_each_scope_and_property_is_named_once() -> None:
    keys = [_key(entry) for entry in PROJECTED_PROPERTIES]
    assert len(set(keys)) == len(keys)


def test_nothing_is_projected_about_a_rendered_reference_entry() -> None:
    # A rendered entry's identity is established by classification, and
    # coverage cannot repair a wrong element identity.
    assert all(entry.element_type != "REFERENCE_ENTRY" for entry in PROJECTED_PROPERTIES)
    for prop in ("doi", "isbn", "issn", "url", "duplicateConfirmed"):
        assert is_projectable("ELEMENT", prop, "REFERENCE_ENTRY") is False


def test_nothing_heuristic_is_projected_and_each_row_names_its_own_formats() -> None:
    """Three rows are defined in Word-native terms and stay DOCX-only.

    A PDF has no CITATION field, no Word source record and no source set to
    match a tag against, so a count of them is a question the format cannot be
    asked rather than a zero. The two rows defined without reference to
    storage carry their own format lists: the reference-region marker —
    "proven by structure" — is provable from both, and citation-target
    resolution is provable today only from a tagged PDF, because a Word
    citation resolves to a bibliography source record and never to a
    reference entry.
    """
    formats = {
        entry.property: entry.formats for entry in PROJECTED_PROPERTIES if not entry.advisory
    }
    assert formats == {
        "nativeCitationCount": ("DOCX",),
        "nativeBibliographySourceCount": ("DOCX",),
        "nativeSourceResolved": ("DOCX",),
        "referenceRegionPresent": ("DOCX", "PDF"),
        "citationTargetResolved": ("PDF",),
    }
    for entry in PROJECTED_PROPERTIES:
        if not entry.advisory:
            assert entry.projection_kind.value.startswith("EXACT_")
    for prop in (
        "citationCount",
        "referenceCount",
        "orphanCitationCount",
        "uncitedReferenceCount",
        "ambiguousCitationCount",
        "duplicateReferenceCount",
        "citationNumberingOrdered",
    ):
        assert is_projectable("DOCUMENT", prop) is False


def test_a_count_is_kept_away_from_partial_coverage() -> None:
    # A partial count is a wrong value, not a missing one, and PARTIAL does
    # not protect against a wrong value producing FAIL.
    for entry in PROJECTED_PROPERTIES:
        if entry.projection_kind is ProjectionKind.EXACT_COUNT:
            assert entry.coverage_policy is CoveragePolicy.COMPLETE_OR_UNAVAILABLE
            assert entry.value_kind == "NUMBER"
            # Stated, never inferred: a projector must not read COUNT out of a
            # property name, because a name is not a contract.
            assert entry.unit == "COUNT"


def test_every_count_has_a_unit_and_the_others_have_none() -> None:
    assert {entry.property: entry.unit for entry in PROJECTED_PROPERTIES} == {
        "nativeCitationCount": "COUNT",
        "nativeBibliographySourceCount": "COUNT",
        "nativeSourceResolved": None,
        "referenceRegionPresent": None,
        "citationTargetResolved": None,
        "observedCitationCount": "COUNT",
        "observedReferenceCount": "COUNT",
        "observedReferenceRegionPresent": None,
    }


def test_only_value_kinds_a_projector_can_build_are_declared() -> None:
    """The projector reads the kind and the unit off the row, not off the name.

    A row naming a kind it cannot build would fail at analysis time on a real
    document; held here, it is a test. A unit on a boolean would be a
    measurement in nothing.
    """
    for entry in PROJECTED_PROPERTIES:
        assert entry.value_kind in {"NUMBER", "BOOLEAN"}
        assert entry.unit in {None, "COUNT"}
        if entry.value_kind == "BOOLEAN":
            assert entry.unit is None
        if entry.unit is not None:
            assert entry.value_kind == "NUMBER"


def test_every_element_scoped_row_names_its_element_type() -> None:
    # Fail-closed lookup depends on it: an ELEMENT row without an element type
    # would be findable without one, which is the hole the SmartFix guard
    # closed on the write side.
    for entry in PROJECTED_PROPERTIES:
        assert (entry.element_type is None) == (entry.scope_kind != "ELEMENT")


def test_the_reference_region_is_positive_only_evidence() -> None:
    entry = projection_for("DOCUMENT", "referenceRegionPresent")
    assert entry is not None
    assert entry.projection_kind is ProjectionKind.EXACT_POSITIVE_MARKER
    assert entry.coverage_policy is CoveragePolicy.POSITIVE_ONLY_PARTIAL_OR_UNAVAILABLE


def test_native_source_resolution_is_scoped_to_the_citation_element() -> None:
    assert projection_for("ELEMENT", "nativeSourceResolved", "CITATION") is not None
    # Not a loose ELEMENT property: without the element type it is not found,
    # which is the same fail-closed rule the SmartFix guard uses.
    assert projection_for("ELEMENT", "nativeSourceResolved") is None
    assert projection_for("ELEMENT", "nativeSourceResolved", "REFERENCE_ENTRY") is None
