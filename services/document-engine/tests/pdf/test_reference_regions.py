"""Several reference lists, and the numeric forms that go with them (Checkpoint 14).

Checkpoints 10 to 13 read a document as having *one* bibliography. That is
true of a thesis and false of a book of chapters, a collection of articles, or
a report whose appendix carries its own sources — and being wrong there is not
a missing region but a silently mis-scoped one. `[1]` in chapter two resolved,
confidently and wrongly, to chapter one's first entry.

Two questions run through the file, and they are the same two Checkpoint 10
set.

*Did PalCert find it?* Per-chapter lists, Vancouver lists, raised numerals and
parenthesised groups are all real citation structure that earlier versions
could not see at all.

*Did PalCert claim more than it found?* That is the one that decides whether
this layer is safe. A raised numeral is shaped exactly like an exponent; `(3)`
is shaped exactly like an equation number; `1. Smith J` is shaped exactly like
a numbered list. Every one of those look-alikes gets a test here, and the rule
throughout is the one the checkpoint states: prefer missing a citation over
fabricating one.
"""

from __future__ import annotations

import hashlib
from decimal import Decimal
from typing import Any

import pytest

from app.engine.contracts.artifact_contract import validate_analysis_artifact
from app.pdf.analyzer import analyze
from app.pdf.heuristics import vancouver_label
from tests.pdf.builder import (
    arabic_numbered_references_pdf,
    arabic_superscript_pdf,
    multi_region_pdf,
    numbered_references_pdf,
    superscript_pdf,
    tagged_citation_pdf,
    vancouver_references_pdf,
)

CHAPTER_ONE = (
    "[1] Smith, J. Water rights.",
    "[2] Khatib, A. Contested basins.",
    "[3] Nasser, L. A survey.",
)
CHAPTER_TWO = (
    "[1] Haddad, M. Allocation.",
    "[2] Salem, R. Reuse.",
    "[3] Odeh, T. Storage.",
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


def regions_of(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    section: list[dict[str, Any]] = artifact["citationAnalysis"]["referenceRegions"]
    return section


def links_of(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    section: list[dict[str, Any]] = artifact["citationAnalysis"]["links"]
    return section


def resolved(artifact: dict[str, Any]) -> list[tuple[str, str, str | None]]:
    """Each link as (citation, status, target) — what actually got chosen."""
    return [
        (row["citationId"], row["linkStatus"], row.get("targetId")) for row in links_of(artifact)
    ]


def domain(artifact: dict[str, Any], name: str) -> dict[str, Any]:
    for entry in artifact["citationAnalysis"]["coverage"]:
        if entry["domain"] == name:
            return dict(entry)
    raise AssertionError(f"{name} is not reported")


# --- several reference regions ----------------------------------------------


def test_two_chapter_bibliographies_are_two_regions() -> None:
    """The shape the checkpoint exists for, and the one earliest missed.

    Two lists, each under its own heading, each on its own page. They are not
    merged: merging would invent a six-entry population the document never
    had, and `[1]` would then look uniquely resolved when it names two works.
    """
    artifact = analyzed(multi_region_pdf())
    regions = regions_of(artifact)
    assert [region["ordinal"] for region in regions] == [1, 2]
    assert [region["family"] for region in regions] == ["NUMBERED", "NUMBERED"]
    assert [region["entryCount"] for region in regions] == [3, 3]
    # Boundaries kept, not recomputed: each list sits on its own page.
    assert [(region["firstPage"], region["lastPage"]) for region in regions] == [(2, 2), (4, 4)]
    assert all(region["sourceKind"] == "HEURISTIC" for region in regions)
    assert all(Decimal(region["confidence"]) > 0 for region in regions)


def test_a_repeated_label_across_regions_stays_two_entries() -> None:
    """`[1]` exists twice and means two different works.

    Each entry names the region it came from, which is the only way a reader
    can check that a link chose from the right population.
    """
    entries = references_of(analyzed(multi_region_pdf()))
    assert [entry["label"] for entry in entries] == [1, 2, 3, 1, 2, 3]
    assert [entry["regionOrdinal"] for entry in entries] == [1, 1, 1, 2, 2, 2]


def test_a_citation_resolves_inside_its_own_chapter() -> None:
    """Chapter two's `[1]` is Haddad, not Smith.

    The assignment rule is ordinal containment, not distance: a reference list
    serves the text it follows, so the first region *beginning after* the
    citation is the one that closes its stretch of document. No page gap, no
    nearest-region ranking.
    """
    artifact = analyzed(multi_region_pdf())
    rows = resolved(artifact)
    assert rows == [("c1", "LINKED", "r1"), ("c2", "LINKED", "r2"), ("c3", "LINKED", "r4")]
    # r4 is chapter two's first entry, r1 is chapter one's.
    by_id = {entry["id"]: entry for entry in references_of(artifact)}
    assert "Haddad" in by_id["r4"]["rawText"]
    assert by_id["r4"]["regionOrdinal"] == 2


def test_a_citation_with_no_region_after_it_is_ambiguous_not_guessed() -> None:
    """An afterword citing `[2]` when every list is already behind it.

    There is no defensible region, so PalCert widens to every region and says
    so. What it must never do is pick the nearest list, or the last one, or
    the one with the higher confidence: each of those would be a guess wearing
    a resolution's clothes.
    """
    artifact = analyzed(
        multi_region_pdf(
            chapters=(
                (("Chapter One cites [1].",), CHAPTER_ONE),
                (("Chapter Two cites [1].",), CHAPTER_TWO),
                (("An afterword cites [2] with no list of its own.",), ()),
            )
        )
    )
    (afterword,) = [row for row in links_of(artifact) if row["citationId"] == "c3"]
    assert afterword["linkStatus"] == "AMBIGUOUS"
    assert afterword.get("targetId") is None
    assert sorted(afterword["candidateIds"]) == ["r2", "r5"]


def test_an_appendix_with_its_own_sources_is_its_own_region() -> None:
    """A main bibliography and a supplementary one are two populations.

    The same machinery as per-chapter lists, and the point of testing it
    separately is that the second heading here is *not* "References" — a
    region is accepted on entry structure, and the heading is one signal.
    """
    artifact = analyzed(
        multi_region_pdf(
            chapters=(
                (("The body cites [3].",), CHAPTER_ONE),
                (("The appendix cites [3] too.",), CHAPTER_TWO),
            ),
            heading="Bibliography",
        )
    )
    assert [region["ordinal"] for region in regions_of(artifact)] == [1, 2]
    rows = resolved(artifact)
    assert rows == [("c1", "LINKED", "r3"), ("c2", "LINKED", "r6")]


def test_bracketed_citations_in_a_single_region_document_are_unchanged() -> None:
    """Checkpoint 10's document reads exactly as it did.

    The bracketed family is tried first and its grammar is untouched, so a
    file with one numbered bibliography produces the same entries, the same
    citations and the same links it produced three checkpoints ago.
    """
    artifact = analyzed(numbered_references_pdf())
    assert [entry["label"] for entry in references_of(artifact)] == [1, 2, 3]
    assert [citation["numericLabels"] for citation in citations_of(artifact)] == [[1], [2], [3]]
    assert all(citation["citationKind"] == "NUMERIC_LABEL" for citation in citations_of(artifact))
    assert [row["linkStatus"] for row in links_of(artifact)] == ["LINKED"] * 3
    assert [region["family"] for region in regions_of(artifact)] == ["NUMBERED"]


# --- raised numerals --------------------------------------------------------


def test_a_single_raised_numeral_is_a_citation() -> None:
    """`…contested³` — invisible to every text-level detector before this.

    As characters it is the digit 3 and nothing more. What makes it a citation
    is geometry plus the entry it names, and neither alone is enough.
    """
    artifact = analyzed(superscript_pdf())
    (citation,) = citations_of(artifact)
    assert citation["numericLabels"] == [3]
    assert citation["numericLabelsRaw"] == "3"
    assert citation["sourceKind"] == "HEURISTIC"
    assert citation["citationKind"] == "NUMERIC_LABEL"
    assert citation["resolutionStatus"] == "LINKED"
    assert Decimal(citation["confidence"]) <= Decimal("0.95")


def test_a_raised_comma_separated_group_is_several_citations() -> None:
    """`…agree¹,²,³` is three citations, and the group is kept verbatim."""
    artifact = analyzed(superscript_pdf(body=(("Several studies agree", "1,2,3", " on this."),)))
    citations = citations_of(artifact)
    assert [citation["numericLabels"] for citation in citations] == [[1], [2], [3]]
    assert {citation["numericLabelsRaw"] for citation in citations} == {"1,2,3"}
    assert [row["linkStatus"] for row in links_of(artifact)] == ["LINKED"] * 3


def test_a_raised_range_expands_to_every_label_in_it() -> None:
    """`…agree¹⁻³` names 1, 2 and 3, and says so in `numericLabelsRaw`."""
    artifact = analyzed(superscript_pdf(body=(("Several studies agree", "1-3", " on this."),)))
    citations = citations_of(artifact)
    assert [citation["numericLabels"] for citation in citations] == [[1], [2], [3]]
    assert {citation["numericLabelsRaw"] for citation in citations} == {"1-3"}


def test_a_parenthesised_vancouver_group_is_read_where_it_is_defensible() -> None:
    """`(3)` and `(1,2)` in a document that numbers its own list without brackets.

    The precondition is the document's own style, not a preference: a file
    whose bibliography reads `[7] Smith, J.` writes its markers `[7]`, so
    `(7)` there is something else. Here the list reads `1. Smith J`, which is
    exactly the style whose markers are parenthesised.
    """
    artifact = analyzed(vancouver_references_pdf(body=("A claim (3) and a pair (1,2) here.",)))
    citations = citations_of(artifact)
    assert [citation["numericLabels"] for citation in citations] == [[3], [1], [2]]
    assert [citation["numericLabelsRaw"] for citation in citations] == ["(3)", "(1,2)", "(1,2)"]
    assert {row["linkStatus"] for row in links_of(artifact)} == {"LINKED"}


def test_a_parenthesised_group_is_ignored_in_a_bracketed_document() -> None:
    """The same `(3)`, in a document that brackets its own labels, is not a citation.

    Reading it would be reading against the author's established style, and
    the style is a fact about the file rather than a tuned preference.
    """
    artifact = analyzed(
        numbered_references_pdf(body=("A claim (3) in a bracketed-style document.",))
    )
    assert citations_of(artifact) == []
    assert [region["family"] for region in regions_of(artifact)] == ["NUMBERED"]


# --- what must not be read as a citation ------------------------------------


def test_a_mathematical_exponent_is_not_a_citation() -> None:
    """`x²` is a raised, smaller digit against running text — the identical shape.

    Two independent reasons it fails: the text it is attached to ends in a
    lone letter, which is what a variable looks like, and 2 would have had to
    name an entry anyway. Either one alone rejects it.
    """
    artifact = analyzed(superscript_pdf(body=(("The value of x", "2", " is large."),)))
    assert citations_of(artifact) == []


def test_chemical_notation_is_not_a_citation() -> None:
    """`H₂O` sets the 2 *below* the baseline.

    Rejected by the raised test itself, before any of the textual checks run:
    a subscript is not strictly above the running text, so it never becomes a
    marker at all.
    """
    artifact = analyzed(superscript_pdf(body=(("The formula H", "2", "O is water."),), raise_by=-4))
    assert citations_of(artifact) == []


def test_a_raised_numeral_naming_nothing_is_reported_as_nothing() -> None:
    """A footnote marker, an ordinal, a page reference — all the same to geometry.

    The reference it pointed at was the only reason to read a raised numeral
    as a citation in the first place, so a marker naming no entry is not a
    weak citation. It is not a citation.
    """
    artifact = analyzed(superscript_pdf(body=(("A remark", "9", " follows."),)))
    assert citations_of(artifact) == []
    # The reference list itself was still found, so this is a rejection rather
    # than a document PalCert could not read.
    assert len(references_of(artifact)) == 3


def test_an_ordinary_numbered_list_is_not_a_reference_region() -> None:
    """`1. Collect the samples` under a "References" heading is still a list.

    The number says "list"; only the `Surname AB` after it says "reference".
    Checkpoint 10 declined the unbracketed family for exactly this reason, and
    the grammar earns it back rather than relaxing into it.
    """
    artifact = analyzed(
        vancouver_references_pdf(
            entries=(
                "1. Collect the samples",
                "2. Weigh them carefully",
                "3. Record the result",
            )
        )
    )
    assert regions_of(artifact) == []
    assert references_of(artifact) == []
    assert citations_of(artifact) == []


@pytest.mark.parametrize(
    "line",
    [
        "1. Collect the samples",
        "2. Weigh them carefully",
        "3. See Table 4 for details",
        "4. 2020 was a dry year",
        "5. Section 3 explains why",
    ],
)
def test_the_vancouver_grammar_rejects_ordinary_list_items(line: str) -> None:
    """Unit-level, so the rejection is pinned independently of any fixture."""
    assert vancouver_label(line) is None


@pytest.mark.parametrize(
    ("line", "label"),
    [
        ("1. Smith J, Jones A. Water rights. J Policy. 2020;5:10-20.", 1),
        ("2. Khatib A. Contested basins. Reg Rev. 2019;3:4-9.", 2),
        ("12) Nasser L, Odeh T. A survey. Water Stud. 2021;7:1-15.", 12),
    ],
)
def test_the_vancouver_grammar_accepts_a_reference_opening(line: str, label: int) -> None:
    assert vancouver_label(line) == label


@pytest.mark.parametrize(
    "body",
    [
        "The array index arr(12) is out of range.",
        "Let x = (3) for the moment.",
        "The sum n + (4) grows without bound.",
    ],
)
def test_arithmetic_and_subscripts_are_not_parenthesised_citations(body: str) -> None:
    """Three look-alikes, each rejected by a closed textual condition.

    A group glued to an identifier is a subscript. A group following an
    operator is arithmetic. Neither is a distance or a score, which matters:
    a tuned number is exactly what would make this quietly wrong on the next
    document.
    """
    artifact = analyzed(vancouver_references_pdf(body=(body,)))
    assert citations_of(artifact) == []


def test_a_display_equation_number_is_not_a_parenthesised_citation() -> None:
    """`E = mc² (2)` sets its number after the formula, not alone at the margin.

    The tail check cannot see it — the character before the group is a letter
    — so the guard is the presence of a mathematical operator anywhere earlier
    on the line. The operator set is restricted to characters prose does not
    use, so a hyphenated word or a fraction in running text is unaffected.
    """
    artifact = analyzed(vancouver_references_pdf(body=("The energy E = mc2 (2) is conserved.",)))
    assert citations_of(artifact) == []


@pytest.mark.parametrize(
    "before",
    ["A claim ", "a well-known result ", "a 5/8 share "],
)
def test_the_equation_guard_leaves_ordinary_prose_alone(before: str) -> None:
    """Hyphen, plus and slash are absent from the operator set on purpose."""
    from app.pdf.heuristics import _MATH_ANYWHERE

    assert _MATH_ANYWHERE.search(before) is None


def test_a_region_label_is_not_rediscovered_as_a_citation() -> None:
    """A numbered bibliography's own `[7]` is not the document citing itself.

    Every accepted region is excluded from every citation detector, which is
    why six entries here produce three citations rather than nine.
    """
    artifact = analyzed(multi_region_pdf())
    assert len(references_of(artifact)) == 6
    assert len(citations_of(artifact)) == 3
    pages = {citation["location"]["page"] for citation in citations_of(artifact)}
    # Pages 2 and 4 hold the lists; the citations are on 1 and 3.
    assert pages == {1, 3}


# --- coexistence with the other link methods --------------------------------


def test_numeric_and_doi_evidence_coexist_without_either_taking_priority() -> None:
    """One citation, two methods, one agreed target.

    Region context restricts which entries a numeric label may choose from. It
    must not make `NUMERIC_LABEL` outrank `DOI_IDENTITY` or the other way
    round: both rows are emitted, and they agree here because the evidence
    agrees.
    """
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("[1]",),
            label_citations=True,
            cited_text="doi:10.1234/abc",
            entries=(("[1]", "Smith, J. Water rights. doi:10.1234/abc"),),
        )
    )
    rows = links_of(artifact)
    assert sorted(row["linkMethod"] for row in rows) == ["DOI_IDENTITY", "NUMERIC_LABEL"]
    assert {row["linkStatus"] for row in rows} == {"LINKED"}
    assert {row["targetId"] for row in rows} == {"r1"}


def test_numeric_and_author_year_citations_coexist_in_one_document() -> None:
    """A bracketed marker and `(Smith, 2020)` in the same sentence.

    The numeric family runs first and claims its character ranges; the
    author-year family takes what is left. One marker therefore never becomes
    two citations, and neither family reinterprets the other's.
    """
    artifact = analyzed(
        vancouver_references_pdf(body=("Water rights are contested (Smith, 2020) and also [1].",))
    )
    kinds = sorted(citation["citationKind"] for citation in citations_of(artifact))
    assert kinds == ["AUTHOR_DATE", "NUMERIC_LABEL"]
    methods = sorted(row["linkMethod"] for row in links_of(artifact))
    assert "NUMERIC_LABEL" in methods


# --- the boundaries Checkpoint 14 must not cross ----------------------------


def test_exact_objects_are_untouched_by_region_discovery() -> None:
    """A tagged document produces exactly what it produced before.

    No region is discovered in it, nothing acquires a confidence, and the
    declared objects keep `PDF_TEXT`. Heuristic regions never replace or
    redefine an exact one.
    """
    artifact = analyzed(tagged_citation_pdf())
    assert regions_of(artifact) == []
    (reference,) = references_of(artifact)
    (citation,) = citations_of(artifact)
    assert reference["sourceKind"] == "PDF_TEXT"
    assert citation["sourceKind"] == "PDF_TEXT"
    assert "confidence" not in reference
    assert "confidence" not in citation
    assert "regionOrdinal" not in reference


def test_every_heuristic_object_carries_a_confidence_below_one() -> None:
    """Regions included, which is new here.

    An object this layer produced without a confidence would look, to every
    later reader, exactly like exact evidence — and 1 would say PalCert was
    certain, which it never is about a recognition it inferred.
    """
    artifact = analyzed(multi_region_pdf())
    produced = (
        regions_of(artifact)
        + [item for item in references_of(artifact) if item["sourceKind"] == "HEURISTIC"]
        + [item for item in citations_of(artifact) if item["sourceKind"] == "HEURISTIC"]
    )
    assert produced
    assert all(Decimal(item["confidence"]) < Decimal("1") for item in produced)


@pytest.mark.parametrize(
    "fixture",
    [multi_region_pdf, superscript_pdf, vancouver_references_pdf],
)
def test_no_exact_fact_is_emitted_from_a_heuristic_node(fixture: Any) -> None:
    """The quarantine, restated for the three shapes Checkpoint 14 adds.

    `citationTargetResolved` and `referenceRegionPresent` stay exact-only. A
    raised citation, a Vancouver entry and a discovered region are evidence
    and never authority, however confident the number beside them is.
    """
    artifact = analyzed(fixture())
    for name in ("citationTargetResolved", "referenceRegionPresent"):
        assert [
            fact for fact in artifact["factSet"]["facts"] if fact["scope"].get("property") == name
        ] == []


@pytest.mark.parametrize(
    "fixture",
    [multi_region_pdf, superscript_pdf, vancouver_references_pdf],
)
def test_coverage_stays_partial_however_many_regions_were_found(fixture: Any) -> None:
    """More recognized styles is not exhaustive classification.

    Supporting a fourth numeric form says PalCert recognizes more of what a
    document may contain. It says nothing about the forms it still cannot
    name, so the semantic domains remain PARTIAL.
    """
    artifact = analyzed(fixture())
    assert domain(artifact, "SEMANTIC_CITATIONS")["status"] == "PARTIAL"
    assert domain(artifact, "SEMANTIC_REFERENCE_ENTRIES")["status"] == "PARTIAL"


@pytest.mark.parametrize(
    "fixture",
    [multi_region_pdf, superscript_pdf, vancouver_references_pdf],
)
def test_the_same_bytes_produce_the_same_artifact(fixture: Any) -> None:
    """Determinism, including the new region collection and its signal lists.

    Signals are emitted sorted and regions are numbered in reading order, so
    nothing here depends on a set's iteration order or a dictionary's
    insertion order.
    """
    data = fixture()
    first = analyzed(data)["citationAnalysis"]
    second = analyzed(data)["citationAnalysis"]
    assert first == second


@pytest.mark.parametrize(
    "fixture",
    [multi_region_pdf, superscript_pdf, vancouver_references_pdf],
)
def test_every_new_shape_still_validates_against_the_contract(fixture: Any) -> None:
    validate_analysis_artifact(analyzed(fixture()))


# --- Arabic -----------------------------------------------------------------


def test_arabic_bracketed_numeric_behaviour_is_unchanged() -> None:
    """Checkpoint 10's Arabic document reads exactly as it did.

    Arabic-Indic labels, mirrored brackets, no spaces. Nothing Checkpoint 14
    adds touches it, and this is what says so.
    """
    artifact = analyzed(arabic_numbered_references_pdf())
    assert [entry["label"] for entry in references_of(artifact)] == [1, 2, 3]
    assert [citation["numericLabels"] for citation in citations_of(artifact)] == [[1], [2]]
    assert {row["linkStatus"] for row in links_of(artifact)} == {"LINKED"}


def test_a_raised_arabic_indic_digit_is_not_exposed_by_this_corpus() -> None:
    """A recorded limitation, not a claim about Arabic PDFs.

    The corpus writes Arabic through a synthetic composite font whose glyph
    program is empty, so PDFium reports Arabic glyphs with essentially no
    vertical extent — and a raised marker is recognized by its box sitting
    strictly above a body span's, which such boxes cannot express. The digit
    is not detected because the text layer of *this fixture* does not carry
    the geometry, and the checkpoint is explicit that a superscript must not
    be synthesized to make a test pass.

    Pinned rather than merely described: if the corpus ever gains a font with
    real metrics, this fails and the gap gets revisited on purpose.
    """
    artifact = analyzed(arabic_superscript_pdf())
    # The list is found, so the fixture is readable and this is specifically
    # about the raised marker.
    assert [entry["label"] for entry in references_of(artifact)] == [1, 2, 3]
    assert citations_of(artifact) == []
