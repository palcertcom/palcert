"""Word-native citation evidence, end to end (Phase 18, Checkpoint 3).

The slice these exercise is the one Word actually supports: a ``CITATION``
field names a key, the key matches a record in the bibliography source store,
and that match is a link. Everything else about citations — what the rendered
text means, whether two entries are the same work, where a typed reference
list begins — is left to a later checkpoint and reported as coverage rather
than guessed at.

Each fixture is built from the OOXML it is meant to test, and every one of
them goes through the real analyzer, so the artifact each assertion reads is
an artifact that already satisfied the complete cross-language contract —
schema *and* citation graph integrity.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import pytest

from app.docx.analyzer import AnalysisRequest, analyze
from app.docx.errors import DocxAnalysisError
from tests.docx.builder import (
    DocxBuilder,
    paragraph,
    section_properties,
    style,
    styles_part,
)

NORMAL = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="24"/>'
STYLES = styles_part(style("Normal", name="Normal", default=True, run_properties=NORMAL))

BIBLIOGRAPHY_NS = "http://schemas.microsoft.com/office/word/2004/10/bibliography"


# --- fixture helpers -------------------------------------------------------


def person(last: str, first: str) -> str:
    return f"<b:Person><b:Last>{last}</b:Last><b:First>{first}</b:First></b:Person>"


def source(tag: str, *, extra: str = "", people: str = "", corporate: str = "") -> str:
    authors = ""
    if people or corporate:
        inner = f"<b:NameList>{people}</b:NameList>" if people else ""
        body = f"<b:Corporate>{corporate}</b:Corporate>" if corporate else ""
        authors = f"<b:Author><b:Author>{body}{inner}</b:Author></b:Author>"
    return (
        f"<b:Source><b:Tag>{tag}</b:Tag><b:SourceType>JournalArticle</b:SourceType>"
        f"<b:Title>Title of {tag}</b:Title><b:Year>2020</b:Year>{authors}{extra}</b:Source>"
    )


def sources_part(*records: str) -> bytes:
    return (
        '<?xml version="1.0"?>'
        f'<b:Sources xmlns:b="{BIBLIOGRAPHY_NS}" SelectedStyle="APA.XSL">'
        f"{''.join(records)}</b:Sources>"
    ).encode()


def citation_field(tag: str, *, rendered: str = "(Author, 2020)") -> str:
    """A complex ``CITATION`` field, the shape Word writes."""
    return (
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        f'<w:r><w:instrText xml:space="preserve"> CITATION {tag} \\l 1033 </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        f"<w:r><w:t>{rendered}</w:t></w:r>"
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    )


def bibliography_field(*entries: str) -> str:
    """A ``BIBLIOGRAPHY`` field and the paragraphs Word rendered into it."""
    head = (
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        '<w:r><w:instrText xml:space="preserve"> BIBLIOGRAPHY </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        f"<w:r><w:t>{entries[0]}</w:t></w:r></w:p>"
    )
    middle = "".join(f"<w:p><w:r><w:t>{entry}</w:t></w:r></w:p>" for entry in entries[1:-1])
    tail = (
        f'<w:p><w:r><w:t>{entries[-1]}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    )
    return head + middle + tail


def analyze_docx(body: str, **kwargs: Any) -> dict[str, Any]:
    kwargs.setdefault("styles", STYLES)
    content = DocxBuilder(body=body, **kwargs).build()
    outcome = analyze(
        AnalysisRequest(
            document_id="doc",
            content=content,
            expected_sha256=hashlib.sha256(content).hexdigest(),
        )
    )
    envelope: dict[str, Any] = json.loads(outcome.artifact.content)
    return envelope


def citation_analysis(body: str, **kwargs: Any) -> dict[str, Any]:
    section: dict[str, Any] = analyze_docx(body, **kwargs)["citationAnalysis"]
    return section


def with_store(*records: str, path: str = "customXml/item1.xml") -> dict[str, Any]:
    """Builder arguments carrying a source store at ``path``."""
    return {
        "extra_relationships": {"rIdCustom1": ("customXml", f"../{path}")},
        "raw_parts": {path: sources_part(*records)},
    }


def coverage_of(analysis: dict[str, Any], domain: str) -> dict[str, Any]:
    entry: dict[str, Any] = next(item for item in analysis["coverage"] if item["domain"] == domain)
    return entry


# --- the minimal slice -----------------------------------------------------


def test_a_native_citation_links_to_the_source_it_names() -> None:
    """Citation → source → link, all of it exact.

    The tag in the field instruction and the tag in the source store are the
    same string or they are not. Nothing here scores, ranks or approximates.
    """
    analysis = citation_analysis(citation_field("Smi20"), **with_store(source("Smi20")))

    (citation,) = analysis["citations"]
    assert citation["sourceKind"] == "OOXML"
    assert citation["citationKind"] == "WORD_NATIVE_FIELD"
    assert citation["parseMethod"] == "FIELD_INSTRUCTION"
    assert citation["nativeTag"] == "Smi20"
    assert citation["resolutionStatus"] == "LINKED"
    assert citation["targetCount"] == 1

    (record,) = analysis["bibliographySources"]
    assert record["tag"] == "Smi20"
    assert record["citedByCount"] == 1

    (link,) = analysis["links"]
    assert link == {
        "citationId": citation["id"],
        "linkMethod": "NATIVE_TAG",
        "linkStatus": "LINKED",
        "targetId": record["id"],
        "candidateCount": 0,
    }


def test_the_simple_field_form_is_read_too() -> None:
    """Word writes ``w:fldSimple`` as well, and it means the same thing."""
    body = '<w:p><w:fldSimple w:instr=" CITATION Smi20 \\l 1033 "><w:r><w:t>(S, 20)</w:t></w:r></w:fldSimple></w:p>'
    analysis = citation_analysis(body, **with_store(source("Smi20")))
    (citation,) = analysis["citations"]
    assert citation["nativeTag"] == "Smi20"
    assert citation["resolutionStatus"] == "LINKED"


def test_a_tag_no_source_matches_is_unresolved_not_absent() -> None:
    """ "We looked and found nothing" is a different answer from "we did not look"."""
    analysis = citation_analysis(citation_field("Gone99"), **with_store(source("Smi20")))

    (citation,) = analysis["citations"]
    assert citation["resolutionStatus"] == "UNRESOLVED"
    (link,) = analysis["links"]
    assert link["linkStatus"] == "UNRESOLVED"
    # The method it tried is still named: an attempt that failed is evidence.
    assert link["linkMethod"] == "NATIVE_TAG"
    assert "targetId" not in link


def test_two_sources_sharing_a_tag_make_the_link_ambiguous() -> None:
    """A tag that names two records is not an identity in this document.

    PalCert names every candidate and picks none — picking the first would be
    a coin toss recorded as a fact.
    """
    analysis = citation_analysis(
        citation_field("Smi20"),
        **with_store(source("Smi20"), source("Smi20", extra="<b:Publisher>Other</b:Publisher>")),
    )

    (citation,) = analysis["citations"]
    assert citation["resolutionStatus"] == "AMBIGUOUS"
    (link,) = analysis["links"]
    assert link["linkStatus"] == "AMBIGUOUS"
    assert link["candidateIds"] == ["s1", "s2"]
    assert link["candidateCount"] == 2
    assert "targetId" not in link

    assert coverage_of(analysis, "NATIVE_SOURCE_RESOLUTION") == {
        "domain": "NATIVE_SOURCE_RESOLUTION",
        "status": "PARTIAL",
        "reasonCode": "DUPLICATE_SOURCE_TAGS",
    }


def test_an_ambiguous_tag_credits_neither_source() -> None:
    """A citation that could not choose is not a citation of both.

    Counted by tag, one citation would show as citing two sources once each,
    and a panel would say the document cites two works it cites once.
    """
    analysis = citation_analysis(
        citation_field("Smi20"),
        **with_store(source("Smi20"), source("Smi20", extra="<b:Publisher>Other</b:Publisher>")),
    )
    assert [record["citedByCount"] for record in analysis["bibliographySources"]] == [0, 0]


def test_an_uncited_source_is_not_credited_either() -> None:
    analysis = citation_analysis(
        citation_field("Smi20"), **with_store(source("Smi20"), source("Kha19"))
    )
    counts = {record["tag"]: record["citedByCount"] for record in analysis["bibliographySources"]}
    assert counts == {"Smi20": 1, "Kha19": 0}


def test_rendered_entries_are_not_reported_as_uncited() -> None:
    """Nothing links a citation to a rendered entry in this checkpoint.

    So no entry has been *observed* to be uncited, and saying three were would
    turn "we did not look" into a finding somebody would act on.
    """
    analysis = citation_analysis(
        citation_field("Smi20") + bibliography_field("Smith, J.", "Khatib, A.", "Zahran, M."),
        **with_store(source("Smi20")),
    )
    assert analysis["summary"]["observedReferenceCount"] == 3
    assert analysis["summary"]["observedUncitedReferenceCount"] == 0


def test_a_citation_naming_no_key_is_recorded_and_not_linked() -> None:
    body = (
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        '<w:r><w:instrText xml:space="preserve"> CITATION \\l 1033 </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    )
    analysis = citation_analysis(body, **with_store(source("Smi20")))

    (citation,) = analysis["citations"]
    assert "nativeTag" not in citation
    # Read completely, and it yielded no identity. That is PARTIAL, not a
    # failure to parse.
    assert citation["parseStatus"] == "PARTIAL"
    assert citation["resolutionStatus"] == "NOT_ATTEMPTED"
    assert citation["targetCount"] == 0
    assert analysis["links"] == []


# --- finding the source store ----------------------------------------------


def test_the_store_is_found_by_its_root_element_not_by_its_path() -> None:
    """Nothing in the package says "bibliography".

    The part arrives under an ordinary ``customXml`` relationship, and
    ``customXml/item1.xml`` is a convention Word follows and other producers
    do not. What identifies it is its own root element.
    """
    analysis = citation_analysis(
        citation_field("Smi20"),
        **with_store(source("Smi20"), path="parts/references-data.xml"),
    )
    assert [record["tag"] for record in analysis["bibliographySources"]] == ["Smi20"]
    assert analysis["citations"][0]["resolutionStatus"] == "LINKED"


def test_custom_xml_that_is_not_a_source_store_is_left_alone() -> None:
    """A document may carry any custom XML at all. Most of it is not this."""
    analysis = citation_analysis(
        citation_field("Smi20"),
        extra_relationships={"rIdCustom1": ("customXml", "../customXml/item1.xml")},
        raw_parts={
            "customXml/item1.xml": b'<?xml version="1.0"?><properties><x>1</x></properties>'
        },
    )
    assert analysis["bibliographySources"] == []
    # Proven absent: zero sources is a true zero, so the count is COMPLETE.
    assert coverage_of(analysis, "NATIVE_BIBLIOGRAPHY_SOURCES")["status"] == "COMPLETE"


def test_no_store_at_all_means_the_citation_was_never_looked_up() -> None:
    analysis = citation_analysis(citation_field("Smi20"))

    (citation,) = analysis["citations"]
    assert citation["resolutionStatus"] == "NOT_ATTEMPTED"
    assert analysis["links"] == []
    assert coverage_of(analysis, "NATIVE_BIBLIOGRAPHY_SOURCES")["status"] == "COMPLETE"
    assert coverage_of(analysis, "NATIVE_SOURCE_RESOLUTION") == {
        "domain": "NATIVE_SOURCE_RESOLUTION",
        "status": "UNAVAILABLE",
        "reasonCode": "SOURCE_STORE_ABSENT",
    }


def test_two_source_stores_leave_the_count_unavailable() -> None:
    """Which one do this document's citations resolve against?

    There is no answer, so there is no count — summing them would invent a set
    the document does not have.
    """
    analysis = citation_analysis(
        citation_field("Smi20"),
        extra_relationships={
            "rIdCustom1": ("customXml", "../customXml/item1.xml"),
            "rIdCustom2": ("customXml", "../customXml/item2.xml"),
        },
        raw_parts={
            "customXml/item1.xml": sources_part(source("Smi20")),
            "customXml/item2.xml": sources_part(source("Kha19")),
        },
    )
    assert analysis["bibliographySources"] == []
    assert analysis["links"] == []
    assert analysis["summary"]["bibliographySourceCount"] == 0
    assert coverage_of(analysis, "NATIVE_BIBLIOGRAPHY_SOURCES")["status"] == "UNAVAILABLE"
    assert analysis["citations"][0]["resolutionStatus"] == "NOT_ATTEMPTED"


def test_an_unreadable_custom_xml_part_is_not_a_confident_zero() -> None:
    """It might have been the store. Saying "no sources" would be a guess."""
    analysis = citation_analysis(
        citation_field("Smi20"),
        extra_relationships={"rIdCustom1": ("customXml", "../customXml/item1.xml")},
        raw_parts={"customXml/item1.xml": b"<b:Sources not closed"},
    )
    assert analysis["bibliographySources"] == []
    assert coverage_of(analysis, "NATIVE_BIBLIOGRAPHY_SOURCES") == {
        "domain": "NATIVE_BIBLIOGRAPHY_SOURCES",
        "status": "UNAVAILABLE",
        "reasonCode": "SOURCE_STORE_UNREADABLE",
    }


def test_an_unreadable_store_does_not_make_the_citation_count_partial() -> None:
    """Two domains, two answers.

    Every citation was read; only the source set is in doubt. Letting an
    unreadable custom XML part drop the native citation count to PARTIAL would
    withhold a number PalCert knows exactly, for a reason that is about a
    different part of the document.
    """
    analysis = citation_analysis(
        citation_field("Smi20"),
        extra_relationships={"rIdCustom1": ("customXml", "../customXml/item1.xml")},
        raw_parts={"customXml/item1.xml": b"<b:Sources not closed"},
    )
    assert coverage_of(analysis, "NATIVE_CITATIONS")["status"] == "COMPLETE"
    assert coverage_of(analysis, "NATIVE_BIBLIOGRAPHY_SOURCES")["status"] == "UNAVAILABLE"
    assert analysis["summary"]["nativeCitationCount"] == 1


def test_an_unreadable_story_part_does_make_the_citation_count_partial() -> None:
    """The count is a lower bound now, and the coverage has to say so.

    A partial count is a *wrong* value rather than a missing one, so the
    projector this feeds must refuse to emit it — which it can only do if the
    artifact reports the truth here.
    """
    header_reference = (
        '<w:headerReference w:type="default" '
        'r:id="rIdHeaderdefault" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>'
    )
    analysis = citation_analysis(
        citation_field("Smi20") + section_properties(extra=header_reference),
        headers={"default": "<placeholder/>"},
        raw_parts={"word/header_default.xml": b"<w:hdr not closed"},
    )
    assert coverage_of(analysis, "NATIVE_CITATIONS") == {
        "domain": "NATIVE_CITATIONS",
        "status": "PARTIAL",
        "reasonCode": "STORY_PART_UNREADABLE",
    }


def test_a_source_without_a_tag_is_not_a_link_target() -> None:
    """Nothing can cite it by tag, so it is not recorded as something that can be."""
    untagged = "<b:Source><b:Title>No tag here</b:Title><b:Year>2020</b:Year></b:Source>"
    analysis = citation_analysis(citation_field("Smi20"), **with_store(untagged, source("Smi20")))
    assert [record["tag"] for record in analysis["bibliographySources"]] == ["Smi20"]


# --- what a source record carries ------------------------------------------


def test_a_resolver_url_doi_is_normalized_to_its_core() -> None:
    """``https://doi.org/10.1/x`` and ``10.1/x`` are one identifier, written twice.

    The Phase 4 matcher recognizes only the core, so the raw form is kept for
    audit and the core is what an identity comparison would use.
    """
    analysis = citation_analysis(
        citation_field("Smi20"),
        **with_store(source("Smi20", extra="<b:DOI>https://doi.org/10.1234/jh.2020.7</b:DOI>")),
    )
    (identifier,) = analysis["bibliographySources"][0]["identifiers"]
    assert identifier["scheme"] == "DOI"
    assert identifier["raw"] == "https://doi.org/10.1234/jh.2020.7"
    assert identifier["normalized"] == "10.1234/jh.2020.7"
    assert identifier["syntaxStatus"] == "VALID"


def test_an_identifier_from_its_own_element_has_no_boundary_problem() -> None:
    """The trailing-punctuation problem does not arise here, and that is the point.

    A DOI read out of a sentence can end in ``.`` or ``)`` that may or may not
    be part of it. A DOI that arrived in a ``b:DOI`` element ends where the
    element ends, and Word labelled what it is.
    """
    analysis = citation_analysis(
        citation_field("Smi20"),
        **with_store(source("Smi20", extra="<b:DOI>10.1234/jh.2020.7.</b:DOI>")),
    )
    (identifier,) = analysis["bibliographySources"][0]["identifiers"]
    assert identifier["boundaryStatus"] == "UNAMBIGUOUS"
    assert identifier["intentEvidence"] == "LABEL_PREFIX"
    assert identifier["normalized"] == "10.1234/jh.2020.7."


def test_a_standard_number_becomes_an_identifier_only_when_its_shape_decides() -> None:
    issn = citation_analysis(
        citation_field("A"),
        **with_store(source("A", extra="<b:StandardNumber>0378-5955</b:StandardNumber>")),
    )
    assert issn["bibliographySources"][0]["identifiers"][0]["scheme"] == "ISSN"

    neither = citation_analysis(
        citation_field("A"),
        **with_store(source("A", extra="<b:StandardNumber>report 17/b</b:StandardNumber>")),
    )
    # Not an ISBN, not an ISSN, so not an identifier — rather than a guessed one.
    assert neither["bibliographySources"][0]["identifiers"] == []


def test_author_particles_stay_attached() -> None:
    """Splitting "van Dijk" into "Dijk" is how an exact author match is lost."""
    analysis = citation_analysis(
        citation_field("A"),
        **with_store(source("A", people=person("van Dijk", "Teun"))),
    )
    (author,) = analysis["bibliographySources"][0]["authors"]
    assert author["raw"] == "Teun van Dijk"
    assert author["normalizedFamily"] == "van dijk"
    assert author["corporate"] is False


def test_a_corporate_author_has_no_family_name_invented_for_it() -> None:
    analysis = citation_analysis(citation_field("A"), **with_store(source("A", corporate="UNESCO")))
    (author,) = analysis["bibliographySources"][0]["authors"]
    assert author == {"raw": "UNESCO", "corporate": True}


# --- the story domain ------------------------------------------------------


def test_a_citation_in_a_footnote_is_recorded_as_a_footnote_citation() -> None:
    """A citation in a footnote is not a citation in the body (§22)."""
    notes = (
        '<?xml version="1.0"?>'
        '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<w:footnote w:id="1">{citation_field("Smi20")}</w:footnote>'
        "</w:footnotes>"
    )
    analysis = citation_analysis(paragraph("Body."), footnotes=notes, **with_store(source("Smi20")))
    (citation,) = analysis["citations"]
    assert citation["location"]["story"] == "FOOTNOTE"
    assert citation["resolutionStatus"] == "LINKED"


def test_a_deleted_citation_is_not_a_citation_in_the_document() -> None:
    """The analyzer's view is FINAL (§55).

    A citation somebody removed is not one the reader will see, and counting
    it would make the native citation count — the one thing here that is meant
    to be exact — a count of something else.
    """
    deleted = (
        '<w:p><w:del><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        '<w:r><w:instrText xml:space="preserve"> CITATION Old01 </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:del></w:p>'
    )
    analysis = citation_analysis(citation_field("Smi20") + deleted, **with_store(source("Smi20")))
    assert [citation["nativeTag"] for citation in analysis["citations"]] == ["Smi20"]
    assert analysis["summary"]["nativeCitationCount"] == 1


# --- the reference region --------------------------------------------------


def test_a_bibliography_field_yields_the_entries_word_rendered() -> None:
    body = paragraph("A claim.") + bibliography_field(
        "Smith, J. (2020). Water rights.",
        "Khatib, A. (2019). Aquifers.",
        "Zahran, M. (2021). Rainfall.",
    )
    analysis = citation_analysis(body)

    assert [reference["rawText"] for reference in analysis["references"]] == [
        "Smith, J. (2020). Water rights.",
        "Khatib, A. (2019). Aquifers.",
        "Zahran, M. (2021). Rainfall.",
    ]
    for reference in analysis["references"]:
        assert reference["parseMethod"] == "WORD_BIBLIOGRAPHY_FIELD"
        # The text is whatever the citation style produced. Nothing is parsed
        # out of it, so nothing is claimed about it.
        assert reference["parseStatus"] == "UNPARSED"
        assert reference["identifiers"] == []
        assert reference["authors"] == []

    assert analysis["summary"]["referenceRegionObserved"] is True
    assert coverage_of(analysis, "REFERENCE_REGION")["status"] == "COMPLETE"


def test_a_linked_entry_does_not_cut_the_reference_list_short() -> None:
    """Fields nest, and Word nests a ``HYPERLINK`` inside a bibliography often.

    The inner field's ``end`` character must close the inner field. Letting it
    close the bibliography would silently truncate the reference list at its
    first linked entry and leave the rest of the document looking like
    ordinary prose.
    """
    linked_entry = (
        "<w:p><w:r><w:t>Khatib, A. (2019). Aquifers. </w:t></w:r>"
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        '<w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.org/a" '
        "</w:instrText></w:r>"
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        "<w:r><w:t>example.org/a</w:t></w:r>"
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    )
    body = (
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        '<w:r><w:instrText xml:space="preserve"> BIBLIOGRAPHY </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        "<w:r><w:t>Smith, J. (2020). Water rights.</w:t></w:r></w:p>"
        + linked_entry
        + "<w:p><w:r><w:t>Zahran, M. (2021). Rainfall.</w:t></w:r>"
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' + paragraph("Appendix A follows.")
    )
    analysis = citation_analysis(body)
    assert [reference["rawText"] for reference in analysis["references"]] == [
        "Smith, J. (2020). Water rights.",
        "Khatib, A. (2019). Aquifers. example.org/a",
        "Zahran, M. (2021). Rainfall.",
    ]


def test_text_after_the_field_is_not_part_of_the_reference_list() -> None:
    body = bibliography_field("Smith, J. (2020).", "Khatib, A. (2019).") + paragraph(
        "Appendix A follows."
    )
    analysis = citation_analysis(body)
    assert [reference["rawText"] for reference in analysis["references"]] == [
        "Smith, J. (2020).",
        "Khatib, A. (2019).",
    ]


def test_no_bibliography_field_is_not_evidence_that_there_is_no_region() -> None:
    """Positive-only evidence.

    A reference list somebody typed by hand is invisible to this test, so its
    absence says nothing — and a domain that answered "no region" would let a
    rule fail a document for a list PalCert merely did not find.
    """
    analysis = citation_analysis(paragraph("References") + paragraph("Smith, J. (2020)."))
    assert analysis["references"] == []
    assert analysis["summary"]["referenceRegionObserved"] is False
    assert coverage_of(analysis, "REFERENCE_REGION") == {
        "domain": "REFERENCE_REGION",
        "status": "UNAVAILABLE",
        "reasonCode": "NOT_IMPLEMENTED",
    }


# --- Arabic ----------------------------------------------------------------


def test_arabic_evidence_survives_intact() -> None:
    analysis = citation_analysis(
        citation_field("مرجع١", rendered="(الخطيب، ٢٠١٩)")
        + bibliography_field("الخطيب، أحمد. (٢٠١٩). المياه الجوفية."),
        **with_store(source("مرجع١", people=person("الخطيب", "أحمد"))),
    )
    (citation,) = analysis["citations"]
    assert citation["nativeTag"] == "مرجع١"
    assert citation["resolutionStatus"] == "LINKED"
    assert analysis["references"][0]["rawText"] == "الخطيب، أحمد. (٢٠١٩). المياه الجوفية."
    assert analysis["bibliographySources"][0]["authors"][0]["raw"] == "أحمد الخطيب"


# --- what this evidence is, and is not -------------------------------------


def test_the_whole_document_is_one_consistent_graph() -> None:
    """Every fixture above already proved this, because ``analyze`` asserts it.

    Stated once explicitly so the reason the other tests can trust their
    artifact is visible: an artifact whose citation graph is inconsistent is a
    failed analysis, not a stored record of one.
    """
    analysis = citation_analysis(
        citation_field("Smi20") + citation_field("Gone99") + bibliography_field("Smith, J."),
        **with_store(source("Smi20")),
    )
    statuses = [citation["resolutionStatus"] for citation in analysis["citations"]]
    assert statuses == ["LINKED", "UNRESOLVED"]
    assert analysis["summary"]["linkedCitationCount"] == 1
    assert analysis["summary"]["unresolvedCitationCount"] == 1
    assert analysis["summary"]["observedCitationCount"] == 2


def test_only_four_properties_cross_into_the_fact_set() -> None:
    """The artifact carries much more evidence than the engine may read.

    Tags, rendered entries, identifiers, link candidates and every advisory
    count stay in the artifact. Four properties become facts, and the
    projection suite proves each of them; this one proves the boundary.
    """
    envelope = analyze_docx(
        citation_field("Smi20") + bibliography_field("Smith, J. (2020)."),
        **with_store(source("Smi20", extra="<b:DOI>10.1234/x</b:DOI>")),
    )
    assert envelope["citationAnalysis"]["references"]
    assert envelope["citationAnalysis"]["bibliographySources"][0]["identifiers"]

    projected = {
        fact["scope"].get("property")
        for fact in envelope["factSet"]["facts"]
        if fact["scope"].get("elementType") == "CITATION"
        or str(fact["scope"].get("property", "")).startswith(("native", "referenceRegion"))
    }
    assert projected == {
        "nativeCitationCount",
        "nativeBibliographySourceCount",
        "nativeSourceResolved",
        "referenceRegionPresent",
    }
    # Nothing about a rendered reference entry is ever a fact.
    element_types = {fact["scope"].get("elementType") for fact in envelope["factSet"]["facts"]}
    assert "REFERENCE_ENTRY" not in element_types


def test_the_citation_tag_stays_out_of_the_structural_model() -> None:
    """The tag is a key somebody typed into Word's source manager.

    It is user content, and the structural model is rendered into the artifact
    wholesale. The contract bounds it inside ``citationAnalysis``; nothing
    else may carry it.
    """
    envelope = analyze_docx(citation_field("Smi20"), **with_store(source("Smi20")))
    model = json.dumps(envelope["structuralModel"], ensure_ascii=False)
    assert "Smi20" not in model
    assert envelope["citationAnalysis"]["citations"][0]["nativeTag"] == "Smi20"


def test_the_same_document_analyzes_to_the_same_bytes() -> None:
    kwargs = with_store(source("Smi20", extra="<b:DOI>10.1234/x</b:DOI>"))
    body = citation_field("Smi20") + bibliography_field("Smith, J. (2020).")
    content = DocxBuilder(body=body, styles=STYLES, **kwargs).build()
    digest = hashlib.sha256(content).hexdigest()

    first = analyze(AnalysisRequest(document_id="d", content=content, expected_sha256=digest))
    second = analyze(AnalysisRequest(document_id="d", content=content, expected_sha256=digest))
    assert first.artifact.sha256 == second.artifact.sha256


def test_a_malformed_package_still_fails_as_a_package() -> None:
    """Citation analysis must not turn a broken document into a readable one."""
    with pytest.raises(DocxAnalysisError):
        analyze(AnalysisRequest(document_id="d", content=b"not a zip", expected_sha256="0" * 64))
