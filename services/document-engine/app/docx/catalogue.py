"""The DOCX analyzer's property catalogue (§40, §41, §97).

One registry, one place. Every fact property the analyzer can emit is declared
here with its scope, type, unit, whether it is exact or derived, and what its
coverage means. Two things depend on that being true:

* **Nothing undocumented escapes.** The fact builder asserts every property it
  emits against this catalogue, so a property invented inside some parser
  function fails a test rather than reaching a published standard.
* **The Rule Builder can be honest later.** A standard author needs to know
  that ``fontSizeComplexScript`` is deterministic for DOCX while ``pageCount``
  is not available at all, without reading the analyzer's source.

The catalogue describes what *this analyzer* supports. It does not constrain
what a rule may reference: a rule about a property PDF supplies, or one a
human reviews, stays perfectly valid and simply selects nothing here (§97).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from app.engine.units.registry import Unit


class ValueKind(StrEnum):
    STRING = "STRING"
    NUMBER = "NUMBER"
    BOOLEAN = "BOOLEAN"
    ENUM = "ENUM"


class Exactness(StrEnum):
    #: Read straight from OOXML, converted with exact arithmetic.
    EXACT = "EXACT"
    #: Computed by PalCert from OOXML under a documented definition.
    DERIVED = "DERIVED"


@dataclass(frozen=True, slots=True)
class PropertyDefinition:
    name: str
    #: Scope kinds this property may appear under.
    scopes: tuple[str, ...]
    value_kind: ValueKind
    unit: Unit | None
    exactness: Exactness
    #: Where the value comes from, in OOXML terms.
    ooxml_source: str
    #: What less-than-complete coverage would mean for this property.
    coverage_note: str
    #: Element types this property is emitted for, when scope is ELEMENT.
    element_types: tuple[str, ...] = ()


def _text(
    name: str,
    scopes: tuple[str, ...],
    source: str,
    note: str,
    element_types: tuple[str, ...] = (),
    exactness: Exactness = Exactness.EXACT,
) -> PropertyDefinition:
    return PropertyDefinition(
        name=name,
        scopes=scopes,
        value_kind=ValueKind.STRING,
        unit=None,
        exactness=exactness,
        ooxml_source=source,
        coverage_note=note,
        element_types=element_types,
    )


_BLOCK_ELEMENTS = (
    "PARAGRAPH",
    "HEADING",
    "FOOTNOTE",
    "ENDNOTE",
    "HEADER",
    "FOOTER",
    "TEXTBOX",
    "CAPTION",
)

#: Every property, in one list. Order is irrelevant; the name is the key.
PROPERTIES: tuple[PropertyDefinition, ...] = (
    # --- typography ------------------------------------------------------
    PropertyDefinition(
        name="fontFamily",
        scopes=("ELEMENT",),
        value_kind=ValueKind.STRING,
        unit=None,
        exactness=Exactness.EXACT,
        ooxml_source="w:rFonts/@w:ascii|@w:hAnsi, resolved through the theme",
        coverage_note="PARTIAL when a theme reference could not be resolved",
        element_types=_BLOCK_ELEMENTS,
    ),
    PropertyDefinition(
        name="fontFamilyComplexScript",
        scopes=("ELEMENT",),
        value_kind=ValueKind.STRING,
        unit=None,
        exactness=Exactness.EXACT,
        ooxml_source="w:rFonts/@w:cs, resolved through the theme",
        coverage_note="PARTIAL when a theme reference could not be resolved",
        element_types=_BLOCK_ELEMENTS,
    ),
    PropertyDefinition(
        name="fontFamilyEastAsian",
        scopes=("ELEMENT",),
        value_kind=ValueKind.STRING,
        unit=None,
        exactness=Exactness.EXACT,
        ooxml_source="w:rFonts/@w:eastAsia, resolved through the theme",
        coverage_note="PARTIAL when a theme reference could not be resolved",
        element_types=_BLOCK_ELEMENTS,
    ),
    PropertyDefinition(
        name="fontSize",
        scopes=("ELEMENT",),
        value_kind=ValueKind.NUMBER,
        unit=Unit.POINT,
        exactness=Exactness.EXACT,
        ooxml_source="w:sz (half-points)",
        coverage_note="UNAVAILABLE for text where no layer declares a size",
        element_types=_BLOCK_ELEMENTS,
    ),
    PropertyDefinition(
        name="fontSizeComplexScript",
        scopes=("ELEMENT",),
        value_kind=ValueKind.NUMBER,
        unit=Unit.POINT,
        exactness=Exactness.EXACT,
        ooxml_source="w:szCs (half-points)",
        coverage_note="UNAVAILABLE for text where no layer declares a size",
        element_types=_BLOCK_ELEMENTS,
    ),
    PropertyDefinition(
        name="bold",
        scopes=("ELEMENT",),
        value_kind=ValueKind.BOOLEAN,
        unit=None,
        exactness=Exactness.EXACT,
        ooxml_source="w:b, under toggle semantics",
        coverage_note="absent when no layer declares it; absence is not false",
        element_types=_BLOCK_ELEMENTS,
    ),
    PropertyDefinition(
        name="boldComplexScript",
        scopes=("ELEMENT",),
        value_kind=ValueKind.BOOLEAN,
        unit=None,
        exactness=Exactness.EXACT,
        ooxml_source="w:bCs, under toggle semantics",
        coverage_note="absent when no layer declares it",
        element_types=_BLOCK_ELEMENTS,
    ),
    PropertyDefinition(
        name="italic",
        scopes=("ELEMENT",),
        value_kind=ValueKind.BOOLEAN,
        unit=None,
        exactness=Exactness.EXACT,
        ooxml_source="w:i, under toggle semantics",
        coverage_note="absent when no layer declares it",
        element_types=_BLOCK_ELEMENTS,
    ),
    PropertyDefinition(
        name="italicComplexScript",
        scopes=("ELEMENT",),
        value_kind=ValueKind.BOOLEAN,
        unit=None,
        exactness=Exactness.EXACT,
        ooxml_source="w:iCs, under toggle semantics",
        coverage_note="absent when no layer declares it",
        element_types=_BLOCK_ELEMENTS,
    ),
    _text("underline", ("ELEMENT",), "w:u/@w:val", "absent when undeclared", _BLOCK_ELEMENTS),
    _text("textColor", ("ELEMENT",), "w:color/@w:val", "absent when undeclared", _BLOCK_ELEMENTS),
    _text(
        "highlight", ("ELEMENT",), "w:highlight/@w:val", "absent when undeclared", _BLOCK_ELEMENTS
    ),
    _text(
        "language",
        ("ELEMENT", "METADATA"),
        "w:lang/@w:val (element) or dc:language (metadata)",
        "absent when undeclared",
        _BLOCK_ELEMENTS,
    ),
    _text(
        "languageComplexScript",
        ("ELEMENT",),
        "w:lang/@w:bidi",
        "absent when undeclared",
        _BLOCK_ELEMENTS,
    ),
    _text(
        "textDirection",
        ("ELEMENT",),
        "w:bidi (paragraph) and w:rtl (run)",
        "RTL/LTR as declared; absent when undeclared",
        _BLOCK_ELEMENTS,
    ),
    # --- paragraph formatting -------------------------------------------
    _text(
        "paragraphAlignment", ("ELEMENT",), "w:jc/@w:val", "absent when undeclared", _BLOCK_ELEMENTS
    ),
    PropertyDefinition(
        name="lineSpacing",
        scopes=("ELEMENT",),
        value_kind=ValueKind.NUMBER,
        unit=None,
        exactness=Exactness.EXACT,
        ooxml_source="w:spacing/@w:line; unit depends on lineSpacingMode",
        coverage_note="carried with lineSpacingMode; the two must be read together",
        element_types=_BLOCK_ELEMENTS,
    ),
    _text(
        "lineSpacingMode",
        ("ELEMENT",),
        "w:spacing/@w:lineRule",
        "AUTO, EXACT or AT_LEAST",
        _BLOCK_ELEMENTS,
    ),
    *(
        PropertyDefinition(
            name=name,
            scopes=("ELEMENT",),
            value_kind=ValueKind.NUMBER,
            unit=Unit.POINT,
            exactness=Exactness.EXACT,
            ooxml_source=source,
            coverage_note="absent when undeclared anywhere in the hierarchy",
            element_types=_BLOCK_ELEMENTS,
        )
        for name, source in (
            ("spacingBefore", "w:spacing/@w:before (twips)"),
            ("spacingAfter", "w:spacing/@w:after (twips)"),
            ("firstLineIndent", "w:ind/@w:firstLine (twips)"),
            ("hangingIndent", "w:ind/@w:hanging (twips)"),
            ("indentStart", "w:ind/@w:start|@w:left (twips)"),
            ("indentEnd", "w:ind/@w:end|@w:right (twips)"),
        )
    ),
    PropertyDefinition(
        name="keepNext",
        scopes=("ELEMENT",),
        value_kind=ValueKind.BOOLEAN,
        unit=None,
        exactness=Exactness.EXACT,
        ooxml_source="w:keepNext",
        coverage_note="absent when undeclared",
        element_types=_BLOCK_ELEMENTS,
    ),
    PropertyDefinition(
        name="pageBreakBefore",
        scopes=("ELEMENT",),
        value_kind=ValueKind.BOOLEAN,
        unit=None,
        exactness=Exactness.EXACT,
        ooxml_source="w:pageBreakBefore",
        coverage_note="a declared break, not a rendered one",
        element_types=_BLOCK_ELEMENTS,
    ),
    _text(
        "styleId",
        ("ELEMENT",),
        "w:pStyle/@w:val",
        "the style actually applied, after default-style resolution",
        _BLOCK_ELEMENTS,
    ),
    # --- lists ------------------------------------------------------------
    PropertyDefinition(
        name="listLevel",
        scopes=("ELEMENT",),
        value_kind=ValueKind.NUMBER,
        unit=Unit.COUNT,
        exactness=Exactness.EXACT,
        ooxml_source="w:numPr/w:ilvl, after numbering resolution",
        coverage_note="UNAVAILABLE when the numbering reference is dangling",
        element_types=("LIST",),
    ),
    _text(
        "numberFormat",
        ("ELEMENT",),
        "w:numFmt/@w:val of the resolved level",
        "UNAVAILABLE when the numbering reference is dangling",
        ("LIST",),
    ),
    PropertyDefinition(
        name="listStartValue",
        scopes=("ELEMENT",),
        value_kind=ValueKind.NUMBER,
        unit=Unit.COUNT,
        exactness=Exactness.EXACT,
        ooxml_source="w:start, with w:startOverride applied",
        coverage_note="UNAVAILABLE when the numbering reference is dangling",
        element_types=("LIST",),
    ),
    # --- tables -----------------------------------------------------------
    PropertyDefinition(
        name="rowCount",
        scopes=("ELEMENT",),
        value_kind=ValueKind.NUMBER,
        unit=Unit.COUNT,
        exactness=Exactness.EXACT,
        ooxml_source="count of w:tr",
        coverage_note="COMPLETE: rows are structural",
        element_types=("TABLE",),
    ),
    PropertyDefinition(
        name="columnCount",
        scopes=("ELEMENT",),
        value_kind=ValueKind.NUMBER,
        unit=Unit.COUNT,
        exactness=Exactness.DERIVED,
        ooxml_source="widest row, w:gridSpan included",
        coverage_note="COMPLETE: derived from structure by a documented rule",
        element_types=("TABLE",),
    ),
    _text(
        "tableAlignment",
        ("ELEMENT",),
        "w:tblPr/w:jc/@w:val",
        "PARTIAL when a table style carries unresolved conditional formatting",
        ("TABLE",),
    ),
    PropertyDefinition(
        name="tableWidth",
        scopes=("ELEMENT",),
        value_kind=ValueKind.NUMBER,
        unit=Unit.POINT,
        exactness=Exactness.EXACT,
        ooxml_source="w:tblW where the type is dxa",
        coverage_note="UNAVAILABLE for percentage or auto widths",
        element_types=("TABLE",),
    ),
    # --- figures and equations -------------------------------------------
    PropertyDefinition(
        name="figureWidth",
        scopes=("ELEMENT",),
        value_kind=ValueKind.NUMBER,
        unit=Unit.MILLIMETRE,
        exactness=Exactness.EXACT,
        ooxml_source="wp:extent/@cx (EMU)",
        coverage_note="UNAVAILABLE for legacy VML pictures, which store no extent",
        element_types=("FIGURE",),
    ),
    PropertyDefinition(
        name="figureHeight",
        scopes=("ELEMENT",),
        value_kind=ValueKind.NUMBER,
        unit=Unit.MILLIMETRE,
        exactness=Exactness.EXACT,
        ooxml_source="wp:extent/@cy (EMU)",
        coverage_note="UNAVAILABLE for legacy VML pictures",
        element_types=("FIGURE",),
    ),
    PropertyDefinition(
        name="hasAlternativeText",
        scopes=("ELEMENT",),
        value_kind=ValueKind.BOOLEAN,
        unit=None,
        exactness=Exactness.EXACT,
        ooxml_source="wp:docPr/@descr or @title",
        coverage_note="COMPLETE for DrawingML, UNAVAILABLE for VML",
        element_types=("FIGURE",),
    ),
    _text(
        "figurePlacement",
        ("ELEMENT",),
        "wp:inline or wp:anchor",
        "COMPLETE for DrawingML",
        ("FIGURE",),
    ),
    # --- document ---------------------------------------------------------
    *(
        PropertyDefinition(
            name=name,
            scopes=("DOCUMENT",),
            value_kind=ValueKind.NUMBER,
            unit=Unit.MILLIMETRE,
            exactness=Exactness.EXACT,
            ooxml_source=source,
            coverage_note=note,
        )
        for name, source, note in (
            ("pageWidth", "w:pgSz/@w:w (twips)", "one fact per section"),
            ("pageHeight", "w:pgSz/@w:h (twips)", "one fact per section"),
            ("marginTop", "w:pgMar/@w:top (twips)", "one fact per section"),
            ("marginBottom", "w:pgMar/@w:bottom (twips)", "one fact per section"),
            (
                "marginLeft",
                "w:pgMar/@w:left (twips)",
                "PARTIAL when mirrored margins make the physical side depend on page parity",
            ),
            (
                "marginRight",
                "w:pgMar/@w:right (twips)",
                "PARTIAL when mirrored margins make the physical side depend on page parity",
            ),
            ("headerDistance", "w:pgMar/@w:header (twips)", "one fact per section"),
            ("footerDistance", "w:pgMar/@w:footer (twips)", "one fact per section"),
            ("gutter", "w:pgMar/@w:gutter (twips)", "one fact per section"),
        )
    ),
    _text(
        "pageOrientation",
        ("DOCUMENT",),
        "w:pgSz/@w:orient",
        "absent when the document does not declare it; never inferred from dimensions",
    ),
    _text(
        "sectionBreakType", ("DOCUMENT",), "w:type/@w:val of the section", "one fact per section"
    ),
    *(
        PropertyDefinition(
            name=name,
            scopes=("DOCUMENT",),
            value_kind=ValueKind.NUMBER,
            unit=Unit.COUNT,
            exactness=Exactness.EXACT,
            ooxml_source=source,
            coverage_note="COMPLETE: counted from structure",
        )
        for name, source in (
            ("sectionCount", "w:sectPr occurrences"),
            ("paragraphCount", "visible w:p in the main story"),
            ("tableCount", "w:tbl in the main story"),
            ("figureCount", "w:drawing and legacy pictures"),
            ("equationCount", "m:oMath, m:oMathPara and legacy equation objects"),
            ("footnoteCount", "user footnotes, separators excluded"),
            ("endnoteCount", "user endnotes, separators excluded"),
            ("commentCount", "w:comment entries"),
            ("sectionColumnCount", "w:cols/@w:num, one fact per section"),
            ("trackedInsertionCount", "w:ins occurrences"),
            ("trackedDeletionCount", "w:del occurrences"),
        )
    ),
    # --- Phase 18: Word-native citation evidence -------------------------
    #
    # The four properties the projector allow-list permits, and the whole of
    # what citation analysis is allowed to assert. Their value kinds and units
    # are the registry's; they are repeated here because this catalogue is what
    # the fact builder checks against, and a contract test holds the two to
    # each other rather than letting them drift.
    *(
        PropertyDefinition(
            name=name,
            scopes=("DOCUMENT",),
            value_kind=ValueKind.NUMBER,
            unit=Unit.COUNT,
            exactness=Exactness.EXACT,
            ooxml_source=source,
            coverage_note=note,
        )
        for name, source, note in (
            (
                "nativeCitationCount",
                "CITATION fields in the walked stories, FINAL revision view",
                "COMPLETE or nothing: a partial count is a wrong number, not a missing one",
            ),
            (
                "nativeBibliographySourceCount",
                "records in the bibliography source store, found by its root element",
                "COMPLETE when one store was read or none exists; never a sum of several",
            ),
        )
    ),
    PropertyDefinition(
        name="nativeSourceResolved",
        scopes=("ELEMENT",),
        value_kind=ValueKind.BOOLEAN,
        unit=None,
        exactness=Exactness.EXACT,
        ooxml_source="the citation's tag matched against an exact source set",
        coverage_note=(
            "PARTIAL whenever any citation has no value: an ambiguous link emits nothing, "
            "and a rule reading only the answered ones would pass on them"
        ),
        element_types=("CITATION",),
    ),
    PropertyDefinition(
        name="referenceRegionPresent",
        scopes=("DOCUMENT",),
        value_kind=ValueKind.BOOLEAN,
        unit=None,
        exactness=Exactness.EXACT,
        ooxml_source="a BIBLIOGRAPHY field's presence",
        coverage_note=(
            "emitted only when true; absence is never evidence of absence, because a "
            "hand-typed reference list is invisible to this proof"
        ),
    ),
    *(
        PropertyDefinition(
            name=name,
            scopes=("DOCUMENT",),
            value_kind=ValueKind.NUMBER,
            unit=Unit.WORDS,
            exactness=Exactness.DERIVED,
            ooxml_source="PalCert word count over the FINAL revision view",
            coverage_note=note,
        )
        for name, note in (
            ("wordCount", "the main story only; identical to bodyWordCount"),
            ("bodyWordCount", "main story, hidden and deleted text excluded"),
            ("footnoteWordCount", "footnote story only"),
            ("endnoteWordCount", "endnote story only"),
            ("totalVisibleWordCount", "every visible story"),
        )
    ),
    *(
        PropertyDefinition(
            name=name,
            scopes=("DOCUMENT",),
            value_kind=ValueKind.NUMBER,
            unit=Unit.CHARACTERS,
            exactness=Exactness.DERIVED,
            ooxml_source="PalCert character count over the main story",
            coverage_note="body story only",
        )
        for name in ("characterCount", "characterCountNoWhitespace")
    ),
    *(
        PropertyDefinition(
            name=name,
            scopes=("DOCUMENT",),
            value_kind=ValueKind.BOOLEAN,
            unit=None,
            exactness=Exactness.EXACT,
            ooxml_source=source,
            coverage_note=note,
        )
        for name, source, note in (
            ("trackedChangesPresent", "w:ins / w:del / w:move*", "COMPLETE"),
            (
                "trackedFormattingChangesPresent",
                "w:pPrChange / w:rPrChange / w:tblPrChange",
                "COMPLETE",
            ),
            ("commentsPresent", "the comments part", "COMPLETE"),
            ("headerPresent", "w:headerReference", "COMPLETE per section"),
            ("footerPresent", "w:footerReference", "COMPLETE per section"),
            (
                "tableOfContentsPresent",
                "a TOC field instruction",
                "structural presence only; says nothing about whether it is up to date",
            ),
            ("mirrorMargins", "w:mirrorMargins in settings", "COMPLETE"),
            ("hiddenTextPresent", "effective w:vanish or w:webHidden", "COMPLETE"),
        )
    ),
    # --- metadata ---------------------------------------------------------
    *(
        PropertyDefinition(
            name=name,
            scopes=("METADATA",),
            value_kind=ValueKind.STRING,
            unit=None,
            exactness=Exactness.EXACT,
            ooxml_source=source,
            coverage_note="UNAVAILABLE when the core properties part is absent",
        )
        for name, source in (
            ("title", "dc:title"),
            ("subject", "dc:subject"),
            ("creator", "dc:creator"),
            ("keywords", "cp:keywords"),
            ("description", "dc:description"),
            ("created", "dcterms:created"),
            ("modified", "dcterms:modified"),
        )
    ),
)

BY_NAME: dict[str, PropertyDefinition] = {definition.name: definition for definition in PROPERTIES}


def definition_for(name: str) -> PropertyDefinition | None:
    return BY_NAME.get(name)


def is_documented(name: str) -> bool:
    return name in BY_NAME


#: Properties PalCert deliberately cannot answer from a DOCX (§1, §2, §3).
#: Published so the Rule Builder can say so rather than offering a rule that
#: will always be INDETERMINATE.
UNAVAILABLE_FROM_DOCX: tuple[tuple[str, str], ...] = (
    ("pageCount", "rendered pagination is not stored in OOXML; a saved count is a stale hint"),
    (
        "pageNumber",
        "a paragraph's page is produced by layout, which structural analysis does not run",
    ),
    ("lineCount", "line breaking is a layout result"),
    (
        "renderedMargin",
        "mirrored margins resolve to a physical side only once page parity is known",
    ),
)


def catalogue_json() -> dict[str, object]:
    """The catalogue as data, for documentation and for the Rule Builder."""
    return {
        "properties": [
            {
                "name": definition.name,
                "scopes": list(definition.scopes),
                "valueKind": str(definition.value_kind),
                "unit": str(definition.unit) if definition.unit else None,
                "exactness": str(definition.exactness),
                "ooxmlSource": definition.ooxml_source,
                "coverageNote": definition.coverage_note,
                "elementTypes": list(definition.element_types),
            }
            for definition in sorted(PROPERTIES, key=lambda item: (item.scopes[0], item.name))
        ],
        "unavailableFromDocx": [
            {"name": name, "reason": reason} for name, reason in UNAVAILABLE_FROM_DOCX
        ],
    }
