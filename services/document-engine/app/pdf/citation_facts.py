"""Projecting PDF citation evidence into facts (Phase 18, Checkpoints 8-9).

Two properties cross, and the reason the other three do not is the same reason
these two do.

``contracts/registries/citation-projection.json`` holds five approved
properties. Three are defined in Word's own terms — every Word ``CITATION``
field, Word-managed bibliography source records, whether a Word citation's tag
matches a record in a Word source set. A PDF has none of those things, so a
count of them is not zero-because-we-counted, it is a question the format
cannot be asked. Projecting a confident zero would fail a compliant PDF for
lacking something it cannot have, which is precisely the false failure the
allow-list exists to prevent.

``referenceRegionPresent`` is defined without reference to storage: *a
reference region demonstrably exists, proven by structure*. A DOCX proves it
with a ``BIBLIOGRAPHY`` field and a PDF with a declared ``/BibEntry``. The
proof differs; the claim is identical, and so is the refusal to ever emit
false — absence of proof is not proof of absence, and an untagged reference
list is invisible to this test.

``citationTargetResolved`` is the second: *does this declared citation resolve
to exactly one declared reference entry in the same document?* It is not
``nativeSourceResolved`` widened — a Word citation resolves to a bibliography
source record, which is not a reference entry — and the two have mirror-image
format support because the two graphs are mirror images.

Checkpoint 10 added a heuristic discovery layer, and it changes nothing here
except to make one rule explicit. Both projected properties are *exact*
evidence — an ``EXACT_POSITIVE_MARKER`` and an ``EXACT_ELEMENT_VALUE`` — so
every input this module reads is filtered to ``sourceKind: PDF_TEXT`` before
it can reach a fact. A citation PalCert recognized by pattern is artifact
evidence and nothing more, however confident the recognition was and however
cleanly its heuristic link resolved.

The registry decides, here as on the DOCX side: the format list, the value
kind, the unit and the coverage policy are read off the row rather than
restated. Nothing in this module re-resolves a citation: the producer and the
integrity pass already established every resolution, and a second algorithm
that disagreed with them would be the worst of both.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from app.engine.contracts.citation_projection import (
    ProjectionKind,
    fact_coverage_for,
    projection_for,
    supports_format,
)

FORMAT = "PDF"

#: The advisory domains that answer for each projectable property. Citation
#: resolution needs both halves: an entry PalCert never identified cannot be
#: the target of a citation it did.
_DOMAINS_FOR_PROPERTY = {
    "referenceRegionPresent": ("REFERENCE_REGION",),
    "citationTargetResolved": ("SEMANTIC_CITATIONS", "SEMANTIC_REFERENCE_ENTRIES"),
    # The advisory rows answer from the semantic domains, which are where
    # heuristic discovery reports what it managed to classify.
    "observedCitationCount": ("SEMANTIC_CITATIONS",),
    "observedReferenceCount": ("SEMANTIC_REFERENCE_ENTRIES",),
    "observedReferenceRegionPresent": ("SEMANTIC_REFERENCE_ENTRIES",),
}

#: The only provenance an advisory fact may be built from.
#:
#: The mirror of ``EXACT_SOURCE_KIND`` and just as strict. An advisory count
#: that also counted declared objects could not carry an honest ``sourceKind``
#: — it would be part-read and part-recognized — and the evaluator's gate keys
#: on exactly that field.
HEURISTIC_SOURCE_KIND = "HEURISTIC"

#: Weakest-wins ordering for combining domains.
_RANK = {"COMPLETE": 2, "PARTIAL": 1, "UNAVAILABLE": 0}

#: The only provenance an exact fact may be built from.
#:
#: Not a filter added defensively: both projected properties are *exact*
#: kinds, and an object this layer merely classified is by definition not
#: exact. PDF_LAYOUT is excluded for the same reason — PalCert's own grouping
#: of spans is derived, and no projected property rests on it.
EXACT_SOURCE_KIND = "PDF_TEXT"

#: Per-citation resolution, as the citation-level statuses translate.
#:
#: AMBIGUOUS and NOT_ATTEMPTED are deliberately absent: neither is a value.
#: "PalCert could not choose between two entries" is not "this citation
#: resolves to none", and "nobody tried" is not a failed attempt.
_RESOLUTION_VALUE = {"LINKED": True, "UNRESOLVED": False}


def _domain_status(analysis: dict[str, Any], domain: str) -> str:
    for entry in analysis["coverage"]:
        if entry["domain"] == domain:
            return str(entry["status"])
    # A domain the artifact did not answer is one PalCert cannot claim to have
    # covered. Fail closed, as the rule engine's own default does.
    return "UNAVAILABLE"


def _combined_status(analysis: dict[str, Any], property_name: str) -> str:
    """The weakest of the domains a property depends on."""
    statuses = [_domain_status(analysis, domain) for domain in _DOMAINS_FOR_PROPERTY[property_name]]
    return min(statuses, key=lambda status: _RANK.get(status, 0))


def projectable_properties() -> tuple[str, ...]:
    """Every allow-list property this format may project, from the registry."""
    from app.engine.contracts.citation_projection import PROJECTED_PROPERTIES

    return tuple(entry.property for entry in PROJECTED_PROPERTIES if supports_format(entry, FORMAT))


def citation_facts(analysis: dict[str, Any] | None) -> list[dict[str, Any]]:
    """The citation facts a PDF may emit, and no others.

    Each property decides for itself. They are independent claims resting on
    different evidence, so one being unprovable must never silence another —
    a document can declare citations that resolve to nothing without a
    ``/BibEntry`` anywhere, and "no reference region proven" is not an answer
    about those citations.
    """
    if analysis is None:
        return []
    return [
        *_reference_region_facts(analysis),
        *_citation_target_facts(analysis),
        *_advisory_facts(analysis),
    ]


def _heuristic(objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The objects PalCert recognized, never the ones the author declared.

    The two populations are already disjoint in the artifact: the analyzer
    suppresses any heuristic object overlapping a span a declared element
    covers, so nothing is counted twice and no exact object is restated here
    under a weaker provenance.
    """
    return [item for item in objects if str(item.get("sourceKind")) == HEURISTIC_SOURCE_KIND]


def _advisory_count_fact(
    analysis: dict[str, Any], property_name: str, observed: int
) -> list[dict[str, Any]]:
    """One advisory counter, or nothing.

    Positive-only, under the discipline every advisory row here follows:
    advisory evidence is emitted affirmatively or not at all. A count of zero
    would restate the fact's own absence, and emitting it would change the
    fact set of every exact-only document to report on a detector that found
    nothing there.

    No confidence. Several observations with their own confidences contribute
    to one number, and there is no honest way to combine them: a single figure
    beside "7" would have to mean confidence that there are seven, which is
    not what any of the per-object numbers measured. The checkpoint's own rule
    applies — omit an aggregate rather than invent one.
    """
    row = projection_for("DOCUMENT", property_name)
    if row is None or not supports_format(row, FORMAT):  # pragma: no cover - registry guard
        return []
    if row.projection_kind is not ProjectionKind.ADVISORY_COUNT:  # pragma: no cover
        raise ValueError(f"{property_name} is not an advisory count in the registry")

    status = fact_coverage_for(row.coverage_policy, _combined_status(analysis, property_name))
    if status == "UNAVAILABLE":
        return []
    if observed == 0:
        # Positive-only, exactly as the two markers are. A zero from a
        # lower-bound detector states nothing the fact's absence does not
        # already state — "we recognized none" is not "there are none" — and
        # emitting it would change the fact set of every exact-only document
        # to say something about a detector that found nothing in it.
        return []

    fact: dict[str, Any] = {
        "scope": {"kind": "DOCUMENT", "property": property_name},
        "value": {"type": "NUMBER", "number": str(observed)},
        "provenance": {"sourceKind": HEURISTIC_SOURCE_KIND},
    }
    if row.unit is not None:
        fact["unit"] = row.unit
    return [fact]


def _advisory_region_fact(analysis: dict[str, Any]) -> list[dict[str, Any]]:
    """That PalCert recognized a reference list nobody declared.

    Positive-only, exactly as the exact marker is and for the identical
    reason: a list written in a style the detector does not know is invisible
    to it, so an absent fact is not evidence of an absent list.

    This one *does* carry a confidence, and it is a selection rather than a
    computation. The claim is existential — "at least one region was
    recognized" — so the region that best supports it is the strongest one,
    and its own analyzer-produced confidence is copied across unchanged.
    Nothing is averaged and nothing is recomputed.
    """
    row = projection_for("DOCUMENT", "observedReferenceRegionPresent")
    if row is None or not supports_format(row, FORMAT):  # pragma: no cover - registry guard
        return []
    if row.projection_kind is not ProjectionKind.ADVISORY_POSITIVE_MARKER:  # pragma: no cover
        raise ValueError("observedReferenceRegionPresent is not an advisory marker")

    status = fact_coverage_for(
        row.coverage_policy, _combined_status(analysis, "observedReferenceRegionPresent")
    )
    if status == "UNAVAILABLE":
        return []

    regions = [
        region
        for region in analysis.get("referenceRegions", [])
        if str(region.get("sourceKind")) == HEURISTIC_SOURCE_KIND
    ]
    if not regions:
        return []

    confidences = [str(region["confidence"]) for region in regions if "confidence" in region]
    provenance: dict[str, Any] = {"sourceKind": HEURISTIC_SOURCE_KIND}
    if confidences:
        provenance["confidence"] = max(confidences, key=lambda value: Decimal(value))

    return [
        {
            "scope": {"kind": "DOCUMENT", "property": "observedReferenceRegionPresent"},
            "value": {"type": "BOOLEAN", "boolean": True},
            "provenance": provenance,
        }
    ]


def _advisory_facts(analysis: dict[str, Any]) -> list[dict[str, Any]]:
    """Everything heuristic discovery is allowed to say in public.

    Three document-level observations and nothing else. No candidate ids, no
    link methods, no parsed titles, no DOIs, no per-citation assertions: those
    stay in the artifact, where a reader can see them labelled as evidence,
    and none of them has a public property contract.
    """
    return [
        *_advisory_count_fact(
            analysis, "observedCitationCount", len(_heuristic(analysis["citations"]))
        ),
        *_advisory_count_fact(
            analysis, "observedReferenceCount", len(_heuristic(analysis["references"]))
        ),
        *_advisory_region_fact(analysis),
    ]


def _reference_region_facts(analysis: dict[str, Any]) -> list[dict[str, Any]]:
    """At most one fact, and only when a declared entry proves the region."""
    row = projection_for("DOCUMENT", "referenceRegionPresent")
    if row is None or not supports_format(row, FORMAT):  # pragma: no cover - registry guard
        return []
    if row.projection_kind is not ProjectionKind.EXACT_POSITIVE_MARKER:  # pragma: no cover
        raise ValueError("referenceRegionPresent is not a positive marker in the registry")

    status = fact_coverage_for(
        row.coverage_policy, _combined_status(analysis, "referenceRegionPresent")
    )
    if status == "UNAVAILABLE":
        return []
    if not any(
        str(reference.get("sourceKind")) == EXACT_SOURCE_KIND
        for reference in analysis["references"]
    ):
        # The third gate, after the REFERENCE_REGION coverage domain and the
        # summary flag, and the only one that reads the entries themselves. A
        # region PalCert recognized proves nothing about structure, and this
        # property's whole contract is "proven by structure".
        return []
    if not bool(analysis["summary"]["referenceRegionObserved"]):
        # Emitted only when proven. A `false` here would let a rule fail a
        # document for a reference list PalCert merely did not find, and an
        # untagged one is invisible to the proof this value rests on.
        return []

    fact: dict[str, Any] = {
        "scope": {"kind": "DOCUMENT", "property": "referenceRegionPresent"},
        "value": {"type": "BOOLEAN", "boolean": True},
        # A declared /BibEntry is text the author marked, read through the
        # structure tree. Exact, and so carrying no confidence.
        "provenance": {"sourceKind": "PDF_TEXT"},
    }
    if row.unit is not None:  # pragma: no cover - the row is unitless
        fact["unit"] = row.unit
    return [fact]


def _exact_citations(analysis: dict[str, Any]) -> list[dict[str, Any]]:
    """The citations the author declared, which are the only projectable ones.

    ``citationTargetResolved`` is an ``EXACT_ELEMENT_VALUE``. A heuristic
    citation's resolution can be perfectly clean — one bracketed marker, one
    numbered entry, one candidate — and it is still PalCert's reading of a
    pattern rather than the document's own statement. Publishing it under an
    exact property would make a guess indistinguishable from a declaration in
    the one place that decides verdicts.
    """
    return [
        citation
        for citation in analysis["citations"]
        if str(citation.get("sourceKind")) == EXACT_SOURCE_KIND
    ]


def _citation_target_facts(analysis: dict[str, Any]) -> list[dict[str, Any]]:
    """One value per *declared* citation PalCert actually resolved.

    The citation's own ``resolutionStatus`` is read and nothing else. The
    producer and the integrity pass already settled it — including the case
    where two exact methods disagreed and the citation became AMBIGUOUS — so
    reading the link rows here would be a second resolution algorithm able to
    disagree with the first.
    """
    row = projection_for("ELEMENT", "citationTargetResolved", "CITATION")
    if row is None or not supports_format(row, FORMAT):  # pragma: no cover - registry guard
        return []
    if row.projection_kind is not ProjectionKind.EXACT_ELEMENT_VALUE:  # pragma: no cover
        raise ValueError("citationTargetResolved is not an element value in the registry")
    if (
        fact_coverage_for(row.coverage_policy, _combined_status(analysis, "citationTargetResolved"))
        == "UNAVAILABLE"
    ):
        return []

    facts: list[dict[str, Any]] = []
    for citation in _exact_citations(analysis):
        resolved = _RESOLUTION_VALUE.get(str(citation["resolutionStatus"]))
        if resolved is None:
            continue
        fact: dict[str, Any] = {
            "scope": {
                "kind": "ELEMENT",
                "elementType": "CITATION",
                "property": "citationTargetResolved",
            },
            "value": {"type": "BOOLEAN", "boolean": resolved},
            # The citation's own address, so a finding points at the citation
            # rather than at the line or the page that contains it.
            "location": {
                "locationSchemaVersion": citation["location"]["locationSchemaVersion"],
                "nodeId": citation["location"]["nodeId"],
                "elementType": "CITATION",
                **(
                    {"page": citation["location"]["page"]}
                    if citation["location"].get("page") is not None
                    else {}
                ),
            },
            "provenance": {"sourceKind": "PDF_TEXT"},
        }
        if row.unit is not None:  # pragma: no cover - the row is unitless
            fact["unit"] = row.unit
        facts.append(fact)
    return facts


def _citation_target_coverage(analysis: dict[str, Any] | None) -> str:
    """COMPLETE only when every citation in scope received a value.

    The Checkpoint-4 principle, on the PDF side. An ambiguous citation
    produces no fact, so a rule such as "every citation resolves" would read
    only the citations PalCert was sure about and pass on those. Declaring the
    domain PARTIAL is what turns that false pass into INDETERMINATE.
    """
    row = projection_for("ELEMENT", "citationTargetResolved", "CITATION")
    if analysis is None or row is None or not supports_format(row, FORMAT):
        return "UNAVAILABLE"
    status = fact_coverage_for(
        row.coverage_policy, _combined_status(analysis, "citationTargetResolved")
    )
    if status == "UNAVAILABLE":
        return status
    # The population is the declared citations, because those are the only
    # ones this property answers for. A document of heuristic citations alone
    # has no population here, and saying PARTIAL over it would imply some of
    # them were answered.
    citations = _exact_citations(analysis)
    if not citations:
        # Nothing was identified, so there is no population this could be
        # complete over.
        return "UNAVAILABLE"
    answered = sum(
        1 for citation in citations if str(citation["resolutionStatus"]) in _RESOLUTION_VALUE
    )
    if answered == 0:
        return "UNAVAILABLE"
    if answered < len(citations):
        return "PARTIAL"
    return status


def citation_coverage(analysis: dict[str, Any] | None) -> list[dict[str, Any]]:
    """What the fact set may claim about citation evidence in a PDF.

    Written out rather than left to the DOCUMENT default, which is COMPLETE.
    Without an entry of its own, a missing ``referenceRegionPresent`` would be
    read under COMPLETE coverage — and ``NOT_EXISTS`` would then *pass*, which
    asserts that the document has no reference region. PalCert cannot know
    that, and this entry is what stops it saying so.
    """
    entries: list[dict[str, Any]] = []

    resolution = _citation_target_coverage(analysis)
    entries.append(
        {
            "kind": "ELEMENT",
            "elementType": "CITATION",
            "status": resolution,
            "note": ("only declared citations are projected; heuristic discovery reaches no fact"),
        }
    )
    entries.append(
        {
            "kind": "ELEMENT",
            "elementType": "CITATION",
            "property": "citationTargetResolved",
            "status": resolution,
        }
    )
    entries.append(
        {
            "kind": "ELEMENT",
            "elementType": "REFERENCE_ENTRY",
            "status": "UNAVAILABLE",
            "note": "a rendered entry is identified by classification, which is not projected",
        }
    )

    for name in ("nativeCitationCount", "nativeBibliographySourceCount", "nativeSourceResolved"):
        entries.append(
            {
                "kind": "DOCUMENT" if name != "nativeSourceResolved" else "ELEMENT",
                **({} if name != "nativeSourceResolved" else {"elementType": "CITATION"}),
                "property": name,
                "status": "UNAVAILABLE",
                "note": "a PDF has no Word-native citation storage to answer this from",
            }
        )

    row = projection_for("DOCUMENT", "referenceRegionPresent")
    status = "UNAVAILABLE"
    if analysis is not None and row is not None and supports_format(row, FORMAT):
        status = fact_coverage_for(
            row.coverage_policy,
            _combined_status(analysis, "referenceRegionPresent"),
        )
    entries.append({"kind": "DOCUMENT", "property": "referenceRegionPresent", "status": status})

    # The advisory rows carry explicit coverage for the same reason the exact
    # ones do, and one more. Without an entry a missing advisory fact would
    # inherit the DOCUMENT default of COMPLETE, and a rule reading
    # `observedCitationCount` with NOT_EXISTS would *pass* — asserting that
    # PalCert recognized no citations *and* that this was the whole story. The
    # status is never COMPLETE: a heuristic population is a lower bound, so
    # claiming exhaustiveness is exactly what the policy forbids.
    for name in (
        "observedCitationCount",
        "observedReferenceCount",
        "observedReferenceRegionPresent",
    ):
        advisory_row = projection_for("DOCUMENT", name)
        advisory_status = "UNAVAILABLE"
        if analysis is not None and advisory_row is not None:
            advisory_status = fact_coverage_for(
                advisory_row.coverage_policy, _combined_status(analysis, name)
            )
        entries.append(
            {
                "kind": "DOCUMENT",
                "property": name,
                "status": advisory_status,
                "note": (
                    "heuristic discovery is a lower bound over the styles the detector "
                    "knows; never exhaustive, and never a total"
                ),
            }
        )

    return entries
