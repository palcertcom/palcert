"""Citation evidence becoming fact (Phase 18, Checkpoint 4).

Checkpoint 3 produced evidence nothing read. This is the layer that reads a
little of it, and these tests are mostly about what it refuses to say.

The reason they are worth this much space is the deterministic engine's
aggregation order: a failed condition produces FAIL *before* coverage is
consulted. So PARTIAL coverage prevents a false pass and does nothing about a
false failure. Every "this is not emitted" assertion below is that rule being
enforced somewhere it would otherwise cost somebody a wrongly failed thesis.
"""

from __future__ import annotations

import io
from typing import Any

from app.docx.catalogue import BY_NAME
from app.engine.contracts.citation_projection import PROJECTED_PROPERTIES
from tests.docx.test_citations import (
    analyze_docx,
    bibliography_field,
    citation_field,
    paragraph,
    source,
    with_store,
)

PROJECTED = {
    "nativeCitationCount",
    "nativeBibliographySourceCount",
    "nativeSourceResolved",
    "referenceRegionPresent",
    # Projectable from PDF only, and named here so a DOCX fact set carrying it
    # would fail rather than pass unnoticed.
    "citationTargetResolved",
}


def facts_for(envelope: dict[str, Any], property_name: str) -> list[dict[str, Any]]:
    return [
        fact
        for fact in envelope["factSet"]["facts"]
        if fact["scope"].get("property") == property_name
    ]


def coverage_for(envelope: dict[str, Any], **selector: Any) -> dict[str, Any] | None:
    for entry in envelope["factSet"]["coverage"]:
        if all(entry.get(key) == value for key, value in selector.items()):
            return entry
    return None


# --- a native linked citation becomes facts --------------------------------


def test_a_linked_citation_produces_the_expected_facts() -> None:
    envelope = analyze_docx(
        citation_field("Smi20") + bibliography_field("Smith, J. (2020)."),
        **with_store(source("Smi20")),
    )

    (count,) = facts_for(envelope, "nativeCitationCount")
    assert count["value"] == {"type": "NUMBER", "number": "1"}
    assert count["unit"] == "COUNT"

    (sources,) = facts_for(envelope, "nativeBibliographySourceCount")
    assert sources["value"] == {"type": "NUMBER", "number": "1"}
    assert sources["unit"] == "COUNT"

    (resolved,) = facts_for(envelope, "nativeSourceResolved")
    assert resolved["scope"] == {
        "kind": "ELEMENT",
        "elementType": "CITATION",
        "property": "nativeSourceResolved",
    }
    assert resolved["value"] == {"type": "BOOLEAN", "boolean": True}
    # The citation's own address, not the paragraph that contains it.
    assert resolved["location"]["nodeId"].endswith("/fld:1")
    assert resolved["location"]["elementType"] == "CITATION"

    (region,) = facts_for(envelope, "referenceRegionPresent")
    assert region["value"] == {"type": "BOOLEAN", "boolean": True}

    # Exact extraction carries no confidence, here as everywhere else.
    for fact in (count, sources, resolved, region):
        assert fact["provenance"] == {"sourceKind": "OOXML"}


def test_every_projected_fact_is_reachable_by_the_coverage_a_rule_reads() -> None:
    envelope = analyze_docx(citation_field("Smi20"), **with_store(source("Smi20")))
    assert coverage_for(envelope, kind="DOCUMENT", property="nativeCitationCount") == {
        "kind": "DOCUMENT",
        "property": "nativeCitationCount",
        "status": "COMPLETE",
    }
    assert (
        coverage_for(
            envelope, kind="ELEMENT", elementType="CITATION", property="nativeSourceResolved"
        )
        or {}
    ).get("status") == "COMPLETE"


# --- ambiguity survives projection -----------------------------------------


def test_an_ambiguous_citation_does_not_become_linked() -> None:
    """No fact at all, rather than a value that picks one of the candidates.

    ``true`` would assert a resolution PalCert refused to make, and ``false``
    would assert the citation does not resolve when the evidence says it may
    resolve to either of two records.
    """
    envelope = analyze_docx(
        citation_field("Smi20"),
        **with_store(source("Smi20"), source("Smi20", extra="<b:Publisher>Other</b:Publisher>")),
    )
    assert envelope["citationAnalysis"]["citations"][0]["resolutionStatus"] == "AMBIGUOUS"
    assert facts_for(envelope, "nativeSourceResolved") == []


def test_an_ambiguous_citation_drops_the_element_coverage_to_partial() -> None:
    """The subtle half, and the one that prevents a false pass.

    A rule such as "every citation resolves to a source" reads the facts that
    exist. With one citation linked and one ambiguous, COMPLETE coverage would
    let it pass on the linked one alone. PARTIAL turns that into INDETERMINATE.
    """
    envelope = analyze_docx(
        citation_field("Smi20") + citation_field("Dup01"),
        **with_store(
            source("Smi20"),
            source("Dup01"),
            source("Dup01", extra="<b:Publisher>Other</b:Publisher>"),
        ),
    )
    statuses = [
        citation["resolutionStatus"] for citation in envelope["citationAnalysis"]["citations"]
    ]
    assert statuses == ["LINKED", "AMBIGUOUS"]
    assert len(facts_for(envelope, "nativeSourceResolved")) == 1
    assert (
        coverage_for(
            envelope, kind="ELEMENT", elementType="CITATION", property="nativeSourceResolved"
        )
        or {}
    ).get("status") == "PARTIAL"


def test_a_citation_nobody_tried_to_link_is_not_reported_as_unresolved() -> None:
    """NOT_ATTEMPTED is not a value either.

    With no source store there is nothing exact to resolve against, so the
    citation has no link row — and a ``false`` fact would say PalCert looked
    and found nothing.
    """
    envelope = analyze_docx(citation_field("Smi20"))
    assert envelope["citationAnalysis"]["citations"][0]["resolutionStatus"] == "NOT_ATTEMPTED"
    assert facts_for(envelope, "nativeSourceResolved") == []
    assert (
        coverage_for(
            envelope, kind="ELEMENT", elementType="CITATION", property="nativeSourceResolved"
        )
        or {}
    ).get("status") == "UNAVAILABLE"


def test_an_unresolved_citation_is_false_and_gains_no_target() -> None:
    envelope = analyze_docx(citation_field("Gone99"), **with_store(source("Smi20")))
    (resolved,) = facts_for(envelope, "nativeSourceResolved")
    assert resolved["value"] == {"type": "BOOLEAN", "boolean": False}
    # A fact carries a value and a location. There is nowhere in it for a
    # target to appear, and nothing in the projection puts one there.
    assert set(resolved) == {"scope", "value", "location", "provenance"}
    assert "targetId" not in str(resolved)


# --- units ------------------------------------------------------------------


def test_exact_counts_keep_the_count_unit() -> None:
    envelope = analyze_docx(citation_field("Smi20"), **with_store(source("Smi20")))
    for name in ("nativeCitationCount", "nativeBibliographySourceCount"):
        (fact,) = facts_for(envelope, name)
        assert fact["unit"] == "COUNT"
        assert fact["value"]["type"] == "NUMBER"


def test_boolean_projections_are_unitless() -> None:
    envelope = analyze_docx(
        citation_field("Smi20") + bibliography_field("Smith, J."),
        **with_store(source("Smi20")),
    )
    for name in ("nativeSourceResolved", "referenceRegionPresent"):
        (fact,) = facts_for(envelope, name)
        assert "unit" not in fact
        assert fact["value"]["type"] == "BOOLEAN"


def test_the_registry_and_the_catalogue_agree() -> None:
    """Two declarations of the same properties, held to each other.

    The registry is the cross-language authority; the catalogue is what the
    fact builder checks emissions against. A unit in one and not the other
    would be a fact measured in something no rule can compare.

    Only the rows the registry marks projectable from DOCX are held to the
    DOCX catalogue: a row this format cannot project has nothing to agree
    with, and requiring an entry for it would be the catalogue describing a
    fact this analyzer can never emit.
    """
    for entry in PROJECTED_PROPERTIES:
        if "DOCX" not in entry.formats:
            assert entry.property not in BY_NAME
            continue
        documented = BY_NAME[entry.property]
        assert str(documented.value_kind) == entry.value_kind
        assert (str(documented.unit) if documented.unit else None) == entry.unit
        if entry.element_type is not None:
            assert entry.element_type in documented.element_types


# --- a partial document withholds a count ----------------------------------


def test_a_count_read_from_an_unreadable_document_is_not_emitted() -> None:
    """A partial count is a wrong number, so there is no number.

    PARTIAL would not save a rule like "at least twenty citations" from failing
    a compliant document, because FAIL is decided before coverage is read. The
    count is withheld and the coverage says UNAVAILABLE, which answers
    INDETERMINATE instead.
    """
    header_reference = (
        '<w:headerReference w:type="default" r:id="rIdHeaderdefault" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>'
    )
    from tests.docx.builder import section_properties

    store = with_store(source("Smi20"))
    envelope = analyze_docx(
        citation_field("Smi20") + section_properties(extra=header_reference),
        headers={"default": "<placeholder/>"},
        extra_relationships=store["extra_relationships"],
        raw_parts={
            **store["raw_parts"],
            "word/header_default.xml": b"<w:hdr not closed",
        },
    )
    assert facts_for(envelope, "nativeCitationCount") == []
    assert (coverage_for(envelope, kind="DOCUMENT", property="nativeCitationCount") or {}).get(
        "status"
    ) == "UNAVAILABLE"
    # The per-citation value survives: a story PalCert could not read does not
    # make the citations it *did* read resolve differently.
    assert len(facts_for(envelope, "nativeSourceResolved")) == 1
    assert (
        coverage_for(
            envelope, kind="ELEMENT", elementType="CITATION", property="nativeSourceResolved"
        )
        or {}
    ).get("status") == "PARTIAL"


def test_an_unreadable_source_store_withholds_the_source_count() -> None:
    envelope = analyze_docx(
        citation_field("Smi20"),
        extra_relationships={"rIdCustom1": ("customXml", "../customXml/item1.xml")},
        raw_parts={"customXml/item1.xml": b"<b:Sources not closed"},
    )
    assert facts_for(envelope, "nativeBibliographySourceCount") == []
    assert (
        coverage_for(envelope, kind="DOCUMENT", property="nativeBibliographySourceCount") or {}
    ).get("status") == "UNAVAILABLE"
    # The citation count is unaffected: a different domain, answered separately.
    (count,) = facts_for(envelope, "nativeCitationCount")
    assert count["value"]["number"] == "1"


# --- the reference region is positive-only ---------------------------------


def test_no_reference_region_means_no_fact_and_no_complete_coverage() -> None:
    """Absence of proof is not proof of absence.

    A hand-typed reference list is invisible to the BIBLIOGRAPHY-field proof,
    so a `false` fact — or COMPLETE coverage over a missing one — would let a
    rule fail a document that has a perfectly good reference list.
    """
    envelope = analyze_docx(paragraph("References") + paragraph("Smith, J. (2020)."))
    assert facts_for(envelope, "referenceRegionPresent") == []
    assert (coverage_for(envelope, kind="DOCUMENT", property="referenceRegionPresent") or {}).get(
        "status"
    ) == "UNAVAILABLE"


# --- nothing about a rendered entry ----------------------------------------


def test_a_rendered_reference_entry_never_becomes_a_fact() -> None:
    envelope = analyze_docx(bibliography_field("Smith, J. (2020).", "Khatib, A. (2019)."))
    assert len(envelope["citationAnalysis"]["references"]) == 2
    element_types = {fact["scope"].get("elementType") for fact in envelope["factSet"]["facts"]}
    assert "REFERENCE_ENTRY" not in element_types
    assert (coverage_for(envelope, kind="ELEMENT", elementType="REFERENCE_ENTRY") or {}).get(
        "status"
    ) == "UNAVAILABLE"


# --- determinism ------------------------------------------------------------


def test_projection_is_deterministic() -> None:
    kwargs = with_store(source("Smi20"), source("Kha19"))
    body = citation_field("Smi20") + citation_field("Gone99") + bibliography_field("Smith, J.")
    first = analyze_docx(body, **kwargs)
    second = analyze_docx(body, **kwargs)
    assert first["factSet"]["facts"] == second["factSet"]["facts"]
    assert first["factSet"]["coverage"] == second["factSet"]["coverage"]


# --- fact sets built without citation evidence ------------------------------


def test_a_fact_set_built_without_citation_analysis_stays_valid() -> None:
    """SmartFix builds a fact set for planning and never looks at citations.

    It must keep working, and it must not claim coverage it does not have:
    "this fact set was built without citation analysis" is a different
    statement from "this document has no citations", and only the first one is
    true here.
    """
    from app.docx.artifact import ANALYZER_NAME, ANALYZER_VERSION
    from app.docx.document import read_document
    from app.docx.facts import build_fact_set
    from app.docx.limits import AnalyzerLimits
    from app.docx.package import DocxPackage
    from app.docx.warnings import WarningCollector
    from app.engine.contracts.validation import validate_contract
    from app.engine.facts.model import FACT_SCHEMA_VERSION
    from tests.docx.builder import DocxBuilder
    from tests.docx.test_citations import STYLES

    content = DocxBuilder(
        body=citation_field("Smi20"), styles=STYLES, **with_store(source("Smi20"))
    ).build()
    limits = AnalyzerLimits.default()
    warnings = WarningCollector(limits)
    package = DocxPackage.open(io.BytesIO(content), limits, warnings)
    try:
        result = read_document(package, limits, warnings)
        fact_set = build_fact_set(
            model=result.model,
            document_id="d",
            extractor_name=ANALYZER_NAME,
            extractor_version=ANALYZER_VERSION,
            fact_schema_version=FACT_SCHEMA_VERSION,
            limits=limits,
            warnings=warnings,
        )
    finally:
        package.close()

    assert validate_contract("DocumentFactSet", fact_set).valid
    properties = {fact["scope"].get("property") for fact in fact_set["facts"]}
    assert properties.isdisjoint(PROJECTED)

    citation_coverage = [
        entry
        for entry in fact_set["coverage"]
        if entry.get("elementType") == "CITATION" or entry.get("property") in PROJECTED
    ]
    assert citation_coverage == [
        {
            "kind": "ELEMENT",
            "elementType": "CITATION",
            "property": "citationTargetResolved",
            "status": "UNAVAILABLE",
            "note": "a Word citation targets a bibliography source, not a reference entry",
        },
        {
            "kind": "ELEMENT",
            "elementType": "CITATION",
            "status": "UNAVAILABLE",
            "note": "this fact set was built without citation analysis",
        },
    ]

    # The same document through the analyzer does project, so the difference is
    # the caller's, not the document's.
    envelope = analyze_docx(citation_field("Smi20"), **with_store(source("Smi20")))
    assert facts_for(envelope, "nativeSourceResolved")
