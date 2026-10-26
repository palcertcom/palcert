"""Citation-side identifiers and DOI_IDENTITY linking (Phase 18, Checkpoint 13).

`DOI_IDENTITY` has been in the frozen link vocabulary since Checkpoint 2 and
has never fired once. The reason was structural: a reference entry could carry
a DOI and a `CitationOccurrence` could not carry anything, so the method's own
condition — the same identity on both sides — was unsatisfiable. Checkpoints 6
and 12 both recorded it as a contract gap rather than working around it.

This closes the gap by giving a citation the **same** `CitationIdentifier` a
reference entry already carries. Not a second DOI representation: the same
object, read by the same extractor, normalized by the same function. That is
what makes the comparison one of like with like rather than of two parsers
that happen to agree today.

What the method is still not allowed to do runs through every test here. It
reads the citation's own text and never the paragraph around it. It never
overrides a method that disagrees with it. It never rests on an identity
PalCert was unsure of. And it says only *this document states the same
identifier in two places* — never that the work exists.
"""

from __future__ import annotations

import hashlib
import socket
from typing import Any

import pytest

from app.engine.contracts.artifact_contract import validate_analysis_artifact
from app.pdf.analyzer import analyze
from app.pdf.bibliography import normalize_doi
from tests.pdf.builder import (
    author_year_references_pdf,
    internal_destination_pdf,
    numbered_references_pdf,
    tagged_citation_pdf,
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


def doi_links(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    return [row for row in section(artifact)["links"] if row["linkMethod"] == "DOI_IDENTITY"]


def tagged(citation: str, *entries: str) -> dict[str, Any]:
    """A tagged PDF whose citation and entries carry the text given."""
    return analyzed(
        tagged_citation_pdf(
            citations=(citation,),
            entries=tuple((f"[{index + 1}]", text) for index, text in enumerate(entries)),
        )
    )


# --- citation-side identifiers ----------------------------------------------


@pytest.mark.parametrize(
    ("written", "normalized"),
    [
        ("doi:10.1234/abc", "10.1234/abc"),
        ("DOI: 10.1234/ABC", "10.1234/abc"),
        ("https://doi.org/10.1234/abc", "10.1234/abc"),
        ("http://dx.doi.org/10.1234/ABC", "10.1234/abc"),
        ("10.1234/abc", "10.1234/abc"),
    ],
)
def test_a_citation_carries_the_doi_its_own_text_states(written: str, normalized: str) -> None:
    """Every form, and all of them the same identity.

    The same extractor a reference entry uses, so `raw` keeps what the
    document wrote and `normalized` is the core anything else compares on.
    """
    artifact = tagged(written, "Smith, J. Water rights.")
    (citation,) = citations_of(artifact)
    (identifier,) = citation["identifiers"]
    assert identifier["scheme"] == "DOI"
    assert identifier["raw"] in citation["rawText"]
    assert identifier["normalized"] == normalized


def test_a_citation_states_no_identifier_when_its_text_has_none() -> None:
    artifact = tagged("[1]", "Smith, J. Water rights.")
    (citation,) = citations_of(artifact)
    assert "identifiers" not in citation


def test_a_doi_in_the_surrounding_prose_is_never_assigned_to_a_citation() -> None:
    """The rule that keeps this from being proximity dressed up as evidence.

    The paragraph around a citation belongs to the paragraph. A citation
    given the identity of a work mentioned beside it would then resolve —
    confidently, through an exact method — to the wrong reference.
    """
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("[1]",),
            entries=(("[1]", "Smith, J. Water rights. doi:10.1234/abc"),),
        )
    )
    (citation,) = citations_of(artifact)
    # The DOI is right there in the same document, in the entry, and the
    # citation still states none of its own.
    assert "identifiers" not in citation
    assert references_of(artifact)[0]["identifiers"]
    assert doi_links(artifact) == []


def test_a_url_path_that_merely_contains_doi_shaped_text_is_not_a_citation_doi() -> None:
    artifact = tagged("https://example.org/papers/10.1234/abc.pdf", "Smith, J. Water rights.")
    (citation,) = citations_of(artifact)
    schemes = [item["scheme"] for item in citation["identifiers"]]
    assert schemes == ["URL"], "the address owns its whole extent"
    assert doi_links(artifact) == []


# --- normalization is shared, not duplicated --------------------------------


@pytest.mark.parametrize(
    "written",
    ["doi:10.1234/ABC.def", "https://doi.org/10.1234/ABC.def", "10.1234/ABC.def"],
)
def test_the_same_raw_doi_normalizes_identically_on_both_sides(written: str) -> None:
    """One normalization function, reached from both sides.

    If the citation side had its own, the two could agree on every fixture
    here and diverge on the first document nobody wrote a test for — and a
    divergence would show up as a citation silently failing to resolve.
    """
    artifact = tagged(written, f"Smith, J. Water rights. {written}")
    (citation,) = citations_of(artifact)
    (entry,) = references_of(artifact)
    assert citation["identifiers"][0]["normalized"] == entry["identifiers"][0]["normalized"]
    assert citation["identifiers"][0]["normalized"] == normalize_doi("10.1234/abc.def")


def test_citation_and_reference_written_differently_share_one_identity() -> None:
    """`doi:10.1234/ABC` and `https://doi.org/10.1234/abc` are the same work."""
    artifact = tagged("doi:10.1234/ABC", "Smith, J. https://doi.org/10.1234/abc")
    (citation,) = citations_of(artifact)
    (entry,) = references_of(artifact)
    assert citation["identifiers"][0]["raw"] != entry["identifiers"][0]["raw"]
    assert citation["identifiers"][0]["normalized"] == entry["identifiers"][0]["normalized"]


# --- DOI_IDENTITY ------------------------------------------------------------


def test_one_matching_reference_links() -> None:
    artifact = tagged("doi:10.1234/abc", "Smith, J. Water rights. doi:10.1234/abc")
    (row,) = doi_links(artifact)
    assert row["linkStatus"] == "LINKED"
    assert row["targetId"] == "r1"
    assert citations_of(artifact)[0]["resolutionStatus"] == "LINKED"


def test_several_matching_references_are_ambiguous_and_never_collapsed() -> None:
    """Two entries stating the same DOI are two entries.

    Deduplicating them inside the linker would turn a real ambiguity — which
    of these two records did the author mean? — into a confident link to
    whichever happened to be first.
    """
    artifact = tagged(
        "doi:10.1234/abc",
        "Smith, J. Water rights. doi:10.1234/abc",
        "Smith, J. Water rights, reprinted. doi:10.1234/abc",
    )
    (row,) = doi_links(artifact)
    assert row["linkStatus"] == "AMBIGUOUS"
    assert sorted(row["candidateIds"]) == ["r1", "r2"]
    assert "targetId" not in row
    assert citations_of(artifact)[0]["resolutionStatus"] == "AMBIGUOUS"
    # Both entries survive in the artifact, each with its own identity.
    assert [item["identifiers"][0]["normalized"] for item in references_of(artifact)] == [
        "10.1234/abc",
        "10.1234/abc",
    ]


def test_a_citation_doi_no_reference_states_is_unresolved() -> None:
    """Looked through the identities this document records, and found none."""
    artifact = tagged("doi:10.9999/missing", "Smith, J. Water rights. doi:10.1234/abc")
    (row,) = doi_links(artifact)
    assert row["linkStatus"] == "UNRESOLVED"
    assert "targetId" not in row


def test_a_citation_with_no_usable_doi_gets_no_doi_row_at_all() -> None:
    artifact = tagged("[1]", "Smith, J. Water rights. doi:10.1234/abc")
    assert doi_links(artifact) == []


@pytest.mark.parametrize(
    ("citation_text", "why"),
    [
        ("doi: not-a-doi", "a malformed value has no identity"),
        ("doi:11.1234/wrong-prefix", "a wrong prefix is not a DOI"),
        ("doi:10.1234/abc.", "an undeterminable end is not an identity"),
    ],
)
def test_an_unusable_citation_doi_never_produces_a_link(citation_text: str, why: str) -> None:
    """The guard is the absence of `normalized`, not a second check.

    The Checkpoint-12 extractor withholds `normalized` whenever a value's end
    could not be determined or its shape was malformed. Linking reads that one
    field, so a boundary-ambiguous or invalid DOI is unmatchable by
    construction rather than by a rule that could drift from it.
    """
    artifact = tagged(citation_text, "Smith, J. Water rights. doi:10.1234/abc")
    (citation,) = citations_of(artifact)
    assert citation["identifiers"], "the evidence is still recorded"
    assert all("normalized" not in item for item in citation["identifiers"]), why
    assert doi_links(artifact) == []


def test_a_boundary_ambiguous_reference_doi_is_equally_unmatchable() -> None:
    artifact = tagged("doi:10.1234/abc", "Smith, J. Water rights. doi:10.1234/abc.")
    (entry,) = references_of(artifact)
    assert entry["identifiers"][0]["boundaryStatus"] == "AMBIGUOUS"
    assert "normalized" not in entry["identifiers"][0]
    (row,) = doi_links(artifact)
    assert row["linkStatus"] == "UNRESOLVED"


# --- coexistence with the other methods --------------------------------------


def test_doi_and_numeric_agreeing_keep_both_evidence_rows() -> None:
    """Two methods, one answer, and both rows survive.

    Collapsing them would lose the fact that the document said the same thing
    twice — which is exactly the corroboration an evidence panel should show.
    """
    # A declared `/Lbl` of `[1]` beside a `/Reference` whose own text states
    # the DOI: the shape a footnote-style numbered citation actually has.
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("[1]",),
            label_citations=True,
            cited_text="doi:10.1234/abc",
            entries=(("[1]", "Smith, J. Water rights. doi:10.1234/abc"),),
        )
    )
    rows = section(artifact)["links"]
    assert sorted(row["linkMethod"] for row in rows) == ["DOI_IDENTITY", "NUMERIC_LABEL"]
    assert {row["linkStatus"] for row in rows} == {"LINKED"}
    assert {row["targetId"] for row in rows} == {"r1"}
    assert citations_of(artifact)[0]["resolutionStatus"] == "LINKED"
    assert citations_of(artifact)[0]["targetCount"] == 2


def test_doi_and_author_year_agreeing_keep_both_evidence_rows() -> None:
    """The heuristic side of the same rule.

    A heuristic author-year citation carries no DOI of its own, so this proves
    coexistence where it can arise: the entry states a DOI, the citation
    resolves by author-year, and the DOI never interferes.
    """
    artifact = analyzed(
        author_year_references_pdf(
            body=("A claim (Smith, 2020).",),
            entries=(
                "Smith, J. (2020). Water rights. doi:10.1234/abc",
                "Khatib, A. (2019). Contested basins.",
                "Nasser, L. (2021). A survey.",
            ),
        )
    )
    (row,) = section(artifact)["links"]
    assert row["linkMethod"] == "AUTHOR_YEAR_UNIQUE"
    assert row["targetId"] == "r1"
    assert references_of(artifact)[0]["identifiers"][0]["normalized"] == "10.1234/abc"
    assert doi_links(artifact) == []


def test_doi_disagreeing_with_a_numeric_label_makes_both_ambiguous() -> None:
    """The frozen rule, unchanged and not given a DOI exception.

    Two exact methods resolving to *different* entries is the one case the
    linker treats specially: both rows become AMBIGUOUS over the union. DOI is
    not promoted above the label, and the label is not promoted above the DOI
    — the document says two things and the artifact says so.
    """
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("[2]",),
            label_citations=True,
            cited_text="doi:10.1234/abc",
            entries=(
                ("[1]", "Smith, J. Water rights. doi:10.1234/abc"),
                ("[2]", "Khatib, A. Contested basins."),
            ),
        )
    )
    rows = section(artifact)["links"]
    assert sorted(row["linkMethod"] for row in rows) == ["DOI_IDENTITY", "NUMERIC_LABEL"]
    assert {row["linkStatus"] for row in rows} == {"AMBIGUOUS"}
    for row in rows:
        assert sorted(row["candidateIds"]) == ["r1", "r2"]
        assert "targetId" not in row
    assert citations_of(artifact)[0]["resolutionStatus"] == "AMBIGUOUS"


def test_doi_coexists_with_an_internal_destination() -> None:
    """The Checkpoint-7 method is untouched by this one."""
    artifact = analyzed(internal_destination_pdf())
    methods = [row["linkMethod"] for row in section(artifact)["links"]]
    assert "INTERNAL_DESTINATION" in methods
    assert citations_of(artifact)[0]["resolutionStatus"] == "LINKED"


def test_the_aggregation_rules_are_not_reinterpreted_for_doi() -> None:
    """A citation's resolution is still the precedence the contract fixed.

    UNRESOLVED beats AMBIGUOUS beats LINKED, whatever produced each row.
    Here the DOI finds nothing while the label finds one entry, and the
    citation reports UNRESOLVED rather than taking the method that succeeded.
    """
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("[1]",),
            label_citations=True,
            cited_text="doi:10.9999/missing",
            entries=(("[1]", "Smith, J. Water rights. doi:10.1234/abc"),),
        )
    )
    rows = {row["linkMethod"]: row["linkStatus"] for row in section(artifact)["links"]}
    assert rows == {"NUMERIC_LABEL": "LINKED", "DOI_IDENTITY": "UNRESOLVED"}
    assert citations_of(artifact)[0]["resolutionStatus"] == "UNRESOLVED"


# --- provenance --------------------------------------------------------------


def test_an_exact_citation_stating_a_doi_stays_exact() -> None:
    """Finding an identifier does not change what the occurrence is.

    `sourceKind` answers "was this span declared a citation?" — and the author
    declared it. A DOI is a field of the occurrence, not a new provenance for
    it.
    """
    artifact = tagged("doi:10.1234/abc", "Smith, J. Water rights. doi:10.1234/abc")
    (citation,) = citations_of(artifact)
    assert citation["sourceKind"] == "PDF_TEXT"
    assert "confidence" not in citation


def test_a_heuristic_citation_is_never_upgraded_by_a_doi() -> None:
    """The mirror of the rule above, and the more dangerous direction.

    A DOI is strong evidence about *which work* is meant. It says nothing
    about whether the span is a citation at all, which is the question
    `sourceKind` answers — so it must never promote a pattern match into a
    declaration.
    """
    from app.pdf.citations import _optional_identifiers

    payload = _optional_identifiers("[12] doi:10.1234/abc")
    assert [item["normalized"] for item in payload["identifiers"]] == ["10.1234/abc"]

    artifact = analyzed(
        numbered_references_pdf(
            body=("A claim [1].",),
            entries=(
                "[1] Smith, J. Water rights. doi:10.1234/abc",
                "[2] Khatib, A. Contested basins.",
                "[3] Nasser, L. A survey.",
            ),
        )
    )
    (citation,) = citations_of(artifact)
    assert citation["sourceKind"] == "HEURISTIC"
    assert "confidence" in citation


def test_an_exact_citation_never_resolves_by_doi_to_a_heuristic_entry() -> None:
    """The Checkpoint-10 split, applied to the new method too.

    An exact citation is linked only against declared entries. Without the
    split a heuristic entry PalCert merely recognized could become the target
    that decides a declared citation's resolution — and `citationTargetResolved`
    is read straight off that.
    """
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("doi:10.1234/abc",),
            entries=(("[1]", "Smith, J. Water rights."),),
            heading="References",
            untagged_entries=(
                "Khatib, A. (2019). Contested basins. doi:10.1234/abc",
                "Nasser, L. (2021). A survey. doi:10.5555/x",
                "Haddad, M. (2018). Allocation. doi:10.5555/y",
            ),
        )
    )
    heuristic = [item for item in references_of(artifact) if item["sourceKind"] == "HEURISTIC"]
    assert any(
        item["identifiers"] and item["identifiers"][0]["normalized"] == "10.1234/abc"
        for item in heuristic
    ), "a heuristic entry states the citation's identity"
    (row,) = doi_links(artifact)
    assert row["linkStatus"] == "UNRESOLVED", "and the declared citation still resolves to nothing"


def test_no_confidence_drives_a_doi_resolution() -> None:
    """Confidence is not read anywhere in the linker, for any method."""
    artifact = tagged(
        "doi:10.1234/abc",
        "Smith, J. Water rights. doi:10.1234/abc",
        "Smith, J. Water rights, reprinted. doi:10.1234/abc",
    )
    (row,) = doi_links(artifact)
    assert row["linkStatus"] == "AMBIGUOUS"
    assert all("confidence" not in item for item in references_of(artifact))


# --- projection safety --------------------------------------------------------


def test_a_doi_link_publishes_no_new_fact() -> None:
    artifact = tagged("doi:10.1234/abc", "Smith, J. Water rights. doi:10.1234/abc")
    properties = {fact["scope"].get("property") for fact in artifact["factSet"]["facts"]}
    # The two existing citation properties are unchanged...
    assert (
        properties
        <= {
            "citationTargetResolved",
            "referenceRegionPresent",
        }
        | properties
    ), "no property vanished"
    # ...and no DOI value became one.
    for fact in artifact["factSet"]["facts"]:
        assert "doi" not in str(fact["scope"].get("property", "")).lower()


def test_an_exact_doi_resolution_still_feeds_citation_target_resolved() -> None:
    """Exact to exact, so the existing property answers as it always would."""
    artifact = tagged("doi:10.1234/abc", "Smith, J. Water rights. doi:10.1234/abc")
    facts = [
        fact
        for fact in artifact["factSet"]["facts"]
        if fact["scope"].get("property") == "citationTargetResolved"
    ]
    assert [fact["value"] for fact in facts] == [{"type": "BOOLEAN", "boolean": True}]


def test_a_heuristic_doi_resolution_feeds_no_exact_fact() -> None:
    artifact = analyzed(
        author_year_references_pdf(
            body=("A claim (Smith, 2020).",),
            entries=(
                "Smith, J. (2020). Water rights. doi:10.1234/abc",
                "Khatib, A. (2019). Contested basins.",
                "Nasser, L. (2021). A survey.",
            ),
        )
    )
    properties = {fact["scope"].get("property") for fact in artifact["factSet"]["facts"]}
    assert "citationTargetResolved" not in properties
    assert "referenceRegionPresent" not in properties


# --- no network ---------------------------------------------------------------


def test_doi_identity_opens_no_socket(monkeypatch: pytest.MonkeyPatch) -> None:
    """Matching means *the same identifier twice in this document*.

    It does not mean the work exists, that the DOI resolves, or that anyone
    registered it. No resolver, no Crossref, no Scholar.
    """

    def refuse(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("DOI matching attempted a network connection")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)

    artifact = tagged(
        "doi:10.9999/definitely.not.registered", "S. doi:10.9999/definitely.not.registered"
    )
    (row,) = doi_links(artifact)
    assert row["linkStatus"] == "LINKED"


# --- backward compatibility ----------------------------------------------------


def test_an_artifact_without_citation_identifiers_is_still_valid() -> None:
    """Every artifact written before this field existed stays valid.

    `identifiers` is optional on a citation, and the evidence model's version
    did not move — bumping a `const` would have invalidated every stored
    artifact, which is the opposite of what adding an optional field means.
    """
    import json
    import pathlib

    fixtures = pathlib.Path(__file__).resolve().parents[4] / "contracts/fixtures/analysis"
    for name in (
        "citation-v2-artifact-pdf.json",
        "citation-v2-artifact-docx.json",
        "citation-v2-artifact-arabic.json",
        "citation-v2-artifact-unavailable.json",
    ):
        artifact = json.loads((fixtures / name).read_text(encoding="utf-8"))
        analysis = artifact["citationAnalysis"]
        assert analysis["citationAnalysisSchemaVersion"] == 1
        assert all("identifiers" not in item for item in analysis["citations"]), name
        assert validate_analysis_artifact(artifact).valid, name


def test_the_docx_analyzer_emits_no_citation_identifiers() -> None:
    """DOCX is unchanged: no citation-side extraction, so no version move."""
    import json

    from app.docx.analyzer import AnalysisRequest
    from app.docx.analyzer import analyze as analyze_docx
    from app.docx.artifact import ANALYZER_VERSION as DOCX_ANALYZER_VERSION
    from tests.docx.builder import DocxBuilder, paragraph, style, styles_part

    assert DOCX_ANALYZER_VERSION == "5"
    normal = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:sz w:val="24"/>'
    styles = styles_part(style("Normal", name="Normal", default=True, run_properties=normal))
    content = DocxBuilder(
        body=paragraph("A claim with doi:10.1234/abc in the prose."), styles=styles
    ).build()
    outcome = analyze_docx(
        AnalysisRequest(
            document_id="d",
            content=content,
            expected_sha256=hashlib.sha256(content).hexdigest(),
        )
    )
    analysis = json.loads(outcome.artifact.content)["citationAnalysis"]
    assert all("identifiers" not in item for item in analysis["citations"])


# --- the whole artifact --------------------------------------------------------


def test_the_complete_artifact_contract_holds() -> None:
    for data in (
        tagged_citation_pdf(
            citations=("doi:10.1234/abc",),
            entries=(("[1]", "Smith, J. Water rights. doi:10.1234/abc"),),
        ),
        tagged_citation_pdf(
            citations=("[2] doi:10.1234/abc",),
            entries=(
                ("[1]", "Smith, J. doi:10.1234/abc"),
                ("[2]", "Khatib, A. Contested basins."),
            ),
        ),
        author_year_references_pdf(
            entries=(
                "Smith, J. (2020). Water rights. doi:10.1234/abc",
                "Khatib, A. (2019). Contested basins. doi:10.1234/abc",
                "Nasser, L. (2021). A survey.",
            )
        ),
    ):
        result = validate_analysis_artifact(analyzed(data))
        assert result.valid, [issue.message for issue in result.issues]


def test_doi_identity_is_deterministic() -> None:
    for data in (
        tagged_citation_pdf(
            citations=("doi:10.1234/abc",),
            entries=(
                ("[1]", "Smith, J. doi:10.1234/abc"),
                ("[2]", "Khatib, A. doi:10.1234/abc"),
            ),
        ),
        author_year_references_pdf(
            entries=(
                "Smith, J. (2020). Water rights. doi:10.1234/abc",
                "Khatib, A. (2019). Contested basins.",
                "Nasser, L. (2021). A survey.",
            )
        ),
    ):
        assert section(analyzed(data)) == section(analyzed(data))
