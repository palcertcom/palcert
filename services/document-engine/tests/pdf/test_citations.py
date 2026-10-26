"""Citation evidence from a PDF, and everything it refuses to claim.

A PDF stores glyphs. It stores a citation only when the author tagged one, and
then it stores exactly that. These tests are about the difference: what a
declaration proves, and what a page that merely looks like a bibliography
does not.

Every fixture goes through the real analyzer, so each artifact asserted
against has already satisfied the complete cross-language contract — the JSON
Schema and the citation graph's own integrity.
"""

from __future__ import annotations

import hashlib
from typing import Any

from app.engine.contracts.artifact_contract import validate_analysis_artifact
from app.engine.contracts.citation_integrity import validate_citation_integrity
from app.pdf.analyzer import ANALYZER_VERSION, ENVELOPE_SCHEMA_VERSION, analyze
from tests.pdf.builder import (
    arabic_pdf,
    internal_destination_pdf,
    scanned_pdf,
    simple_text_pdf,
    tagged_citation_pdf,
)

PROJECTED = {
    "nativeCitationCount",
    "nativeBibliographySourceCount",
    "nativeSourceResolved",
    "referenceRegionPresent",
    "citationTargetResolved",
}


def analyzed(data: bytes) -> dict[str, Any]:
    artifact: dict[str, Any] = analyze(
        data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d"
    )
    return artifact


def citations_of(data: bytes) -> dict[str, Any]:
    section: dict[str, Any] = analyzed(data)["citationAnalysis"]
    return section


def coverage(analysis: dict[str, Any], domain: str) -> dict[str, Any]:
    entry: dict[str, Any] = next(e for e in analysis["coverage"] if e["domain"] == domain)
    return entry


# --- exact evidence produces a valid graph ---------------------------------


def test_declared_citations_produce_a_valid_citation_analysis() -> None:
    artifact = analyzed(tagged_citation_pdf())
    assert artifact["analysisSchemaVersion"] == ENVELOPE_SCHEMA_VERSION
    assert validate_analysis_artifact(artifact).valid
    assert validate_citation_integrity(artifact["citationAnalysis"]).issues == ()


def test_a_declared_citation_and_entry_are_read_from_the_declaration() -> None:
    analysis = citations_of(tagged_citation_pdf())

    (citation,) = analysis["citations"]
    assert citation["sourceKind"] == "PDF_TEXT"
    assert citation["rawText"] == "[1]"
    # The structure says it is a citation; it does not say what kind, and
    # reading that out of the text is the classification this refuses.
    assert citation["citationKind"] == "UNKNOWN"
    assert citation["parseMethod"] == "NONE"
    assert citation["parseStatus"] == "UNPARSED"
    assert citation["location"]["page"] == 1

    (reference,) = analysis["references"]
    assert reference["rawText"] == "Smith, J. (2020). Water rights."
    assert reference["parseStatus"] == "UNPARSED"
    # Nothing is claimed about the work itself.
    assert reference["identifiers"] == []
    assert reference["authors"] == []


def test_the_citation_is_bound_to_its_own_span_not_its_line() -> None:
    """A line is PalCert's grouping; a span is the author's marked content.

    Binding by line would make the citation's text the whole sentence it sits
    at the end of, and would swallow the label typeset beside a reference
    entry — both of which are PalCert reporting its own layout work as the
    author's declaration.
    """
    analysis = citations_of(tagged_citation_pdf())
    (citation,) = analysis["citations"]
    assert "contested" not in citation["rawText"]
    assert citation["location"]["nodeId"].startswith("page:1/textobj:")


# --- resolution outcomes ----------------------------------------------------


def test_one_declared_label_matching_one_entry_is_linked() -> None:
    analysis = citations_of(tagged_citation_pdf())
    (citation,) = analysis["citations"]
    assert citation["resolutionStatus"] == "LINKED"
    (link,) = analysis["links"]
    assert link["linkStatus"] == "LINKED"
    assert link["linkMethod"] == "NUMERIC_LABEL"
    assert link["targetId"] == analysis["references"][0]["id"]


def test_a_label_no_entry_carries_is_unresolved() -> None:
    analysis = citations_of(
        tagged_citation_pdf(
            citations=("[7]",),
            entries=(("[1]", "Smith, J. (2020). Water rights."),),
        )
    )
    (citation,) = analysis["citations"]
    assert citation["resolutionStatus"] == "UNRESOLVED"
    (link,) = analysis["links"]
    assert link["linkStatus"] == "UNRESOLVED"
    # The method it tried is still named, and no target appears.
    assert link["linkMethod"] == "NUMERIC_LABEL"
    assert "targetId" not in link


def test_two_entries_sharing_a_label_are_ambiguous_and_stay_that_way() -> None:
    """PalCert names both and chooses neither.

    Choosing would be a coin toss recorded as a citation's target, and the
    document says nothing that decides between them.
    """
    analysis = citations_of(
        tagged_citation_pdf(
            citations=("[1]",),
            entries=(
                ("[1]", "Smith, J. (2020). Water rights."),
                ("[1]", "Khatib, A. (2019). Aquifers."),
            ),
        )
    )
    (citation,) = analysis["citations"]
    assert citation["resolutionStatus"] == "AMBIGUOUS"
    (link,) = analysis["links"]
    assert link["linkStatus"] == "AMBIGUOUS"
    assert link["candidateIds"] == ["r1", "r2"]
    assert link["candidateCount"] == 2
    assert "targetId" not in link
    # Neither entry is credited with the citation.
    assert [reference["citedByCount"] for reference in analysis["references"]] == [0, 0]


def test_a_citation_with_no_declared_label_is_never_attempted() -> None:
    """ "We did not look" is a different answer from "we looked and failed"."""
    analysis = citations_of(
        tagged_citation_pdf(
            citations=("(Smith et al., 2020)",),
            entries=(("[1]", "Smith, J. (2020). Water rights."),),
        )
    )
    (citation,) = analysis["citations"]
    assert citation["resolutionStatus"] == "NOT_ATTEMPTED"
    assert citation["targetCount"] == 0
    assert analysis["links"] == []


def test_a_citation_labelled_by_its_own_lbl_element_links_too() -> None:
    analysis = citations_of(tagged_citation_pdf(label_citations=True))
    (citation,) = analysis["citations"]
    assert citation["resolutionStatus"] == "LINKED"


# --- no confidence, ever ----------------------------------------------------


def test_pdf_text_evidence_carries_no_confidence() -> None:
    """A structure element is a declaration, not a graded answer.

    The contract's integrity pass rejects a confidence on anything that is not
    HEURISTIC, so this is belt and braces — and it is the property that keeps
    PDF evidence out of the "probably a citation" business entirely.
    """
    analysis = citations_of(tagged_citation_pdf())
    for observation in [*analysis["citations"], *analysis["references"]]:
        assert observation["sourceKind"] in {"PDF_TEXT", "PDF_LAYOUT"}
        assert "confidence" not in observation


def test_no_observation_anywhere_in_the_corpus_carries_confidence() -> None:
    for data in (tagged_citation_pdf(), simple_text_pdf(), scanned_pdf(), arabic_pdf()):
        analysis = citations_of(data)
        for observation in [*analysis["citations"], *analysis["references"]]:
            assert "confidence" not in observation


# --- nothing is invented ----------------------------------------------------


def test_an_untagged_page_that_looks_like_a_bibliography_yields_nothing() -> None:
    """The visual result is identical; only the declaration differs.

    A line reading "[1] Smith, J. (2020)." is a line of text. Calling it a
    reference entry would be PalCert asserting something the document never
    said, and a rule would then be checked against PalCert's guess.
    """
    analysis = citations_of(tagged_citation_pdf(tagged=False))
    assert analysis["citations"] == []
    assert analysis["references"] == []
    assert analysis["links"] == []
    assert coverage(analysis, "SEMANTIC_CITATIONS") == {
        "domain": "SEMANTIC_CITATIONS",
        "status": "UNAVAILABLE",
        "reasonCode": "NOT_IMPLEMENTED",
    }
    assert analysis["summary"]["referenceRegionObserved"] is False


def test_a_declaration_with_nothing_to_point_at_is_not_evidence() -> None:
    analysis = citations_of(tagged_citation_pdf(marks=False))
    assert analysis["citations"] == []
    assert analysis["references"] == []


def test_a_scanned_pdf_invents_no_citation_evidence() -> None:
    analysis = citations_of(scanned_pdf())
    assert analysis["citations"] == []
    assert analysis["references"] == []
    assert coverage(analysis, "SEMANTIC_CITATIONS")["reasonCode"] == "NO_TEXT_LAYER"
    assert coverage(analysis, "REFERENCE_REGION")["reasonCode"] == "NO_TEXT_LAYER"


def test_an_ordinary_document_reports_no_citations_without_claiming_none_exist() -> None:
    analysis = citations_of(simple_text_pdf())
    assert analysis["citations"] == []
    assert coverage(analysis, "SEMANTIC_CITATIONS")["status"] == "UNAVAILABLE"


# --- coverage tells the truth, per domain ----------------------------------


def test_the_native_domains_say_the_format_has_no_such_thing() -> None:
    """Not "we did not look" — a PDF has no Word source store to look in.

    Reported separately from the semantic domains so a missing capability
    never degrades one that is present.
    """
    analysis = citations_of(tagged_citation_pdf())
    for domain in (
        "NATIVE_CITATIONS",
        "NATIVE_BIBLIOGRAPHY_SOURCES",
        "NATIVE_SOURCE_RESOLUTION",
    ):
        assert coverage(analysis, domain) == {
            "domain": domain,
            "status": "UNAVAILABLE",
            "reasonCode": "FORMAT_HAS_NO_NATIVE_CITATIONS",
        }


def test_declared_citations_never_make_the_domain_complete() -> None:
    """PalCert sees what the author tagged, not necessarily every citation.

    A citation the author did not tag is invisible here, so the domain is
    never COMPLETE however many declarations were found.
    """
    analysis = citations_of(
        tagged_citation_pdf(
            citations=("[1]", "[2]"),
            entries=(("[1]", "Smith, J."), ("[2]", "Khatib, A.")),
        )
    )
    assert len(analysis["citations"]) == 2
    assert coverage(analysis, "SEMANTIC_CITATIONS") == {
        "domain": "SEMANTIC_CITATIONS",
        "status": "PARTIAL",
        "reasonCode": "SEMANTIC_CLASSIFICATION_NOT_EXHAUSTIVE",
    }
    assert coverage(analysis, "SEMANTIC_REFERENCE_ENTRIES")["status"] == "PARTIAL"


def test_a_missing_capability_does_not_degrade_a_present_one() -> None:
    """Text is readable and a region is proven, while the native domains are not.

    Four independent answers in one document, which is what keeps a scanned
    page from implying that link evidence failed, or the reverse.
    """
    analysis = citations_of(tagged_citation_pdf())
    assert coverage(analysis, "REFERENCE_REGION")["status"] == "COMPLETE"
    assert coverage(analysis, "SEMANTIC_CITATIONS")["status"] == "PARTIAL"
    assert coverage(analysis, "NATIVE_CITATIONS")["status"] == "UNAVAILABLE"
    statuses = {entry["status"] for entry in analysis["coverage"]}
    assert statuses == {"COMPLETE", "PARTIAL", "UNAVAILABLE"}


def test_the_reference_region_is_positive_only() -> None:
    absent = citations_of(simple_text_pdf())
    assert coverage(absent, "REFERENCE_REGION")["status"] == "UNAVAILABLE"
    assert absent["summary"]["referenceRegionObserved"] is False

    proven = citations_of(tagged_citation_pdf())
    assert coverage(proven, "REFERENCE_REGION")["status"] == "COMPLETE"
    assert proven["summary"]["referenceRegionObserved"] is True


# --- Arabic -----------------------------------------------------------------


def test_arabic_citation_evidence_survives_intact() -> None:
    analysis = citations_of(
        tagged_citation_pdf(
            citations=("[1]",),
            entries=(("[1]", "Al Khatib, A. (2019). Groundwater."),),
        )
    )
    assert analysis["references"][0]["rawText"].startswith("Al Khatib")
    # The existing Arabic corpus fixture has no structural citation
    # declaration, so it must yield none rather than a recognized one.
    assert citations_of(arabic_pdf())["citations"] == []


# --- no projection ----------------------------------------------------------


def test_only_the_storage_independent_properties_cross_into_the_fact_set() -> None:
    """Two of five, and the artifact keeps everything.

    A PDF may carry citations, entries, links, candidates and resolutions and
    project exactly the two properties whose contracts are about the document
    rather than about Word's storage: a reference region proven by structure,
    and whether a declared citation resolves to one declared entry.
    """
    artifact = analyzed(tagged_citation_pdf())
    assert artifact["citationAnalysis"]["citations"]

    properties = {fact["scope"].get("property") for fact in artifact["factSet"]["facts"]}
    assert PROJECTED.intersection(properties) == {
        "referenceRegionPresent",
        "citationTargetResolved",
    }
    # Nothing is ever projected about a rendered entry: its identity comes from
    # classification, and coverage cannot repair a wrong element identity.
    element_types = {fact["scope"].get("elementType") for fact in artifact["factSet"]["facts"]}
    assert "REFERENCE_ENTRY" not in element_types


def test_the_word_native_properties_stay_unsupported_for_pdf() -> None:
    """Three of the four are questions a PDF cannot be asked.

    Every Word CITATION field, Word-managed source records, a Word citation's
    tag matched against a Word source set: a PDF has none of those, so a
    confident zero would fail a compliant document for lacking something it
    cannot have.
    """
    from app.pdf.support import Format, Support, support_for

    for name in (
        "nativeCitationCount",
        "nativeBibliographySourceCount",
        "nativeSourceResolved",
    ):
        assert support_for(Format.PDF, name) is Support.UNSUPPORTED
    assert support_for(Format.PDF, "referenceRegionPresent") is Support.EXACT


# --- identity and determinism ----------------------------------------------


def test_the_pdf_analyzer_version_moved_with_the_envelope() -> None:
    """A stale PDF analysis must not be served where the evidence is expected.

    Reuse is decided by analyzer name and version. 1.0.0 carried no citation
    section at all; 2.0.0 carried one without internal-destination links;
    3.0.0 projected no citation fact; 4.0.0 projected the reference-region
    marker but not per-citation resolution; 5.0.0 read only what a tagged PDF
    declared, so an untagged one carried an empty citation graph; 6.0.0 read
    numbered reference lists heuristically and no author-year ones; 7.0.0 read
    both families and nothing inside an entry; 8.0.0 read inside an entry and
    nothing inside a citation. Every one of them produces a perfectly valid
    artifact, so nothing about reading one says it is stale — only this number
    does.
    """
    assert ANALYZER_VERSION == "11.0.0"
    assert ENVELOPE_SCHEMA_VERSION == 2
    artifact = analyzed(simple_text_pdf())
    assert artifact["analyzer"]["version"] == "11.0.0"
    assert artifact["analysisSchemaVersion"] == 2
    # The structural model did not change, and does not claim to have.
    assert artifact["structuralModel"]["analysisSchemaVersion"] == 1


def test_the_same_pdf_produces_the_same_citation_graph() -> None:
    data = tagged_citation_pdf(
        citations=("[1]", "[2]"),
        entries=(("[1]", "Smith, J."), ("[2]", "Khatib, A.")),
    )
    first = analyzed(data)["citationAnalysis"]
    second = analyzed(data)["citationAnalysis"]
    assert first == second


# --- the exact relationship Checkpoint 6 could not record -------------------


def test_a_declared_citation_links_to_a_declared_entry_by_internal_destination() -> None:
    """The gap Checkpoint 6 reported, closed and consumed.

    Both ends are the author's declaration: the annotation names its citation
    through /StructParent and the parent tree, and its /GoTo destination lands
    inside the extent of one declared entry. Neither end is resolved by
    proximity.
    """
    analysis = citations_of(internal_destination_pdf())
    (citation,) = analysis["citations"]
    assert citation["resolutionStatus"] == "LINKED"
    (link,) = analysis["links"]
    assert link == {
        "citationId": "c1",
        "linkMethod": "INTERNAL_DESTINATION",
        "candidateCount": 0,
        "linkStatus": "LINKED",
        "targetId": "r1",
    }


def test_a_structure_destination_names_its_entry_outright() -> None:
    """No coordinates and nothing to fall inside of: the exact form."""
    analysis = citations_of(internal_destination_pdf(destination="structure"))
    (link,) = analysis["links"]
    assert link["linkMethod"] == "INTERNAL_DESTINATION"
    assert link["linkStatus"] == "LINKED"
    assert link["targetId"] == "r1"


def test_an_internal_destination_is_never_labelled_numeric() -> None:
    """The method says how the target was established, and only that.

    The citation here carries no numeric label at all, so a NUMERIC_LABEL row
    would be a false statement about an attempt that never happened.
    """
    analysis = citations_of(internal_destination_pdf())
    assert [link["linkMethod"] for link in analysis["links"]] == ["INTERNAL_DESTINATION"]


def test_a_destination_landing_on_no_declared_entry_is_unresolved() -> None:
    """Not a guessed target, and not the nearest entry.

    The link exists and was attempted, so the row stays and names the method.
    What it does not do is pick the entry closest to where the destination
    landed.
    """
    for case in ("off-page", "whole-page", "none"):
        analysis = citations_of(internal_destination_pdf(destination=case))
        (citation,) = analysis["citations"]
        assert citation["resolutionStatus"] == "UNRESOLVED", case
        (link,) = analysis["links"]
        assert link["linkStatus"] == "UNRESOLVED"
        assert link["linkMethod"] == "INTERNAL_DESTINATION"
        assert "targetId" not in link


def test_a_destination_landing_on_two_declared_entries_is_ambiguous() -> None:
    analysis = citations_of(
        internal_destination_pdf(
            entries=(("[1]", "Smith, J. (2020)."), ("[2]", "Khatib, A. (2019).")),
            destination="first-entry",
            overlapping_entries=True,
        )
    )
    (citation,) = analysis["citations"]
    assert citation["resolutionStatus"] == "AMBIGUOUS"
    (link,) = analysis["links"]
    assert link["linkStatus"] == "AMBIGUOUS"
    assert link["candidateIds"] == ["r1", "r2"]
    assert "targetId" not in link


def test_an_annotation_that_names_no_citation_is_not_consumed() -> None:
    """Without /StructParent there is no exact way to say whose it is.

    The alternative would be deciding from where the annotation sits on the
    page, which is the guessing this refuses. The annotation is dropped and
    the citation stays NOT_ATTEMPTED rather than gaining a relationship
    PalCert inferred.
    """
    analysis = citations_of(internal_destination_pdf(bind_annotation=False))
    (citation,) = analysis["citations"]
    assert citation["resolutionStatus"] == "NOT_ATTEMPTED"
    assert analysis["links"] == []


def test_no_relationship_is_created_from_text_or_layout_proximity() -> None:
    """A tagged document with no link annotation at all.

    The citation and the entry sit on the same page, a few inches apart, and
    nothing connects them. Proximity is not evidence.
    """
    analysis = citations_of(
        tagged_citation_pdf(
            citations=("(Smith et al., 2020)",),
            entries=(("[1]", "Smith, J. (2020). Water rights."),),
        )
    )
    assert analysis["links"] == []
    assert analysis["citations"][0]["resolutionStatus"] == "NOT_ATTEMPTED"


# --- two exact methods at once ---------------------------------------------


def test_numeric_label_behaviour_is_unchanged() -> None:
    """Checkpoint 6's method still does exactly what it did."""
    analysis = citations_of(tagged_citation_pdf())
    (link,) = analysis["links"]
    assert link["linkMethod"] == "NUMERIC_LABEL"
    assert link["linkStatus"] == "LINKED"
    assert link["targetId"] == "r1"


def test_two_methods_agreeing_keep_both_rows_and_one_target() -> None:
    """Evidence survives rather than being collapsed into one answer.

    Two rows, one per method, both LINKED to the entry both of them found.
    The contract's own precedence then reads the citation as LINKED.
    """
    analysis = citations_of(
        internal_destination_pdf(
            entries=(("[1]", "Smith, J. (2020)."), ("[2]", "Khatib, A. (2019).")),
            citation_marker="[1]",
            destination="first-entry",
        )
    )
    (citation,) = analysis["citations"]
    assert citation["resolutionStatus"] == "LINKED"
    assert citation["targetCount"] == 2
    assert [
        (link["linkMethod"], link["linkStatus"], link["targetId"]) for link in analysis["links"]
    ] == [
        ("NUMERIC_LABEL", "LINKED", "r1"),
        ("INTERNAL_DESTINATION", "LINKED", "r1"),
    ]


def test_two_methods_disagreeing_become_ambiguity_rather_than_a_choice() -> None:
    """Disagreement is never hidden and never resolved by precedence.

    The label says one entry, the destination says another. Both are exact and
    the document does not say which is meant, so both rows become AMBIGUOUS
    over the union — rather than one method being declared more believable.
    """
    analysis = citations_of(
        internal_destination_pdf(
            entries=(("[1]", "Smith, J. (2020)."), ("[2]", "Khatib, A. (2019).")),
            citation_marker="[1]",
            destination="second-entry",
        )
    )
    (citation,) = analysis["citations"]
    assert citation["resolutionStatus"] == "AMBIGUOUS"
    for link in analysis["links"]:
        assert link["linkStatus"] == "AMBIGUOUS"
        assert link["candidateIds"] == ["r1", "r2"]
        assert "targetId" not in link
    assert [link["linkMethod"] for link in analysis["links"]] == [
        "NUMERIC_LABEL",
        "INTERNAL_DESTINATION",
    ]
    # Neither entry is credited, because neither was chosen.
    assert [reference["citedByCount"] for reference in analysis["references"]] == [0, 0]


def test_a_document_with_both_kinds_of_evidence_is_deterministic() -> None:
    data = internal_destination_pdf(
        entries=(("[1]", "Smith, J. (2020)."), ("[2]", "Khatib, A. (2019).")),
        citation_marker="[1]",
        destination="second-entry",
    )
    assert analyzed(data)["citationAnalysis"] == analyzed(data)["citationAnalysis"]


def test_internal_destination_evidence_carries_no_confidence() -> None:
    analysis = citations_of(internal_destination_pdf())
    for observation in [*analysis["citations"], *analysis["references"]]:
        assert "confidence" not in observation


def test_a_resolved_link_projects_the_target_property_not_the_native_one() -> None:
    """The resolution is exact, and it is carried by the property that means it.

    ``nativeSourceResolved`` means a Word citation's tag matching a Word
    source record. A PDF citation resolving to a rendered entry is a different
    relationship, and widening that property to cover it would redefine what
    it already promises for DOCX. Checkpoint 9 gave the relationship its own
    property instead.
    """
    artifact = analyzed(internal_destination_pdf())
    assert artifact["citationAnalysis"]["links"][0]["linkStatus"] == "LINKED"
    properties = {fact["scope"].get("property") for fact in artifact["factSet"]["facts"]}
    assert "nativeSourceResolved" not in properties
    assert "citationTargetResolved" in properties


def test_internal_destination_does_not_upgrade_semantic_coverage() -> None:
    """Understanding the links says nothing about whether tagging was complete.

    A citation the author did not tag is still invisible, so the domain is
    still PARTIAL however well the declared ones resolve.
    """
    analysis = citations_of(internal_destination_pdf())
    assert coverage(analysis, "SEMANTIC_CITATIONS") == {
        "domain": "SEMANTIC_CITATIONS",
        "status": "PARTIAL",
        "reasonCode": "SEMANTIC_CLASSIFICATION_NOT_EXHAUSTIVE",
    }
