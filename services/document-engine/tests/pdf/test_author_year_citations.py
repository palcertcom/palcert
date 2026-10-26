"""Conservative author-year heuristic discovery (Phase 18, Checkpoint 11).

Checkpoint 10 recognized `[12]`. This recognizes `(Smith, 2020)`, and the two
are not the same problem. A bracketed number is punctuation nobody writes by
accident; a capitalized word beside a four-digit number inside parentheses is
ordinary English. `(March, 2020)` is a date, `(Copyright, 2019)` is a notice,
`(Smith v. Jones, 2020)` is a lawsuit, `(Python 3.9)` is a dependency.

So most of this file is about what is *refused*. The grammar is anchored end
to end rather than searching, a group that does not parse completely is
rejected whole, and a closed list of words that are never authors takes out
the rest. What survives is matched by exact identity — never by similarity,
never by ranking — and when an identity names two works the citation stays
AMBIGUOUS whatever its confidence says.
"""

from __future__ import annotations

import hashlib
from decimal import Decimal
from typing import Any

import pytest

from app.engine.contracts.artifact_contract import validate_analysis_artifact
from app.pdf.analyzer import analyze
from app.pdf.author_year import AuthorShape, find_citations, normalize_surname, parse_entry
from app.pdf.heuristics import HEURISTIC_CEILING
from tests.pdf.builder import (
    author_year_references_pdf,
    numbered_references_pdf,
    scanned_pdf,
    tagged_citation_pdf,
)

#: Three entries, one of each author shape, so a test can pick the identity it
#: needs without restating the list.
ENTRIES = (
    "Haddad, M., Salem, R., & Odeh, T. (2021). A survey of allocation.",
    "Khatib, A., & Nasser, L. (2019). Contested basins. Regional Review.",
    "Smith, J. (2020). Water rights. Journal of Policy.",
)


def analyzed(data: bytes) -> dict[str, Any]:
    artifact: dict[str, Any] = analyze(
        data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d"
    )
    return artifact


def section(artifact: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = artifact["citationAnalysis"]
    return result


def citations_of(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    return list(section(artifact)["citations"])


def references_of(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    return list(section(artifact)["references"])


def author_year(objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [item for item in objects if item.get("citationKind") == "AUTHOR_DATE"]


def facts_for(artifact: dict[str, Any], name: str) -> list[dict[str, Any]]:
    return [fact for fact in artifact["factSet"]["facts"] if fact["scope"].get("property") == name]


def with_body(*body: str, entries: tuple[str, ...] = ENTRIES) -> dict[str, Any]:
    return analyzed(author_year_references_pdf(body=body, entries=entries))


# --- the forms it recognizes ------------------------------------------------


def test_a_single_author_parenthetical_citation_is_recognized() -> None:
    artifact = with_body("Water rights have been contested (Smith, 2020).")
    (citation,) = author_year(citations_of(artifact))
    assert citation["sourceKind"] == "HEURISTIC"
    assert citation["citationKind"] == "AUTHOR_DATE"
    assert citation["parseMethod"] == "AUTHOR_DATE_PATTERN"
    assert citation["authorTokens"] == ["Smith"]
    assert citation["yearToken"] == "2020"
    assert citation["rawText"] == "(Smith, 2020)"


def test_a_narrative_citation_is_recognized() -> None:
    """`Smith (2020)` is the same citation with the author outside the parens."""
    artifact = with_body("As Smith (2020) showed, the basin was over-allocated.")
    (citation,) = author_year(citations_of(artifact))
    assert citation["authorTokens"] == ["Smith"]
    assert citation["yearToken"] == "2020"
    assert citation["rawText"] == "Smith (2020)"


def test_a_two_author_citation_names_both() -> None:
    artifact = with_body("A later reading disputes it (Khatib & Nasser, 2019).")
    (citation,) = author_year(citations_of(artifact))
    assert citation["authorTokens"] == ["Khatib", "Nasser"]


def test_an_et_al_citation_names_only_the_first_author() -> None:
    """Which is all the document gives: `et al.` is not a surname."""
    artifact = with_body("A survey covers both (Haddad et al., 2021).")
    (citation,) = author_year(citations_of(artifact))
    assert citation["authorTokens"] == ["Haddad"]
    assert citation["yearToken"] == "2021"


def test_a_grouped_citation_becomes_one_citation_per_work() -> None:
    """`(Smith, 2020; Khatib & Nasser, 2019)` cites two works, so it is two.

    One occurrence carrying both would have to resolve to two targets at once,
    which the frozen graph can only record as AMBIGUOUS — saying PalCert could
    not choose when the document named both outright.
    """
    artifact = with_body("Both readings exist (Smith, 2020; Khatib & Nasser, 2019).")
    found = author_year(citations_of(artifact))
    assert [citation["authorTokens"] for citation in found] == [["Smith"], ["Khatib", "Nasser"]]
    assert [citation["yearToken"] for citation in found] == ["2020", "2019"]
    assert all(citation["resolutionStatus"] == "LINKED" for citation in found)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("(Smith, 2020)", [("Smith", None, AuthorShape.SINGLE, "2020")]),
        ("(Smith 2020)", [("Smith", None, AuthorShape.SINGLE, "2020")]),
        ("(Smith and Jones, 2021)", [("Smith", "Jones", AuthorShape.PAIR, "2021")]),
        ("(Smith et al. 2022)", [("Smith", None, AuthorShape.ET_AL, "2022")]),
        ("(van Dijk, 2018)", [("van Dijk", None, AuthorShape.SINGLE, "2018")]),
        ("(Smith, 2020a)", [("Smith", None, AuthorShape.SINGLE, "2020a")]),
        # The Arabic comma, which a bilingual document sets and the text layer
        # preserves exactly.
        ("(Smith، 2020)", [("Smith", None, AuthorShape.SINGLE, "2020")]),
        # ...and every form that is not an author-year citation.
        ("(2020)", []),
        ("(Smith)", []),
        ("(see Smith, 2020)", []),
        ("(Smith, 2020, p. 14)", []),
        ("(Smith, 20)", []),
        ("(smith, 2020)", []),
        ("(Smith v. Jones, 2020)", []),
        ("(March, 2020)", []),
    ],
)
def test_the_accepted_grammar_is_exactly_this(
    text: str, expected: list[tuple[str, str | None, AuthorShape, str]]
) -> None:
    """Pinned on the strings a detector receives, not through a fixture.

    The PDF builders encode to WinAnsi, so a grammar test that went through
    one could only cover the characters that survive it.
    """
    found = find_citations(text)
    assert [
        (item.first_author, item.second_author, item.shape, item.year) for item in found
    ] == expected


# --- reference fields parsed ------------------------------------------------


def test_an_author_year_reference_list_is_segmented_and_parsed() -> None:
    """No brackets anywhere, and PalCert still finds the list.

    Checkpoint 10's region detector needed numbered labels. An author-year
    bibliography has none — it is ordered alphabetically — so recognizing it
    needed a second entry family, not a looser numeric one.
    """
    artifact = analyzed(author_year_references_pdf(entries=ENTRIES))
    entries = references_of(artifact)
    assert len(entries) == 3
    assert all(entry["sourceKind"] == "HEURISTIC" for entry in entries)
    assert all(entry["parseMethod"] == "REGION_MEMBERSHIP" for entry in entries)
    # PARTIAL, not PARSED: the surnames and the year were read and nothing else.
    assert all(entry["parseStatus"] == "PARTIAL" for entry in entries)
    assert [entry["year"] for entry in entries] == ["2021", "2019", "2020"]
    assert [[token["normalizedFamily"] for token in entry["authors"]] for entry in entries] == [
        ["haddad", "salem", "odeh"],
        ["khatib", "nasser"],
        ["smith"],
    ]


def test_no_field_without_its_own_defensible_parse_is_claimed() -> None:
    """Each field is a separate parse with its own failure modes.

    Checkpoint 12 added title, container title, DOI and URL, each behind a
    grammar of its own. Volume, issue, pages, publisher and article number
    still have none and stay absent — claiming one PalCert did not defensibly
    read would put invented bibliographic data into an artifact that an
    evidence panel renders as fact.

    These fixture entries carry no identifier and no journal shape, so those
    are absent here too: a field is emitted when it was read, not when the
    parser exists.
    """
    artifact = analyzed(author_year_references_pdf(entries=ENTRIES))
    for entry in references_of(artifact):
        assert entry["identifiers"] == []
        assert "containerTitle" not in entry
        for field in ("volume", "issue", "pages", "publisher", "articleNumber"):
            assert field not in entry, field


def test_every_parsed_author_is_traceable_to_its_own_entry() -> None:
    """A parsed field that cannot be checked against its source is a claim.

    Each author token carries the surname as written, and that surname appears
    verbatim in the entry's own rawText — so a reader can always see what the
    parse was reading.
    """
    artifact = analyzed(author_year_references_pdf(entries=ENTRIES))
    for entry in references_of(artifact):
        for token in entry["authors"]:
            assert token["raw"] in entry["rawText"]
            assert token["normalizedFamily"] == normalize_surname(token["raw"])
            assert token["corporate"] is False
        assert f"({entry['year']})" in entry["rawText"]


def test_an_author_year_entry_carries_no_numeric_label() -> None:
    artifact = analyzed(author_year_references_pdf(entries=ENTRIES))
    assert all("label" not in entry for entry in references_of(artifact))


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Smith, J. (2020). Water rights.", (("Smith",), AuthorShape.SINGLE, "2020")),
        (
            "Khatib, A., & Nasser, L. (2019). Basins.",
            (("Khatib", "Nasser"), AuthorShape.PAIR, "2019"),
        ),
        (
            "Haddad, M., Salem, R., & Odeh, T. (2021). A survey.",
            (("Haddad", "Salem", "Odeh"), AuthorShape.ET_AL, "2021"),
        ),
        ("van Dijk, P. (2018). Allocation.", (("van Dijk",), AuthorShape.SINGLE, "2018")),
        # ...and what does not open a reference entry.
        ("An ordinary sentence about 2020 and the basin.", None),
        ("Smith (2020). No initials, so no entry.", None),
        ("Smith, J. Water rights. No parenthesised year.", None),
        ("March, A. (2020). A month is never an author.", None),
    ],
)
def test_the_entry_grammar_is_exactly_this(
    text: str, expected: tuple[tuple[str, ...], AuthorShape, str] | None
) -> None:
    parsed = parse_entry(text)
    if expected is None:
        assert parsed is None
    else:
        assert parsed is not None
        assert (parsed.authors, parsed.shape, parsed.year) == expected


# --- matching ---------------------------------------------------------------


def test_a_unique_author_year_identity_links() -> None:
    artifact = with_body("A claim (Smith, 2020).")
    (citation,) = author_year(citations_of(artifact))
    assert citation["resolutionStatus"] == "LINKED"
    (link,) = section(artifact)["links"]
    assert link["linkMethod"] == "AUTHOR_YEAR_UNIQUE"
    assert link["targetId"] == references_of(artifact)[2]["id"]


def test_duplicate_author_year_references_are_ambiguous() -> None:
    """Two works by Smith in 2020, and PalCert names both rather than choosing."""
    artifact = with_body(
        "A claim (Smith, 2020).",
        entries=(
            "Smith, J. (2020). Water rights.",
            "Smith, J. (2020). A second work of the same year.",
            "Khatib, A. (2019). Contested basins.",
        ),
    )
    (citation,) = author_year(citations_of(artifact))
    assert citation["resolutionStatus"] == "AMBIGUOUS"
    (link,) = section(artifact)["links"]
    assert link["linkStatus"] == "AMBIGUOUS"
    assert sorted(link["candidateIds"]) == ["r1", "r2"]
    assert "targetId" not in link


def test_an_unmatched_author_year_identity_is_unresolved() -> None:
    """Looked through the identities PalCert parsed, and found none."""
    artifact = with_body("A claim (Ghost, 1999).")
    (citation,) = author_year(citations_of(artifact))
    assert citation["resolutionStatus"] == "UNRESOLVED"
    (link,) = section(artifact)["links"]
    assert link["linkStatus"] == "UNRESOLVED"
    assert link["linkMethod"] == "AUTHOR_YEAR_UNIQUE"


def test_an_author_year_citation_with_nothing_to_search_is_not_attempted() -> None:
    """A numbered bibliography holds no author-year identity at all.

    "Looked and found nothing" needs a population to have looked in. A thesis
    whose reference list is `[1] Smith...` gives PalCert no author-year
    identity anywhere, so a `(Smith, 2020)` in its prose is a citation nobody
    could attempt rather than one that failed — and it gets no link row, which
    is what the contract means by NOT_ATTEMPTED.
    """
    artifact = analyzed(
        numbered_references_pdf(
            body=("A claim (Smith, 2020) inside a numbered thesis.",),
            entries=(
                "[1] Smith, J. Water rights.",
                "[2] Khatib, A. Contested basins.",
                "[3] Nasser, L. A survey.",
            ),
        )
    )
    (citation,) = author_year(citations_of(artifact))
    assert citation["resolutionStatus"] == "NOT_ATTEMPTED"
    assert section(artifact)["links"] == []


def test_the_author_shape_breaks_a_tie_and_never_creates_one() -> None:
    """`Smith` and `Smith & Jones` in the same year are different works.

    The shape is consulted only once the author-year identity has already
    named more than one entry, and it can only remove candidates. That is what
    keeps it a structural discriminator rather than a ranking.
    """
    artifact = with_body(
        "One (Smith, 2020) and another (Smith & Jones, 2020).",
        entries=(
            "Smith, J. (2020). A solo work.",
            "Smith, J., & Jones, B. (2020). A joint work.",
            "Khatib, A. (2019). Contested basins.",
        ),
    )
    found = author_year(citations_of(artifact))
    assert [citation["resolutionStatus"] for citation in found] == ["LINKED", "LINKED"]
    targets = [link["targetId"] for link in section(artifact)["links"]]
    assert targets == ["r1", "r2"]


def test_shape_does_not_rescue_a_genuine_ambiguity() -> None:
    """Two solo Smith 2020 entries stay two candidates.

    The shape narrows only when it leaves exactly one. Otherwise the citation
    is ambiguous and says so.
    """
    artifact = with_body(
        "A claim (Smith, 2020).",
        entries=(
            "Smith, J. (2020). A solo work.",
            "Smith, J. (2020). Another solo work.",
            "Khatib, A. (2019). Contested basins.",
        ),
    )
    (citation,) = author_year(citations_of(artifact))
    assert citation["resolutionStatus"] == "AMBIGUOUS"


def test_same_year_different_authors_are_never_confused() -> None:
    """No fuzzy selection: identity is the surname, and the surname decides."""
    artifact = with_body(
        "A claim (Smith, 2020).",
        entries=(
            "Smith, J. (2020). Water rights.",
            "Smyth, J. (2020). A near-identical surname.",
            "Jones, B. (2020). Another work of the same year.",
        ),
    )
    (citation,) = author_year(citations_of(artifact))
    assert citation["resolutionStatus"] == "LINKED"
    (link,) = section(artifact)["links"]
    assert link["targetId"] == "r1"


def test_a_surname_is_compared_case_insensitively_and_not_otherwise() -> None:
    """Case folding, and nothing else.

    No diacritic stripping, no transliteration, no initial-only fallback, no
    edit distance — each turns a comparison into a judgement, and a wrong
    judgement points a citation at the wrong work.
    """
    assert normalize_surname("Smith") == normalize_surname("SMITH")
    assert normalize_surname("van Dijk") == "van dijk"
    assert normalize_surname("Smith") != normalize_surname("Smyth")
    assert normalize_surname("Müller") != normalize_surname("Muller")


# --- false positives --------------------------------------------------------


@pytest.mark.parametrize(
    ("description", "body"),
    [
        ("years in ordinary prose", ("The basin dried in 2020 and again in 2021.",)),
        ("dates", ("Signed on (March, 2020) by both parties.", "Also (June, 2019).")),
        ("copyright notices", ("(Copyright, 2019) All rights reserved.", "(c) 2020 Acme.")),
        ("legal citations", ("Held in (Smith v. Jones, 2020) and (Brown vs. Board, 1954).",)),
        ("version numbers", ("Built with (Python 3.9) and (v2, 2021) tooling.",)),
        ("parenthetical numeric values", ("The result (3.14), (n = 42) and (1990-2020).",)),
        ("a name followed by an unrelated year", ("Smith joined the ministry in 2019.",)),
        ("headings containing years", ("Results for 2020", "Annual Report 2019")),
        ("a locator after the year", ("A claim (Smith, 2020, p. 14) here.",)),
        ("a qualifier before the author", ("A claim (see Smith, 2020) here.",)),
        ("a group PalCert cannot read whole", ("And (Smith, 2020; personal communication).",)),
        ("a lowercase word", ("A claim (smith, 2020) here.",)),
    ],
)
def test_false_positive_classes_are_rejected(description: str, body: tuple[str, ...]) -> None:
    """Each fixture carries a real author-year reference list.

    So the detector is running at full strength: nothing here is rejected
    merely because discovery was switched off.
    """
    artifact = with_body(*body)
    assert len(references_of(artifact)) == 3, "the region must still be recognized"
    assert author_year(citations_of(artifact)) == [], description


def test_the_reference_list_is_not_rediscovered_as_in_text_citations() -> None:
    """Every entry opens with `Smith, J. (2020)`, which the narrative grammar reads.

    Without excluding the region outright, an author-year bibliography would
    have the document citing its own reference list once per entry — and each
    of those would link to itself.
    """
    artifact = with_body("One claim (Smith, 2020).")
    found = author_year(citations_of(artifact))
    assert [citation["rawText"] for citation in found] == ["(Smith, 2020)"]


# --- coexistence with the numeric family ------------------------------------


def test_numeric_discovery_is_unchanged_by_this_checkpoint() -> None:
    """Checkpoint 10's detector reads a numbered document identically."""
    artifact = analyzed(
        numbered_references_pdf(
            entries=(
                "[1] Smith, J. (2020). Water rights.",
                "[2] Khatib, A. (2019). Contested basins.",
                "[3] Nasser, L. (2021). A survey.",
            )
        )
    )
    citations = citations_of(artifact)
    assert [citation["citationKind"] for citation in citations] == ["NUMERIC_LABEL"] * 3
    assert [citation["numericLabels"] for citation in citations] == [[1], [2], [3]]
    assert all(citation["resolutionStatus"] == "LINKED" for citation in citations)
    assert [entry["label"] for entry in references_of(artifact)] == [1, 2, 3]


def test_a_numeric_marker_is_never_reinterpreted_as_author_year() -> None:
    """The families claim character ranges, and numeric claims first."""
    artifact = analyzed(
        numbered_references_pdf(
            body=("A claim [1] and another [2].",),
            entries=(
                "[1] Smith, J. (2020). Water rights.",
                "[2] Khatib, A. (2019). Basins.",
                "[3] Nasser, L. (2021). A survey.",
            ),
        )
    )
    citations = citations_of(artifact)
    assert [citation["citationKind"] for citation in citations] == ["NUMERIC_LABEL"] * 2
    assert author_year(citations) == []


def test_both_families_can_appear_in_one_document_without_duplicating() -> None:
    """A mixed-style document, and each marker recognized exactly once."""
    artifact = analyzed(
        numbered_references_pdf(
            body=("A numeric claim [2] and an author-year one (Smith, 2020).",),
            entries=(
                "[1] Smith, J. (2020). Water rights.",
                "[2] Khatib, A. (2019). Basins.",
                "[3] Nasser, L. (2021). A survey.",
            ),
        )
    )
    kinds = [citation["citationKind"] for citation in citations_of(artifact)]
    assert kinds == ["NUMERIC_LABEL", "AUTHOR_DATE"]
    raw = [citation["rawText"] for citation in citations_of(artifact)]
    assert raw == ["[2]", "(Smith, 2020)"]


# --- exact evidence is preserved --------------------------------------------


def test_a_tagged_pdf_is_unchanged() -> None:
    artifact = analyzed(tagged_citation_pdf())
    assert [citation["sourceKind"] for citation in citations_of(artifact)] == ["PDF_TEXT"]
    assert [entry["sourceKind"] for entry in references_of(artifact)] == ["PDF_TEXT"]
    assert citations_of(artifact)[0]["resolutionStatus"] == "LINKED"
    assert section(artifact)["summary"]["referenceRegionObserved"] is True


def test_a_heuristic_author_year_overlap_with_exact_evidence_is_suppressed() -> None:
    """A declared citation is not re-found by pattern.

    The overlap test is span node identity — the same rule Checkpoint 10 uses
    — so the exact object keeps the field and no second object is created for
    the same characters.
    """
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("(Smith, 2020)",),
            entries=(("[1]", "Smith, J. (2020). Water rights."),),
            heading="References",
            untagged_entries=(
                "Khatib, A. (2019). Contested basins.",
                "Nasser, L. (2021). A survey.",
                "Haddad, M. (2018). Allocation.",
            ),
        )
    )
    declared = [
        citation for citation in citations_of(artifact) if citation["sourceKind"] == "PDF_TEXT"
    ]
    assert len(declared) == 1
    assert declared[0]["rawText"] == "(Smith, 2020)"
    # No heuristic citation was created for the same text.
    assert not [
        citation
        for citation in author_year(citations_of(artifact))
        if citation["rawText"] == "(Smith, 2020)"
    ]


def test_exact_link_rows_are_untouched_by_author_year_matching() -> None:
    artifact = analyzed(tagged_citation_pdf())
    assert section(artifact)["links"] == [
        {
            "citationId": "c1",
            "linkMethod": "NUMERIC_LABEL",
            "candidateCount": 0,
            "linkStatus": "LINKED",
            "targetId": "r1",
        }
    ]


# --- provenance and projection safety ---------------------------------------


def test_every_author_year_object_carries_a_confidence() -> None:
    artifact = with_body("A claim (Smith, 2020) and (Haddad et al., 2021).")
    produced = author_year(citations_of(artifact)) + references_of(artifact)
    assert produced
    for item in produced:
        assert "confidence" in item, item["id"]
        assert Decimal("0") < Decimal(item["confidence"]) <= HEURISTIC_CEILING
        assert item["sourceKind"] == "HEURISTIC"


def test_a_weaker_author_year_citation_scores_lower_than_a_stronger_one() -> None:
    """Confidence tracks the evidence, and the evidence differs.

    A citation whose identity names exactly one parsed entry has two signals a
    citation matching nothing does not. Both are recorded; neither decides
    anything.
    """
    matched = with_body("A claim (Smith, 2020).")
    unmatched = with_body("A claim (Ghost, 1999).")
    strong = Decimal(author_year(citations_of(matched))[0]["confidence"])
    weak = Decimal(author_year(citations_of(unmatched))[0]["confidence"])
    assert strong > weak


def test_confidence_never_rescues_an_ambiguous_identity() -> None:
    """AMBIGUOUS stays AMBIGUOUS however confident the recognition was."""
    artifact = with_body(
        "A claim (Smith, 2020).",
        entries=(
            "Smith, J. (2020). A solo work.",
            "Smith, J. (2020). Another solo work.",
            "Khatib, A. (2019). Contested basins.",
        ),
    )
    (citation,) = author_year(citations_of(artifact))
    assert citation["resolutionStatus"] == "AMBIGUOUS"
    assert Decimal(citation["confidence"]) > Decimal("0.5")
    (link,) = section(artifact)["links"]
    assert "targetId" not in link


def test_author_year_citations_emit_no_exact_public_facts() -> None:
    """A clean author-year resolution is still not an exact element value."""
    artifact = with_body("A claim (Smith, 2020).")
    assert author_year(citations_of(artifact))[0]["resolutionStatus"] == "LINKED"
    assert facts_for(artifact, "citationTargetResolved") == []
    assert facts_for(artifact, "referenceRegionPresent") == []
    assert section(artifact)["summary"]["referenceRegionObserved"] is False


def test_no_fact_sits_at_an_author_year_node() -> None:
    artifact = with_body("A claim (Smith, 2020) and (Haddad et al., 2021).")
    heuristic_nodes = {
        item["location"]["nodeId"]
        for item in author_year(citations_of(artifact)) + references_of(artifact)
    }
    assert heuristic_nodes
    for fact in artifact["factSet"]["facts"]:
        if fact["scope"].get("property") in {"citationTargetResolved", "referenceRegionPresent"}:
            assert fact.get("location", {}).get("nodeId") not in heuristic_nodes


# --- coverage ---------------------------------------------------------------


def test_semantic_coverage_stays_partial_with_two_families() -> None:
    """Two styles is not every style.

    Numbered and author-year are what PalCert reads. A note-marker citation, a
    superscript, a Vancouver variant and every Arabic-script author-year form
    are all invisible to it, and COMPLETE would deny that any of them exists.
    """
    artifact = analyzed(author_year_references_pdf(entries=ENTRIES))
    for name in ("SEMANTIC_CITATIONS", "SEMANTIC_REFERENCE_ENTRIES"):
        entry = next(item for item in section(artifact)["coverage"] if item["domain"] == name)
        assert entry["status"] == "PARTIAL"
        assert entry["reasonCode"] == "SEMANTIC_CLASSIFICATION_NOT_EXHAUSTIVE"


def test_an_image_only_pdf_produces_no_author_year_citations() -> None:
    artifact = analyzed(scanned_pdf())
    assert citations_of(artifact) == []
    assert references_of(artifact) == []


# --- Arabic -----------------------------------------------------------------


def test_arabic_script_prose_produces_no_author_year_citations() -> None:
    """Deliberate, and a protection rather than a shortfall.

    The Latin grammar's safety rests on a leading capital, and Arabic script
    has no case. Recognizing "any Arabic word followed by a year in
    parentheses" would manufacture citations out of ordinary prose, so this
    checkpoint recognizes none — see `docs/architecture/citations.md` for the
    gap and what closing it would need.
    """
    artifact = with_body("تناقش الأطروحة (الخطيب، 2019) والتوزيع (ناصر، 2021).")
    assert author_year(citations_of(artifact)) == []


def test_arabic_numeric_discovery_still_works() -> None:
    """Checkpoint 10's Arabic support is untouched by this checkpoint."""
    from tests.pdf.builder import arabic_numbered_references_pdf

    artifact = analyzed(arabic_numbered_references_pdf())
    assert [entry["label"] for entry in references_of(artifact)] == [1, 2, 3]
    assert all(citation["citationKind"] == "NUMERIC_LABEL" for citation in citations_of(artifact))


# --- the artifact stays valid, and stays the same ---------------------------


def test_the_complete_artifact_contract_holds() -> None:
    for data in (
        author_year_references_pdf(entries=ENTRIES),
        author_year_references_pdf(body=("A claim (Ghost, 1999).",), entries=ENTRIES),
        author_year_references_pdf(
            body=("A claim (Smith, 2020).",),
            entries=(
                "Smith, J. (2020). A solo work.",
                "Smith, J. (2020). Another solo work.",
                "Khatib, A. (2019). Contested basins.",
            ),
        ),
        numbered_references_pdf(
            body=("A mixed claim [2] and (Smith, 2020).",),
            entries=(
                "[1] Smith, J. (2020). Water rights.",
                "[2] Khatib, A. (2019). Basins.",
                "[3] Nasser, L. (2021). A survey.",
            ),
        ),
    ):
        result = validate_analysis_artifact(analyzed(data))
        assert result.valid, [issue.message for issue in result.issues]


def test_author_year_discovery_is_deterministic() -> None:
    for data in (
        author_year_references_pdf(entries=ENTRIES),
        author_year_references_pdf(
            body=("Both (Smith, 2020; Khatib & Nasser, 2019).",), entries=ENTRIES
        ),
    ):
        assert section(analyzed(data)) == section(analyzed(data))


def test_a_candidate_the_artifact_does_not_carry_is_never_named() -> None:
    """A bound cut an entry out, so no link may point at it.

    Naming an entry a reader cannot look up is worse than reporting one fewer
    candidate, and building the link from an object rather than from an id the
    artifact actually holds is how that happens. Exercised directly because a
    document large enough to reach the reference cap is not a fixture.
    """
    from app.pdf.citations import _author_year_links
    from app.pdf.heuristics import HeuristicAuthorYearCitation, HeuristicReference, LineRef
    from app.pdf.model import BBox

    line = LineRef(
        0,
        0,
        "n",
        ("s",),
        "(Smith, 2020)",
        None,
        BBox(Decimal(0), Decimal(1), Decimal(1), Decimal(0)),
    )
    entry = HeuristicReference(
        label=None,
        ordinal=1,
        text="Smith, J. (2020).",
        line=line,
        span_node_ids=("s",),
        signals=frozenset(),
        confidence=Decimal("0.5"),
        authors=("Smith",),
        author_shape=AuthorShape.SINGLE,
        year="2020",
    )
    citation = HeuristicAuthorYearCitation(
        parsed=find_citations("(Smith, 2020)")[0],
        line=line,
        span_node_ids=("s",),
        signals=frozenset(),
        confidence=Decimal("0.5"),
    )

    links, resolutions = _author_year_links([citation], [entry], {}, first_index=1)
    assert links == []
    assert resolutions == {"c1": ("NOT_ATTEMPTED", 0)}

    links, resolutions = _author_year_links([citation], [entry], {id(entry): "r1"}, first_index=1)
    assert links[0]["targetId"] == "r1"
    assert resolutions == {"c1": ("LINKED", 1)}
