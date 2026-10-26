"""Citation evidence a PDF can prove, and what it may only suspect (Phase 18).

A PDF stores glyphs and rectangles. It does not store citations — unless the
author tagged them, and then it stores exactly that: ``/Reference`` for a
citation, ``/BibEntry`` for a bibliography entry, ``/Lbl`` for the label that
names one. Those are declarations in the file, in the standard structure
namespace, and they are the only citation evidence this module reads.

Everything else a reader would use is refused. A line that looks like
"[12] Smith, J. (2020)." is a line of text; calling it a reference entry would
be PalCert asserting something the document never said, and the coverage says
so rather than the analysis guessing. There is no pattern matching over prose,
no nearest-text selection, no geometry, no similarity and no confidence —
``PDF_TEXT`` evidence is exact or it is absent.

Linking is narrower still. Two labels, both of them ``/Lbl`` elements the
author wrote, normalizing to the same integer, is a numeric-label match and
nothing else is attempted.

Checkpoint 10 adds a second, clearly separated layer. ``app.pdf.heuristics``
recovers numbered reference entries and bracketed numeric citation markers
from readable PDFs that declared nothing, and this module merges them in under
four rules that never bend:

* every heuristic object carries ``sourceKind: HEURISTIC`` and a
  ``confidence``, and no exact object ever acquires either;
* a heuristic object whose spans are already claimed by a declared element is
  dropped, not merged — the overlap test is span node identity;
* an **exact** citation is linked only against **exact** entries, so no
  heuristic discovery can reach the exact-evidence facts the projector
  publishes;
* ``referenceRegionObserved`` counts declared entries only, because the fact
  it feeds is an exact positive marker.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.pdf.author_year import normalize_surname
from app.pdf.bibliography import Identifier, find_identifiers
from app.pdf.destinations import InternalDestinationLink
from app.pdf.heuristics import (
    HeuristicAuthorYearCitation,
    HeuristicCitation,
    HeuristicDiscovery,
    HeuristicReference,
    ReferenceRegion,
    format_confidence,
    region_for_citation,
    resolve_author_year,
)
from app.pdf.model import BBox, PageModel, PdfStructuralModel, TextLayer, TextSpan

CITATION_ANALYSIS_SCHEMA_VERSION = 1
LOCATION_SCHEMA_VERSION = 1

MAX_CITATIONS = 20_000
MAX_REFERENCES = 5_000
MAX_CITATION_TEXT_CHARS = 240
MAX_REFERENCE_TEXT_CHARS = 1_200
MAX_CANDIDATES = 10
#: How many surnames one parsed entry may carry into the artifact. The schema
#: allows 32; a reference naming more than this has its identity established
#: by the first one long before the list ends.
MAX_PARSED_AUTHORS = 8

#: Characters a label may wrap its number in. Stripped, never interpreted:
#: what remains must be digits or the element carries no numeric label at all.
_LABEL_TRIM = " \t\r\n[](){}.,:;-"


class Domain:
    NATIVE_CITATIONS = "NATIVE_CITATIONS"
    NATIVE_BIBLIOGRAPHY_SOURCES = "NATIVE_BIBLIOGRAPHY_SOURCES"
    NATIVE_SOURCE_RESOLUTION = "NATIVE_SOURCE_RESOLUTION"
    SEMANTIC_CITATIONS = "SEMANTIC_CITATIONS"
    SEMANTIC_REFERENCE_ENTRIES = "SEMANTIC_REFERENCE_ENTRIES"
    REFERENCE_REGION = "REFERENCE_REGION"


@dataclass(frozen=True, slots=True)
class TaggedCitationElement:
    """One ``/Reference`` or ``/BibEntry``, bound to the text it marks."""

    kind: str
    page_index: int
    order: int
    node_id: str
    text: str
    #: The integer its ``/Lbl`` names, when it has one that is purely numeric.
    label: int | None
    #: Its index in the structure tree's declared list, so an annotation bound
    #: to a structure element can be matched back to it.
    element_index: int = -1
    #: The extent of the spans it binds, in PDF user space — the same space a
    #: destination's coordinates are written in.
    extent: BBox | None = None
    #: Every span this declaration covers. Carried so a heuristic detector can
    #: be told which text is already spoken for, by identity rather than by
    #: comparing what the text says.
    span_node_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class _Linkable:
    """One citation as the linker sees it: an id, a label, a provenance.

    ``exact`` is the whole reason this type exists. An exact citation is
    linked only against declared entries, so a heuristic reference can never
    become the target that decides an exact citation's ``resolutionStatus`` —
    and ``citationTargetResolved``, which the projector publishes as exact
    element evidence, reads exactly that status.
    """

    citation_id: str
    label: int | None
    element_index: int
    exact: bool
    #: Which region's population this citation may defensibly resolve against,
    #: by that region's ordinal — or None when no region follows it and the
    #: assignment cannot be defended. None widens the search to every region
    #: and lets ambiguity stand rather than choosing.
    region_ordinal: int | None = None
    #: Normalized DOI identities this citation's own text stated. Empty
    #: whenever it stated none, or stated one PalCert could not determine the
    #: end or the shape of — in which case there is no identity to match on
    #: and no DOI row is written at all.
    doi_identities: tuple[str, ...] = ()


def _union(spans: list[TextSpan]) -> BBox | None:
    boxes = [span.raw_bbox for span in spans]
    if not boxes:
        return None
    return BBox(
        left=min(box.left for box in boxes),
        top=max(box.top for box in boxes),
        right=max(box.right for box in boxes),
        bottom=min(box.bottom for box in boxes),
    )


def _numeric_label(text: str) -> int | None:
    """The integer a label names, or None.

    Deliberately unforgiving. "12", "[12]" and "12." are the same label; "12a",
    "Smith 2020" and "12-14" are no label at all rather than a guess at one.
    """
    stripped = text.strip(_LABEL_TRIM).strip()
    if not stripped or not stripped.isdigit() or len(stripped) > 9:
        return None
    return int(stripped)


def _text_of(spans: list[TextSpan]) -> str:
    return "".join(span.text for span in spans).strip()


def bind_citation_elements(
    model: PdfStructuralModel,
    citation_elements: list[dict[str, Any]],
) -> list[TaggedCitationElement]:
    """Attach each declared element to the lines its marked content covers.

    Bound at *span* level rather than line level, and the difference is not a
    detail. A line is PalCert's own grouping of spans that share a baseline,
    so a citation marker at the end of a sentence lands on the same line as
    the sentence — binding by line would make the citation's text the whole
    sentence, and would swallow the label of a reference entry typeset beside
    it. A span carries exactly one marked-content id, the one the author
    stamped on it, so binding by span reports the element the author declared.

    An element whose marks bind to nothing is dropped: a declaration PalCert
    cannot point at is not evidence it can report.
    """
    by_page: dict[int, PageModel] = {page.page_index: page for page in model.pages}
    bound: list[TaggedCitationElement] = []

    for element in citation_elements:
        page = by_page.get(int(element["pageIndex"]))
        if page is None:
            continue
        claimed = set(element["mcids"])
        spans = [span for span in page.spans if span.marked_content_id in claimed]
        if not spans:
            continue

        text = _text_of(spans)

        # The label comes from a declared /Lbl when there is one. Failing
        # that, an element whose *entire* content is a number is its own
        # label: a /Reference reading "[1]" carries the label 1, and one
        # reading "Smith et al. (2020)" carries none. The normalizer accepts
        # nothing else, so this reads a declared element whole rather than
        # searching prose for something that looks like a number.
        label_claimed = set(element["labelMcids"])
        label_spans = [span for span in page.spans if span.marked_content_id in label_claimed]
        label = _numeric_label(_text_of(label_spans)) if label_spans else _numeric_label(text)

        bound.append(
            TaggedCitationElement(
                kind=str(element["kind"]),
                page_index=page.page_index,
                order=int(element["order"]),
                node_id=spans[0].node_id,
                text=text,
                label=label,
                element_index=int(element["order"]),
                extent=_union(spans),
                span_node_ids=tuple(span.node_id for span in spans),
            )
        )

    bound.sort(key=lambda entry: (entry.page_index, entry.order))
    return bound


def _region_ordinal_for(discovery: HeuristicDiscovery, document_index: int) -> int | None:
    """Which region's list closes the stretch of text this citation sits in."""
    region = region_for_citation(list(discovery.regions), document_index)
    return None if region is None else region.ordinal


def claimed_span_ids(bound: list[TaggedCitationElement]) -> frozenset[str]:
    """Every span a declared citation element already covers.

    What a heuristic detector must not touch, expressed as identity. A span is
    either the one the author stamped or it is not; there is no threshold and
    nothing to tune, which is exactly why the overlap rule is written this way
    rather than by comparing what two pieces of text say.
    """
    return frozenset(span for element in bound for span in element.span_node_ids)


def build_citation_analysis(
    model: PdfStructuralModel,
    bound: list[TaggedCitationElement],
    *,
    structure_present: bool,
    structure_truncated: bool,
    internal_links: list[InternalDestinationLink] | None = None,
    heuristics: HeuristicDiscovery | None = None,
) -> dict[str, Any]:
    """The ``citationAnalysis`` section for one PDF.

    Exact evidence is built first and keeps the identities it always had:
    ``c1..cN`` and ``r1..rM`` are the declared elements, in declaration order,
    unchanged by anything the heuristic layer does or does not find. Heuristic
    objects are appended after them, so adding this layer cannot renumber an
    artifact somebody already stored.
    """
    discovery = heuristics or HeuristicDiscovery(attempted=False)

    citations = [entry for entry in bound if entry.kind == "CITATION"][:MAX_CITATIONS]
    references = [entry for entry in bound if entry.kind == "REFERENCE_ENTRY"][:MAX_REFERENCES]

    reference_json = [
        _reference_json(entry, index) for index, entry in enumerate(references, start=1)
    ]
    exact_reference_count = len(reference_json)
    heuristic_references = list(discovery.references)[: MAX_REFERENCES - exact_reference_count]
    for offset, entry in enumerate(heuristic_references, start=exact_reference_count + 1):
        reference_json.append(_heuristic_reference_json(entry, offset))

    linkables = [
        _Linkable(
            citation_id=f"c{index}",
            label=entry.label,
            element_index=entry.element_index,
            exact=True,
            doi_identities=tuple(
                _doi_identities(_citation_identifiers(entry.text[:MAX_CITATION_TEXT_CHARS]))
            ),
        )
        for index, entry in enumerate(citations, start=1)
    ]
    exact_citation_count = len(linkables)
    heuristic_citations = list(discovery.citations)[: MAX_CITATIONS - exact_citation_count]
    linkables.extend(
        _Linkable(
            citation_id=f"c{index}",
            label=entry.label,
            element_index=-1,
            exact=False,
            region_ordinal=_region_ordinal_for(discovery, entry.document_index),
            doi_identities=tuple(
                _doi_identities(_citation_identifiers(entry.text[:MAX_CITATION_TEXT_CHARS]))
            ),
        )
        for index, entry in enumerate(heuristic_citations, start=exact_citation_count + 1)
    )
    numeric_count = len(linkables)
    author_year_citations = list(discovery.author_year_citations)[: MAX_CITATIONS - numeric_count]
    #: Where each heuristic reference ended up in the artifact's own numbering,
    #: so an author-year match names an id rather than an object.
    reference_ids = {
        id(entry): f"r{offset}"
        for offset, entry in enumerate(heuristic_references, start=exact_reference_count + 1)
    }

    links, resolutions = _links(
        linkables,
        exact_references=references,
        heuristic_references=heuristic_references,
        exact_reference_count=exact_reference_count,
        internal_links=internal_links or [],
        reference_payloads=reference_json,
    )
    author_year_links, author_year_resolutions = _author_year_links(
        author_year_citations,
        heuristic_references,
        reference_ids,
        first_index=numeric_count + 1,
    )
    links.extend(author_year_links)
    resolutions.update(author_year_resolutions)

    citation_json = [
        _citation_json(entry, index, resolutions.get(f"c{index}", ("NOT_ATTEMPTED", 0)))
        for index, entry in enumerate(citations, start=1)
    ]
    for offset, marker in enumerate(heuristic_citations, start=exact_citation_count + 1):
        citation_json.append(
            _heuristic_citation_json(
                marker, offset, resolutions.get(f"c{offset}", ("NOT_ATTEMPTED", 0))
            )
        )
    for offset, author_year in enumerate(author_year_citations, start=numeric_count + 1):
        citation_json.append(
            _author_year_citation_json(
                author_year, offset, resolutions.get(f"c{offset}", ("NOT_ATTEMPTED", 0))
            )
        )
    _apply_cited_by(reference_json, links)

    return {
        "citationAnalysisSchemaVersion": CITATION_ANALYSIS_SCHEMA_VERSION,
        "coverage": _coverage(
            model,
            citations=citations,
            references=references,
            structure_present=structure_present,
            structure_truncated=structure_truncated,
            heuristic_citations=len(heuristic_citations) + len(author_year_citations),
            heuristic_references=len(heuristic_references),
            heuristics_truncated=discovery.truncated,
        ),
        "citations": citation_json,
        "references": reference_json,
        "referenceRegions": [
            _region_json(region, entries=heuristic_references) for region in discovery.regions
        ],
        "bibliographySources": [],
        "links": links,
        "summary": _summary(
            citation_json, reference_json, links, exact_reference_count=exact_reference_count
        ),
    }


def _location(entry: TaggedCitationElement) -> dict[str, Any]:
    """Where the evidence is, in the addresses the PDF model already uses.

    A page number, because a PDF has pages and PalCert knows which one this
    is. No `story`: that is a WordprocessingML idea and a PDF has none.
    """
    return {
        "locationSchemaVersion": LOCATION_SCHEMA_VERSION,
        "nodeId": entry.node_id,
        "page": entry.page_index + 1,
    }


def _citation_json(
    entry: TaggedCitationElement, index: int, resolution: tuple[str, int]
) -> dict[str, Any]:
    status, target_count = resolution
    payload: dict[str, Any] = {
        "id": f"c{index}",
        "ordinal": index,
        # The text was read from the file; the *citation* was declared by the
        # author. Neither is a guess, so neither carries a confidence.
        "sourceKind": "PDF_TEXT",
        # What kind of citation it is — numeric, author-date, a note marker —
        # is not something the structure declares, and reading it out of the
        # text would be the classification this checkpoint refuses.
        "citationKind": "UNKNOWN",
        "parseMethod": "NONE",
        "parseStatus": "UNPARSED",
        "location": _location(entry),
        "rawText": entry.text[:MAX_CITATION_TEXT_CHARS],
        "targetCount": target_count,
        "resolutionStatus": status,
        "truncated": len(entry.text) > MAX_CITATION_TEXT_CHARS,
    }
    if entry.label is not None:
        payload["numericLabels"] = [entry.label]
    # A DOI the author wrote inside a declared citation is read exactly, like
    # everything else about that citation. Finding one does not change what
    # the occurrence is: `sourceKind` stays PDF_TEXT because the *citation*
    # was declared, and an identifier is a field of it rather than a new
    # provenance for it.
    identifiers = _citation_identifiers(payload["rawText"])
    if identifiers:
        payload["identifiers"] = identifiers
    return payload


def _reference_json(entry: TaggedCitationElement, index: int) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": f"r{index}",
        "ordinal": index,
        "sourceKind": "PDF_TEXT",
        "location": _location(entry),
        "rawText": entry.text[:MAX_REFERENCE_TEXT_CHARS],
        # The entry was identified, not parsed. Nothing is claimed about the
        # work it describes: no authors, no year, no identifiers, because
        # reading those out of the text is what a later checkpoint may earn.
        "parseMethod": "NONE",
        # The entry was identified, not parsed: no author, no year, no title
        # is read out of it, because each of those needs a heuristic grammar
        # and a declared element must not acquire heuristic output.
        "parseStatus": "UNPARSED",
        # An identifier is the exception, and a narrow one. A DOI the author
        # wrote inside a declared entry is stated outright — there is no
        # segmentation to guess at and no sentence to delimit — and without
        # it `DOI_IDENTITY` could never compare two declared objects, which
        # is the one case where both sides are exact. `parseStatus` stays
        # UNPARSED: reading a stated identifier is not parsing the work.
        "identifiers": _citation_identifiers(entry.text[:MAX_REFERENCE_TEXT_CHARS]),
        "authors": [],
        "duplicateStatus": "NONE",
        "citedByCount": 0,
        "truncated": len(entry.text) > MAX_REFERENCE_TEXT_CHARS,
    }
    if entry.label is not None:
        payload["label"] = entry.label
    return payload


def _optional_identifiers(raw_text: str) -> dict[str, Any]:
    """``identifiers`` when the text states any, and the key absent otherwise.

    A citation PalCert recognized by pattern keeps its HEURISTIC provenance
    whatever it turns out to contain. A DOI is stronger evidence about *which
    work* is meant; it says nothing about whether this span is a citation at
    all, which is the question `sourceKind` answers.
    """
    identifiers = _citation_identifiers(raw_text)
    return {"identifiers": identifiers} if identifiers else {}


def _heuristic_location(
    entry: HeuristicCitation | HeuristicReference | HeuristicAuthorYearCitation,
) -> dict[str, Any]:
    """The line PalCert read it from, addressed the way every PDF finding is."""
    return {
        "locationSchemaVersion": LOCATION_SCHEMA_VERSION,
        "nodeId": entry.line.node_id,
        "page": entry.line.page_index + 1,
    }


def _heuristic_citation_json(
    entry: HeuristicCitation, index: int, resolution: tuple[str, int]
) -> dict[str, Any]:
    """One recognized marker, labelled as the classification it is.

    ``NUMERIC_LABEL`` and ``LABEL_PATTERN`` say what was recognized and how,
    and ``HEURISTIC`` says PalCert decided it rather than read it. The
    confidence is always present: an object this layer produced without one
    would look, to every later reader, exactly like exact evidence.
    """
    status, target_count = resolution
    return {
        "id": f"c{index}",
        "ordinal": index,
        "sourceKind": "HEURISTIC",
        "citationKind": "NUMERIC_LABEL",
        "parseMethod": "LABEL_PATTERN",
        "parseStatus": "PARSED",
        "location": _heuristic_location(entry),
        "rawText": entry.text[:MAX_CITATION_TEXT_CHARS],
        "numericLabels": [entry.label],
        # The bracketed group this number came from, so expanding `[4-6]`
        # into three citations stays auditable from the artifact alone.
        "numericLabelsRaw": entry.raw_group[:120],
        "targetCount": target_count,
        "resolutionStatus": status,
        "confidence": format_confidence(entry.confidence),
        "truncated": len(entry.text) > MAX_CITATION_TEXT_CHARS,
        **_optional_identifiers(entry.text[:MAX_CITATION_TEXT_CHARS]),
    }


def _region_json(region: ReferenceRegion, *, entries: list[HeuristicReference]) -> dict[str, Any]:
    """One discovered reference list, with the evidence that made it one.

    The signals are emitted sorted and the confidence is a pure function of
    them, so a reader can recompute the number rather than take it on trust.
    That is the whole point of publishing a region: `[1]` resolving to one
    entry rather than another is only checkable if the populations are
    visible.
    """
    return {
        "ordinal": region.ordinal,
        "sourceKind": "HEURISTIC",
        "family": region.family.value,
        "headingLocation": {
            "locationSchemaVersion": LOCATION_SCHEMA_VERSION,
            "nodeId": region.heading_node_id,
            "page": region.heading_page_index + 1,
        },
        "firstPage": region.first_page_index + 1,
        "lastPage": region.last_page_index + 1,
        "entryCount": sum(1 for entry in entries if entry.region_ordinal == region.ordinal),
        "signals": sorted(region.signals),
        "confidence": format_confidence(region.confidence),
    }


def _heuristic_reference_json(entry: HeuristicReference, index: int) -> dict[str, Any]:
    """One segmented entry, and only what was defensibly read out of it.

    ``parseMethod`` names how the entry was *identified* — region membership,
    which is what the other values in that vocabulary name too: a Word
    bibliography field, a Word bibliography style, a layout block.
    ``parseStatus`` is the separate statement of how much of its content was
    read, which is why no new parse method is needed for Checkpoint 11 and
    none is invented.

    ``PARTIAL`` whenever any field was read, and **never** ``PARSED``. The
    contract does not define what a fully parsed reference entry requires —
    the enum offers the value and nothing says which fields it promises — so
    claiming it would be inventing a guarantee. An entry PalCert read nothing
    out of stays ``UNPARSED``.

    Every emitted value is an exact substring of ``rawText``: the surnames,
    the year, the title, the container, and each identifier's ``raw``. A
    normalized identifier is a case fold of its own ``raw``, so it stays
    traceable through it.
    """
    payload: dict[str, Any] = {
        "id": f"r{index}",
        "ordinal": index,
        "sourceKind": "HEURISTIC",
        "location": _heuristic_location(entry),
        "rawText": entry.text[:MAX_REFERENCE_TEXT_CHARS],
        "parseMethod": "REGION_MEMBERSHIP",
        "parseStatus": "UNPARSED",
        "identifiers": [],
        "authors": [
            {
                "raw": author[:200],
                "normalizedFamily": normalize_surname(author)[:80],
                # A surname followed by initials is a person. A corporate
                # author is written without them and does not parse here at
                # all, so this is a reading of the shape rather than a guess.
                "corporate": False,
            }
            for author in entry.authors[:MAX_PARSED_AUTHORS]
        ],
        "duplicateStatus": "NONE",
        "citedByCount": 0,
        "confidence": format_confidence(entry.confidence),
        # Which reference list this entry came out of. The one field that lets
        # a reader check a numeric link: `[1]` resolving to `r4` is right when
        # `r4` is in the region serving that chapter and wrong when it is not.
        "regionOrdinal": entry.region_ordinal,
        "truncated": len(entry.text) > MAX_REFERENCE_TEXT_CHARS,
    }
    if entry.label is not None:
        payload["label"] = entry.label
    if entry.year is not None:
        payload["year"] = entry.year[:8]
    if entry.title is not None:
        payload["title"] = entry.title[:400]
    if entry.container_title is not None:
        payload["containerTitle"] = entry.container_title[:300]
    if entry.identifiers:
        payload["identifiers"] = [_identifier_json(item) for item in entry.identifiers]
    if payload["identifiers"] or entry.authors or entry.title:
        payload["parseStatus"] = "PARTIAL"
    return payload


def _citation_identifiers(raw_text: str) -> list[dict[str, Any]]:
    """Identifiers the citation's **own text** states, and nothing else.

    Read from this occurrence's ``rawText`` and from no wider window. A DOI in
    the surrounding paragraph belongs to the paragraph: assigning it to the
    nearest citation would be proximity standing in for evidence, and a
    citation wrongly given the identity of a work beside it would then resolve
    — confidently — to the wrong reference.

    The same extractor a reference entry uses, so `doi:10.1234/abc` yields the
    same object with the same normalization wherever it is written. That is
    what makes ``DOI_IDENTITY`` a comparison of like with like rather than of
    two parsers that happen to agree today.
    """
    return [_identifier_json(item) for item in find_identifiers(raw_text)]


def _doi_identities(identifiers: list[dict[str, Any]]) -> list[str]:
    """Every usable DOI identity in a set of identifiers, in order.

    Usable means ``normalized`` is present, which the Checkpoint-12 extractor
    withholds whenever the value's end could not be determined or its shape
    was malformed. So a boundary-ambiguous or invalid DOI simply has no
    identity here and can match nothing — the guard is the absence of the
    field rather than a second check that could drift from it.
    """
    seen: list[str] = []
    for identifier in identifiers:
        if identifier["scheme"] != "DOI":
            continue
        normalized = identifier.get("normalized")
        if normalized is not None and normalized not in seen:
            seen.append(normalized)
    return seen


def _identifier_json(identifier: Identifier) -> dict[str, Any]:
    """One DOI or URL, with what PalCert knew about it and nothing more.

    ``normalized`` is present only when the value's end was determinable and
    its shape was well-formed — it is the identity other evidence may match
    on, and an identity PalCert is unsure of must not be matchable at all.

    ``syntaxStatus`` is an offline shape check. No resolver was contacted, no
    Crossref lookup was made, and nothing here says the work exists.
    """
    payload: dict[str, Any] = {
        "scheme": identifier.scheme,
        "raw": identifier.raw,
        "intentEvidence": identifier.intent,
        "boundaryStatus": identifier.boundary,
        "syntaxStatus": identifier.syntax,
    }
    if identifier.normalized is not None:
        payload["normalized"] = identifier.normalized
    return payload


def _author_year_citation_json(
    entry: HeuristicAuthorYearCitation, index: int, resolution: tuple[str, int]
) -> dict[str, Any]:
    """One recognized author-year marker.

    ``AUTHOR_DATE_PATTERN`` is already in the citation parse-method
    vocabulary and means exactly this, so nothing is overloaded and nothing is
    added. ``authorTokens`` carries the surnames as written; the author shape
    that breaks a tie between two same-identity entries is readable from them
    and from ``rawText``, which is why no shape field is invented for it.
    """
    status, target_count = resolution
    parsed = entry.parsed
    tokens = [parsed.first_author[:80]]
    if parsed.second_author is not None:
        tokens.append(parsed.second_author[:80])
    return {
        "id": f"c{index}",
        "ordinal": index,
        "sourceKind": "HEURISTIC",
        "citationKind": "AUTHOR_DATE",
        "parseMethod": "AUTHOR_DATE_PATTERN",
        "parseStatus": "PARSED",
        "location": _heuristic_location(entry),
        "rawText": parsed.raw[:MAX_CITATION_TEXT_CHARS],
        "authorTokens": tokens,
        "yearToken": parsed.year[:8],
        "targetCount": target_count,
        "resolutionStatus": status,
        "confidence": format_confidence(entry.confidence),
        "truncated": len(parsed.raw) > MAX_CITATION_TEXT_CHARS,
        **_optional_identifiers(parsed.raw[:MAX_CITATION_TEXT_CHARS]),
    }


def _numeric_label_targets(citation: _Linkable, by_label: dict[int, list[str]]) -> list[str] | None:
    """The entries a citation's declared label names, or None if it has none.

    An empty list is an attempt that found nothing; None is no attempt at all,
    and the contract keeps those apart.
    """
    if citation.label is None:
        return None
    return list(by_label.get(citation.label, []))


def _internal_destination_targets(
    link: InternalDestinationLink, references: list[TaggedCitationElement]
) -> list[str]:
    """The declared entries this annotation's destination lands on.

    A structure destination names one element outright. An explicit
    destination names a point, and the entries it resolves to are those whose
    extent contains it — strictly, with no tolerance, because a tolerance is
    a tuning parameter and a tuned distance is a guess about which entry was
    meant. A destination that names a whole page, or lands beside the text
    rather than in it, resolves to nothing and the link is UNRESOLVED.
    """
    index_by_element = {
        reference.element_index: f"r{index}" for index, reference in enumerate(references, start=1)
    }
    if link.target_element_index is not None:
        named = index_by_element.get(link.target_element_index)
        return [named] if named is not None else []

    if link.target_page_index is None or link.target_point is None:
        return []
    x, y = link.target_point
    found: list[str] = []
    for index, reference in enumerate(references, start=1):
        if reference.page_index != link.target_page_index or reference.extent is None:
            continue
        extent = reference.extent
        if extent.left <= x <= extent.right and extent.bottom <= y <= extent.top:
            found.append(f"r{index}")
    return found


def _links(
    linkables: list[_Linkable],
    *,
    exact_references: list[TaggedCitationElement],
    heuristic_references: list[HeuristicReference],
    exact_reference_count: int,
    internal_links: list[InternalDestinationLink],
    reference_payloads: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, tuple[str, int]]]:
    """Every method that had something to say, and what they said together.

    Each method proposes independently: a numeric-label match, and a link
    annotation whose destination resolves to a declared entry. Each proposal
    becomes its own link row, so the evidence survives rather than being
    collapsed into one answer.

    One case needs a rule of its own. When two methods resolve to *different*
    entries, both rows would be LINKED and the contract's own precedence — all
    LINKED means LINKED — would report a confidently resolved citation while
    the document offers two answers. So that case, and only that case, makes
    both rows AMBIGUOUS over the union of what they found. Disagreement
    becomes ambiguity rather than a silent choice between methods, and no
    precedence order decides which exact method is more believable.

    **Region scoping.** A document may carry several reference lists — a
    bibliography per chapter, an appendix with its own sources. A citation
    resolves against the population of the list that closes the stretch of
    text it sits in, so the same label appearing in two chapters is two
    different works and neither is uniquely resolved document-wide. Where no
    region defensibly serves a citation, the search widens to every region and
    the frozen states report what that found: one entry LINKED, several
    AMBIGUOUS, none UNRESOLVED. Nothing is ever chosen by page distance.

    **Two label indexes, not one.** An exact citation may only resolve to a
    declared entry; a heuristic one may resolve to either. Without the split,
    a heuristic entry PalCert merely recognized could become the target of a
    citation the author declared — and ``citationTargetResolved``, an exact
    element value, is read straight off that citation's resolution. The gate
    in the projector would then be the only thing standing between a guess
    and a published fact, and one gate is not enough for that.
    """
    exact_by_label: dict[int, list[str]] = {}
    for index, reference in enumerate(exact_references, start=1):
        if reference.label is not None:
            exact_by_label.setdefault(reference.label, []).append(f"r{index}")

    all_by_label: dict[int, list[str]] = {label: list(ids) for label, ids in exact_by_label.items()}
    #: The same index, split by region, so a citation can be resolved against
    #: one list rather than against every list at once.
    by_region_label: dict[int, dict[int, list[str]]] = {}
    for offset, entry in enumerate(heuristic_references, start=exact_reference_count + 1):
        # An author-year entry carries no number, so there is nothing for a
        # numeric marker to match it by. It is reachable only through the
        # author-year identity index.
        if entry.label is not None:
            all_by_label.setdefault(entry.label, []).append(f"r{offset}")
            by_region_label.setdefault(entry.region_ordinal, {}).setdefault(entry.label, []).append(
                f"r{offset}"
            )

    # DOI identity, indexed the same way and split the same way. Built from
    # the reference payloads the artifact will actually carry, so an entry a
    # bound cut out cannot be named by a link.
    exact_by_doi: dict[str, list[str]] = {}
    all_by_doi: dict[str, list[str]] = {}
    for index, payload in enumerate(reference_payloads, start=1):
        for identity in _doi_identities(payload.get("identifiers", [])):
            # Never deduplicated: two entries sharing a DOI are two entries,
            # and collapsing them here would turn a real ambiguity into a
            # confident link to whichever happened to be first.
            all_by_doi.setdefault(identity, []).append(payload["id"])
            if index <= exact_reference_count:
                exact_by_doi.setdefault(identity, []).append(payload["id"])

    destinations_by_citation: dict[int, list[InternalDestinationLink]] = {}
    for link in internal_links:
        destinations_by_citation.setdefault(link.citation_element_index, []).append(link)

    links: list[dict[str, Any]] = []
    resolutions: dict[str, tuple[str, int]] = {}

    for citation in linkables:
        citation_id = citation.citation_id
        proposals: list[tuple[str, list[str]]] = []

        if citation.exact:
            # A declared citation resolves against declared entries only, and
            # those are not region-scoped: the structure tree named them.
            by_label = exact_by_label
        elif citation.region_ordinal is not None:
            by_label = by_region_label.get(citation.region_ordinal, {})
        else:
            # No list defensibly serves this citation, so every list is a
            # candidate and the frozen states carry the ambiguity.
            by_label = all_by_label
        label_targets = _numeric_label_targets(citation, by_label)
        if label_targets is not None:
            proposals.append(("NUMERIC_LABEL", label_targets))
        # DOI identity is a proposal like any other: it is added to the list
        # and the frozen aggregation decides what the citation's resolution
        # is. It is not consulted first, and it does not override a method
        # that disagrees with it.
        by_doi = exact_by_doi if citation.exact else all_by_doi
        if citation.doi_identities:
            doi_targets: list[str] = []
            for identity in citation.doi_identities:
                for target in by_doi.get(identity, []):
                    if target not in doi_targets:
                        doi_targets.append(target)
            proposals.append(("DOI_IDENTITY", doi_targets))

        if citation.exact:
            # An internal destination is an annotation the author authored,
            # bound through the structure tree. A heuristic citation has no
            # annotation and no structure element, so there is nothing to
            # look up and nothing is invented for it.
            for destination in destinations_by_citation.get(citation.element_index, []):
                proposals.append(
                    (
                        "INTERNAL_DESTINATION",
                        _internal_destination_targets(destination, exact_references),
                    )
                )

        if not proposals:
            resolutions[citation_id] = ("NOT_ATTEMPTED", 0)
            continue

        resolved = sorted({targets[0] for _, targets in proposals if len(targets) == 1})
        disagreement = len(resolved) > 1

        for method, targets in proposals:
            row: dict[str, Any] = {
                "citationId": citation_id,
                "linkMethod": method,
                "candidateCount": 0,
            }
            if disagreement:
                # Two exact methods, two different entries. Both are
                # defensible and the document does not say which is meant.
                candidates = resolved[:MAX_CANDIDATES]
                row["linkStatus"] = "AMBIGUOUS"
                row["candidateIds"] = candidates
                row["candidateCount"] = len(candidates)
            elif len(targets) == 1:
                row["linkStatus"] = "LINKED"
                row["targetId"] = targets[0]
            elif len(targets) > 1:
                # One method, several defensible entries. PalCert names them
                # all and chooses none: picking one would be a coin toss
                # recorded as a citation's target. Confidence does not enter
                # here — a graded belief about *recognizing* a marker says
                # nothing about which of two entries it meant.
                candidates = targets[:MAX_CANDIDATES]
                row["linkStatus"] = "AMBIGUOUS"
                row["candidateIds"] = candidates
                row["candidateCount"] = len(candidates)
            else:
                row["linkStatus"] = "UNRESOLVED"
            links.append(row)

        statuses = [str(link["linkStatus"]) for link in links if link["citationId"] == citation_id]
        resolutions[citation_id] = (_aggregate(statuses), len(statuses))

    return links, resolutions


def _author_year_links(
    citations: list[HeuristicAuthorYearCitation],
    entries: list[HeuristicReference],
    reference_ids: dict[int, str],
    *,
    first_index: int,
) -> tuple[list[dict[str, Any]], dict[str, tuple[str, int]]]:
    """AUTHOR_YEAR_UNIQUE, and only when the identity really is unique.

    The method's name is its contract: it may be used when author and year
    identity establishes *one* entry. So one candidate is LINKED, several are
    AMBIGUOUS naming every one of them, and none is an attempt that found
    nothing. Confidence is not consulted anywhere in this function — a graded
    belief about whether a marker was *recognized* says nothing about which of
    two works by Smith in 2020 was meant, and using it to choose would record
    a coin toss as a citation's target.

    Author-year citations are matched only against entries PalCert parsed,
    which are heuristic by construction: an exact `/BibEntry` is identified
    and never parsed, so it carries no author and no year to match on. Exact
    citations are untouched by this function entirely.
    """
    links: list[dict[str, Any]] = []
    resolutions: dict[str, tuple[str, int]] = {}

    #: Entries carrying an author-year identity. Without at least one there is
    #: nothing to look *in*, and "looked and found nothing" would be a claim
    #: PalCert cannot make: a thesis whose reference list is numbered has no
    #: author-year identity anywhere, so an author-year marker in its prose is
    #: a citation nobody could attempt rather than one that failed.
    #: Only entries that reached the artifact can be candidates. A bound cut
    #: one out, so it has no id for a link to name and it is not a defensible
    #: target either — naming an entry a reader cannot look up is worse than
    #: reporting one fewer candidate.
    present = [entry for entry in entries if id(entry) in reference_ids]
    #: ...and only entries an author-year citation may resolve to. Checkpoint
    #: 12 parses author and year out of *numbered* entries as well, which
    #: would otherwise silently turn Checkpoint 11's NOT_ATTEMPTED into an
    #: UNRESOLVED — an attempt PalCert never made, reported as one that
    #: failed. Enriching an entry is not the same decision as making it a
    #: candidate, and this keeps them apart.
    identified = [entry for entry in present if entry.matchable_by_author_year]

    for offset, citation in enumerate(citations, start=first_index):
        citation_id = f"c{offset}"
        if not identified:
            resolutions[citation_id] = ("NOT_ATTEMPTED", 0)
            continue
        matches = resolve_author_year(citation.parsed, present)
        row: dict[str, Any] = {
            "citationId": citation_id,
            "linkMethod": "AUTHOR_YEAR_UNIQUE",
            "candidateCount": 0,
        }
        if len(matches) == 1:
            row["linkStatus"] = "LINKED"
            row["targetId"] = reference_ids[id(matches[0])]
        elif matches:
            candidates = sorted(reference_ids[id(entry)] for entry in matches)[:MAX_CANDIDATES]
            row["linkStatus"] = "AMBIGUOUS"
            row["candidateIds"] = candidates
            row["candidateCount"] = len(candidates)
        else:
            row["linkStatus"] = "UNRESOLVED"
        links.append(row)
        resolutions[citation_id] = (_aggregate([str(row["linkStatus"])]), 1)

    return links, resolutions


def _aggregate(statuses: list[str]) -> str:
    """The contract's own precedence, unchanged and not reinterpreted."""
    if not statuses:
        return "NOT_ATTEMPTED"
    if "UNRESOLVED" in statuses:
        return "UNRESOLVED"
    if "AMBIGUOUS" in statuses:
        return "AMBIGUOUS"
    return "LINKED"


def _apply_cited_by(references: list[dict[str, Any]], links: list[dict[str, Any]]) -> None:
    counts: dict[str, int] = {}
    for link in links:
        if link["linkStatus"] == "LINKED":
            target = str(link["targetId"])
            counts[target] = counts.get(target, 0) + 1
    for reference in references:
        reference["citedByCount"] = counts.get(str(reference["id"]), 0)


def _coverage(
    model: PdfStructuralModel,
    *,
    citations: list[TaggedCitationElement],
    references: list[TaggedCitationElement],
    structure_present: bool,
    structure_truncated: bool,
    heuristic_citations: int,
    heuristic_references: int,
    heuristics_truncated: bool,
) -> list[dict[str, Any]]:
    """Six domains that fail independently, because they do.

    A PDF with no text layer can still be tagged; a tagged PDF can still have
    no bibliography; neither has anything to do with Word's native citation
    model, which a PDF simply does not have. Folding them into one answer
    would let a missing capability degrade a capability that is present.
    """
    entries: list[dict[str, Any]] = []

    def add(domain: str, status: str, reason: str | None = None) -> None:
        entry: dict[str, Any] = {"domain": domain, "status": status}
        if reason is not None:
            entry["reasonCode"] = reason
        entries.append(entry)

    # Word's native citation model has no PDF equivalent. Not "we did not
    # look" — the format does not have it.
    for domain in (
        Domain.NATIVE_CITATIONS,
        Domain.NATIVE_BIBLIOGRAPHY_SOURCES,
        Domain.NATIVE_SOURCE_RESOLUTION,
    ):
        add(domain, "UNAVAILABLE", "FORMAT_HAS_NO_NATIVE_CITATIONS")

    no_text = model.text_layer in {TextLayer.IMAGE_ONLY, TextLayer.EMPTY_OR_UNKNOWN}

    def semantic_status(
        found: list[TaggedCitationElement], heuristic_found: int
    ) -> tuple[str, str | None]:
        """PARTIAL whenever PalCert classified something, and never better.

        Checkpoint 10 is what can move an untagged document off
        ``NOT_IMPLEMENTED``: a readable PDF whose reference list PalCert
        recognized is no longer one PalCert knows nothing about. But it moves
        only to PARTIAL, and only when the detector actually produced
        objects. Scanning every span is not recognizing every citation style —
        an author-year document is invisible to this detector, and a
        `(Smith 2020)` it cannot see is exactly what COMPLETE would deny the
        existence of.
        """
        if no_text:
            # A scan has nothing to bind a declaration to, and an untagged
            # scan has no declaration either.
            return "UNAVAILABLE", "NO_TEXT_LAYER"
        if structure_truncated:
            return "PARTIAL", "LIMIT_TRUNCATED"
        if heuristics_truncated and heuristic_found:
            return "PARTIAL", "LIMIT_TRUNCATED"
        if not structure_present and not heuristic_found:
            # Nothing declared and nothing recognized. PalCert did not decline
            # to look — it looked and knows the styles it knows.
            return "UNAVAILABLE", "NOT_IMPLEMENTED"
        # Tagged, or recognized, or both. Either way a citation the author did
        # not tag and this detector does not recognize is invisible, so the
        # domain is never COMPLETE.
        return "PARTIAL", "SEMANTIC_CLASSIFICATION_NOT_EXHAUSTIVE"

    add(Domain.SEMANTIC_CITATIONS, *semantic_status(citations, heuristic_citations))
    add(Domain.SEMANTIC_REFERENCE_ENTRIES, *semantic_status(references, heuristic_references))

    # Positive-only, and **declared only**. A declared bibliography entry
    # proves a region exists; a region PalCert merely recognized does not, and
    # this domain is one of the two gates that keeps the exact positive marker
    # `referenceRegionPresent` out of reach of the heuristic layer. Heuristic
    # region discovery is recorded by the heuristic entries themselves, which
    # carry their own provenance and confidence.
    if references and not no_text:
        add(Domain.REFERENCE_REGION, "COMPLETE")
    elif no_text:
        add(Domain.REFERENCE_REGION, "UNAVAILABLE", "NO_TEXT_LAYER")
    else:
        add(Domain.REFERENCE_REGION, "UNAVAILABLE", "NOT_IMPLEMENTED")

    return entries


def _summary(
    citations: list[dict[str, Any]],
    references: list[dict[str, Any]],
    links: list[dict[str, Any]],
    *,
    exact_reference_count: int,
) -> dict[str, Any]:
    statuses = [str(citation["resolutionStatus"]) for citation in citations]
    return {
        "observedCitationCount": len(citations),
        # A PDF has no Word-native citation, whatever it has tagged.
        "nativeCitationCount": 0,
        "observedReferenceCount": len(references),
        "bibliographySourceCount": 0,
        "linkedCitationCount": statuses.count("LINKED"),
        "ambiguousCitationCount": statuses.count("AMBIGUOUS"),
        "unresolvedCitationCount": statuses.count("UNRESOLVED"),
        # Counted only over entries linking was actually attempted against:
        # an entry nobody tried to cite has not been observed to be uncited.
        "observedUncitedReferenceCount": (
            sum(1 for reference in references if reference["citedByCount"] == 0) if links else 0
        ),
        "observedDuplicateReferenceCount": 0,
        # Declared entries only. This flag feeds `referenceRegionPresent`,
        # which is an EXACT_POSITIVE_MARKER meaning "proven by structure" — so
        # a region PalCert recognized heuristically must not set it. The
        # second gate is the REFERENCE_REGION coverage domain above.
        "referenceRegionObserved": exact_reference_count > 0,
        "truncationFlags": [],
    }
