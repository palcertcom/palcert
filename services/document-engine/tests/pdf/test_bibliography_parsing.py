"""Structured bibliographic parsing (Phase 18, Checkpoint 12).

Checkpoints 10 and 11 found reference entries; this reads what is inside one.
Nothing here discovers a citation or changes a link — and most of this file
exists to prove that second half.

One rule decides every case: **the raw text is the source of truth, and a
field is emitted only when it is an exact substring of it.** A parsed field is
rendered by an evidence panel as though PalCert read it, so a title assembled
from fragments, a DOI with its punctuation tidied, or a journal inferred from
position would all be PalCert's prose presented as the document's.

Nothing is verified. Every check is offline syntax — no resolver, no Crossref,
no network of any kind — so a well-formed DOI means a well-formed DOI and
never that the work exists.
"""

from __future__ import annotations

import hashlib
import socket
from typing import Any

import pytest

from app.engine.contracts.artifact_contract import validate_analysis_artifact
from app.pdf.analyzer import analyze
from app.pdf.bibliography import (
    find_identifiers,
    normalize_doi,
    normalize_url,
    parse_entry_text,
    parse_title,
)
from tests.pdf.builder import (
    author_year_references_pdf,
    numbered_references_pdf,
    scanned_pdf,
    tagged_citation_pdf,
)

#: An entry of each shape the parser is meant to read.
ENTRIES = (
    "Haddad, M., Salem, R., & Odeh, T. (2021). A survey of allocation. Water Studies, 5(2), 10-22.",
    "Khatib, A., & Nasser, L. (2019). Contested basins. doi:10.1234/rr.2019.7",
    "Smith, J. (2020). Water rights. https://doi.org/10.5555/JP.2020.99",
)


def analyzed(data: bytes) -> dict[str, Any]:
    artifact: dict[str, Any] = analyze(
        data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d"
    )
    return artifact


def references_of(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    return list(artifact["citationAnalysis"]["references"])


def citations_of(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    return list(artifact["citationAnalysis"]["citations"])


#: Two entries that parse cleanly and carry nothing interesting, used to pad
#: a fixture up to the three a region needs. A test that cares about one entry
#: should not have to restate the other two.
FILLER = (
    "Alpha, A. (2001). A first filler work.",
    "Beta, B. (2002). A second filler work.",
)


def entries_from(*entries: str) -> list[dict[str, Any]]:
    """Analyze a reference list, padded to the minimum a region needs."""
    padded = entries if len(entries) >= 3 else (*entries, *FILLER)
    found = references_of(analyzed(author_year_references_pdf(body=(), entries=padded)))
    return found[: len(entries)] if len(entries) < 3 else found


def only_identifier(entry_text: str) -> dict[str, Any]:
    (entry,) = entries_from(entry_text)
    identifiers: list[dict[str, Any]] = entry["identifiers"]
    assert len(identifiers) == 1, identifiers
    return identifiers[0]


# --- identifiers ------------------------------------------------------------


def test_a_bare_doi_is_recorded_without_claiming_the_document_declared_it() -> None:
    """`10.xxxx/...` is distinctive enough to be evidence, not to be a declaration.

    The contract provides `intentEvidence: NONE` for exactly this: a bare
    candidate is recorded, and the artifact says nothing marked it as a DOI
    beyond its own shape.
    """
    identifier = only_identifier("Smith, J. (2020). Water rights. 10.1234/jp.2020.99")
    assert identifier["scheme"] == "DOI"
    assert identifier["raw"] == "10.1234/jp.2020.99"
    assert identifier["normalized"] == "10.1234/jp.2020.99"
    assert identifier["intentEvidence"] == "NONE"
    assert identifier["syntaxStatus"] == "VALID"


def test_a_doi_label_is_recorded_as_an_explicit_declaration() -> None:
    identifier = only_identifier("Smith, J. (2020). Water rights. doi:10.1234/jp.2020.99")
    assert identifier["intentEvidence"] == "LABEL_PREFIX"
    assert identifier["raw"] == "10.1234/jp.2020.99"
    assert identifier["normalized"] == "10.1234/jp.2020.99"


def test_a_resolver_url_keeps_the_url_raw_and_normalizes_to_the_doi_core() -> None:
    """Exactly what the contract's own example asks for.

    `raw` is what the document wrote, resolver and all, so the normalization
    is auditable; `normalized` is the core, because that is the identity
    anything else would match on.
    """
    identifier = only_identifier(
        "Smith, J. (2020). Water rights. https://doi.org/10.5555/JP.2020.99"
    )
    assert identifier["intentEvidence"] == "RESOLVER_HOST"
    assert identifier["raw"] == "https://doi.org/10.5555/JP.2020.99"
    assert identifier["normalized"] == "10.5555/jp.2020.99"


@pytest.mark.parametrize(
    "prefix", ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "HTTPS://DOI.ORG/"]
)
def test_every_resolver_form_normalizes_to_the_same_identity(prefix: str) -> None:
    (identifier,) = find_identifiers(f"Smith, J. (2020). Water. {prefix}10.5555/JP.2020.99")
    assert identifier.normalized == "10.5555/jp.2020.99"


def test_doi_normalization_is_case_folding_and_nothing_else() -> None:
    """Case-insensitive for comparison, so folding preserves identity.

    Percent-decoding does not, so it is left alone: `%2F` and `/` are
    different characters in a suffix and PalCert does not decide which the
    registrant meant.
    """
    assert normalize_doi("10.1234/ABC.def") == "10.1234/abc.def"
    assert normalize_doi("10.1234/a%2Fb") == "10.1234/a%2fb"


@pytest.mark.parametrize(
    "text",
    [
        "Smith, J. (2020). Water rights. doi: not-a-doi at all",
        "Smith, J. (2020). Water rights. doi:11.1234/wrong-prefix",
        "Smith, J. (2020). Water rights. doi:10.12/too-short",
        "Smith, J. (2020). Water rights. doi:10.1234-no-slash",
    ],
)
def test_a_malformed_doi_never_becomes_an_identity(text: str) -> None:
    """The document said "DOI" and then wrote something that is not one.

    That is a real observation, so it is recorded rather than dropped — with
    `syntaxStatus: INVALID` and **no** `normalized` value, so nothing can
    ever match on it.
    """
    identifiers = find_identifiers(text)
    assert identifiers, "an explicit label is evidence even when the value is broken"
    for identifier in identifiers:
        assert identifier.normalized is None
        assert identifier.syntax == "INVALID"


def test_a_doi_shape_with_no_label_and_no_resolver_is_not_invented() -> None:
    """Nothing that is not a DOI becomes one just because digits are nearby."""
    assert find_identifiers("Smith, J. (2020). Water rights. Volume 10.1234 of a series.") == []
    assert find_identifiers("Smith, J. (2020). Pages 10-1234, in a collection.") == []


def test_an_identifier_whose_end_is_undeterminable_carries_no_identity() -> None:
    """A DOI suffix may legitimately end in `.`, `,`, `;`, `)` or `]`.

    The contract says PalCert cannot tell content from sentence punctuation
    and does not guess. So the evidence is kept, the boundary is reported
    AMBIGUOUS, and no identity is claimed — which is what stops an uncertain
    read from ever reaching a link.
    """
    identifier = only_identifier("Smith, J. (2020). Water rights. DOI: 10.1234/jp.2020.99.")
    assert identifier["boundaryStatus"] == "AMBIGUOUS"
    assert "normalized" not in identifier
    assert identifier["raw"] == "10.1234/jp.2020.99."


def test_an_explicit_url_is_extracted_and_safely_normalized() -> None:
    """Scheme and host fold; path, query and fragment are left exactly as written.

    RFC 3986 makes the first two case-insensitive and the rest case-
    *sensitive*, so folding the path would change what the value points at.
    """
    identifier = only_identifier(
        "Smith, J. (2020). Water rights. Retrieved from HTTPS://Example.ORG/a/B?x=Y#Frag"
    )
    assert identifier["scheme"] == "URL"
    assert identifier["intentEvidence"] == "URL_SCHEME"
    assert identifier["normalized"] == "https://example.org/a/B?x=Y#Frag"


def test_a_url_without_a_scheme_is_never_inferred() -> None:
    """Supplying the scheme would be inventing part of the value."""
    assert find_identifiers("Smith, J. (2020). Water rights. See www.example.org/page") == []
    assert find_identifiers("Smith, J. (2020). Water rights. example.org/page") == []


def test_normalize_url_leaves_everything_it_does_not_understand_alone() -> None:
    assert normalize_url("https://Example.org/Path") == "https://example.org/Path"
    # No tracking parameter is stripped, no redirect followed, nothing resolved.
    assert normalize_url("https://x.test/a?utm_source=b") == "https://x.test/a?utm_source=b"


def test_a_url_path_that_looks_like_a_doi_is_not_read_as_one() -> None:
    """Found by re-reading the extractor against an address it had not been shown.

    A URL owns its whole extent. Reading a DOI out of its path would invent an
    identifier the document never stated *and* lose the URL that was really
    there.
    """
    found = find_identifiers(
        "Smith, J. (2020). Water rights. https://example.org/papers/10.1234/abc.pdf"
    )
    assert [(item.scheme, item.raw) for item in found] == [
        ("URL", "https://example.org/papers/10.1234/abc.pdf")
    ]


def test_a_resolver_url_is_one_identifier_and_not_also_a_plain_url() -> None:
    found = find_identifiers("Smith, J. (2020). https://doi.org/10.1234/abc and https://x.test/y")
    assert [item.scheme for item in found] == ["DOI", "URL"]


# --- titles and containers --------------------------------------------------


def test_a_delimitable_title_is_parsed() -> None:
    (entry,) = entries_from("Smith, J. (2020). Water rights. Journal of Policy, 12(3), 45-67.")
    assert entry["title"] == "Water rights"
    assert entry["containerTitle"] == "Journal of Policy"


def test_a_title_the_grammar_cannot_delimit_is_absent() -> None:
    """`Water rights in the U.S. basin.` cuts to `Water rights in the U.S`.

    A mangled title that still looks like one is worse than none, so any
    candidate containing a period is refused outright. The cost is the titles
    that legitimately contain one; the purchase is never publishing a wrong
    one.
    """
    (entry,) = entries_from("Smith, J. (2020). Water rights in the U.S. basin. Journal, 1(1), 2-3.")
    assert "title" not in entry
    assert "containerTitle" not in entry


def test_a_container_is_claimed_only_when_volume_issue_and_pages_confirm_it() -> None:
    """Position alone does not say whether a segment is a journal.

    It could be a publisher, a series, a conference or a thesis institution.
    `Journal of Policy, 12(3), 45-67` says: the volume-issue-pages shape is a
    journal article's and nothing else's.
    """
    (with_shape,) = entries_from("Smith, J. (2020). Water rights. Journal of Policy, 12(3), 45-67.")
    assert with_shape["containerTitle"] == "Journal of Policy"

    (publisher,) = entries_from("Smith, J. (2020). Water rights. Oxford University Press.")
    assert publisher["title"] == "Water rights"
    assert "containerTitle" not in publisher, "a publisher is not a journal"

    (thesis,) = entries_from("Smith, J. (2020). Water rights. PhD thesis, Islamic University.")
    assert "containerTitle" not in thesis


def test_no_title_is_manufactured_merely_because_text_follows_the_year() -> None:
    (entry,) = entries_from("Smith, J. (2020). 12(3).")
    assert "title" not in entry


def test_parse_title_refuses_what_it_cannot_delimit() -> None:
    assert parse_title("x. Water rights. Journal.", after=3)[0] == "Water rights"
    assert parse_title("x. U.S. policy. Journal.", after=3)[0] is None
    assert parse_title("x. 1234. Journal.", after=3)[0] is None
    assert parse_title("x. ", after=3)[0] is None


# --- traceability -----------------------------------------------------------


def test_every_parsed_field_is_an_exact_substring_of_the_raw_text() -> None:
    """The guarantee the whole module rests on, swept over every entry.

    A `normalized` identifier is a case fold of its own `raw`, which is itself
    a substring — so the normalization stays checkable through the value it
    came from.
    """
    for data in (
        author_year_references_pdf(entries=ENTRIES),
        numbered_references_pdf(
            entries=(
                "[1] Smith, J. (2020). Water rights. doi:10.5555/jp.2020.99",
                "[2] Khatib, A. (2019). Contested basins. Regional Review, 3(1), 4-9.",
                "[3] Nasser, L. (2021). A survey. https://example.org/survey",
            )
        ),
    ):
        entries = references_of(analyzed(data))
        assert entries
        for entry in entries:
            raw = entry["rawText"]
            for field in ("title", "containerTitle", "year"):
                if field in entry:
                    assert entry[field] in raw, (field, entry[field])
            for token in entry["authors"]:
                assert token["raw"] in raw
                assert token["normalizedFamily"] == token["raw"].casefold()
            for identifier in entry["identifiers"]:
                assert identifier["raw"] in raw
                if "normalized" in identifier and identifier["scheme"] == "DOI":
                    assert identifier["normalized"] in identifier["raw"].casefold()


def test_raw_text_is_never_rewritten_by_parsing() -> None:
    """Parsing reads; it does not edit what it read."""
    entry_text = "Smith, J. (2020). Water rights. Journal of Policy, 12(3), 45-67."
    (entry,) = entries_from(entry_text)
    assert entry["rawText"] == entry_text


def test_a_field_is_never_read_past_the_stored_raw_text() -> None:
    """A value a reader cannot find in `rawText` is not traceable at all.

    The entry text is bounded before parsing rather than after, so a long
    entry loses the fields beyond the bound instead of carrying unverifiable
    ones.
    """
    from app.pdf.heuristics import MAX_REFERENCE_TEXT_CHARS

    filler = "word " * 300
    long_entry = f"Smith, J. (2020). Water rights. {filler}doi:10.1234/past.the.bound"
    assert len(long_entry) > MAX_REFERENCE_TEXT_CHARS
    (entry,) = entries_from(long_entry)
    assert entry["truncated"] is True
    for identifier in entry["identifiers"]:
        assert identifier["raw"] in entry["rawText"]


# --- parse status -----------------------------------------------------------


def test_an_entry_with_any_parsed_field_is_partial_and_never_parsed() -> None:
    """The contract does not define what a fully parsed entry requires.

    The enum offers `PARSED` and nothing says which fields it promises, so
    claiming it would invent a guarantee. Everything PalCert reads partially
    stays `PARTIAL`.
    """
    for entry in entries_from(*ENTRIES):
        assert entry["parseStatus"] == "PARTIAL"


def test_an_entry_nothing_was_read_from_stays_unparsed() -> None:
    artifact = analyzed(
        numbered_references_pdf(
            entries=(
                "[1] A line with no author, no year and no identifier.",
                "[2] Another such line entirely.",
                "[3] And a third one as well.",
            )
        )
    )
    for entry in references_of(artifact):
        assert entry["parseStatus"] == "UNPARSED"
        assert entry["authors"] == []
        assert entry["identifiers"] == []


# --- numbered bibliographies ------------------------------------------------


def test_a_numbered_entry_with_author_year_structure_is_parsed() -> None:
    """Enrichment, which is a different decision from matchability."""
    artifact = analyzed(
        numbered_references_pdf(
            entries=(
                "[1] Smith, J. (2020). Water rights. doi:10.5555/jp.2020.99",
                "[2] Khatib, A. (2019). Contested basins.",
                "[3] Nasser, L. (2021). A survey.",
            )
        )
    )
    entries = references_of(artifact)
    assert [entry["label"] for entry in entries] == [1, 2, 3]
    assert [entry["year"] for entry in entries] == ["2020", "2019", "2021"]
    assert [entry["title"] for entry in entries] == ["Water rights", "Contested basins", "A survey"]
    assert entries[0]["identifiers"][0]["normalized"] == "10.5555/jp.2020.99"


def test_parsing_a_numbered_entry_does_not_make_it_author_year_matchable() -> None:
    """The separate decision, gated and proved.

    Checkpoint 11 reports NOT_ATTEMPTED for an author-year marker in a thesis
    whose reference list is numbered: there is no author-year population to
    look in. Checkpoint 12 gives those entries a parsed identity, and if that
    quietly made them candidates the same citation would become UNRESOLVED —
    an attempt PalCert never made, reported as one that failed.

    Enriching an entry is not the same decision as making it a candidate.
    """
    artifact = analyzed(
        numbered_references_pdf(
            body=("A claim (Smith, 2020) in a numbered thesis.",),
            entries=(
                "[1] Smith, J. (2020). Water rights.",
                "[2] Khatib, A. (2019). Contested basins.",
                "[3] Nasser, L. (2021). A survey.",
            ),
        )
    )
    # The entry really does carry the identity the citation names...
    assert references_of(artifact)[0]["year"] == "2020"
    assert references_of(artifact)[0]["authors"][0]["normalizedFamily"] == "smith"
    # ...and the citation is still NOT_ATTEMPTED, with no link row.
    (citation,) = [
        item for item in citations_of(artifact) if item.get("citationKind") == "AUTHOR_DATE"
    ]
    assert citation["resolutionStatus"] == "NOT_ATTEMPTED"
    assert artifact["citationAnalysis"]["links"] == []


# --- matching is untouched --------------------------------------------------


def test_no_doi_identity_link_is_ever_emitted() -> None:
    """`DOI_IDENTITY` needs DOI evidence on *both* sides, and a citation has none.

    `CitationOccurrence` is a closed object with no identifier field, so an
    in-text citation cannot carry a DOI at all. The method stays unused rather
    than being fed a DOI derived from nearby prose — which is the one thing
    this checkpoint says not to do.
    """
    for data in (
        author_year_references_pdf(entries=ENTRIES),
        numbered_references_pdf(
            entries=(
                "[1] Smith, J. (2020). Water rights. doi:10.5555/jp.2020.99",
                "[2] Khatib, A. (2019). Basins. doi:10.5555/jp.2020.99",
                "[3] Nasser, L. (2021). A survey.",
            )
        ),
    ):
        artifact = analyzed(data)
        methods = {link["linkMethod"] for link in artifact["citationAnalysis"]["links"]}
        assert "DOI_IDENTITY" not in methods


def test_duplicate_doi_identities_produce_no_link_at_all() -> None:
    """Two entries sharing a DOI, and nothing resolves because of it.

    Both identities are recorded; neither is used to pick a target. A shared
    identifier is exactly the case where a false unique link would be most
    convincing and most wrong.
    """
    artifact = analyzed(
        author_year_references_pdf(
            body=("A claim (Smith, 2020).",),
            entries=(
                "Smith, J. (2020). Water rights. doi:10.5555/shared.doi",
                "Khatib, A. (2019). Contested basins. doi:10.5555/shared.doi",
                "Nasser, L. (2021). A survey of allocation.",
            ),
        )
    )
    normalized = [
        identifier["normalized"]
        for entry in references_of(artifact)
        for identifier in entry["identifiers"]
    ]
    assert normalized == ["10.5555/shared.doi", "10.5555/shared.doi"]
    links = artifact["citationAnalysis"]["links"]
    assert [link["linkMethod"] for link in links] == ["AUTHOR_YEAR_UNIQUE"]
    # Smith is the first entry in this list, and `(Smith, 2020)` resolves to
    # it on the author-year identity — not on the DOI two entries share.
    assert links[0]["targetId"] == "r1"


def test_author_year_matching_is_unchanged() -> None:
    artifact = analyzed(
        author_year_references_pdf(
            body=("A claim (Smith, 2020) and another (Haddad et al., 2021).",), entries=ENTRIES
        )
    )
    found = [item for item in citations_of(artifact) if item.get("citationKind") == "AUTHOR_DATE"]
    assert [item["resolutionStatus"] for item in found] == ["LINKED", "LINKED"]


def test_numeric_matching_is_unchanged() -> None:
    artifact = analyzed(
        numbered_references_pdf(
            body=("A claim [2].",),
            entries=(
                "[1] Smith, J. (2020). Water rights.",
                "[2] Khatib, A. (2019). Contested basins.",
                "[3] Nasser, L. (2021). A survey.",
            ),
        )
    )
    (citation,) = citations_of(artifact)
    assert citation["citationKind"] == "NUMERIC_LABEL"
    assert citation["resolutionStatus"] == "LINKED"
    (link,) = artifact["citationAnalysis"]["links"]
    assert link["linkMethod"] == "NUMERIC_LABEL"
    assert link["targetId"] == "r2"


def test_exact_evidence_is_unchanged() -> None:
    """The default tagged fixture states no identifier, so it carries none."""
    artifact = analyzed(tagged_citation_pdf())
    (entry,) = references_of(artifact)
    assert entry["sourceKind"] == "PDF_TEXT"
    assert entry["parseStatus"] == "UNPARSED"
    assert entry["identifiers"] == []
    assert "title" not in entry
    assert "confidence" not in entry


# --- provenance and projection safety ---------------------------------------


def test_the_bibliographic_grammars_never_run_over_exact_entries() -> None:
    """A declared `/BibEntry` is identified, not parsed.

    Author, year, title and container each need a heuristic grammar, and
    running one over a declared element would attach heuristic output to an
    exact object — the merge Checkpoint 10 forbade.

    A **stated identifier** is the one exception, added in Checkpoint 13. A
    DOI written inside a declared entry is stated outright: there is no
    segmentation to guess at and no sentence to delimit, and without it
    `DOI_IDENTITY` could never compare two declared objects. `parseStatus`
    stays `UNPARSED`, because reading a stated identifier is not parsing the
    work.
    """
    artifact = analyzed(
        tagged_citation_pdf(
            entries=(("[1]", "Smith, J. (2020). Water rights. doi:10.5555/jp.2020.99"),)
        )
    )
    (entry,) = references_of(artifact)
    assert entry["sourceKind"] == "PDF_TEXT"
    assert entry["parseStatus"] == "UNPARSED"
    assert entry["authors"] == []
    assert "year" not in entry
    assert "title" not in entry
    assert "containerTitle" not in entry
    assert "confidence" not in entry
    # ...and the stated DOI is read.
    assert [item["normalized"] for item in entry["identifiers"]] == ["10.5555/jp.2020.99"]


def test_parsed_fields_reach_no_public_fact() -> None:
    artifact = analyzed(author_year_references_pdf(entries=ENTRIES))
    assert references_of(artifact)[0]["identifiers"] or references_of(artifact)[2]["identifiers"]
    properties = {fact["scope"].get("property") for fact in artifact["factSet"]["facts"]}
    assert "citationTargetResolved" not in properties
    assert "referenceRegionPresent" not in properties


def test_every_parsed_entry_still_carries_heuristic_provenance() -> None:
    for entry in entries_from(*ENTRIES):
        assert entry["sourceKind"] == "HEURISTIC"
        assert "confidence" in entry


def test_parsing_adds_no_confidence_of_its_own() -> None:
    """Parsing confidence is not a separate number, and not a link input.

    An entry's confidence describes how sure PalCert is that it *is* a
    reference entry. Reading a DOI out of it does not change that, and no
    field here feeds resolution: a citation links on author-year identity or
    on a numeric label, never on how confidently a title parsed.
    """
    plain = entries_from(
        "Smith, J. (2020). Water rights.",
        "Khatib, A. (2019). Contested basins.",
        "Nasser, L. (2021). A survey.",
    )
    enriched = entries_from(
        "Smith, J. (2020). Water rights. Journal of Policy, 12(3), 45-67. doi:10.1/a",
        "Khatib, A. (2019). Contested basins. Regional Review, 3(1), 4-9. doi:10.1/b",
        "Nasser, L. (2021). A survey of allocation. Water Studies, 5(2), 10-22. doi:10.1/c",
    )
    assert [item["confidence"] for item in plain] == [item["confidence"] for item in enriched]


# --- no network -------------------------------------------------------------


def test_analysis_opens_no_socket(monkeypatch: pytest.MonkeyPatch) -> None:
    """Extraction is parsing, never verification.

    A DOI that parses is a well-formed DOI and nothing more — no resolver, no
    Crossref, no Scholar. Proved by making any outbound connection fail the
    test rather than by reading the code for absent calls.
    """

    def refuse(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("analysis attempted a network connection")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)

    artifact = analyzed(author_year_references_pdf(entries=ENTRIES))
    assert references_of(artifact)[2]["identifiers"][0]["normalized"] == "10.5555/jp.2020.99"


def test_a_syntactically_valid_doi_is_never_called_existent() -> None:
    """`syntaxStatus` is an offline shape check and says nothing more."""
    identifier = only_identifier("Smith, J. (2020). Water. doi:10.9999/definitely.not.registered")
    assert identifier["syntaxStatus"] == "VALID"
    assert identifier["normalized"] == "10.9999/definitely.not.registered"


# --- the whole artifact -----------------------------------------------------


def test_an_image_only_pdf_parses_nothing() -> None:
    artifact = analyzed(scanned_pdf())
    assert references_of(artifact) == []


def test_arabic_behaviour_is_preserved() -> None:
    """Numeric discovery still works; no Arabic name normalization was added.

    A DOI is explicit ASCII whatever language surrounds it, so extraction is
    language-independent — but nothing here transliterates or normalizes an
    Arabic personal name, and nothing tries to.
    """
    from tests.pdf.builder import arabic_numbered_references_pdf

    artifact = analyzed(arabic_numbered_references_pdf())
    entries = references_of(artifact)
    assert [entry["label"] for entry in entries] == [1, 2, 3]
    assert all(entry["authors"] == [] for entry in entries)
    assert all(entry["identifiers"] == [] for entry in entries)


def test_the_complete_artifact_contract_holds() -> None:
    for data in (
        author_year_references_pdf(entries=ENTRIES),
        numbered_references_pdf(
            entries=(
                "[1] Smith, J. (2020). Water rights. doi:10.5555/jp.2020.99",
                "[2] Khatib, A. (2019). Basins. https://example.org/b",
                "[3] Nasser, L. (2021). A survey. DOI: 10.1/c.",
            )
        ),
        tagged_citation_pdf(),
    ):
        result = validate_analysis_artifact(analyzed(data))
        assert result.valid, [issue.message for issue in result.issues]


def test_parsing_is_deterministic() -> None:
    for data in (
        author_year_references_pdf(entries=ENTRIES),
        numbered_references_pdf(
            entries=(
                "[1] Smith, J. (2020). Water rights. doi:10.5555/jp.2020.99",
                "[2] Khatib, A. (2019). Basins. https://example.org/b",
                "[3] Nasser, L. (2021). A survey.",
            )
        ),
    ):
        assert analyzed(data)["citationAnalysis"] == analyzed(data)["citationAnalysis"]


def test_parse_entry_text_without_a_year_reads_identifiers_only() -> None:
    """Position means nothing in an entry PalCert could not find a year in."""
    parsed = parse_entry_text("Some text with doi:10.1234/abc and more prose.", year_end=None)
    assert parsed.title is None
    assert parsed.container_title is None
    assert [item.normalized for item in parsed.identifiers] == ["10.1234/abc"]
