"""The Phase 18 deterministic projector allow-list.

The table lives in ``contracts/registries/citation-projection.json``; the API's
reading is generated into TypeScript from the same file. Neither runtime holds
a private copy, because this table decides which citation observations may
produce a compliance verdict — and a disagreement about that is a disagreement
about whether somebody's thesis passes.

The rule it enforces, restated because it is the whole reason the list is four
rows long: the deterministic engine checks ``failed > 0`` before it looks at
coverage, so PARTIAL coverage prevents a false pass and does nothing at all to
a false failure. A property may therefore be projected only when both the
semantic element identity and the value are deterministically established.
Coverage cannot repair a wrong element identity.

Checkpoint 2 defines the authority. No projector implements it yet.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Any

_REGISTRY_RELATIVE = Path("contracts") / "registries" / "citation-projection.json"


def _find_registry() -> Path:
    """Locate the shared registry by walking up to the repository root.

    Searched rather than hard-coded to a parent depth, so moving this module
    one package deeper does not silently fall back to a stale table.
    """
    for directory in Path(__file__).resolve().parents:
        candidate = directory / _REGISTRY_RELATIVE
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        f"Could not find {_REGISTRY_RELATIVE} above {__file__}. The projection registry is "
        f"shared with the API; there is no fallback copy."
    )


@lru_cache(maxsize=1)
def load_registry() -> dict[str, Any]:
    """The projection registry, read from the single source of truth."""
    with _find_registry().open(encoding="utf-8") as handle:
        registry: dict[str, Any] = json.load(handle)
    return registry


_REGISTRY = load_registry()

CITATION_PROJECTION_REGISTRY_VERSION: int = _REGISTRY["registryVersion"]


class ProjectionKind(StrEnum):
    """How a property earns the right to produce a verdict."""

    #: An exhaustively enumerable count. Exact, never a lower bound.
    EXACT_COUNT = "EXACT_COUNT"
    #: A per-element value read from structure, on an element structure names.
    EXACT_ELEMENT_VALUE = "EXACT_ELEMENT_VALUE"
    #: Emitted only when true, read with EXISTS; absence is never a failure.
    EXACT_POSITIVE_MARKER = "EXACT_POSITIVE_MARKER"
    #: A lower bound from heuristic discovery. Earns no verdict at all: the
    #: evaluator returns INDETERMINATE on any fact whose provenance is
    #: HEURISTIC, so the number is reported and never decides.
    ADVISORY_COUNT = "ADVISORY_COUNT"
    #: The same, for a recognition emitted only when true.
    ADVISORY_POSITIVE_MARKER = "ADVISORY_POSITIVE_MARKER"


class CoveragePolicy(StrEnum):
    """Which coverage statuses a property may be emitted under."""

    #: A count is COMPLETE or UNAVAILABLE, never PARTIAL: a partial count is a
    #: wrong value rather than a missing one, and would fail a good document.
    COMPLETE_OR_UNAVAILABLE = "COMPLETE_OR_UNAVAILABLE"
    #: A per-element value: a missing element cannot make a present one wrong.
    COMPLETE_PARTIAL_OR_UNAVAILABLE = "COMPLETE_PARTIAL_OR_UNAVAILABLE"
    #: Positive-only evidence, which may pass or be indeterminate, never fail.
    POSITIVE_ONLY_PARTIAL_OR_UNAVAILABLE = "POSITIVE_ONLY_PARTIAL_OR_UNAVAILABLE"
    #: The only policy an advisory row may carry, and PARTIAL the only status
    #: it may be emitted under. A heuristic population is a lower bound by
    #: construction, so COMPLETE would claim an exhaustiveness the contract
    #: cannot prove.
    ADVISORY_PARTIAL_ONLY = "ADVISORY_PARTIAL_ONLY"


class EvidenceClass(StrEnum):
    """Which evidence a row is allowed to read.

    Stated in the registry rather than inferred from the projection kind, so a
    future row cannot quietly mix the two populations into one number. A fact
    counting both declared and recognized objects could not carry an honest
    ``sourceKind``, and provenance is what the evaluator's advisory gate keys
    on.
    """

    EXACT = "EXACT"
    HEURISTIC = "HEURISTIC"


@dataclass(frozen=True, slots=True)
class ProjectedProperty:
    scope_kind: str
    property: str
    value_kind: str
    projection_kind: ProjectionKind
    coverage_policy: CoveragePolicy
    formats: tuple[str, ...]
    evidence_class: EvidenceClass = EvidenceClass.EXACT
    element_type: str | None = None
    unit: str | None = None

    #: Convenience mirror of ``evidence_class``, set once at construction.
    #:
    #: A derived field rather than a computed one because the row already has
    #: a field called ``property`` — the registry's name for it — which
    #: shadows the builtin decorator inside this class body.
    advisory: bool = False


PROJECTED_PROPERTIES: tuple[ProjectedProperty, ...] = tuple(
    ProjectedProperty(
        scope_kind=row["scopeKind"],
        property=row["property"],
        value_kind=row["valueKind"],
        projection_kind=ProjectionKind(row["projectionKind"]),
        coverage_policy=CoveragePolicy(row["coveragePolicy"]),
        formats=tuple(row["formats"]),
        evidence_class=EvidenceClass(row["evidenceClass"]),
        advisory=EvidenceClass(row["evidenceClass"]) is EvidenceClass.HEURISTIC,
        element_type=row.get("elementType"),
        unit=row.get("unit"),
    )
    for row in _REGISTRY["properties"]
)


def _key(scope_kind: str, prop: str, element_type: str | None) -> str:
    return f"{scope_kind}:{element_type or ''}:{prop}"


_BY_KEY: dict[str, ProjectedProperty] = {
    _key(entry.scope_kind, entry.property, entry.element_type): entry
    for entry in PROJECTED_PROPERTIES
}


def projection_for(
    scope_kind: str, prop: str, element_type: str | None = None
) -> ProjectedProperty | None:
    """The allow-list entry, or ``None`` when the property is not projectable.

    ``None`` is the answer for every citation observation Phase 18 makes except
    these four. A projector treats it as a refusal, never as a gap to fill in.
    """
    return _BY_KEY.get(_key(scope_kind, prop, element_type))


def is_projectable(scope_kind: str, prop: str, element_type: str | None = None) -> bool:
    return projection_for(scope_kind, prop, element_type) is not None


def supports_format(entry: ProjectedProperty, fmt: str) -> bool:
    """Whether this row may be projected from ``fmt``.

    The registry names the formats per row rather than per property, because
    the same claim is not provable from every format: three of the four
    properties are defined in Word-native terms and no PDF can answer them at
    all.
    """
    return fmt in entry.formats


def fact_coverage_for(policy: CoveragePolicy, domain_status: str) -> str:
    """The fact-set coverage an advisory domain status earns under one policy.

    One implementation for both analyzers, because this is the translation
    that keeps a partial count out of the engine and a second copy of it is a
    second chance to get it subtly wrong. Under ``COMPLETE_OR_UNAVAILABLE`` a
    PARTIAL domain becomes UNAVAILABLE: a count read from an incompletely-read
    document is a *wrong* number rather than a missing one, and PARTIAL would
    not protect a rule from failing on it.
    """
    if policy is CoveragePolicy.ADVISORY_PARTIAL_ONLY:
        # An advisory population is a lower bound by construction: the detector
        # knows some styles and not others, so "we read the whole document"
        # still does not mean "we recognized everything in it". COMPLETE would
        # be a claim of exhaustiveness the contract cannot prove, so a complete
        # domain is reported as PARTIAL rather than promoted.
        return "UNAVAILABLE" if domain_status == "UNAVAILABLE" else "PARTIAL"
    if domain_status == "COMPLETE":
        return "COMPLETE"
    if domain_status == "PARTIAL" and policy is not CoveragePolicy.COMPLETE_OR_UNAVAILABLE:
        return "PARTIAL"
    return "UNAVAILABLE"
