"""Orchestrating one PDF analysis (§8, §9, §97-§99).

The order is fixed and the first step is not negotiable: the bytes are hashed
and compared with what the DocumentVersion promised before any parser is handed
them. A PDF that is not the PDF PalCert thinks it is must not reach native code
at all, and must certainly not produce a report (§9).

After that the two engines each do what they are good at. pikepdf reads the
file's own statements - the catalog, the metadata, the structure tree, the
inventory of active content. PDFium renders and measures - page geometry, glyph
boxes, fonts, images. Neither is asked to do the other's job, and the results
meet in the structural model.

Determinism is a property this module is responsible for. Fonts are collected
into a canonical order rather than a dictionary's, warnings are sorted, and
every number has already been quantised, so the same bytes and the same engine
versions produce a byte-identical artifact (§97, §98, §99).
"""

from __future__ import annotations

import hashlib
from decimal import Decimal

import pikepdf
import pypdfium2 as pdfium
from pypdfium2.version import PDFIUM_INFO, PYPDFIUM_INFO

from app.engine.contracts.artifact_contract import (
    AnalysisArtifactContractError,
    assert_analysis_artifact,
)
from app.engine.contracts.validation import assert_contract
from app.pdf.citations import bind_citation_elements, build_citation_analysis, claimed_span_ids
from app.pdf.classify import classify_document, classify_page
from app.pdf.destinations import read_internal_destination_links
from app.pdf.errors import PdfAnalysisError, PdfFailure
from app.pdf.extract import extract_images, extract_spans, page_geometry
from app.pdf.facts import build_fact_set
from app.pdf.heuristics import discover
from app.pdf.inspect import (
    PageAttributes,
    open_document,
    read_features,
    read_metadata,
    read_page_attributes,
)
from app.pdf.layout import build_blocks, build_lines, content_inset
from app.pdf.limits import PdfLimits
from app.pdf.model import (
    EngineIdentity,
    FontIdentity,
    PageModel,
    PdfStructuralModel,
    TextLayer,
)
from app.pdf.numbers import quantise
from app.pdf.tags import read_structure
from app.pdf.warnings import PdfWarning

ANALYZER_NAME = "palcert-pdf"
#: Semantic, and deliberately not a git commit: a stored artifact is
#: interpreted through this for ever.
#: Phase 18 moved it five times. "2.0.0" read the citation evidence a tagged
#: PDF declares; "3.0.0" added the link annotations whose destinations name a
#: declared reference entry; "4.0.0" projects the one citation property a PDF
#: could then prove into the fact set, so a tagged document produced a fact
#: earlier versions did not; "5.0.0" adds a second — a per-citation
#: `citationTargetResolved` value, and the coverage entry that governs it;
#: "6.0.0" adds the heuristic layer, so a readable *untagged* PDF now carries
#: a citation graph where every earlier version carried an empty one; "7.0.0"
#: adds the second heuristic family, author-year, so a document whose
#: reference list is alphabetical rather than numbered is read at all;
#: "8.0.0" reads *inside* a recognized entry — title, container, DOI, URL —
#: so entries that carried only an identity now carry structured fields;
#: "9.0.0" reads an identifier out of a *citation's* own text and links on it,
#: so `DOI_IDENTITY` — in the vocabulary since Checkpoint 2 and never once
#: satisfiable — now fires; "10.0.0" stops assuming a document has exactly one
#: bibliography, publishes the reference regions it found, and reads two
#: numeric citation forms it could not see before — a raised numeral and a
#: parenthesised Vancouver group; "11.0.0" projects the first advisory facts —
#: three document-level counters carrying `sourceKind: HEURISTIC`, which the
#: evaluator refuses to decide on — and writes explicit coverage for them on
#: every PDF, so the fact set of a document that was analyzed before this
#: version is missing entries a rule may now look for.
#:
#: Every move is the same rule. Reuse of a stored analysis is decided by
#: analyzer name and version, and an artifact from an earlier one is perfectly
#: valid — so nothing about reading it says it is stale except this number.
ANALYZER_VERSION = "11.0.0"
#: The PdfStructuralModel's own version. It did not change: the model carries
#: the same pages, spans, lines and blocks it always did.
ANALYSIS_SCHEMA_VERSION = 1
#: The *envelope's* version, which is not the model's. Version 2 is the one
#: that carries `citationAnalysis`, and the contract requires it in both
#: directions: a v2 artifact must have the section and a v1 must not.
ENVELOPE_SCHEMA_VERSION = 2


def engine_identity() -> EngineIdentity:
    return EngineIdentity(
        analyzer_name=ANALYZER_NAME,
        analyzer_version=ANALYZER_VERSION,
        pdfium_version=str(PDFIUM_INFO),
        pypdfium2_version=str(PYPDFIUM_INFO),
        pikepdf_version=pikepdf.__version__,
        qpdf_version=pikepdf.__libqpdf_version__,
    )


def verify_source(data: bytes, expected_sha256: str) -> None:
    """Refuse bytes that are not the bytes promised (§9)."""
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected_sha256.lower():
        raise PdfAnalysisError(
            PdfFailure.SOURCE_INTEGRITY_FAILED,
            "the stored digest and the retrieved bytes disagree",
        )


def _image_coverage(images: tuple[object, ...], width: Decimal, height: Decimal) -> Decimal:
    """The largest single image's share of the page.

    The largest rather than the sum: a page tiled with a hundred small figures
    is not a scan, and summing would say it was.
    """
    area = width * height
    if area <= 0 or not images:
        return Decimal(0)
    largest = Decimal(0)
    for image in images:
        box = image.display_bbox  # type: ignore[attr-defined]
        largest = max(largest, box.width * box.height)
    return quantise(min(largest / area, Decimal(1)), 4)


def analyze(
    data: bytes,
    *,
    expected_sha256: str,
    document_id: str,
    limits: PdfLimits | None = None,
) -> dict[str, object]:
    """Analyze one PDF and return the complete analysis artifact."""
    limits = limits or PdfLimits.default()
    verify_source(data, expected_sha256)

    if len(data) > limits.max_bytes:
        raise PdfAnalysisError(PdfFailure.LIMIT_EXCEEDED, "the file exceeds the size limit")

    # Code -> identifiers and counts. Never document content: a warning
    # detail reaches the report UI and, unlike the artifact, is not treated as
    # user text (§109). "3 of 40 pages" is safe to say; what is on them is not.
    warnings: dict[PdfWarning, dict[str, str]] = {}

    def warn(code: PdfWarning, **detail: object) -> None:
        entry = warnings.setdefault(code, {})
        for key, value in detail.items():
            entry[key] = str(value)

    def bump(code: PdfWarning, key: str) -> None:
        entry = warnings.setdefault(code, {})
        entry[key] = str(int(entry.get(key, "0")) + 1)

    with open_document(data) as pdf:
        features = read_features(pdf)
        if features.page_count > limits.max_pages:
            raise PdfAnalysisError(PdfFailure.LIMIT_EXCEEDED, "the page limit was exceeded")
        metadata = read_metadata(pdf)
        structure = read_structure(pdf)
        # Read from the same pikepdf pass the structure tree came from: both
        # ends of an internal-destination link are structure-tree identities,
        # so there is nothing a second parser would see that this one cannot.
        internal_links = read_internal_destination_links(pdf, structure)
        page_attributes = read_page_attributes(pdf)

    if features.encrypted:
        # Openable without a password, or open_document would have refused. The
        # fact is still worth recording (§19).
        warn(PdfWarning.ENCRYPTED_DOCUMENT)
    if not features.tagged:
        warn(PdfWarning.UNTAGGED)
    if metadata.conflicts:
        # The field names disagree; the values they disagree about stay in the
        # artifact and never in the warning.
        warn(PdfWarning.METADATA_CONFLICT, fields=",".join(metadata.conflicts))
    if features.active_content_present:
        warn(PdfWarning.ACTIVE_CONTENT_PRESENT)
    if features.attachment_count:
        warn(PdfWarning.ATTACHMENT_PRESENT, count=features.attachment_count)
    if features.xfa_present:
        warn(PdfWarning.XFA_PRESENT)
    if features.signature_field_count:
        warn(PdfWarning.SIGNATURE_PRESENT, count=features.signature_field_count)
    if structure.truncated:
        warn(PdfWarning.LAYOUT_PARTIAL)

    document = pdfium.PdfDocument(data)
    pages: list[PageModel] = []
    fonts: dict[str, FontIdentity] = {}
    budget = limits.max_text_chars

    try:
        for index in range(len(document)):
            page = document[index]
            attributes = (
                page_attributes[index] if index < len(page_attributes) else PageAttributes()
            )
            geometry, box_invalid = page_geometry(page, user_unit=attributes.user_unit)
            if box_invalid:
                bump(PdfWarning.PAGE_BOX_INVALID, "pages")

            spans, chars, unmapped, truncated = extract_spans(
                page, geometry, page_index=index, limits=limits, budget=budget
            )
            budget = max(0, budget - chars)
            if truncated:
                bump(PdfWarning.OBJECT_LIMIT_REACHED, "pages")
            if unmapped:
                bump(PdfWarning.TEXT_MAPPING_INCOMPLETE, "pages")

            images, _seen, image_partial = extract_images(
                page, geometry, page_index=index, limits=limits
            )
            if image_partial:
                bump(PdfWarning.FORM_DEPTH_LIMIT_REACHED, "pages")

            for span in spans:
                if span.font is not None:
                    fonts.setdefault(span.font.raw_name, span.font)
                    if span.font.substitution_possible:
                        warn(PdfWarning.FONT_SUBSTITUTION_POSSIBLE)
                else:
                    warn(PdfWarning.FONT_IDENTITY_UNRESOLVED)

            lines = build_lines(spans, page_index=index)
            # Roles only ever come from the structure tree, bound through the
            # marked-content ids the author wrote. An untagged page has no
            # marks, so `roles` is empty and every block stays a block (§35).
            page_roles = structure.roles_by_mcid.get(index, {})
            roles = {
                line.node_id: page_roles[line.marked_content_ids[0]]
                for line in lines
                # One unambiguous tag per line, or none: a line whose marks
                # disagree is not a single semantic thing.
                if len({page_roles.get(m) for m in line.marked_content_ids} - {None}) == 1
                and line.marked_content_ids
                and line.marked_content_ids[0] in page_roles
            }
            blocks = build_blocks(lines, page_index=index, roles=roles or None)

            coverage = _image_coverage(images, geometry.effective_width, geometry.effective_height)
            layer = classify_page(
                native_characters=chars,
                unmapped_characters=unmapped,
                image_coverage=coverage,
                text_object_count=len(spans),
            )
            if layer is TextLayer.IMAGE_ONLY:
                bump(PdfWarning.IMAGE_ONLY_PAGE, "pages")

            pages.append(
                PageModel(
                    page_index=index,
                    geometry=geometry,
                    spans=spans,
                    lines=lines,
                    blocks=blocks,
                    images=images,
                    text_layer=layer,
                    native_character_count=chars,
                    text_object_count=len(spans),
                    unmapped_character_count=unmapped,
                    annotation_count=attributes.annotation_count,
                    image_coverage_ratio=coverage,
                    content_inset=content_inset(
                        lines,
                        images,
                        page_width=geometry.effective_width,
                        page_height=geometry.effective_height,
                    ),
                    partial=truncated or image_partial,
                )
            )
    finally:
        document.close()

    document_layer = classify_document(tuple(p.text_layer for p in pages))
    if document_layer is TextLayer.HYBRID:
        warn(PdfWarning.HYBRID_TEXT_LAYER)

    reading_order = "TAGGED_STRUCTURE" if structure.present else "GEOMETRIC"
    if reading_order == "GEOMETRIC":
        warn(PdfWarning.READING_ORDER_DERIVED)

    model = PdfStructuralModel(
        features=features,
        metadata=metadata,
        pages=tuple(pages),
        # Canonical order, never a dictionary's insertion order (§99).
        fonts=tuple(fonts[name] for name in sorted(fonts)),
        engine=engine_identity(),
        text_layer=document_layer,
        reading_order_source=reading_order,
        model_version=ANALYSIS_SCHEMA_VERSION,
    )

    structural = model.as_json()
    structural["structureTree"] = structure.as_json()

    # Citation evidence, in two clearly separated layers. What the author
    # declared is read exactly; what a readable untagged PDF merely looks like
    # is recognized heuristically, told which spans are already spoken for,
    # and carried with its own provenance and confidence.
    bound = bind_citation_elements(model, structure.citation_elements)
    citation_analysis = build_citation_analysis(
        model,
        bound,
        structure_present=structure.present,
        structure_truncated=structure.truncated,
        internal_links=internal_links,
        heuristics=discover(model, claimed_spans=claimed_span_ids(bound)),
    )

    fact_set = build_fact_set(model, document_id=document_id, citation_analysis=citation_analysis)
    # The same gate the DOCX analyzer has always had. Without it the PDF fact
    # set was never checked against the contract the rule engine reads it
    # through, which is how two mis-keyed value shapes survived from Phase 13.
    try:
        assert_contract("DocumentFactSet", fact_set)
    except ValueError as error:
        raise PdfAnalysisError(
            PdfFailure.DOCUMENT_INVALID, "the fact set does not satisfy the shared contract"
        ) from error

    artifact: dict[str, object] = {
        "analysisSchemaVersion": ENVELOPE_SCHEMA_VERSION,
        "format": "PDF",
        "analyzer": {"name": ANALYZER_NAME, "version": ANALYZER_VERSION},
        "source": {"documentId": document_id, "sha256": expected_sha256.lower()},
        "factSchemaVersion": 2,
        "structuralModel": structural,
        "factSet": fact_set,
        # Evidence only. Checkpoint 6 projects none of it: the four citation
        # properties stay UNSUPPORTED for PDF, and no citation fact is emitted.
        "citationAnalysis": citation_analysis,
        "warnings": [
            {"code": str(code), "detail": warnings[code]} for code in sorted(warnings, key=str)
        ],
    }

    # The same gate the DOCX analyzer passes through (§13): an artifact Node
    # would reject must never become a stored record a check later chokes on.
    # An invalid artifact is a failed analysis, so no report and no charge.
    try:
        assert_analysis_artifact(artifact)
    except AnalysisArtifactContractError as error:
        raise PdfAnalysisError(
            PdfFailure.DOCUMENT_INVALID, "the artifact does not satisfy the shared contract"
        ) from error

    return artifact
