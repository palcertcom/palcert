"""Projecting citation evidence into facts (Phase 18, Checkpoint 4).

The line between evidence and authority. Checkpoint 3 produced a validated
``citationAnalysis``; nothing in it could decide anything, because nothing read
it. This is what reads it — and it reads almost none of it.

``contracts/registries/citation-projection.json`` is the authority for what may
cross, and it is consulted rather than paraphrased: the value kind and the unit
of every fact emitted here come out of the registry row, never out of the
property's name. A property absent from the registry is not projectable, and
that is the whole answer — not a gap for this module to fill in.

Two things this module will not do, both of them because of how the
deterministic engine aggregates. It evaluates FAIL before it consults coverage,
so ``PARTIAL`` prevents a false pass and does **not** prevent a false failure:

* **A value it is not sure of is not emitted.** An ambiguous link produces no
  fact at all, rather than a fact that picks one of the candidates or a
  ``false`` that says the citation does not resolve.
* **Coverage is COMPLETE only when every element in scope got a value.** A
  per-element property whose facts cover some citations and not others is
  ``PARTIAL``, because a rule reading only the facts that exist would otherwise
  pass a document on the citations PalCert happened to be sure about.
"""

from __future__ import annotations

from fractions import Fraction
from typing import Any

from app.engine.contracts.citation_projection import (
    ProjectedProperty,
    ProjectionKind,
    fact_coverage_for,
    projection_for,
)
from app.engine.units.registry import Unit, format_exact

#: Which advisory coverage domain governs each projected property.
#:
#: A binding rather than a contract: the registry says what may be projected
#: and how it is typed, and this says which of the artifact's six domains
#: answers for it. It lives here because it is knowledge about the producer —
#: the same property projected from a different analyzer could be governed by
#: a different domain.
_DOMAIN_FOR_PROPERTY = {
    "nativeCitationCount": "NATIVE_CITATIONS",
    "nativeBibliographySourceCount": "NATIVE_BIBLIOGRAPHY_SOURCES",
    "nativeSourceResolved": "NATIVE_SOURCE_RESOLUTION",
    "referenceRegionPresent": "REFERENCE_REGION",
}

#: Per-citation resolution, as the link statuses translate.
#:
#: AMBIGUOUS and NOT_ATTEMPTED are deliberately absent: neither is a value.
#: "PalCert could not choose between two sources" is not "the citation does not
#: resolve", and emitting ``false`` for it would fail a document for evidence
#: that says the opposite.
_RESOLUTION_VALUE = {"LINKED": True, "UNRESOLVED": False}


def _domain_status(analysis: dict[str, Any], domain: str) -> str:
    for entry in analysis["coverage"]:
        if entry["domain"] == domain:
            return str(entry["status"])
    # A domain the artifact did not answer is one PalCert cannot claim to have
    # covered. Fail closed, exactly as the rule engine's own default does.
    return "UNAVAILABLE"


def _row(scope_kind: str, prop: str, element_type: str | None = None) -> ProjectedProperty:
    entry = projection_for(scope_kind, prop, element_type)
    if entry is None:  # pragma: no cover - a registry change would fail a test first
        raise ValueError(f"{scope_kind}/{element_type or ''}/{prop} is not projectable")
    return entry


def _value(row: ProjectedProperty, raw: int | bool) -> dict[str, Any]:
    """A fact value shaped by the registry row, never by the property's name."""
    if row.value_kind == "BOOLEAN":
        return {"type": "BOOLEAN", "boolean": bool(raw)}
    if row.value_kind == "NUMBER":
        return {"type": "NUMBER", "number": format_exact(Fraction(int(raw)))}
    raise ValueError(f"unsupported projected value kind: {row.value_kind}")


def _unit(row: ProjectedProperty) -> Unit | None:
    """The registry's unit, as a canonical PalCert unit.

    Resolved through the ``Unit`` vocabulary rather than passed through as a
    string, so a registry naming a unit the engine does not have fails here
    instead of producing a fact measured in something nothing can compare.
    """
    return None if row.unit is None else Unit(row.unit)


def project_citation_facts(builder: Any, analysis: dict[str, Any] | None) -> None:
    """Emit every fact the registry permits, and not one more.

    ``builder`` is the analyzer's :class:`FactBuilder`; taken loosely typed so
    this module does not import the fact builder and the fact builder can
    import it.
    """
    if analysis is None:
        return

    summary = analysis["summary"]

    # --- exact counts -----------------------------------------------------
    for prop, count in (
        ("nativeCitationCount", summary["nativeCitationCount"]),
        ("nativeBibliographySourceCount", summary["bibliographySourceCount"]),
    ):
        row = _row("DOCUMENT", prop)
        if row.projection_kind is not ProjectionKind.EXACT_COUNT:  # pragma: no cover
            raise ValueError(f"{prop} is not an exact count in the registry")
        if (
            fact_coverage_for(
                row.coverage_policy, _domain_status(analysis, _DOMAIN_FOR_PROPERTY[prop])
            )
            != "COMPLETE"
        ):
            continue
        builder.add(
            {"kind": "DOCUMENT", "property": prop},
            _value(row, int(count)),
            unit=_unit(row),
        )

    # --- the reference region, positive only ------------------------------
    row = _row("DOCUMENT", "referenceRegionPresent")
    region_coverage = fact_coverage_for(
        row.coverage_policy,
        _domain_status(analysis, _DOMAIN_FOR_PROPERTY["referenceRegionPresent"]),
    )
    if region_coverage != "UNAVAILABLE" and bool(summary["referenceRegionObserved"]):
        # Emitted only when true. A `false` here would let a rule fail a
        # document for a reference list PalCert merely did not find, and a
        # hand-typed list is invisible to the proof this value rests on.
        builder.add(
            {"kind": "DOCUMENT", "property": "referenceRegionPresent"},
            _value(row, True),
            unit=_unit(row),
        )

    # --- per-citation resolution -----------------------------------------
    row = _row("ELEMENT", "nativeSourceResolved", "CITATION")
    if (
        fact_coverage_for(
            row.coverage_policy,
            _domain_status(analysis, _DOMAIN_FOR_PROPERTY["nativeSourceResolved"]),
        )
        == "UNAVAILABLE"
    ):
        return
    for citation in analysis["citations"]:
        resolved = _RESOLUTION_VALUE.get(str(citation["resolutionStatus"]))
        if resolved is None:
            continue
        builder.add(
            {"kind": "ELEMENT", "elementType": "CITATION", "property": "nativeSourceResolved"},
            _value(row, resolved),
            unit=_unit(row),
            location=_fact_location(citation["location"]),
        )


def _fact_location(location: dict[str, Any]) -> dict[str, Any]:
    """The citation's own address, carried across unchanged.

    The same node id the structural walk assigned, so a finding about a
    citation points at the citation rather than at the paragraph containing it.
    """
    carried: dict[str, Any] = {
        "locationSchemaVersion": location["locationSchemaVersion"],
        "nodeId": location["nodeId"],
        "elementType": "CITATION",
    }
    if location.get("path"):
        carried["path"] = list(location["path"])
    if location.get("ordinal") is not None:
        carried["ordinal"] = location["ordinal"]
    return carried


def citation_coverage_entries(analysis: dict[str, Any] | None) -> list[dict[str, Any]]:
    """What the fact set may claim about citation evidence.

    Separate from the facts because coverage is what the engine consults when
    a fact is *missing*, and the missing ones are the whole safety story here.
    """
    entries: list[dict[str, Any]] = []

    # Nothing is projected about a rendered reference entry, at any coverage.
    # Its identity is established by classification, and coverage cannot repair
    # a wrong element identity.
    entries.append(
        {
            "kind": "ELEMENT",
            "elementType": "REFERENCE_ENTRY",
            "status": "UNAVAILABLE",
            "note": "a rendered entry is identified by classification, which is not projected",
        }
    )

    # A Word citation resolves to a bibliography *source* record, never to a
    # rendered reference entry, so DOCX cannot answer `citationTargetResolved`
    # at all — the registry marks it unsupported on this format. Said out loud
    # here because the ELEMENT/CITATION scope above can be COMPLETE: without a
    # property entry of its own, a rule on a question DOCX never answers would
    # be read under complete coverage and could pass or fail on silence.
    entries.append(
        {
            "kind": "ELEMENT",
            "elementType": "CITATION",
            "property": "citationTargetResolved",
            "status": "UNAVAILABLE",
            "note": "a Word citation targets a bibliography source, not a reference entry",
        }
    )

    if analysis is None:
        entries.append(
            {
                "kind": "ELEMENT",
                "elementType": "CITATION",
                "status": "UNAVAILABLE",
                "note": "this fact set was built without citation analysis",
            }
        )
        return entries

    resolution_status = _element_resolution_coverage(analysis)
    entries.append(
        {
            "kind": "ELEMENT",
            "elementType": "CITATION",
            "status": resolution_status,
            **(
                {"note": "Word-native citation fields only; nothing heuristic is recognized"}
                if resolution_status != "UNAVAILABLE"
                else {"note": "no exact source set to resolve citations against"}
            ),
        }
    )
    entries.append(
        {
            "kind": "ELEMENT",
            "elementType": "CITATION",
            "property": "nativeSourceResolved",
            "status": resolution_status,
        }
    )

    for prop in ("nativeCitationCount", "nativeBibliographySourceCount", "referenceRegionPresent"):
        element_type = None
        row = _row("DOCUMENT", prop, element_type)
        entries.append(
            {
                "kind": "DOCUMENT",
                "property": prop,
                "status": fact_coverage_for(
                    row.coverage_policy, _domain_status(analysis, _DOMAIN_FOR_PROPERTY[prop])
                ),
            }
        )

    return entries


def _element_resolution_coverage(analysis: dict[str, Any]) -> str:
    """COMPLETE only when every citation in scope got a value.

    This is the one that is easy to get wrong. An ambiguous citation produces
    no fact, so a rule such as "every citation resolves to a source" would read
    only the citations PalCert was sure about — and pass a document on them
    while an unresolved one sits in the middle of it. Declaring the domain
    PARTIAL is what turns that false pass into INDETERMINATE.
    """
    row = _row("ELEMENT", "nativeSourceResolved", "CITATION")
    status = fact_coverage_for(
        row.coverage_policy, _domain_status(analysis, _DOMAIN_FOR_PROPERTY["nativeSourceResolved"])
    )
    if status == "UNAVAILABLE":
        return status

    citations = analysis["citations"]
    answered = sum(
        1 for citation in citations if str(citation["resolutionStatus"]) in _RESOLUTION_VALUE
    )
    if answered < len(citations):
        return "PARTIAL"
    return status
