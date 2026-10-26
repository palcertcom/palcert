"""What a PDF's citation evidence is allowed to assert (Phase 18, Checkpoints 8-9).

Two of the five approved properties cross into the fact set, and the reason
the other three do not is the same reason these two do.

Three are defined in Word's own terms — every Word ``CITATION`` field,
Word-managed source records, whether a Word citation's tag matches a record in
a Word source set. A PDF has none of those things, so a count of them is not
zero-because-we-counted; it is a question the format cannot be asked, and a
confident zero would fail a compliant document for lacking something it cannot
have.

``referenceRegionPresent`` is defined without reference to storage: a reference
region demonstrably exists, proven by structure. A DOCX proves it with a
``BIBLIOGRAPHY`` field and a PDF with a declared ``/BibEntry``. Same claim,
same refusal to ever emit false.

``citationTargetResolved`` (Checkpoint 9) is the second such property: does a
declared citation resolve to exactly one declared reference entry in the same
analyzed document? It is *not* ``nativeSourceResolved`` under another name — a
Word citation resolves to a bibliography source record, which is not a
reference entry — and this file holds the two apart.
"""

from __future__ import annotations

import hashlib
from typing import Any

from app.engine.contracts.citation_projection import (
    PROJECTED_PROPERTIES,
    projection_for,
    supports_format,
)
from app.engine.contracts.validation import validate_contract
from app.pdf.analyzer import analyze
from app.pdf.support import Format, Support, support_for
from tests.pdf.builder import (
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
WORD_NATIVE_ONLY = PROJECTED - {"referenceRegionPresent", "citationTargetResolved"}


def analyzed(data: bytes) -> dict[str, Any]:
    artifact: dict[str, Any] = analyze(
        data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d"
    )
    return artifact


def facts_for(artifact: dict[str, Any], name: str) -> list[dict[str, Any]]:
    return [fact for fact in artifact["factSet"]["facts"] if fact["scope"].get("property") == name]


def coverage_for(artifact: dict[str, Any], **selector: Any) -> dict[str, Any] | None:
    for entry in artifact["factSet"]["coverage"]:
        if all(entry.get(key) == value for key, value in selector.items()):
            return entry
    return None


# --- the one property that crosses -----------------------------------------


def test_a_proven_reference_region_becomes_a_fact() -> None:
    artifact = analyzed(tagged_citation_pdf())
    (fact,) = facts_for(artifact, "referenceRegionPresent")
    assert fact["scope"] == {"kind": "DOCUMENT", "property": "referenceRegionPresent"}
    assert fact["value"] == {"type": "BOOLEAN", "boolean": True}
    # A declared /BibEntry is the author's statement read through the structure
    # tree. Exact, and so carrying no confidence.
    assert fact["provenance"] == {"sourceKind": "PDF_TEXT"}
    assert coverage_for(artifact, kind="DOCUMENT", property="referenceRegionPresent") == {
        "kind": "DOCUMENT",
        "property": "referenceRegionPresent",
        "status": "COMPLETE",
    }


def test_the_marker_is_unitless_as_the_registry_says() -> None:
    artifact = analyzed(tagged_citation_pdf())
    (fact,) = facts_for(artifact, "referenceRegionPresent")
    assert "unit" not in fact
    row = projection_for("DOCUMENT", "referenceRegionPresent")
    assert row is not None
    assert row.unit is None
    assert row.value_kind == "BOOLEAN"
    assert supports_format(row, "PDF")


def test_absence_of_evidence_never_becomes_false() -> None:
    """And the coverage is what stops absence being read as proof.

    Without an entry of its own the property would inherit the PDF's DOCUMENT
    coverage, which is COMPLETE — and NOT_EXISTS would then pass, asserting
    that the document has no reference region. PalCert cannot know that.
    """
    artifact = analyzed(simple_text_pdf())
    assert facts_for(artifact, "referenceRegionPresent") == []
    assert (coverage_for(artifact, kind="DOCUMENT", property="referenceRegionPresent") or {}).get(
        "status"
    ) == "UNAVAILABLE"


def test_an_image_only_pdf_invents_no_citation_fact() -> None:
    artifact = analyzed(scanned_pdf())
    assert facts_for(artifact, "referenceRegionPresent") == []
    assert (coverage_for(artifact, kind="DOCUMENT", property="referenceRegionPresent") or {}).get(
        "status"
    ) == "UNAVAILABLE"


def test_an_untagged_page_that_looks_like_a_bibliography_projects_nothing() -> None:
    artifact = analyzed(tagged_citation_pdf(tagged=False))
    assert facts_for(artifact, "referenceRegionPresent") == []


# --- the three that do not --------------------------------------------------


def test_no_word_native_property_is_projected_from_a_pdf() -> None:
    for data in (tagged_citation_pdf(), internal_destination_pdf(), simple_text_pdf()):
        artifact = analyzed(data)
        properties = {fact["scope"].get("property") for fact in artifact["factSet"]["facts"]}
        assert properties.isdisjoint(WORD_NATIVE_ONLY)


def test_a_discovered_count_is_never_published_as_an_exact_total() -> None:
    """Two citations were found. Nothing says two is all there are.

    The artifact records what was discovered; the fact set publishes no count
    at all, because the only count properties mean Word-native citations and
    tagged discovery is never exhaustive anyway.
    """
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("[1]", "[2]"),
            entries=(("[1]", "Smith, J."), ("[2]", "Khatib, A.")),
        )
    )
    assert len(artifact["citationAnalysis"]["citations"]) == 2
    assert facts_for(artifact, "nativeCitationCount") == []
    assert facts_for(artifact, "nativeBibliographySourceCount") == []
    for name in ("nativeCitationCount", "nativeBibliographySourceCount"):
        assert (coverage_for(artifact, kind="DOCUMENT", property=name) or {}).get(
            "status"
        ) == "UNAVAILABLE"


RESOLUTION_CASES: dict[str, Any] = {
    "LINKED": lambda: tagged_citation_pdf(),
    "UNRESOLVED": lambda: tagged_citation_pdf(citations=("[7]",), entries=(("[1]", "Smith, J."),)),
    "AMBIGUOUS": lambda: tagged_citation_pdf(
        citations=("[1]",),
        entries=(("[1]", "Smith, J."), ("[1]", "Khatib, A.")),
    ),
    "NOT_ATTEMPTED": lambda: tagged_citation_pdf(
        citations=("(Smith et al., 2020)",), entries=(("[1]", "Smith, J."),)
    ),
}


def test_no_resolution_outcome_projects_a_word_native_value() -> None:
    """LINKED, UNRESOLVED, AMBIGUOUS and NOT_ATTEMPTED alike.

    ``nativeSourceResolved`` means a Word citation's tag matching a Word
    source record, and a PDF citation resolving to a rendered entry is a
    different relationship. Checkpoint 9 gave that relationship a property of
    its own rather than widening this one, so this stays empty for ever.
    """
    for expected, build in RESOLUTION_CASES.items():
        artifact = analyzed(build())
        assert artifact["citationAnalysis"]["citations"][0]["resolutionStatus"] == expected
        assert facts_for(artifact, "nativeSourceResolved") == [], expected
        assert support_for(Format.PDF, "nativeSourceResolved") is Support.UNSUPPORTED


def test_each_resolution_outcome_projects_the_value_it_licenses() -> None:
    """LINKED is true, UNRESOLVED is false, and the other two are silence.

    AMBIGUOUS is the one that matters. "PalCert could not choose between two
    entries" is not "this citation resolves to none", and a ``false`` would
    fail a document on evidence that says the opposite. NOT_ATTEMPTED is the
    same refusal from the other side: nobody tried, so nothing is claimed.
    """
    expected_values: dict[str, bool | None] = {
        "LINKED": True,
        "UNRESOLVED": False,
        "AMBIGUOUS": None,
        "NOT_ATTEMPTED": None,
    }
    for status, build in RESOLUTION_CASES.items():
        artifact = analyzed(build())
        citations = artifact["citationAnalysis"]["citations"]
        assert citations[0]["resolutionStatus"] == status
        facts = facts_for(artifact, "citationTargetResolved")
        want = expected_values[status]
        if want is None:
            assert facts == [], status
        else:
            assert [fact["value"] for fact in facts] == [{"type": "BOOLEAN", "boolean": want}], (
                status
            )


def test_an_unprovable_reference_region_does_not_silence_the_resolution() -> None:
    """Two independent claims, and one being unprovable answers nothing about
    the other.

    A tagged PDF can declare citations and no ``/BibEntry`` at all. The
    reference region is then unproven — and `referenceRegionPresent` is
    positive-only, so it stays silent — but each declared citation resolves to
    no declared entry, which is exactly what `citationTargetResolved` is
    ``false`` for. Emitting the coverage without the fact would have been the
    worse half of the bug: coverage claiming PARTIAL over a population no fact
    covered.
    """
    artifact = analyzed(tagged_citation_pdf(citations=("[1]",), entries=()))
    analysis = artifact["citationAnalysis"]
    assert analysis["references"] == []
    assert analysis["summary"]["referenceRegionObserved"] is False
    assert [c["resolutionStatus"] for c in analysis["citations"]] == ["UNRESOLVED"]

    assert facts_for(artifact, "referenceRegionPresent") == []
    assert [fact["value"] for fact in facts_for(artifact, "citationTargetResolved")] == [
        {"type": "BOOLEAN", "boolean": False}
    ]


def test_a_projected_resolution_fact_is_shaped_by_the_registry() -> None:
    """Scope, element type, value kind, unit and location, all pinned."""
    artifact = analyzed(tagged_citation_pdf())
    citation = artifact["citationAnalysis"]["citations"][0]
    (fact,) = facts_for(artifact, "citationTargetResolved")

    assert fact["scope"] == {
        "kind": "ELEMENT",
        "elementType": "CITATION",
        "property": "citationTargetResolved",
    }
    assert fact["value"] == {"type": "BOOLEAN", "boolean": True}
    # Unitless, because the registry row says so. A unit on a boolean would be
    # a measurement in nothing.
    assert "unit" not in fact
    # Exact evidence carries no confidence, at any point.
    assert "confidence" not in fact["provenance"]
    # The citation's own address, so a finding points at the citation rather
    # than at the line or page that contains it.
    assert fact["location"]["nodeId"] == citation["location"]["nodeId"]
    assert fact["location"]["elementType"] == "CITATION"


def test_a_partly_resolved_document_withholds_the_unanswered_citation() -> None:
    """One answered citation and one ambiguous one.

    End to end this shows the fact being withheld; the coverage demotion it
    would cause on its own is proved in
    :func:`test_an_unanswered_citation_demotes_complete_coverage_to_partial`,
    because a real PDF's identification domains are already PARTIAL.
    """
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("[1]", "[2]"),
            entries=(("[1]", "Smith, J."), ("[2]", "Khatib, A."), ("[2]", "Nasser, L.")),
        )
    )
    statuses = [c["resolutionStatus"] for c in artifact["citationAnalysis"]["citations"]]
    assert sorted(statuses) == ["AMBIGUOUS", "LINKED"]
    assert len(facts_for(artifact, "citationTargetResolved")) == 1
    assert (
        coverage_for(
            artifact, kind="ELEMENT", elementType="CITATION", property="citationTargetResolved"
        )
        or {}
    ).get("status") == "PARTIAL"


def test_even_a_fully_resolved_pdf_stops_at_partial_coverage() -> None:
    """Every citation answered, and the coverage is still PARTIAL.

    Two conditions have to hold for COMPLETE, and a PDF can only ever meet
    one. Every *identified* citation received a value here — but identification
    itself is not exhaustive on this format: a citation the author never tagged
    is invisible to the structure tree, so ``SEMANTIC_CITATIONS`` is PARTIAL
    and stays PARTIAL. Claiming COMPLETE would assert that PalCert saw every
    citation in the document, which it did not, and "every citation resolves"
    would then pass on the tagged ones alone.

    The weaker of the two domains wins, so a resolution answer is never
    stronger than the identification it rests on.
    """
    artifact = analyzed(
        tagged_citation_pdf(
            citations=("[1]", "[2]"),
            entries=(("[1]", "Smith, J."), ("[2]", "Khatib, A.")),
        )
    )
    assert [c["resolutionStatus"] for c in artifact["citationAnalysis"]["citations"]] == [
        "LINKED",
        "LINKED",
    ]
    assert len(facts_for(artifact, "citationTargetResolved")) == 2
    domains = {
        entry["domain"]: entry["status"] for entry in artifact["citationAnalysis"]["coverage"]
    }
    assert domains["SEMANTIC_CITATIONS"] == "PARTIAL"
    assert domains["SEMANTIC_REFERENCE_ENTRIES"] == "PARTIAL"
    assert (
        coverage_for(
            artifact, kind="ELEMENT", elementType="CITATION", property="citationTargetResolved"
        )
        or {}
    ).get("status") == "PARTIAL"


def test_a_pdf_with_no_declared_citations_claims_no_resolution_coverage() -> None:
    """There is no population this could be complete over.

    An untagged PDF is not a PDF whose citations all resolve; it is a PDF
    PalCert could not ask. COMPLETE here would let ``NOT_EXISTS`` pass and
    assert the document contains no unresolved citation.
    """
    artifact = analyzed(simple_text_pdf())
    assert facts_for(artifact, "citationTargetResolved") == []
    assert (
        coverage_for(
            artifact, kind="ELEMENT", elementType="CITATION", property="citationTargetResolved"
        )
        or {}
    ).get("status") == "UNAVAILABLE"


def test_a_scanned_pdf_claims_no_resolution_coverage() -> None:
    artifact = analyzed(scanned_pdf())
    assert facts_for(artifact, "citationTargetResolved") == []
    assert (
        coverage_for(
            artifact, kind="ELEMENT", elementType="CITATION", property="citationTargetResolved"
        )
        or {}
    ).get("status") == "UNAVAILABLE"


def test_no_reference_entry_fact_is_ever_emitted() -> None:
    artifact = analyzed(tagged_citation_pdf())
    assert artifact["citationAnalysis"]["references"]
    element_types = {fact["scope"].get("elementType") for fact in artifact["factSet"]["facts"]}
    assert "REFERENCE_ENTRY" not in element_types
    assert (coverage_for(artifact, kind="ELEMENT", elementType="REFERENCE_ENTRY") or {}).get(
        "status"
    ) == "UNAVAILABLE"


# --- the projector does not re-resolve anything ----------------------------


def test_the_projector_consumes_the_resolution_it_was_given() -> None:
    """Two exact methods disagreed; the producer made that ambiguity.

    The projector reads the citation's resolution and the coverage domains. It
    never looks at a link row's method, so it cannot prefer NUMERIC_LABEL over
    INTERNAL_DESTINATION or invent a second resolution algorithm.
    """
    artifact = analyzed(
        internal_destination_pdf(
            entries=(("[1]", "Smith, J. (2020)."), ("[2]", "Khatib, A. (2019).")),
            citation_marker="[1]",
            destination="second-entry",
        )
    )
    analysis = artifact["citationAnalysis"]
    assert analysis["citations"][0]["resolutionStatus"] == "AMBIGUOUS"
    assert {link["linkMethod"] for link in analysis["links"]} == {
        "NUMERIC_LABEL",
        "INTERNAL_DESTINATION",
    }
    # The region is still proven, and that is all the fact set says.
    assert facts_for(artifact, "referenceRegionPresent")
    assert facts_for(artifact, "nativeSourceResolved") == []


def test_projection_loses_no_provenance() -> None:
    """The fact is a projection, not a replacement for the evidence graph."""
    artifact = analyzed(
        internal_destination_pdf(
            entries=(("[1]", "Smith, J. (2020)."), ("[2]", "Khatib, A. (2019).")),
            citation_marker="[1]",
            destination="first-entry",
        )
    )
    analysis = artifact["citationAnalysis"]
    assert [link["linkMethod"] for link in analysis["links"]] == [
        "NUMERIC_LABEL",
        "INTERNAL_DESTINATION",
    ]
    assert analysis["citations"][0]["sourceKind"] == "PDF_TEXT"
    assert analysis["citations"][0]["parseStatus"] == "UNPARSED"
    assert analysis["references"][0]["label"] == 1
    assert [entry["domain"] for entry in analysis["coverage"]]


# --- coverage never claims more than it knows ------------------------------


def test_semantic_coverage_stays_partial_while_the_fact_is_exact() -> None:
    """A fact may be exact while the domain it came from is PARTIAL.

    The region is proven; whether every citation in the document was tagged is
    unknown, and remains unknown after the projection.
    """
    artifact = analyzed(tagged_citation_pdf())
    advisory = {entry["domain"]: entry for entry in artifact["citationAnalysis"]["coverage"]}
    assert advisory["SEMANTIC_CITATIONS"]["status"] == "PARTIAL"
    assert advisory["REFERENCE_REGION"]["status"] == "COMPLETE"
    assert facts_for(artifact, "referenceRegionPresent")


def test_a_truncated_structure_tree_claims_nothing_exhaustive() -> None:
    from app.pdf.citation_facts import citation_coverage, citation_facts

    truncated = {
        "summary": {"referenceRegionObserved": True},
        # A declared entry, because the marker is exact evidence and the
        # projector reads the entries themselves to be sure of it.
        "references": [{"sourceKind": "PDF_TEXT"}],
        "citations": [],
        "coverage": [
            {
                "domain": "REFERENCE_REGION",
                "status": "PARTIAL",
                "reasonCode": "LIMIT_TRUNCATED",
            }
        ],
    }
    # A positive marker may be emitted under PARTIAL — it is emitted only when
    # true, so a partial read cannot make it wrong — but the coverage says
    # PARTIAL and never COMPLETE.
    assert citation_facts(truncated)
    entry = next(
        item
        for item in citation_coverage(truncated)
        if item.get("property") == "referenceRegionPresent"
    )
    assert entry["status"] == "PARTIAL"


def test_a_fact_set_built_without_citation_analysis_claims_nothing() -> None:
    from app.pdf.citation_facts import citation_coverage, citation_facts

    assert citation_facts(None) == []
    statuses = {
        entry.get("property") or entry.get("elementType"): entry["status"]
        for entry in citation_coverage(None)
    }
    assert set(statuses.values()) == {"UNAVAILABLE"}


# --- the fact set stays valid ----------------------------------------------


def test_the_pdf_fact_set_satisfies_the_shared_contract() -> None:
    for data in (tagged_citation_pdf(), scanned_pdf(), simple_text_pdf()):
        artifact = analyzed(data)
        result = validate_contract("DocumentFactSet", artifact["factSet"])
        assert result.valid, [issue.message for issue in result.issues]


def test_every_emitted_property_is_one_pdf_declares_it_can_answer() -> None:
    from app.pdf.support import supported_pdf_properties

    allowed = supported_pdf_properties()
    artifact = analyzed(tagged_citation_pdf())
    for fact in artifact["factSet"]["facts"]:
        name = fact["scope"].get("property")
        if name is not None:
            assert name in allowed, name


def test_the_registry_and_the_public_support_registry_agree_about_pdf() -> None:
    """The two tables must agree about the support level, not merely the name.

    An advisory row that the support registry called EXACT would be the whole
    failure this checkpoint guards against, expressed as a one-word
    disagreement between two files nobody reads together.
    """
    for entry in PROJECTED_PROPERTIES:
        if not supports_format(entry, "PDF"):
            expected = Support.UNSUPPORTED
        elif entry.advisory:
            expected = Support.ADVISORY
        else:
            expected = Support.EXACT
        assert support_for(Format.PDF, entry.property) is expected, entry.property


def test_projection_is_deterministic() -> None:
    data = tagged_citation_pdf()
    assert analyzed(data)["factSet"] == analyzed(data)["factSet"]


# --- a defect this checkpoint found -----------------------------------------


def test_pdf_string_and_enum_facts_use_the_keys_the_engine_reads() -> None:
    """A Phase 13 defect, found because Checkpoint 8 validated the fact set.

    The PDF builder wrote ``{"type": "STRING", "string": …}`` and
    ``{"type": "ENUM", "enum": …}``. The shared contract defines ``text`` and
    ``enumValue``, and ``FactValue.from_json`` reads exactly those — so every
    PDF string and enum fact reached the rule engine with no value at all, and
    a rule about a PDF's orientation or its producer silently matched nothing.

    It survived because the PDF analyzer never ran its fact set through the
    contract the way the DOCX analyzer always has. It does now, so this cannot
    come back quietly.
    """
    from app.engine.facts.model import DocumentFactSet

    artifact = analyzed(simple_text_pdf())
    typed = [
        fact for fact in artifact["factSet"]["facts"] if fact["value"]["type"] in {"STRING", "ENUM"}
    ]
    assert typed, "the fixture must emit at least one string or enum fact"
    for fact in typed:
        assert "string" not in fact["value"]
        assert "enum" not in fact["value"]

    # Read back the way the engine reads it: every value arrives populated.
    parsed = DocumentFactSet.from_json(artifact["factSet"])
    for fact in parsed.facts:
        if str(fact.value.type) == "STRING":
            assert fact.value.text
        elif str(fact.value.type) == "ENUM":
            assert fact.value.enum_value


# --- the per-element rule, held apart from the format's own limit ----------


def _analysis(statuses: tuple[str, ...], *, domain_status: str) -> dict[str, Any]:
    """The smallest shape :mod:`app.pdf.citation_facts` reads.

    Built by hand so the per-element rule can be exercised with COMPLETE
    identification domains — which a real PDF never has, and which is exactly
    why the rule would otherwise go untested on this format.
    """
    return {
        "citations": [
            {
                # Declared, because this property answers for declared
                # citations only. A heuristic one is covered by its own tests.
                "sourceKind": "PDF_TEXT",
                "resolutionStatus": status,
                "location": {"locationSchemaVersion": 1, "nodeId": f"c{i}"},
            }
            for i, status in enumerate(statuses)
        ],
        "coverage": [
            {"domain": "SEMANTIC_CITATIONS", "status": domain_status},
            {"domain": "SEMANTIC_REFERENCE_ENTRIES", "status": domain_status},
        ],
    }


def test_complete_identification_with_every_citation_answered_is_complete() -> None:
    from app.pdf.citation_facts import _citation_target_coverage

    assert (
        _citation_target_coverage(_analysis(("LINKED", "UNRESOLVED"), domain_status="COMPLETE"))
        == "COMPLETE"
    )


def test_an_unanswered_citation_demotes_complete_coverage_to_partial() -> None:
    """The Checkpoint-4 principle, on the PDF side.

    An ambiguous citation produces no fact, so a rule such as "every citation
    resolves" would read only the citations PalCert was sure about and pass on
    those. Declaring PARTIAL is what turns that false pass into INDETERMINATE.
    """
    from app.pdf.citation_facts import _citation_target_coverage

    for unanswered in ("AMBIGUOUS", "NOT_ATTEMPTED"):
        assert (
            _citation_target_coverage(_analysis(("LINKED", unanswered), domain_status="COMPLETE"))
            == "PARTIAL"
        ), unanswered


def test_no_citation_answered_is_unavailable_not_partial() -> None:
    """Nothing was established, so there is nothing to be partly sure of."""
    from app.pdf.citation_facts import _citation_target_coverage

    assert (
        _citation_target_coverage(_analysis(("AMBIGUOUS",), domain_status="COMPLETE"))
        == "UNAVAILABLE"
    )


def test_the_weaker_identification_domain_governs() -> None:
    """A resolution answer is never stronger than the identification beneath it.

    An entry PalCert never identified cannot be the target of a citation it
    did, so both halves have to hold and the weaker one wins.
    """
    from app.pdf.citation_facts import _citation_target_coverage

    analysis = _analysis(("LINKED",), domain_status="COMPLETE")
    analysis["coverage"][1]["status"] = "PARTIAL"
    assert _citation_target_coverage(analysis) == "PARTIAL"

    analysis["coverage"][1]["status"] = "UNAVAILABLE"
    assert _citation_target_coverage(analysis) == "UNAVAILABLE"


def test_a_missing_identification_domain_fails_closed() -> None:
    from app.pdf.citation_facts import _citation_target_coverage

    analysis = _analysis(("LINKED",), domain_status="COMPLETE")
    analysis["coverage"] = [analysis["coverage"][0]]
    assert _citation_target_coverage(analysis) == "UNAVAILABLE"
