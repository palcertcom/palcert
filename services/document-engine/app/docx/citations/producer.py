"""Assembling one document's ``citationAnalysis`` (Phase 18, Checkpoint 3).

Everything here is deterministic reading. Word's own ``CITATION`` fields, its
own source store, its own ``BIBLIOGRAPHY`` field result — and a link only when
one tag matches one source tag exactly. There is no pattern matching over
prose, no classifier, no scoring and no network call.

The section this produces is **advisory**. The rule engine never reads it:
evidence becomes authority only by being projected into a fact through the
Phase 18 projector allow-list, and Checkpoint 3 ships no projector. What the
coverage entries here are for is the decision that projector will have to
make — a count under anything but COMPLETE coverage is a wrong number, not a
missing one, so it must not be emitted at all.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.docx.citations.evidence import (
    BibliographyFieldMarker,
    NativeCitationField,
    RenderedReferenceParagraph,
)
from app.docx.citations.sources import (
    BibliographySourceRecord,
    SourceStore,
    SourceStoreStatus,
)
from app.docx.nodes import NodeLocator, Story

#: The evidence model's own version, independent of the artifact envelope.
CITATION_ANALYSIS_SCHEMA_VERSION = 1

#: Matches the Phase 4 fact location version: the same addresses, so a later
#: projector does not have to translate between two location models.
LOCATION_SCHEMA_VERSION = 1

#: Contract bounds, reproduced so evidence is trimmed rather than failing the
#: artifact contract after everything else succeeded.
MAX_CITATIONS = 20_000
MAX_REFERENCES = 5_000
MAX_REFERENCE_TEXT_CHARS = 1_200
MAX_CANDIDATES = 10

#: Stories whose citations count as citations in the document. Comments are
#: deliberately absent: a citation somebody suggested in a comment is not one
#: the document makes, and the structural walk never enters them either.
_EVIDENCE_STORIES = {
    Story.MAIN_DOCUMENT,
    Story.HEADER,
    Story.FOOTER,
    Story.FOOTNOTE,
    Story.ENDNOTE,
    Story.TEXTBOX,
}


class CoverageDomain:
    NATIVE_CITATIONS = "NATIVE_CITATIONS"
    NATIVE_BIBLIOGRAPHY_SOURCES = "NATIVE_BIBLIOGRAPHY_SOURCES"
    NATIVE_SOURCE_RESOLUTION = "NATIVE_SOURCE_RESOLUTION"
    SEMANTIC_CITATIONS = "SEMANTIC_CITATIONS"
    SEMANTIC_REFERENCE_ENTRIES = "SEMANTIC_REFERENCE_ENTRIES"
    REFERENCE_REGION = "REFERENCE_REGION"


@dataclass(frozen=True, slots=True)
class CitationEvidenceInput:
    """Everything the producer reads, gathered by the walk and the package."""

    citation_fields: tuple[NativeCitationField, ...]
    bibliography_fields: tuple[BibliographyFieldMarker, ...]
    reference_paragraphs: tuple[RenderedReferenceParagraph, ...]
    store: SourceStore
    #: True when a part the walk needed could not be read, which makes the
    #: native citation count a lower bound rather than an exact number.
    stories_incomplete: bool = False


def build_citation_analysis(evidence: CitationEvidenceInput) -> dict[str, Any]:
    """The ``citationAnalysis`` section, ready for the artifact contract."""
    eligible = _eligible_citation_fields(evidence)
    citations = _citations(eligible)
    sources = _sources(evidence.store)
    links = _links(citations, evidence.store, sources)
    _apply_link_results(citations, links)
    _apply_cited_by(sources, links)
    references = _references(evidence)

    # Counted from what was eligible, not from everything the walk saw: a
    # document whose only extra citations were deleted ones is not truncated,
    # and flagging it would drop the count's coverage for no reason.
    citations_truncated = len(eligible) > MAX_CITATIONS
    references_truncated = (
        sum(1 for paragraph in evidence.reference_paragraphs if paragraph.in_document)
        > MAX_REFERENCES
    )

    return {
        "citationAnalysisSchemaVersion": CITATION_ANALYSIS_SCHEMA_VERSION,
        "coverage": _coverage(
            evidence,
            citations_truncated=citations_truncated,
            references_truncated=references_truncated,
        ),
        "citations": [_citation_json(citation) for citation in citations],
        "references": references,
        "bibliographySources": sources,
        "links": links,
        "summary": _summary(
            evidence,
            citations=citations,
            references=references,
            sources=sources,
            citations_truncated=citations_truncated,
            references_truncated=references_truncated,
        ),
    }


# --- citations --------------------------------------------------------------


@dataclass(slots=True)
class _Citation:
    id: str
    ordinal: int
    tag: str | None
    locator: NodeLocator
    target_count: int = 0
    resolution_status: str = "NOT_ATTEMPTED"


def _eligible_citation_fields(
    evidence: CitationEvidenceInput,
) -> list[NativeCitationField]:
    """The fields that are citations in the document as it now reads."""
    return [
        field
        for field in evidence.citation_fields
        if field.in_document and field.locator.story in _EVIDENCE_STORIES
    ]


def _citations(fields: list[NativeCitationField]) -> list[_Citation]:
    return [
        _Citation(
            id=f"c{index}",
            ordinal=index,
            tag=field.tag,
            locator=field.locator,
        )
        for index, field in enumerate(fields[:MAX_CITATIONS], start=1)
    ]


def _citation_json(citation: _Citation) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": citation.id,
        "ordinal": citation.ordinal,
        "sourceKind": "OOXML",
        "citationKind": "WORD_NATIVE_FIELD",
        "parseMethod": "FIELD_INSTRUCTION",
        # The instruction either named a key or it did not. PARTIAL is the
        # honest answer for a CITATION field carrying only switches: it was
        # read completely and yielded no identity.
        "parseStatus": "PARSED" if citation.tag else "PARTIAL",
        "location": _location(citation.locator),
        # The rendered form of a native citation is whatever the citation
        # style produced, and this slice does not capture it. Its identity is
        # the tag, which is carried below and nowhere else.
        "rawText": "",
        "targetCount": citation.target_count,
        "resolutionStatus": citation.resolution_status,
        "truncated": False,
    }
    if citation.tag:
        payload["nativeTag"] = citation.tag
    return payload


def _location(locator: NodeLocator) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "locationSchemaVersion": LOCATION_SCHEMA_VERSION,
        "nodeId": locator.node_id,
        "story": str(locator.story),
    }
    if locator.path:
        payload["path"] = list(locator.path[:32])
    return payload


# --- sources ----------------------------------------------------------------


def _sources(store: SourceStore) -> list[dict[str, Any]]:
    if store.status is not SourceStoreStatus.EXACT:
        # An inexact store contributes no records at all. Listing the ones
        # that happened to be readable would present a partial set as the
        # document's set.
        return []
    return [_source_json(record, index) for index, record in enumerate(store.sources, start=1)]


def _apply_cited_by(sources: list[dict[str, Any]], links: list[dict[str, Any]]) -> None:
    """Count citations against the source each one actually resolved to.

    Counted from the links rather than from matching tags, because those two
    differ in exactly the case that matters: when a tag names two records,
    counting by tag credits the citation to both, and a panel would show two
    sources each cited once by one citation. A link that could not choose
    credits neither, which is what "PalCert could not tell" looks like as a
    number.
    """
    counts: dict[str, int] = {}
    for link in links:
        if link["linkStatus"] == "LINKED":
            target = str(link["targetId"])
            counts[target] = counts.get(target, 0) + 1
    for source in sources:
        source["citedByCount"] = counts.get(str(source["id"]), 0)


def _source_json(record: BibliographySourceRecord, index: int) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": f"s{index}",
        "tag": record.tag,
        "authors": [
            {
                "raw": author.raw,
                "corporate": author.corporate,
                **(
                    {"normalizedFamily": author.normalized_family}
                    if author.normalized_family
                    else {}
                ),
            }
            for author in record.authors
        ],
        "identifiers": [
            {
                "scheme": identifier.scheme,
                "raw": identifier.raw,
                # The value came out of its own element, so Word labelled what
                # it is and the element's end is the value's end. Neither the
                # intent nor the boundary is being inferred.
                "intentEvidence": "LABEL_PREFIX",
                "boundaryStatus": "UNAMBIGUOUS",
                "syntaxStatus": identifier.syntax_status,
                **({"normalized": identifier.normalized} if identifier.normalized else {}),
            }
            for identifier in record.identifiers
        ],
        # Filled in from the links, once they exist.
        "citedByCount": 0,
    }
    for key, value in (
        ("sourceType", record.source_type),
        ("title", record.title),
        ("containerTitle", record.container_title),
        ("publisher", record.publisher),
        ("year", record.year),
    ):
        if value:
            payload[key] = value
    return payload


# --- links ------------------------------------------------------------------


def _links(
    citations: list[_Citation],
    store: SourceStore,
    sources: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """One link row per citation PalCert actually tried to resolve.

    A row exists only when linking was attempted, so a citation with no tag,
    or any citation at all when the source set is not exact, gets no row and
    stays NOT_ATTEMPTED. That is the distinction the contract exists to keep:
    "we looked and found nothing" is UNRESOLVED, and "there was nothing exact
    to look in" is not a failed lookup.
    """
    if store.status is not SourceStoreStatus.EXACT:
        return []

    by_tag: dict[str, list[str]] = {}
    for source in sources:
        by_tag.setdefault(str(source["tag"]), []).append(str(source["id"]))

    links: list[dict[str, Any]] = []
    for citation in citations:
        if not citation.tag:
            continue
        matches = by_tag.get(citation.tag, [])
        link: dict[str, Any] = {
            "citationId": citation.id,
            "linkMethod": "NATIVE_TAG",
            "candidateCount": 0,
        }
        if len(matches) == 1:
            link["linkStatus"] = "LINKED"
            link["targetId"] = matches[0]
        elif len(matches) > 1:
            # Two source records share the tag, so the tag is not an identity
            # in this document. PalCert names every candidate and picks none.
            candidates = matches[:MAX_CANDIDATES]
            link["linkStatus"] = "AMBIGUOUS"
            link["candidateIds"] = candidates
            link["candidateCount"] = len(candidates)
        else:
            link["linkStatus"] = "UNRESOLVED"
        links.append(link)
    return links


def _apply_link_results(citations: list[_Citation], links: list[dict[str, Any]]) -> None:
    """Make each citation's summary agree with its own link rows.

    The precedence is the contract's, not this module's: no rows means
    NOT_ATTEMPTED, any UNRESOLVED row means UNRESOLVED, then AMBIGUOUS, then
    LINKED. Computing it here rather than at each branch above is what keeps
    the summary from drifting away from what it summarises.
    """
    by_citation: dict[str, list[str]] = {}
    for link in links:
        by_citation.setdefault(str(link["citationId"]), []).append(str(link["linkStatus"]))

    for citation in citations:
        statuses = by_citation.get(citation.id, [])
        citation.target_count = len(statuses)
        if not statuses:
            citation.resolution_status = "NOT_ATTEMPTED"
        elif "UNRESOLVED" in statuses:
            citation.resolution_status = "UNRESOLVED"
        elif "AMBIGUOUS" in statuses:
            citation.resolution_status = "AMBIGUOUS"
        else:
            citation.resolution_status = "LINKED"


# --- rendered reference entries --------------------------------------------


def _references(evidence: CitationEvidenceInput) -> list[dict[str, Any]]:
    """Paragraphs Word wrote inside a ``BIBLIOGRAPHY`` field's result.

    Exact evidence of *where* the reference list is, and deliberately not of
    what each entry means: the text is whatever the citation style produced,
    so nothing is parsed out of it here. ``parseStatus`` says UNPARSED for
    exactly that reason, and no identifiers or authors are claimed.
    """
    references: list[dict[str, Any]] = []
    for paragraph in evidence.reference_paragraphs:
        if not paragraph.in_document:
            continue
        if len(references) >= MAX_REFERENCES:
            break
        text = paragraph.text.strip()
        if not text:
            continue
        references.append(
            {
                "id": f"r{len(references) + 1}",
                "ordinal": len(references) + 1,
                "sourceKind": "OOXML",
                "location": _location(paragraph.locator),
                "rawText": text[:MAX_REFERENCE_TEXT_CHARS],
                "parseMethod": "WORD_BIBLIOGRAPHY_FIELD",
                "parseStatus": "UNPARSED",
                "identifiers": [],
                "authors": [],
                "duplicateStatus": "NONE",
                # Nothing links a native citation to a *rendered* entry: the
                # citation resolves to a source record, and matching it to the
                # text a style produced would be the guesswork Phase 18 refuses.
                "citedByCount": 0,
                "truncated": len(text) > MAX_REFERENCE_TEXT_CHARS,
            }
        )
    return references


# --- coverage ---------------------------------------------------------------


def _coverage(
    evidence: CitationEvidenceInput,
    *,
    citations_truncated: bool,
    references_truncated: bool,
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []

    def add(domain: str, status: str, reason: str | None = None) -> None:
        entry: dict[str, Any] = {"domain": domain, "status": status}
        if reason is not None:
            entry["reasonCode"] = reason
        entries.append(entry)

    # Native citations: every CITATION field in every story the walk read.
    if citations_truncated:
        add(CoverageDomain.NATIVE_CITATIONS, "PARTIAL", "LIMIT_TRUNCATED")
    elif evidence.stories_incomplete:
        add(CoverageDomain.NATIVE_CITATIONS, "PARTIAL", "STORY_PART_UNREADABLE")
    else:
        add(CoverageDomain.NATIVE_CITATIONS, "COMPLETE")

    # The source store: exact, proven absent, or not established at all.
    store = evidence.store
    if store.status is SourceStoreStatus.EXACT and not store.truncated:
        add(CoverageDomain.NATIVE_BIBLIOGRAPHY_SOURCES, "COMPLETE")
    elif store.status is SourceStoreStatus.ABSENT:
        # Proven absent is a complete answer, and the count is a true zero.
        add(CoverageDomain.NATIVE_BIBLIOGRAPHY_SOURCES, "COMPLETE")
    elif store.truncated:
        add(CoverageDomain.NATIVE_BIBLIOGRAPHY_SOURCES, "UNAVAILABLE", "LIMIT_TRUNCATED")
    elif store.status is SourceStoreStatus.AMBIGUOUS:
        # Several stores: no one set is the document's, so there is no count.
        add(CoverageDomain.NATIVE_BIBLIOGRAPHY_SOURCES, "UNAVAILABLE", "SOURCE_STORE_UNREADABLE")
    else:
        add(CoverageDomain.NATIVE_BIBLIOGRAPHY_SOURCES, "UNAVAILABLE", "SOURCE_STORE_UNREADABLE")

    # Resolution needs both halves. A per-citation value under a store that
    # might be missing entries would be a false "unresolved".
    if store.status is SourceStoreStatus.ABSENT:
        add(CoverageDomain.NATIVE_SOURCE_RESOLUTION, "UNAVAILABLE", "SOURCE_STORE_ABSENT")
    elif not store.exact:
        add(CoverageDomain.NATIVE_SOURCE_RESOLUTION, "UNAVAILABLE", "SOURCE_STORE_UNREADABLE")
    elif store.duplicate_tags:
        add(CoverageDomain.NATIVE_SOURCE_RESOLUTION, "PARTIAL", "DUPLICATE_SOURCE_TAGS")
    elif citations_truncated:
        add(CoverageDomain.NATIVE_SOURCE_RESOLUTION, "PARTIAL", "LIMIT_TRUNCATED")
    elif evidence.stories_incomplete:
        add(CoverageDomain.NATIVE_SOURCE_RESOLUTION, "PARTIAL", "STORY_PART_UNREADABLE")
    else:
        add(CoverageDomain.NATIVE_SOURCE_RESOLUTION, "COMPLETE")

    # Nothing heuristic is attempted in this checkpoint, and saying so is not
    # the same as saying there is none.
    add(CoverageDomain.SEMANTIC_CITATIONS, "UNAVAILABLE", "NOT_IMPLEMENTED")
    add(CoverageDomain.SEMANTIC_REFERENCE_ENTRIES, "UNAVAILABLE", "NOT_IMPLEMENTED")

    # Positive-only: a BIBLIOGRAPHY field proves a region exists. Its absence
    # proves nothing — a typed reference list is invisible to this test — so
    # the domain is UNAVAILABLE rather than a confident "no region".
    if _has_reference_region(evidence):
        if references_truncated:
            add(CoverageDomain.REFERENCE_REGION, "PARTIAL", "LIMIT_TRUNCATED")
        else:
            add(CoverageDomain.REFERENCE_REGION, "COMPLETE")
    else:
        add(CoverageDomain.REFERENCE_REGION, "UNAVAILABLE", "NOT_IMPLEMENTED")

    return entries


def _has_reference_region(evidence: CitationEvidenceInput) -> bool:
    return any(
        marker.in_document and marker.locator.story in _EVIDENCE_STORIES
        for marker in evidence.bibliography_fields
    )


# --- summary ----------------------------------------------------------------


def _summary(
    evidence: CitationEvidenceInput,
    *,
    citations: list[_Citation],
    references: list[dict[str, Any]],
    sources: list[dict[str, Any]],
    citations_truncated: bool,
    references_truncated: bool,
) -> dict[str, Any]:
    statuses = [citation.resolution_status for citation in citations]
    truncation: list[str] = []
    if citations_truncated:
        truncation.append("CITATIONS")
    if references_truncated:
        truncation.append("REFERENCES")
    if evidence.store.truncated:
        truncation.append("BIBLIOGRAPHY_SOURCES")

    return {
        "observedCitationCount": len(citations),
        # Every citation this slice finds is a Word-native field, so the two
        # counts agree — and they are separate fields because the moment a
        # heuristic citation is found they will not.
        "nativeCitationCount": len(citations),
        "observedReferenceCount": len(references),
        "bibliographySourceCount": len(sources),
        "linkedCitationCount": statuses.count("LINKED"),
        "ambiguousCitationCount": statuses.count("AMBIGUOUS"),
        "unresolvedCitationCount": statuses.count("UNRESOLVED"),
        # Zero, and not "all of them": nothing links a citation to a rendered
        # entry in this checkpoint, so no entry has been observed to be
        # uncited. Reporting every entry as uncited would turn "we did not
        # look" into a finding somebody would act on.
        "observedUncitedReferenceCount": 0,
        "observedDuplicateReferenceCount": 0,
        "referenceRegionObserved": _has_reference_region(evidence),
        "truncationFlags": truncation,
    }
