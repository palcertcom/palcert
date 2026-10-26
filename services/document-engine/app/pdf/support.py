"""The format-aware property support registry, read from the shared contract (§61, §62).

The table lives in ``contracts/registries/document-property-support.json``. The
API reads it through a generated TypeScript constant and the analyzers read it
here. Neither side owns a copy, because a registry that says "PDF can measure
this" in the UI and "it cannot" in the analyzer would sell a user a check that
cannot answer the question they paid to have answered.

The three levels are not a quality score. ``EXACT`` means the format stores the
property and PalCert reads it. ``DERIVED`` means PalCert computes it under a
documented definition and labels the evidence accordingly. ``UNSUPPORTED``
means the format cannot answer, and a rule about it is INDETERMINATE rather
than PASS (§69).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Any

_REGISTRY_RELATIVE = Path("contracts") / "registries" / "document-property-support.json"


def _find_registry() -> Path:
    for directory in Path(__file__).resolve().parents:
        candidate = directory / _REGISTRY_RELATIVE
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        f"Could not find {_REGISTRY_RELATIVE} above {__file__}. The property support "
        f"registry is shared with the API; there is no fallback copy."
    )


class Support(StrEnum):
    #: The format stores the property and PalCert reads it.
    EXACT = "EXACT"
    #: PalCert computes it from what the format does store, under a documented
    #: definition. Deterministic and exhaustive — an ink inset is measured.
    DERIVED = "DERIVED"
    #: PalCert *recognized* it. The population is a lower bound rather than a
    #: total and the evidence stays labelled HEURISTIC all the way to the
    #: verdict, which is always INDETERMINATE. Not a weaker EXACT and not a
    #: variant of DERIVED: those two are computations, this one is a belief.
    ADVISORY = "ADVISORY"
    #: The format cannot answer. A rule about it is INDETERMINATE, never PASS.
    UNSUPPORTED = "UNSUPPORTED"


class Format(StrEnum):
    DOCX = "DOCX"
    PDF = "PDF"


@dataclass(frozen=True, slots=True)
class PropertySupport:
    name: str
    scopes: tuple[str, ...]
    value_kind: str
    unit: str | None
    #: The element types an ELEMENT-scoped property is emitted for (registry
    #: v2). Empty means the row does not say, which is how every Phase 13 row
    #: is written; a populated tuple is closed.
    element_types: tuple[str, ...]
    docx: Support
    docx_note: str
    pdf: Support
    pdf_note: str

    def support(self, fmt: Format) -> Support:
        return self.pdf if fmt is Format.PDF else self.docx

    def note(self, fmt: Format) -> str:
        return self.pdf_note if fmt is Format.PDF else self.docx_note


@lru_cache(maxsize=1)
def _raw() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(_find_registry().read_text(encoding="utf-8"))
    return data


@lru_cache(maxsize=1)
def registry_version() -> int:
    return int(_raw()["registryVersion"])


@lru_cache(maxsize=1)
def _by_name() -> dict[str, PropertySupport]:
    table: dict[str, PropertySupport] = {}
    for row in _raw()["properties"]:
        table[row["name"]] = PropertySupport(
            name=row["name"],
            scopes=tuple(row["scopes"]),
            value_kind=row["valueKind"],
            unit=row["unit"],
            element_types=tuple(row.get("elementTypes", ())),
            docx=Support(row["docx"]["support"]),
            docx_note=row["docx"]["note"],
            pdf=Support(row["pdf"]["support"]),
            pdf_note=row["pdf"]["note"],
        )
    return table


def properties() -> tuple[PropertySupport, ...]:
    return tuple(_by_name().values())


def entry_for(name: str) -> PropertySupport | None:
    return _by_name().get(name)


def support_for(fmt: Format, name: str) -> Support:
    """How well ``fmt`` can answer ``name``.

    An unknown property is UNSUPPORTED rather than an error: a standard may
    reference a property no analyzer implements yet, and the honest answer is
    "this format cannot tell you", not a crash.
    """
    entry = _by_name().get(name)
    if entry is None:
        return Support.UNSUPPORTED
    return entry.support(fmt)


def supported_pdf_properties() -> tuple[str, ...]:
    """Every property the PDF analyzer is allowed to emit."""
    return tuple(
        sorted(name for name, entry in _by_name().items() if entry.pdf is not Support.UNSUPPORTED)
    )


def distinct_semantics() -> tuple[tuple[str, str], ...]:
    """Property pairs that measure something similar and mean something else.

    Kept in the registry rather than in a comment because merging them is the
    kind of change that looks like a coverage improvement in review: a margin
    rule answered from an ink measurement reads as wider PDF support and is
    simply a wrong answer (§62).
    """
    return tuple(
        (str(pair["docx"]), str(pair["pdf"])) for pair in _raw().get("distinctSemantics", [])
    )
