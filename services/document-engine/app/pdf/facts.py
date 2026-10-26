"""Turning the PDF model into DocumentFacts the Phase 4 rule engine evaluates (§67-§70).

The rule engine already knows how to answer a standard from a fact set; this
module's only job is to say what a PDF honestly provides. Three rules govern
every fact emitted here.

**Nothing is emitted that the registry does not allow.** Every property is
checked against the shared property-support registry before it is built, so a
property PalCert has decided PDF cannot answer cannot leak out of the analyzer
because some function here was written optimistically (§61).

**Provenance is the truth about where a number came from.** A page box read
from the file is PDF_TEXT; a block position PalCert computed by grouping lines
is PDF_LAYOUT. No number is dressed up as more exact than it is, and no numeric
confidence is invented for either (§67, §102).

**Missing evidence is never a pass.** A page with no usable text layer produces
no typography facts at all, and the coverage entry for that domain says
UNAVAILABLE. The rule engine then returns INDETERMINATE, which is the honest
answer: PalCert did not check and does not know (§69). What it does *not* do is
turn a document with one scanned page into universal INDETERMINATE - a rule
whose evidence was extracted cleanly still fails if the evidence says it fails
(§70).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from app.pdf.citation_facts import citation_coverage, citation_facts
from app.pdf.fonts import derived_bold, derived_italic
from app.pdf.layout import baseline_distances
from app.pdf.model import PageModel, PdfStructuralModel, TextLayer
from app.pdf.numbers import plain
from app.pdf.support import Format, Support, support_for

#: The fact vocabulary version this analyzer writes. PDF needed no new one:
#: PDF_TEXT and PDF_LAYOUT provenance, the PAGE and METADATA scopes and the
#: page field on a location were all already there (§13).
FACT_SCHEMA_VERSION = 2
LOCATION_SCHEMA_VERSION = 1


def _allowed(name: str) -> bool:
    return support_for(Format.PDF, name) is not Support.UNSUPPORTED


def _provenance(name: str) -> dict[str, str]:
    """PDF_TEXT for what the file states, PDF_LAYOUT for what PalCert measured.

    No ``confidence`` key in either case: a number invented for an exact read
    would make a meaningless figure look measured, and one invented for a
    derived value would make a judgement look quantified (§102).
    """
    kind = "PDF_TEXT" if support_for(Format.PDF, name) is Support.EXACT else "PDF_LAYOUT"
    return {"sourceKind": kind}


def _fact(
    scope: dict[str, Any],
    value: dict[str, Any],
    *,
    unit: str | None = None,
    location: dict[str, Any] | None = None,
    property_name: str,
) -> dict[str, Any]:
    fact: dict[str, Any] = {
        "scope": scope,
        "value": value,
        "provenance": _provenance(property_name),
    }
    if unit is not None:
        fact["unit"] = unit
    if location is not None:
        fact["location"] = location
    return fact


def _number(value: Decimal | int) -> dict[str, Any]:
    text = plain(value) if isinstance(value, Decimal) else str(value)
    return {"type": "NUMBER", "number": text}


def _string(value: str) -> dict[str, Any]:
    # The shared contract's key is `text`, and the rule engine reads `text`.
    # This said `string` from Phase 13 until Phase 18 Checkpoint 8, which meant
    # every PDF STRING fact arrived at the engine with no value at all.
    return {"type": "STRING", "text": value}


def _boolean(value: bool) -> dict[str, Any]:
    return {"type": "BOOLEAN", "boolean": value}


def _enum(value: str) -> dict[str, Any]:
    #: As above: the contract's key is `enumValue`.
    return {"type": "ENUM", "enumValue": value}


def _location(node_id: str, page_number: int | None = None) -> dict[str, Any]:
    location: dict[str, Any] = {
        "locationSchemaVersion": LOCATION_SCHEMA_VERSION,
        "nodeId": node_id,
    }
    if page_number is not None:
        location["page"] = page_number
    return location


def _document_facts(model: PdfStructuralModel) -> list[dict[str, Any]]:
    """Facts about the document as a whole."""
    features = model.features
    facts: list[dict[str, Any]] = []

    def add(name: str, value: dict[str, Any], unit: str | None = None) -> None:
        if _allowed(name):
            facts.append(
                _fact({"kind": "DOCUMENT", "property": name}, value, unit=unit, property_name=name)
            )

    # The inversion that matters: PDF page count is the document, not a hint
    # left behind by a word processor (§25).
    add("pageCount", _number(features.page_count), "PAGES")
    add("pdfVersion", _string(features.pdf_version))
    add("tagged", _boolean(features.tagged))
    add("encrypted", _boolean(features.encrypted))
    add("attachmentCount", _number(features.attachment_count), "COUNT")
    add("annotationCount", _number(features.annotation_count), "COUNT")
    add("formFieldCount", _number(features.form_field_count), "COUNT")
    add("xfaPresent", _boolean(features.xfa_present))
    add("javaScriptPresent", _boolean(features.javascript_present))
    add("activeContentPresent", _boolean(features.active_content_present))
    add("signatureFieldCount", _number(features.signature_field_count), "COUNT")
    add("outlineCount", _number(features.outline_count), "COUNT")
    add("imageObjectCount", _number(sum(len(p.images) for p in model.pages)), "COUNT")
    add("textLayer", _enum(str(model.text_layer)))

    # A claim recorded as a claim. PalCert does not validate PDF/A (§17).
    if model.metadata.claimed_pdfa_part is not None:
        add("claimedPdfAPart", _string(model.metadata.claimed_pdfa_part))
    if model.metadata.claimed_pdfa_conformance is not None:
        add("claimedPdfAConformance", _string(model.metadata.claimed_pdfa_conformance))

    # Text-derived counts exist only where there is text to count.
    if model.text_layer in (TextLayer.NATIVE_TEXT, TextLayer.HYBRID):
        characters = sum(p.native_character_count for p in model.pages)
        words = sum(len(" ".join(b.text for b in p.blocks).split()) for p in model.pages)
        lines = sum(len(p.lines) for p in model.pages)
        add("characterCount", _number(characters), "CHARACTERS")
        add("wordCount", _number(words), "WORDS")
        add("bodyWordCount", _number(words), "WORDS")
        add("totalVisibleWordCount", _number(words), "WORDS")
        add("lineCount", _number(lines), "COUNT")

    return facts


def _metadata_facts(model: PdfStructuralModel) -> list[dict[str, Any]]:
    """Metadata facts, carrying which source won (§72).

    The precedence is documented and deterministic, and the note records the
    source so a reader of the evidence can tell an XMP title from a
    DocumentInfo one without opening the structural model.
    """
    facts: list[dict[str, Any]] = []
    metadata = model.metadata
    for field, value in sorted(metadata.effective.items()):
        if not _allowed(field) or not value:
            continue
        provenance = _provenance(field)
        source = metadata.chosen_source.get(field)
        if source is not None:
            provenance = {**provenance, "note": f"from {source}"}
        facts.append(
            {
                "scope": {"kind": "METADATA", "field": field},
                "value": _string(value),
                "provenance": provenance,
            }
        )
    if metadata.language and _allowed("language"):
        facts.append(
            {
                "scope": {"kind": "METADATA", "field": "language"},
                "value": _string(metadata.language),
                "provenance": _provenance("language"),
            }
        )
    return facts


def _page_facts(page: PageModel) -> list[dict[str, Any]]:
    """Geometry facts for one page. Always available: pages are real (§25, §26)."""
    facts: list[dict[str, Any]] = []
    geometry = page.geometry
    node = f"page:{page.page_number}"

    def add(name: str, value: dict[str, Any], unit: str | None = None) -> None:
        if _allowed(name):
            facts.append(
                _fact(
                    {"kind": "PAGE", "pages": "ALL", "property": name},
                    value,
                    unit=unit,
                    location=_location(node, page.page_number),
                    property_name=name,
                )
            )

    add("pageWidth", _number(geometry.effective_width), "POINT")
    add("pageHeight", _number(geometry.effective_height), "POINT")
    add("pageOrientation", _enum(str(geometry.orientation)))
    add("pageRotation", _number(geometry.rotation), "COUNT")
    add("pageTextLayer", _enum(str(page.text_layer)))

    # A measurement of where ink starts, never a margin (§55, §56).
    if page.content_inset is not None:
        for side, distance in sorted(page.content_inset.items()):
            add(f"observedContentInset{side.capitalize()}", _number(distance), "POINT")
    return facts


def _element_facts(page: PageModel) -> list[dict[str, Any]]:
    """Typography facts from spans, and layout facts from blocks.

    Spans carry the font and size the document declared, so they are the
    typography evidence. They are scoped to PARAGRAPH only when the structure
    tree vouched for the block they belong to; otherwise the element type is
    the neutral one and the evidence stays layout evidence (§30, §35).
    """
    if page.text_layer not in (TextLayer.NATIVE_TEXT,):
        return []

    facts: list[dict[str, Any]] = []
    role_of_span: dict[str, str] = {}
    for block in page.blocks:
        if block.structure_role is None:
            continue
        for line_id in block.line_ids:
            for line in page.lines:
                if line.node_id == line_id:
                    for span_id in line.span_ids:
                        role_of_span[span_id] = block.structure_role

    for span in page.spans:
        if span.font is None:
            continue
        # Untagged content gets PARAGRAPH: it is a run of body text, and the
        # element type that would be a claim - HEADING - is never assigned
        # without a tag to justify it.
        element = role_of_span.get(span.node_id, "PARAGRAPH")
        location = _location(span.node_id, page.page_number)

        def add(
            name: str,
            value: dict[str, Any],
            unit: str | None = None,
            *,
            # Bound at definition time: the closure must not read whichever
            # span the loop happens to be on when it is finally called.
            element: str = element,
            location: dict[str, Any] = location,
        ) -> None:
            if _allowed(name):
                facts.append(
                    _fact(
                        {"kind": "ELEMENT", "elementType": element, "property": name},
                        value,
                        unit=unit,
                        location=location,
                        property_name=name,
                    )
                )

        add("fontFamily", _string(span.font.base_name))
        if span.font_size is not None:
            add("fontSize", _number(span.font_size), "POINT")
        add("fontEmbedded", _boolean(span.font.embedded))
        add("fontSubset", _boolean(span.font.subset))
        bold = derived_bold(span.font)
        if bold is not None:
            add("bold", _boolean(bold))
        italic = derived_italic(span.font)
        if italic is not None:
            add("italic", _boolean(italic))
        add("pageNumber", _number(page.page_number), "PAGES")

    # Measured baseline distance, labelled as the layout evidence it is (§58).
    gaps = baseline_distances(page.lines)
    if gaps and _allowed("lineSpacing"):
        typical = sorted(gaps)[len(gaps) // 2]
        facts.append(
            _fact(
                {"kind": "ELEMENT", "elementType": "PARAGRAPH", "property": "lineSpacing"},
                _number(typical),
                unit="POINT",
                location=_location(f"page:{page.page_number}", page.page_number),
                property_name="lineSpacing",
            )
        )
    return facts


def _coverage(model: PdfStructuralModel) -> list[dict[str, Any]]:
    """What was and was not answerable, per domain (§66, §68).

    Static format support says what PDF *can* answer; this says what this
    document actually did. A searchable thesis and a scan of one have identical
    format support and very different coverage.
    """
    entries: list[dict[str, Any]] = []

    def add(kind: str, status: str, note: str, **extra: Any) -> None:
        entry = {"kind": kind, "status": status, "note": note}
        entry.update(extra)
        entries.append(entry)

    add("DOCUMENT", "COMPLETE", "page count and document features read from the file")
    add("PAGE", "COMPLETE", "page geometry read from the page tree")

    text_pages = [p for p in model.pages if p.text_layer is TextLayer.NATIVE_TEXT]
    if not model.pages:
        add("ELEMENT", "UNAVAILABLE", "the document has no pages")
    elif len(text_pages) == len(model.pages):
        add("ELEMENT", "COMPLETE", "every page has a usable native text layer")
    elif text_pages:
        add(
            "ELEMENT",
            "PARTIAL",
            f"{len(text_pages)} of {len(model.pages)} pages have a usable native text layer; "
            "no text was recovered from the rest and no OCR was performed",
        )
    else:
        add(
            "ELEMENT",
            "UNAVAILABLE",
            "no page has a usable native text layer; no OCR was performed",
        )

    if model.features.tagged:
        add(
            "ELEMENT",
            "PARTIAL",
            "semantic roles taken from the tagged structure tree",
            elementType="HEADING",
        )
    else:
        add(
            "ELEMENT",
            "UNAVAILABLE",
            "the document is untagged, so it declares no headings, tables or figures; "
            "PalCert does not infer them from appearance",
            elementType="HEADING",
        )

    if model.metadata.effective:
        sources = sorted(set(model.metadata.chosen_source.values()))
        add(
            "METADATA",
            "COMPLETE",
            f"metadata read from {' and '.join(sources)}",
        )
    else:
        add(
            "METADATA",
            "UNAVAILABLE",
            "the document carries neither XMP nor DocumentInfo metadata",
        )
    return entries


def build_fact_set(
    model: PdfStructuralModel,
    *,
    document_id: str,
    citation_analysis: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The complete DocumentFactSet for one PDF.

    ``citation_analysis`` is the validated evidence section, when one was
    produced. Left out, no citation fact is emitted and the citation domains
    report UNAVAILABLE — the truth for a caller that never looked, which is
    not the same thing as a document without citations.
    """
    facts: list[dict[str, Any]] = []
    facts.extend(_document_facts(model))
    facts.extend(_metadata_facts(model))
    for page in model.pages:
        facts.extend(_page_facts(page))
        facts.extend(_element_facts(page))
    facts.extend(citation_facts(citation_analysis))

    return {
        "factSchemaVersion": FACT_SCHEMA_VERSION,
        "documentId": document_id,
        "extractor": {
            "name": model.engine.analyzer_name,
            "version": model.engine.analyzer_version,
        },
        "coverage": [*_coverage(model), *citation_coverage(citation_analysis)],
        "facts": facts,
    }
