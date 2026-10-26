"""The normalized document fact model.

The rule engine consumes only this. It never sees a python-docx object, an
OOXML node, a PDF parser handle, a DOM or a filesystem path — which is what
lets the whole evaluator be a pure library, and what will let the DOCX and PDF
extractors of later phases be replaced without touching a single evaluator.

Everything here is parsed from JSON that has already been validated against
``contracts/schemas/evaluation.schema.json``. Parsing is therefore total: if a
field is absent here, the schema permitted its absence.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from fractions import Fraction
from typing import Any

from app.engine.units.registry import Unit

FACT_SCHEMA_VERSION = 2
SUPPORTED_FACT_SCHEMA_VERSIONS: frozenset[int] = frozenset({1, 2})
LOCATION_SCHEMA_VERSION = 1

#: Element types a fact set may use, per fact-schema version.
#:
#: Version 2 (Phase 6) adds ENDNOTE and TEXTBOX. WordprocessingML keeps both in
#: their own stories, and filing them under PARAGRAPH would let a rule about
#: body text fail because of a text box. A fact set that *declares* version 1
#: may not use them, or "version 1" would silently mean two vocabularies.
FACT_SCHEMA_VERSION_ELEMENT_TYPES: dict[int, frozenset[str]] = {
    1: frozenset(
        {
            "HEADING",
            "PARAGRAPH",
            "TABLE",
            "FIGURE",
            "CAPTION",
            "LIST",
            "FOOTNOTE",
            "CITATION",
            "REFERENCE_ENTRY",
            "EQUATION",
            "HEADER",
            "FOOTER",
        }
    ),
    2: frozenset(
        {
            "HEADING",
            "PARAGRAPH",
            "TABLE",
            "FIGURE",
            "CAPTION",
            "LIST",
            "FOOTNOTE",
            "ENDNOTE",
            "TEXTBOX",
            "CITATION",
            "REFERENCE_ENTRY",
            "EQUATION",
            "HEADER",
            "FOOTER",
        }
    ),
}


def element_types_for_fact_schema(version: int) -> frozenset[str]:
    """The element vocabulary of one fact-schema version (empty if unknown)."""
    return FACT_SCHEMA_VERSION_ELEMENT_TYPES.get(version, frozenset())


class ScopeKind(StrEnum):
    DOCUMENT = "DOCUMENT"
    SECTION = "SECTION"
    ELEMENT = "ELEMENT"
    METADATA = "METADATA"
    PAGE = "PAGE"


class ElementType(StrEnum):
    HEADING = "HEADING"
    PARAGRAPH = "PARAGRAPH"
    TABLE = "TABLE"
    FIGURE = "FIGURE"
    CAPTION = "CAPTION"
    LIST = "LIST"
    FOOTNOTE = "FOOTNOTE"
    ENDNOTE = "ENDNOTE"
    TEXTBOX = "TEXTBOX"
    CITATION = "CITATION"
    REFERENCE_ENTRY = "REFERENCE_ENTRY"
    EQUATION = "EQUATION"
    HEADER = "HEADER"
    FOOTER = "FOOTER"


class PageSelector(StrEnum):
    ALL = "ALL"
    FIRST = "FIRST"
    LAST = "LAST"
    ODD = "ODD"
    EVEN = "EVEN"


class FactValueType(StrEnum):
    STRING = "STRING"
    NUMBER = "NUMBER"
    BOOLEAN = "BOOLEAN"
    ENUM = "ENUM"
    STRING_LIST = "STRING_LIST"
    NUMBER_LIST = "NUMBER_LIST"
    STRUCTURED = "STRUCTURED"


class CoverageStatus(StrEnum):
    """How much of a fact domain the extractor could actually see.

    The distinction this exists for: "this document contains no figures" and
    "we could not determine whether this document contains figures" demand
    different verdicts, and conflating them is how an engine reports PASS for
    something it never looked at.
    """

    COMPLETE = "COMPLETE"
    PARTIAL = "PARTIAL"
    UNAVAILABLE = "UNAVAILABLE"


@dataclass(frozen=True, slots=True)
class FactScope:
    """Where an observation was made.

    Deliberately the same shape as the Phase 3 rule scope, so selecting the
    facts a rule applies to is structural matching on identifying fields —
    never string-parsing a rule code such as ``BODY.FONT.SIZE``.
    """

    kind: ScopeKind
    property: str | None = None
    section_key: str | None = None
    element_type: ElementType | None = None
    level: int | None = None
    field_name: str | None = None
    pages: PageSelector | None = None

    @staticmethod
    def from_json(data: dict[str, Any]) -> FactScope:
        return FactScope(
            kind=ScopeKind(data["kind"]),
            property=data.get("property"),
            section_key=data.get("sectionKey"),
            element_type=(
                ElementType(data["elementType"]) if data.get("elementType") is not None else None
            ),
            level=data.get("level"),
            field_name=data.get("field"),
            pages=PageSelector(data["pages"]) if data.get("pages") is not None else None,
        )

    def selector_key(self) -> tuple[str, str, str]:
        """The coarse key this scope is indexed under.

        Indexing on (kind, element type, property/field) is what keeps
        evaluation away from scanning every fact for every rule. Finer
        distinctions — heading level, section key — are applied when matching
        the candidates the index returns.
        """
        return (
            self.kind.value,
            self.element_type.value if self.element_type is not None else "",
            self.property or self.field_name or "",
        )


@dataclass(frozen=True, slots=True)
class Location:
    """Where in the document something was observed.

    ``node_id`` is the only required locator. Page number is frequently unknown
    during structural DOCX extraction — pagination is a rendering property, not
    a document property — so requiring it would force extractors to invent one.
    ``page is None`` means *unknown*, never page zero.
    """

    node_id: str
    page: int | None = None
    section_key: str | None = None
    element_type: ElementType | None = None
    ordinal: int | None = None
    path: tuple[str, ...] = ()
    location_schema_version: int = LOCATION_SCHEMA_VERSION

    @staticmethod
    def from_json(data: dict[str, Any]) -> Location:
        return Location(
            node_id=data["nodeId"],
            page=data.get("page"),
            section_key=data.get("sectionKey"),
            element_type=(
                ElementType(data["elementType"]) if data.get("elementType") is not None else None
            ),
            ordinal=data.get("ordinal"),
            path=tuple(data.get("path", ())),
            location_schema_version=data.get("locationSchemaVersion", LOCATION_SCHEMA_VERSION),
        )

    def to_json(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "locationSchemaVersion": self.location_schema_version,
            "nodeId": self.node_id,
        }
        if self.page is not None:
            result["page"] = self.page
        if self.section_key is not None:
            result["sectionKey"] = self.section_key
        if self.element_type is not None:
            result["elementType"] = self.element_type.value
        if self.ordinal is not None:
            result["ordinal"] = self.ordinal
        if self.path:
            result["path"] = list(self.path)
        return result

    def sort_key(self) -> tuple[int, int, int, str]:
        """Canonical ordering for violations.

        Locations with a known page sort before those without, then by page,
        then by ordinal, then by node id. The node id is the final tie-break so
        the order is total and therefore reproducible — dictionary iteration
        order must never reach the serialized output.
        """
        return (
            0 if self.page is not None else 1,
            self.page if self.page is not None else 0,
            self.ordinal if self.ordinal is not None else 0,
            self.node_id,
        )


@dataclass(frozen=True, slots=True)
class FactValue:
    """An observed value.

    Numbers arrive as decimal strings and are held as :class:`Decimal`. They
    are converted to :class:`~fractions.Fraction` only for arithmetic, so no
    binary float is ever involved in deciding whether a document complies.
    """

    type: FactValueType
    text: str | None = None
    number: Decimal | None = None
    boolean: bool | None = None
    enum_value: str | None = None
    values: tuple[str, ...] = ()
    numbers: tuple[Decimal, ...] = ()
    structured: dict[str, Any] = field(default_factory=dict)

    @staticmethod
    def from_json(data: dict[str, Any]) -> FactValue:
        value_type = FactValueType(data["type"])
        return FactValue(
            type=value_type,
            text=data.get("text"),
            number=_decimal_or_none(data.get("number")),
            boolean=data.get("boolean"),
            enum_value=data.get("enumValue"),
            values=tuple(data.get("values", ())),
            numbers=tuple(_decimal(entry) for entry in data.get("numbers", ())),
            structured=data.get("structured", {}),
        )

    def as_fraction(self) -> Fraction | None:
        """The value as exact rational arithmetic, or None if it is not numeric."""
        if self.type is FactValueType.NUMBER and self.number is not None:
            return Fraction(self.number)
        return None

    def display(self) -> str:
        """The value as evidence text. Never used for comparison."""
        if self.type is FactValueType.NUMBER and self.number is not None:
            return _plain(self.number)
        if self.type is FactValueType.STRING and self.text is not None:
            return self.text
        if self.type is FactValueType.BOOLEAN and self.boolean is not None:
            return "true" if self.boolean else "false"
        if self.type is FactValueType.ENUM and self.enum_value is not None:
            return self.enum_value
        if self.type is FactValueType.STRING_LIST:
            return ", ".join(self.values)
        if self.type is FactValueType.NUMBER_LIST:
            return ", ".join(_plain(entry) for entry in self.numbers)
        return self.type.value


class SourceKind(StrEnum):
    OOXML = "OOXML"
    PDF_TEXT = "PDF_TEXT"
    PDF_LAYOUT = "PDF_LAYOUT"
    HEURISTIC = "HEURISTIC"
    SYNTHETIC = "SYNTHETIC"


@dataclass(frozen=True, slots=True)
class FactProvenance:
    """How an observation was obtained.

    ``confidence`` is optional and must stay absent for exact extraction.
    Stamping 1.0 on an OOXML attribute read would dress a certainty up as a
    measurement, and downstream code would have no way to tell the difference
    from a genuine probabilistic estimate.
    """

    source_kind: SourceKind
    confidence: Decimal | None = None
    note: str | None = None

    @staticmethod
    def from_json(data: dict[str, Any]) -> FactProvenance:
        return FactProvenance(
            source_kind=SourceKind(data["sourceKind"]),
            confidence=_decimal_or_none(data.get("confidence")),
            note=data.get("note"),
        )


@dataclass(frozen=True, slots=True)
class DocumentFact:
    scope: FactScope
    value: FactValue
    unit: Unit | None = None
    location: Location | None = None
    provenance: FactProvenance | None = None

    @staticmethod
    def from_json(data: dict[str, Any]) -> DocumentFact:
        return DocumentFact(
            scope=FactScope.from_json(data["scope"]),
            value=FactValue.from_json(data["value"]),
            unit=Unit(data["unit"]) if data.get("unit") is not None else None,
            location=(
                Location.from_json(data["location"]) if data.get("location") is not None else None
            ),
            provenance=(
                FactProvenance.from_json(data["provenance"])
                if data.get("provenance") is not None
                else None
            ),
        )

    def sort_key(self) -> tuple[int, int, int, str]:
        """Ordering used to make evaluation independent of input order."""
        if self.location is None:
            return (2, 0, 0, "")
        return self.location.sort_key()


@dataclass(frozen=True, slots=True)
class CoverageEntry:
    """Coverage for one family of facts."""

    kind: ScopeKind
    status: CoverageStatus
    element_type: ElementType | None = None
    section_key: str | None = None
    property: str | None = None
    field_name: str | None = None
    note: str | None = None

    @staticmethod
    def from_json(data: dict[str, Any]) -> CoverageEntry:
        return CoverageEntry(
            kind=ScopeKind(data["kind"]),
            status=CoverageStatus(data["status"]),
            element_type=(
                ElementType(data["elementType"]) if data.get("elementType") is not None else None
            ),
            section_key=data.get("sectionKey"),
            property=data.get("property"),
            field_name=data.get("field"),
            note=data.get("note"),
        )

    def specificity(self) -> int:
        """How many selectors this entry names.

        Coverage lookup takes the most specific match, so an entry naming
        kind + element type + property beats one naming only the kind.
        """
        return sum(
            1
            for value in (self.element_type, self.section_key, self.property, self.field_name)
            if value is not None
        )

    def matches(self, scope: FactScope) -> bool:
        if self.kind is not scope.kind:
            return False
        if self.element_type is not None and self.element_type is not scope.element_type:
            return False
        if self.section_key is not None and self.section_key != scope.section_key:
            return False
        if self.property is not None and self.property != scope.property:
            return False
        return not (self.field_name is not None and self.field_name != scope.field_name)


@dataclass(frozen=True, slots=True)
class Extractor:
    name: str
    version: str


@dataclass(frozen=True, slots=True)
class DocumentFactSet:
    """Everything a document parser hands the rule engine."""

    fact_schema_version: int
    document_id: str
    extractor: Extractor
    coverage: tuple[CoverageEntry, ...]
    facts: tuple[DocumentFact, ...]

    @staticmethod
    def from_json(data: dict[str, Any]) -> DocumentFactSet:
        return DocumentFactSet(
            fact_schema_version=data["factSchemaVersion"],
            document_id=data["documentId"],
            extractor=Extractor(
                name=data["extractor"]["name"], version=data["extractor"]["version"]
            ),
            coverage=tuple(CoverageEntry.from_json(entry) for entry in data["coverage"]),
            facts=tuple(DocumentFact.from_json(entry) for entry in data["facts"]),
        )

    def coverage_for(self, scope: FactScope) -> CoverageStatus:
        """Coverage for the domain a rule scope addresses.

        **The default is UNAVAILABLE.** An extractor that said nothing about a
        domain has told us nothing about it, and treating silence as "complete,
        and there is nothing there" would turn every unexamined property into a
        confident PASS. Fail closed.
        """
        best: CoverageEntry | None = None
        for entry in self.coverage:
            if not entry.matches(scope):
                continue
            if best is None or entry.specificity() > best.specificity():
                best = entry
        return best.status if best is not None else CoverageStatus.UNAVAILABLE


def _decimal(value: str) -> Decimal:
    try:
        return Decimal(value)
    except InvalidOperation as error:  # pragma: no cover - schema rejects these first
        raise ValueError(f"{value!r} is not a valid decimal string") from error


def _decimal_or_none(value: str | None) -> Decimal | None:
    return None if value is None else _decimal(value)


def _plain(value: Decimal) -> str:
    """Render a Decimal without exponent notation, for evidence text."""
    return format(value.normalize(), "f") if value == value.to_integral_value() else str(value)
