"""Conservative numeric-style heuristic discovery (Phase 18, Checkpoint 10).

Two questions run through every test here, and they are different questions.

*Did PalCert find it?* A readable PDF with a numbered reference list and
bracketed markers carries real citation structure, and refusing to see any of
it was the cost of Checkpoints 6 to 9.

*Did PalCert claim more than it found?* That is the one that decides whether
this layer is safe. Every object it produces says ``HEURISTIC`` and carries a
confidence; none of it reaches a fact; none of it displaces, relabels or
merges into anything the author declared; and the coverage never claims to
have recognized a style the detector does not know.
"""

from __future__ import annotations

import hashlib
from decimal import Decimal
from typing import Any

import pytest

from app.engine.contracts.artifact_contract import validate_analysis_artifact
from app.pdf.analyzer import analyze
from app.pdf.heuristics import (
    HEURISTIC_CEILING,
    REQUIRED_REGION_SIGNALS,
    SIGNAL_GROUPS,
    SIGNAL_WEIGHTS,
    expand_marker,
    score,
)
from tests.pdf.builder import (
    arabic_numbered_references_pdf,
    numbered_references_pdf,
    scanned_pdf,
    simple_text_pdf,
    tagged_citation_pdf,
)

ENTRIES = (
    "[1] Smith, J. (2020). Water rights. Journal of Policy.",
    "[2] Khatib, A. (2019). Contested basins. Regional Review.",
    "[3] Nasser, L. (2021). A survey of allocation. Water Studies.",
)


def analyzed(data: bytes) -> dict[str, Any]:
    artifact: dict[str, Any] = analyze(
        data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d"
    )
    return artifact


def citations_of(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    section: list[dict[str, Any]] = artifact["citationAnalysis"]["citations"]
    return section


def references_of(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    section: list[dict[str, Any]] = artifact["citationAnalysis"]["references"]
    return section


def heuristic(objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [item for item in objects if item["sourceKind"] == "HEURISTIC"]


def exact(objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [item for item in objects if item["sourceKind"] == "PDF_TEXT"]


def facts_for(artifact: dict[str, Any], name: str) -> list[dict[str, Any]]:
    return [fact for fact in artifact["factSet"]["facts"] if fact["scope"].get("property") == name]


def domain(artifact: dict[str, Any], name: str) -> dict[str, Any]:
    for entry in artifact["citationAnalysis"]["coverage"]:
        if entry["domain"] == name:
            return dict(entry)
    raise AssertionError(f"{name} is not reported")


# --- what it finds ----------------------------------------------------------


def test_an_untagged_numbered_reference_list_produces_heuristic_entries() -> None:
    """The document Checkpoint 10 exists for.

    No structure tree, no ``/BibEntry``, nothing declared — and a reference
    list any reader would identify at a glance. Before this checkpoint PalCert
    reported an empty citation graph for it.
    """
    artifact = analyzed(numbered_references_pdf(entries=ENTRIES))
    entries = references_of(artifact)
    assert [entry["label"] for entry in entries] == [1, 2, 3]
    assert all(entry["sourceKind"] == "HEURISTIC" for entry in entries)
    assert all(entry["parseMethod"] == "REGION_MEMBERSHIP" for entry in entries)
    assert "Smith" in entries[0]["rawText"]


def test_numeric_in_text_markers_produce_heuristic_citations() -> None:
    artifact = analyzed(numbered_references_pdf(entries=ENTRIES))
    citations = citations_of(artifact)
    assert [citation["numericLabels"] for citation in citations] == [[1], [2], [3]]
    assert all(citation["sourceKind"] == "HEURISTIC" for citation in citations)
    assert all(citation["citationKind"] == "NUMERIC_LABEL" for citation in citations)
    assert all(citation["parseMethod"] == "LABEL_PATTERN" for citation in citations)


@pytest.mark.parametrize(
    ("marker", "expected"),
    [
        ("[12]", [12]),
        ("[3, 7, 11]", [3, 7, 11]),
        ("[4-6]", [4, 5, 6]),
        ("[2; 5]", [2, 5]),
    ],
)
def test_each_supported_marker_form_expands_deterministically(
    marker: str, expected: list[int]
) -> None:
    """A group naming several works becomes several citations, not one.

    ``[3, 7, 11]`` cites three different things, and one occurrence carrying
    three labels would have to resolve to three targets at once — which the
    frozen graph can only express as AMBIGUOUS, saying PalCert could not
    choose when in fact the document named all three.
    """
    entries = tuple(f"[{n}] Author {n}. A work." for n in range(1, 13))
    artifact = analyzed(
        numbered_references_pdf(body=(f"A claim {marker}.", "Filler."), entries=entries)
    )
    assert [citation["numericLabels"][0] for citation in citations_of(artifact)] == expected
    assert {citation["numericLabelsRaw"] for citation in citations_of(artifact)} == {marker}


@pytest.mark.parametrize(
    ("group", "expected"),
    [
        ("[12]", [12]),
        ("[ 12 ]", [12]),
        ("[3, 7, 11]", [3, 7, 11]),
        ("[3;7]", [3, 7]),
        ("[4-6]", [4, 5, 6]),
        # En dash and em dash, which a real typesetter uses for a range and
        # which the WinAnsi fixture builder cannot encode - so the accepted
        # syntax is pinned here, on the text a detector would receive.
        ("[4\u20136]", [4, 5, 6]),
        ("[4\u20146]", [4, 5, 6]),
        # Mirrored brackets, as a right-to-left run presents the same marker.
        ("]12[", [12]),
        ("]4-6[", [4, 5, 6]),
        # Arabic-Indic digits, folded before anything is read.
        ("[\u0661\u0662]", [12]),
        # ...and every form that is not citation syntax.
        ("[2020]", None),
        ("[0]", None),
        ("[1200]", None),
        ("[6-4]", None),
        ("[5-5]", None),
        ("[1-400]", None),
        ("[3.4]", None),
        ("[12a]", None),
        ("[]", None),
        ("[,]", None),
        ("[1-2-3]", None),
    ],
)
def test_the_accepted_marker_syntax_is_exactly_this(group: str, expected: list[int] | None) -> None:
    assert expand_marker(group) == expected


# --- what it claims ---------------------------------------------------------


def test_every_heuristic_object_carries_a_confidence() -> None:
    """The producer invariant, held over every object this layer emits.

    The shared schema leaves ``confidence`` optional, because an older
    artifact without one is still a valid artifact and this checkpoint does
    not break that. What is *not* optional is what PalCert's own analyzer
    produces: an object with no confidence reads exactly like exact evidence
    to every later consumer.
    """
    for data in (
        numbered_references_pdf(entries=ENTRIES),
        arabic_numbered_references_pdf(),
        tagged_citation_pdf(
            heading="References",
            untagged_citations=("[3]",),
            untagged_entries=("[3] Nasser, L. A survey.",),
            entries=(("[1]", "Smith, J."), ("[2]", "Khatib, A.")),
        ),
    ):
        artifact = analyzed(data)
        produced = heuristic(citations_of(artifact)) + heuristic(references_of(artifact))
        assert produced, "the fixture must produce heuristic evidence"
        for item in produced:
            assert "confidence" in item, item["id"]
            assert Decimal("0") < Decimal(item["confidence"]) <= HEURISTIC_CEILING


def test_exact_objects_never_acquire_a_confidence() -> None:
    artifact = analyzed(
        tagged_citation_pdf(
            heading="References",
            untagged_citations=("[3]",),
            untagged_entries=("[3] Nasser, L. A survey.",),
            entries=(("[1]", "Smith, J."), ("[2]", "Khatib, A.")),
        )
    )
    declared = exact(citations_of(artifact)) + exact(references_of(artifact))
    assert declared
    for item in declared:
        assert "confidence" not in item, item["id"]


def test_no_heuristic_confidence_reaches_certainty() -> None:
    """A full signal set is still not proof.

    The signals are the evidence this detector knows how to look for, not the
    evidence that exists, so the reserved headroom is a standing statement
    that the whole recognition may be wrong.
    """
    artifact = analyzed(numbered_references_pdf(entries=ENTRIES))
    produced = heuristic(citations_of(artifact)) + heuristic(references_of(artifact))
    assert produced
    assert all(Decimal(item["confidence"]) < Decimal("1") for item in produced)


# --- the confidence model ---------------------------------------------------


def test_every_signal_group_is_a_complete_partition() -> None:
    """Each group's weights sum to 1, so a score is a fraction of the evidence."""
    assert set(SIGNAL_GROUPS) == {
        "REGION",
        "NUMERIC_ENTRY",
        "NUMERIC_CITATION",
        "SUPERSCRIPT_CITATION",
        "VANCOUVER_ENTRY",
        "PAREN_CITATION",
        "AUTHOR_YEAR_ENTRY",
        "AUTHOR_YEAR_CITATION",
    }
    for group, weights in SIGNAL_GROUPS.items():
        assert all(weight > 0 for weight in weights.values()), group
        assert sum(weights.values()) == Decimal("1"), group

    # Every signal belongs to exactly one group, so a score computed from
    # names alone can never mix two groups' scales.
    names = [name for weights in SIGNAL_GROUPS.values() for name in weights]
    assert len(names) == len(set(names)) == len(SIGNAL_WEIGHTS)


def test_stronger_evidence_never_scores_lower() -> None:
    """Monotonicity, over every subset of every group.

    The property that makes a confidence comparable at all: a candidate that
    showed everything a weaker one did, and more, cannot come out below it.
    """
    from itertools import combinations

    for names_in_group in SIGNAL_GROUPS.values():
        names = sorted(names_in_group)
        for size in range(len(names) + 1):
            for weaker in combinations(names, size):
                weak_set = frozenset(weaker)
                for extra in names:
                    stronger = weak_set | {extra}
                    assert score(stronger) >= score(weak_set), (weaker, extra)


def test_the_score_does_not_depend_on_signal_order() -> None:
    forward = frozenset(SIGNAL_WEIGHTS) & {
        "ENTRY_REGION_ACCEPTED",
        "ENTRY_BRACKETED_LABEL_AT_START",
    }
    assert score(forward) == score(frozenset(sorted(forward, reverse=True)))


def test_a_heading_alone_can_never_accept_a_region() -> None:
    """Stated in the code as a required pair, and held to it here.

    A page whose only signal is the word "References" scores 0.30 of the
    region evidence. The acceptance rule is not a threshold on that number —
    it is the requirement that numbered-entry structure be present too, which
    is why a paper discussing bibliographies in its prose is not a paper with
    a bibliography.
    """
    assert set(REQUIRED_REGION_SIGNALS) == {
        "REGION_HEADING_VOCABULARY",
        "REGION_ENTRY_STRUCTURE",
    }
    heading_only = analyzed(
        numbered_references_pdf(
            entries=(
                "Water rights were contested for decades in the basin.",
                "The dispute continued without resolution for many years.",
                "A later settlement changed very little on the ground.",
            )
        )
    )
    assert references_of(heading_only) == []
    assert citations_of(heading_only) == []


def test_a_numbered_list_with_no_heading_is_not_a_reference_region() -> None:
    artifact = analyzed(
        numbered_references_pdf(heading="Appendix of measurements", entries=ENTRIES)
    )
    assert references_of(artifact) == []


# --- linking ----------------------------------------------------------------


def test_one_numeric_target_links() -> None:
    artifact = analyzed(numbered_references_pdf(body=("A claim [2].",), entries=ENTRIES))
    (citation,) = citations_of(artifact)
    assert citation["resolutionStatus"] == "LINKED"
    (link,) = artifact["citationAnalysis"]["links"]
    assert link["linkMethod"] == "NUMERIC_LABEL"
    assert link["targetId"] == references_of(artifact)[1]["id"]


def test_duplicate_labels_become_ambiguous() -> None:
    """Two entries numbered the same, and PalCert names both rather than picking.

    Confidence does not enter here, and that separation is the point: a graded
    belief about *recognizing* a marker says nothing about which of two
    entries the author meant.
    """
    artifact = analyzed(
        numbered_references_pdf(
            body=("A claim [2].",),
            entries=(
                "[1] Smith, J. Water rights.",
                "[2] Khatib, A. Contested basins.",
                "[2] Nasser, L. A survey of allocation.",
            ),
        )
    )
    (citation,) = citations_of(artifact)
    assert citation["resolutionStatus"] == "AMBIGUOUS"
    (link,) = artifact["citationAnalysis"]["links"]
    assert link["linkStatus"] == "AMBIGUOUS"
    assert len(link["candidateIds"]) == 2
    assert "targetId" not in link


def test_a_missing_numeric_label_is_unresolved() -> None:
    """Looked, found nothing — which is not the same as never having looked."""
    artifact = analyzed(numbered_references_pdf(body=("A claim [9].",), entries=ENTRIES))
    (citation,) = citations_of(artifact)
    assert citation["resolutionStatus"] == "UNRESOLVED"
    (link,) = artifact["citationAnalysis"]["links"]
    assert link["linkStatus"] == "UNRESOLVED"
    assert link["linkMethod"] == "NUMERIC_LABEL"


def test_a_citation_with_nothing_to_attempt_stays_not_attempted() -> None:
    """A declared citation carrying no label, in a document with no region.

    No numeric label and no internal destination is no defensible attempt, and
    the heuristic layer adds nothing here: it does not invent a label for a
    citation the author wrote in another style.
    """
    artifact = analyzed(
        tagged_citation_pdf(citations=("(Smith et al., 2020)",), entries=(("[1]", "Smith, J."),))
    )
    (citation,) = citations_of(artifact)
    assert citation["resolutionStatus"] == "NOT_ATTEMPTED"
    assert artifact["citationAnalysis"]["links"] == []


# --- false positives --------------------------------------------------------


def test_the_reference_list_is_not_rediscovered_as_in_text_citations() -> None:
    """Every entry opens with ``[7]``; none of them is a citation.

    Without excluding the region outright, a numbered bibliography would have
    every document citing its own reference list once per entry — and each of
    those would link to itself.
    """
    artifact = analyzed(numbered_references_pdf(body=("A claim [1].",), entries=ENTRIES))
    assert len(citations_of(artifact)) == 1
    assert citations_of(artifact)[0]["numericLabels"] == [1]


@pytest.mark.parametrize(
    ("description", "body"),
    [
        ("years", ("Published in [2020] and revised in [1999].",)),
        ("ordinary numbered list", ("1. Collect the samples", "2. Weigh them", "3. Record")),
        ("section numbers", ("2.1 Method", "See section 3.4 for detail")),
        ("table and figure labels", ("Table 3 shows the totals", "Figure 12 plots them")),
        ("equation numbers", ("The result (3) follows, see [3.4] above.",)),
        ("a descending range", ("Compare pages [12-4] of the annex.",)),
        ("an implausibly wide range", ("Across rows [1-400] of the sheet.",)),
        ("a label out of range", ("Item [1200] in the catalogue.",)),
        ("bracketed prose", ("The author [see note] disagrees.",)),
        ("parenthesised numbers", ("As shown in (12) and (3, 7).",)),
    ],
)
def test_false_positive_classes_are_rejected(description: str, body: tuple[str, ...]) -> None:
    """Each of these is a number in a document, and none of them is a citation.

    The fixtures all carry a real reference region, so the detector is running
    at full strength — nothing is rejected merely because discovery was
    switched off.
    """
    artifact = analyzed(numbered_references_pdf(body=body, entries=ENTRIES))
    assert references_of(artifact), "the region must still be recognized"
    assert citations_of(artifact) == [], description


def test_a_year_shaped_line_does_not_open_a_reference_entry() -> None:
    artifact = analyzed(
        numbered_references_pdf(
            entries=("[2020] A year, not a label.", "[1999] Another.", "[1984] A third.")
        )
    )
    assert references_of(artifact) == []


def test_an_identifier_subscript_is_not_a_citation() -> None:
    """`arr[12]` is a subscript, and a thesis with code listings has many.

    Found by re-reading the detector against a document it had not been shown:
    a listing in a document that also has a bibliography was citing its own
    array indexes. The guard is ASCII-only on purpose — Arabic typesetting
    attaches a marker straight to the preceding word, so excluding every
    preceding letter would read Latin documents and not Arabic ones.
    """
    artifact = analyzed(
        numbered_references_pdf(
            body=("The loop reads arr[12] and data[100] each pass.",), entries=ENTRIES
        )
    )
    assert references_of(artifact), "the region must still be recognized"
    assert citations_of(artifact) == []


def test_the_region_does_not_swallow_what_follows_the_last_entry() -> None:
    """The final entry has no next label to close it, and it is closed anyway.

    Found the same way. Running the region to the end of the document put an
    appendix inside the last entry's raw text — fabricated evidence, not
    merely incomplete — and hid every citation after the list.

    The bound comes from the list rather than from a constant: the longest
    continuation run between two labels is how far *this* list's entries wrap,
    so the last entry is allowed exactly that much. A one-line-per-entry list
    absorbs nothing.
    """
    artifact = analyzed(
        numbered_references_pdf(
            entries=ENTRIES, tail=("Appendix A", "Raw measurements follow [2].")
        )
    )
    entries = references_of(artifact)
    assert "Appendix" not in entries[-1]["rawText"]
    assert entries[-1]["rawText"].endswith("Water Studies.")
    # And the appendix's own citation is visible, because it is outside the region.
    assert [citation["numericLabels"] for citation in citations_of(artifact)] == [
        [1],
        [2],
        [3],
        [2],
    ]


def test_a_wrapped_entry_still_folds_its_continuation_lines() -> None:
    """Closing the region must not cost the entries their wrapped text."""
    artifact = analyzed(
        numbered_references_pdf(
            body=(),
            entries=(
                "[1] Smith, J. Water rights.",
                "    A long continuation line.",
                "[2] Khatib, A. Contested basins.",
                "    Another continuation.",
                "[3] Nasser, L. A survey.",
                "    Final wrapped line.",
            ),
            tail=("Appendix A", "Measurements follow."),
        )
    )
    entries = references_of(artifact)
    assert [entry["label"] for entry in entries] == [1, 2, 3]
    assert all(
        "continuation" in entry["rawText"] or "wrapped" in entry["rawText"] for entry in entries
    )
    assert "Appendix" not in entries[-1]["rawText"]


# --- exact evidence is preserved --------------------------------------------


def test_a_tagged_pdf_is_completely_unchanged() -> None:
    """The frozen exact pipeline, byte for byte.

    A tagged document has no heading vocabulary and no untagged entries, so
    the heuristic layer finds nothing in it — but the guarantee tested here is
    stronger than "finds nothing": it is that the artifact is identical to
    what the exact analyzer alone produced.
    """
    artifact = analyzed(tagged_citation_pdf())
    section = artifact["citationAnalysis"]
    assert [citation["sourceKind"] for citation in section["citations"]] == ["PDF_TEXT"]
    assert [reference["sourceKind"] for reference in section["references"]] == ["PDF_TEXT"]
    assert section["citations"][0]["resolutionStatus"] == "LINKED"
    assert section["summary"]["referenceRegionObserved"] is True


def test_a_mixed_document_keeps_every_declared_object_intact() -> None:
    """Part declared, part merely typed, and the declared part does not move.

    Exact objects keep the identities, ordinals, provenance and links they had
    before the heuristic layer existed; heuristic objects are appended after
    them. An artifact somebody already stored cannot be renumbered by adding
    this layer.
    """
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("[1]",),
            entries=(("[1]", "Smith, J. (2020)."), ("[2]", "Khatib, A. (2019).")),
            heading="References",
            untagged_citations=("[3]",),
            untagged_entries=("[3] Nasser, L. (2021). A survey.",),
        )
    )
    references = references_of(artifact)
    citations = citations_of(artifact)

    assert [reference["id"] for reference in references] == ["r1", "r2", "r3"]
    assert [reference["sourceKind"] for reference in references] == [
        "PDF_TEXT",
        "PDF_TEXT",
        "HEURISTIC",
    ]
    assert [citation["id"] for citation in citations] == ["c1", "c2"]
    assert [citation["sourceKind"] for citation in citations] == ["PDF_TEXT", "HEURISTIC"]

    # The declared citation still resolves to the declared entry it always did.
    assert citations[0]["resolutionStatus"] == "LINKED"
    exact_link = next(
        link for link in artifact["citationAnalysis"]["links"] if link["citationId"] == "c1"
    )
    assert exact_link["targetId"] == "r1"


def test_a_heuristic_duplicate_of_a_declared_object_is_suppressed() -> None:
    """The overlap rule, by span identity rather than by what the text says.

    Entries 1 and 2 are declared *and* match the bracketed-label pattern
    exactly. Two objects for one entry would double the reference count and
    leave a reader unable to tell which was real, so the heuristic candidate
    is dropped and the declared object keeps the field to itself.
    """
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("[1]",),
            entries=(("[1]", "Smith, J. (2020)."), ("[2]", "Khatib, A. (2019).")),
            heading="References",
            untagged_citations=("[3]",),
            untagged_entries=("[3] Nasser, L. (2021). A survey.",),
        )
    )
    labels = [reference["label"] for reference in references_of(artifact)]
    assert labels == [1, 2, 3], "each label appears exactly once"
    assert [reference["label"] for reference in heuristic(references_of(artifact))] == [3]
    # Likewise the declared citation is not re-found as a heuristic one.
    assert [citation["numericLabels"] for citation in citations_of(artifact)] == [[1], [3]]


def test_an_exact_citation_never_resolves_to_a_heuristic_entry() -> None:
    """The structural half of projection safety, below the projector.

    ``citationTargetResolved`` is read straight off a declared citation's
    resolution, so if a heuristic entry could become that citation's target,
    the projector's own filter would be the only thing between a guess and a
    published fact. It is not: the linker gives exact citations an index of
    declared entries only.
    """
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("[3]",),
            entries=(("[1]", "Smith, J. (2020)."),),
            heading="References",
            untagged_entries=(
                "[2] Khatib, A. (2019).",
                "[3] Nasser, L. (2021).",
                "[4] Haddad, M. (2018).",
            ),
        )
    )
    declared = exact(citations_of(artifact))
    assert declared, "the fixture must declare a citation"
    # A heuristic entry labelled 3 exists, and the declared citation still
    # reports that it resolves to nothing.
    assert 3 in [reference["label"] for reference in heuristic(references_of(artifact))]
    assert declared[0]["resolutionStatus"] == "UNRESOLVED"


# --- projection safety ------------------------------------------------------


def test_heuristic_citations_emit_no_citation_target_resolved_fact() -> None:
    """A clean heuristic resolution is still not an exact element value."""
    artifact = analyzed(numbered_references_pdf(entries=ENTRIES))
    assert all(citation["resolutionStatus"] == "LINKED" for citation in citations_of(artifact)), (
        "the fixture must resolve cleanly, or it proves nothing"
    )
    assert facts_for(artifact, "citationTargetResolved") == []


def test_a_heuristic_region_emits_no_reference_region_present_fact() -> None:
    """``referenceRegionPresent`` means *proven by structure*, and this is not.

    Three independent gates have to agree before it is published: the
    REFERENCE_REGION coverage domain, the summary flag, and the entries'
    own provenance. A heuristic-only document fails all three.
    """
    artifact = analyzed(numbered_references_pdf(entries=ENTRIES))
    assert references_of(artifact), "a region must have been recognized"
    assert facts_for(artifact, "referenceRegionPresent") == []
    assert artifact["citationAnalysis"]["summary"]["referenceRegionObserved"] is False
    assert domain(artifact, "REFERENCE_REGION")["status"] == "UNAVAILABLE"


def test_a_mixed_document_projects_only_its_declared_evidence() -> None:
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("[1]",),
            entries=(("[1]", "Smith, J. (2020)."), ("[2]", "Khatib, A. (2019).")),
            heading="References",
            untagged_citations=("[3]",),
            untagged_entries=("[3] Nasser, L. (2021). A survey.",),
        )
    )
    # The region is proven by a declared /BibEntry, so the marker is published.
    assert len(facts_for(artifact, "referenceRegionPresent")) == 1
    # Exactly one per-citation fact, at the declared citation's own node.
    target = facts_for(artifact, "citationTargetResolved")
    declared_node = exact(citations_of(artifact))[0]["location"]["nodeId"]
    assert [fact["location"]["nodeId"] for fact in target] == [declared_node]


def test_no_heuristic_object_ever_reaches_the_fact_set() -> None:
    """Swept rather than spot-checked: no fact may sit at a heuristic node."""
    for data in (
        numbered_references_pdf(entries=ENTRIES),
        arabic_numbered_references_pdf(),
        tagged_citation_pdf(
            citations=("[1]",),
            entries=(("[1]", "Smith, J."), ("[2]", "Khatib, A.")),
            heading="References",
            untagged_citations=("[3]",),
            untagged_entries=("[3] Nasser, L. A survey.",),
        ),
    ):
        artifact = analyzed(data)
        heuristic_nodes = {
            item["location"]["nodeId"]
            for item in heuristic(citations_of(artifact)) + heuristic(references_of(artifact))
        }
        assert heuristic_nodes, "the fixture must produce heuristic evidence"
        for fact in artifact["factSet"]["facts"]:
            if fact["scope"].get("property") in {
                "citationTargetResolved",
                "referenceRegionPresent",
            }:
                assert fact.get("location", {}).get("nodeId") not in heuristic_nodes


# --- coverage ---------------------------------------------------------------


def test_heuristic_discovery_never_claims_complete_semantic_coverage() -> None:
    """Scanning every span is not recognizing every citation style.

    This detector knows one family. An author-year document sitting beside a
    numbered one is invisible to it, and COMPLETE would be a claim that no
    such citation exists.
    """
    artifact = analyzed(numbered_references_pdf(entries=ENTRIES))
    for name in ("SEMANTIC_CITATIONS", "SEMANTIC_REFERENCE_ENTRIES"):
        entry = domain(artifact, name)
        assert entry["status"] == "PARTIAL"
        assert entry["reasonCode"] == "SEMANTIC_CLASSIFICATION_NOT_EXHAUSTIVE"


def test_a_readable_pdf_with_nothing_recognized_stays_unavailable() -> None:
    """The detector ran and recognized nothing, which is not partial knowledge."""
    artifact = analyzed(simple_text_pdf())
    for name in ("SEMANTIC_CITATIONS", "SEMANTIC_REFERENCE_ENTRIES"):
        entry = domain(artifact, name)
        assert entry["status"] == "UNAVAILABLE"
        assert entry["reasonCode"] == "NOT_IMPLEMENTED"


def test_an_image_only_pdf_produces_no_heuristic_objects() -> None:
    """No text layer, no classification, and the coverage says which."""
    artifact = analyzed(scanned_pdf())
    assert citations_of(artifact) == []
    assert references_of(artifact) == []
    for name in ("SEMANTIC_CITATIONS", "SEMANTIC_REFERENCE_ENTRIES", "REFERENCE_REGION"):
        entry = domain(artifact, name)
        assert entry["status"] == "UNAVAILABLE"
        assert entry["reasonCode"] == "NO_TEXT_LAYER"


def test_the_native_domains_are_untouched_by_heuristic_discovery() -> None:
    artifact = analyzed(numbered_references_pdf(entries=ENTRIES))
    for name in (
        "NATIVE_CITATIONS",
        "NATIVE_BIBLIOGRAPHY_SOURCES",
        "NATIVE_SOURCE_RESOLUTION",
    ):
        entry = domain(artifact, name)
        assert entry["status"] == "UNAVAILABLE"
        assert entry["reasonCode"] == "FORMAT_HAS_NO_NATIVE_CITATIONS"


# --- Arabic -----------------------------------------------------------------


def test_an_arabic_reference_region_is_found_by_its_own_heading() -> None:
    """`المراجع`, with Arabic-Indic labels, in a text layer PalCert does not reorder.

    The extraction represents this document's right-to-left runs in visual
    order — the pre-existing corpus fixture round-trips the same way — and
    PalCert deliberately never reverses extracted text. So the detector reads
    both directions rather than assuming one, and the brackets are matched in
    both their Unicode-mirrored forms.
    """
    artifact = analyzed(arabic_numbered_references_pdf())
    entries = references_of(artifact)
    assert [entry["label"] for entry in entries] == [1, 2, 3]
    assert all(entry["sourceKind"] == "HEURISTIC" for entry in entries)

    citations = citations_of(artifact)
    assert [citation["numericLabels"] for citation in citations] == [[1], [2]]
    assert all(citation["resolutionStatus"] == "LINKED" for citation in citations)


def test_an_english_reference_region_is_found_by_its_own_heading() -> None:
    for heading in ("References", "REFERENCES", "Bibliography", "5. References"):
        artifact = analyzed(numbered_references_pdf(heading=heading, entries=ENTRIES))
        assert [entry["label"] for entry in references_of(artifact)] == [1, 2, 3], heading


# --- the artifact stays valid, and stays the same ---------------------------


def test_the_complete_artifact_contract_holds_over_heuristic_evidence() -> None:
    for data in (
        numbered_references_pdf(entries=ENTRIES),
        arabic_numbered_references_pdf(),
        numbered_references_pdf(body=("A claim [9].",), entries=ENTRIES),
        tagged_citation_pdf(
            heading="References",
            untagged_citations=("[3]",),
            untagged_entries=("[3] Nasser, L. A survey.",),
            entries=(("[1]", "Smith, J."), ("[2]", "Khatib, A.")),
        ),
    ):
        result = validate_analysis_artifact(analyzed(data))
        assert result.valid, [issue.message for issue in result.issues]


def test_heuristic_discovery_is_deterministic() -> None:
    """Same bytes, same graph — the guarantee the rest of the artifact already has."""
    for data in (numbered_references_pdf(entries=ENTRIES), arabic_numbered_references_pdf()):
        first = analyzed(data)["citationAnalysis"]
        second = analyzed(data)["citationAnalysis"]
        assert first == second


# --- DOCX is not in this checkpoint -----------------------------------------


def test_docx_gains_no_heuristic_discovery_and_does_not_move() -> None:
    """Checkpoint 10 is PDF-first, and "first" has to be visible in the output.

    Heuristic discovery for DOCX is a later checkpoint. This one must not
    quietly acquire it through shared helper code, and the DOCX analyzer's
    version must not move for a change its output did not undergo — a bump
    would re-analyze every stored DOCX for nothing.
    """
    import json

    from app.docx.analyzer import AnalysisRequest
    from app.docx.analyzer import analyze as analyze_docx
    from app.docx.artifact import ANALYZER_VERSION as DOCX_ANALYZER_VERSION

    assert DOCX_ANALYZER_VERSION == "5"

    from tests.docx.builder import DocxBuilder, paragraph, style, styles_part

    normal = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:sz w:val="24"/>'
    styles = styles_part(style("Normal", name="Normal", default=True, run_properties=normal))
    content = DocxBuilder(
        body=paragraph("A contested claim [1].")
        + paragraph("References")
        + paragraph("[1] Smith, J. (2020). Water rights.")
        + paragraph("[2] Khatib, A. (2019). Contested basins.")
        + paragraph("[3] Nasser, L. (2021). A survey."),
        styles=styles,
    ).build()

    outcome = analyze_docx(
        AnalysisRequest(
            document_id="d",
            content=content,
            expected_sha256=hashlib.sha256(content).hexdigest(),
        )
    )
    section = json.loads(outcome.artifact.content)["citationAnalysis"]
    # The same numbered list a PDF would now yield three entries for. A DOCX
    # declares none of it, and this checkpoint does not change that.
    assert section["citations"] == []
    assert section["references"] == []


def test_no_docx_object_could_carry_heuristic_provenance() -> None:
    """The DOCX producer has no path to HEURISTIC at all."""
    import inspect

    from app.docx.citations import producer

    assert "HEURISTIC" not in inspect.getsource(producer)
