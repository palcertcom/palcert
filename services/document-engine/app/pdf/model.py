"""The PdfStructuralModel (§14, §20-§22, §27).

What a PDF actually contains, recorded without pretending it contains what a
Word document contains. A PDF stores pages, and on those pages a stream of
drawing operations: put this glyph here with this font at this size, draw this
image in this rectangle. It does not store paragraphs, margins, headings or
sections, and the model does not invent them.

Three ideas run through it:

**Raw and display geometry are both kept.** ``raw_bbox`` is PDF user space as
the file states it, origin bottom-left. ``display_bbox`` is what a reader sees,
after the crop box and page rotation, origin top-left. Rules and report
locations want the second; anyone debugging the file wants the first; guessing
which one a number is would make both useless.

**Structure and derivation are separated.** Pages, text objects, fonts and
images are read from the file. Lines and blocks are *derived* by PalCert's own
grouping, are versioned by ``layout_algorithm_version``, and are labelled so no
consumer can mistake a measured block for an authored paragraph.

**Node ids are coordinates, not identifiers.** ``page:1/textobj:17`` is
reproducible from the same bytes and the same analyzer version. No UUID, no
sequence, no timestamp (§27).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from enum import StrEnum

from app.pdf.numbers import plain

#: Bumped when the shape of this model changes.
PDF_MODEL_VERSION = 1
#: Bumped when the meaning of display coordinates changes (§22).
COORDINATE_SCHEMA_VERSION = 1
#: Bumped when the grouping algorithm changes its output for the same bytes (§32).
LAYOUT_ALGORITHM_VERSION = 1


class PageBox(StrEnum):
    """Which box a geometry fact is based on. Never interchangeable (§21)."""

    MEDIA = "MediaBox"
    CROP = "CropBox"
    BLEED = "BleedBox"
    TRIM = "TrimBox"
    ART = "ArtBox"


class TextLayer(StrEnum):
    """How much usable native text a page or document has (§50)."""

    NATIVE_TEXT = "NATIVE_TEXT"
    IMAGE_ONLY = "IMAGE_ONLY"
    HYBRID = "HYBRID"
    EMPTY_OR_UNKNOWN = "EMPTY_OR_UNKNOWN"


class Orientation(StrEnum):
    PORTRAIT = "PORTRAIT"
    LANDSCAPE = "LANDSCAPE"
    SQUARE = "SQUARE"


class ObjectKind(StrEnum):
    TEXT = "TEXT"
    IMAGE = "IMAGE"
    PATH = "PATH"
    SHADING = "SHADING"
    FORM = "FORM"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True, slots=True)
class BBox:
    """A rectangle in points, already quantised to canonical decimals."""

    left: Decimal
    top: Decimal
    right: Decimal
    bottom: Decimal

    @property
    def width(self) -> Decimal:
        return self.right - self.left

    @property
    def height(self) -> Decimal:
        return abs(self.bottom - self.top)

    def as_json(self) -> dict[str, str]:
        return {
            "left": plain(self.left),
            "top": plain(self.top),
            "right": plain(self.right),
            "bottom": plain(self.bottom),
            "width": plain(self.width),
            "height": plain(self.height),
        }


@dataclass(frozen=True, slots=True)
class FontIdentity:
    """What the PDF says about a font, and what the renderer had to do about it.

    ``raw_name`` is the BaseFont as written, subset prefix and all.
    ``base_name`` has the six-letter subset prefix removed under the rule in
    ISO 32000-2 9.6.4 — exactly that rule, never a fuzzy cleanup (§39).

    ``substitution_possible`` marks the case that matters for evidence: an
    unembedded font is drawn with whatever the renderer had, and the renderer's
    choice is a property of the machine, not of the document. Compliance facts
    use the declared identity; the substitute is recorded only so a reader can
    see why a rendering may differ (§41, §100).
    """

    raw_name: str
    base_name: str
    subset: bool
    embedded: bool
    subtype: str | None = None
    weight: int | None = None
    italic_angle: Decimal | None = None
    flags: int | None = None
    substitution_possible: bool = False

    def as_json(self) -> dict[str, object]:
        return {
            "rawFontName": self.raw_name,
            "normalizedBaseFontName": self.base_name,
            "subset": self.subset,
            "embedded": self.embedded,
            "subtype": self.subtype,
            "weight": self.weight,
            "italicAngle": None if self.italic_angle is None else plain(self.italic_angle),
            "flags": self.flags,
            "substitutionPossible": self.substitution_possible,
        }


@dataclass(frozen=True, slots=True)
class TextSpan:
    """A run of characters sharing a font, a size and a line (§29).

    ``font_size`` is the effective size: the text-state size after the text and
    object matrices, which is what a reader measures with a ruler and what a
    typography rule means. The formula is documented in
    ``docs/architecture/pdf-analysis.md``.
    """

    node_id: str
    text: str
    font: FontIdentity | None
    font_size: Decimal | None
    raw_bbox: BBox
    display_bbox: BBox
    page_index: int
    form_depth: int = 0
    unmapped_characters: int = 0
    #: The marked-content id of the text object these characters came from, or
    #: None when the content is not marked. This is the only link between
    #: rendered text and the structure tree, and it is an identity rather than
    #: a guess: the same integer appears in the content stream and in the
    #: element's /K entry (ISO 32000-2 14.7.4.2).
    marked_content_id: int | None = None

    def as_json(self) -> dict[str, object]:
        return {
            "nodeId": self.node_id,
            "text": self.text,
            "font": None if self.font is None else self.font.as_json(),
            "fontSize": None if self.font_size is None else plain(self.font_size),
            "rawPdfBBox": self.raw_bbox.as_json(),
            "displayBBox": self.display_bbox.as_json(),
            "formDepth": self.form_depth,
            "unmappedCharacters": self.unmapped_characters,
            "markedContentId": self.marked_content_id,
        }


@dataclass(frozen=True, slots=True)
class LayoutLine:
    """Spans PalCert grouped onto one baseline. Derived, not authored (§31)."""

    node_id: str
    span_ids: tuple[str, ...]
    text: str
    display_bbox: BBox
    baseline: Decimal
    marked_content_ids: tuple[int, ...] = ()

    def as_json(self) -> dict[str, object]:
        return {
            "nodeId": self.node_id,
            "spanIds": list(self.span_ids),
            "text": self.text,
            "displayBBox": self.display_bbox.as_json(),
            "baseline": plain(self.baseline),
            "markedContentIds": list(self.marked_content_ids),
        }


@dataclass(frozen=True, slots=True)
class LayoutBlock:
    """Lines PalCert grouped together. A block is NOT a paragraph (§30).

    It is called a block everywhere — in the model, in facts, in the report —
    precisely so nobody has to remember that it isn't one.
    """

    node_id: str
    line_ids: tuple[str, ...]
    text: str
    display_bbox: BBox
    page_index: int
    reading_index: int
    #: Present only when a tagged structure element vouches for this block.
    structure_role: str | None = None

    def as_json(self) -> dict[str, object]:
        return {
            "nodeId": self.node_id,
            "lineIds": list(self.line_ids),
            "text": self.text,
            "displayBBox": self.display_bbox.as_json(),
            "readingIndex": self.reading_index,
            "structureRole": self.structure_role,
        }


@dataclass(frozen=True, slots=True)
class ImageObject:
    node_id: str
    display_bbox: BBox
    page_index: int
    form_depth: int = 0

    def as_json(self) -> dict[str, object]:
        return {
            "nodeId": self.node_id,
            "displayBBox": self.display_bbox.as_json(),
            "formDepth": self.form_depth,
        }


@dataclass(frozen=True, slots=True)
class PageGeometry:
    """Every box the page declares, plus the geometry a reader actually sees."""

    media: BBox
    crop: BBox | None
    bleed: BBox | None
    trim: BBox | None
    art: BBox | None
    rotation: int
    user_unit: Decimal
    #: Which box the effective size was taken from; always stated (§21).
    effective_box: PageBox
    effective_width: Decimal
    effective_height: Decimal
    orientation: Orientation

    def as_json(self) -> dict[str, object]:
        return {
            "mediaBox": self.media.as_json(),
            "cropBox": None if self.crop is None else self.crop.as_json(),
            "bleedBox": None if self.bleed is None else self.bleed.as_json(),
            "trimBox": None if self.trim is None else self.trim.as_json(),
            "artBox": None if self.art is None else self.art.as_json(),
            "rotation": self.rotation,
            "userUnit": plain(self.user_unit),
            "effectiveBox": str(self.effective_box),
            "effectiveWidthPoints": plain(self.effective_width),
            "effectiveHeightPoints": plain(self.effective_height),
            "orientation": str(self.orientation),
        }


@dataclass(frozen=True, slots=True)
class PageModel:
    page_index: int
    geometry: PageGeometry
    spans: tuple[TextSpan, ...]
    lines: tuple[LayoutLine, ...]
    blocks: tuple[LayoutBlock, ...]
    images: tuple[ImageObject, ...]
    text_layer: TextLayer
    native_character_count: int
    text_object_count: int
    unmapped_character_count: int
    annotation_count: int
    image_coverage_ratio: Decimal
    content_inset: dict[str, Decimal] | None = None
    partial: bool = False

    @property
    def page_number(self) -> int:
        """One-based, for display. The model never shows a zero-based page."""
        return self.page_index + 1

    def as_json(self) -> dict[str, object]:
        return {
            "pageIndex": self.page_index,
            "pageNumber": self.page_number,
            "geometry": self.geometry.as_json(),
            "spans": [s.as_json() for s in self.spans],
            "lines": [line.as_json() for line in self.lines],
            "blocks": [b.as_json() for b in self.blocks],
            "images": [i.as_json() for i in self.images],
            "textLayer": str(self.text_layer),
            "nativeTextCharacterCount": self.native_character_count,
            "textObjectCount": self.text_object_count,
            "unmappedCharacterCount": self.unmapped_character_count,
            "annotationCount": self.annotation_count,
            "imageCoverageRatio": plain(self.image_coverage_ratio),
            "observedContentInset": (
                None
                if self.content_inset is None
                else {k: plain(v) for k, v in sorted(self.content_inset.items())}
            ),
            "partial": self.partial,
        }


@dataclass(frozen=True, slots=True)
class DocumentMetadata:
    """Metadata, with its provenance kept (§71, §72).

    XMP and DocumentInfo may disagree, and the disagreement is itself
    information: a thesis whose XMP says one author and whose DocumentInfo says
    another has been through two tools, and a reader deserves to know that
    rather than be handed whichever one PalCert happened to read last.

    So nothing is collapsed irreversibly. Both sources keep their own values,
    ``effective`` records what the documented precedence chose, ``chosen_source``
    records *which* source that was so it can travel into fact provenance, and
    ``conflicts`` names every property where the two disagreed so a structured
    warning can be raised rather than the loser disappearing.

    These values are private derived user data. They live in the model, which
    lives in the private derived bucket, and they never reach a log, a metric
    label or an audit event (§73, §107, §109).
    """

    xmp: dict[str, str] = field(default_factory=dict)
    doc_info: dict[str, str] = field(default_factory=dict)
    effective: dict[str, str] = field(default_factory=dict)
    #: property -> "xmp" | "documentInfo": which source the effective value came from.
    chosen_source: dict[str, str] = field(default_factory=dict)
    conflicts: tuple[str, ...] = ()
    language: str | None = None
    claimed_pdfa_part: str | None = None
    claimed_pdfa_conformance: str | None = None

    def as_json(self) -> dict[str, object]:
        # Both sources keep their own values. The model is private derived
        # data; it is the logs and metrics that must never carry these (§73).
        return {
            "xmp": dict(sorted(self.xmp.items())),
            "documentInfo": dict(sorted(self.doc_info.items())),
            "effective": dict(sorted(self.effective.items())),
            "chosenSource": dict(sorted(self.chosen_source.items())),
            "conflicts": list(self.conflicts),
            "language": self.language,
            "claimedPdfAPart": self.claimed_pdfa_part,
            "claimedPdfAConformance": self.claimed_pdfa_conformance,
        }


@dataclass(frozen=True, slots=True)
class DocumentFeatures:
    """What the document contains that is not text (§15, §18, §74-§77).

    Every one of these is a count or a flag. Nothing here is opened, followed,
    fetched or executed: an embedded file is counted, a URI action is counted,
    JavaScript is counted. That is the whole interaction.
    """

    pdf_version: str
    page_count: int
    encrypted: bool
    encryption_summary: str | None
    tagged: bool
    attachment_count: int = 0
    annotation_count: int = 0
    form_field_count: int = 0
    xfa_present: bool = False
    javascript_present: bool = False
    launch_action_count: int = 0
    uri_action_count: int = 0
    remote_goto_count: int = 0
    rich_media_count: int = 0
    signature_field_count: int = 0
    outline_count: int = 0

    @property
    def active_content_present(self) -> bool:
        return (
            self.javascript_present
            or self.xfa_present
            or self.launch_action_count > 0
            or self.uri_action_count > 0
            or self.remote_goto_count > 0
            or self.rich_media_count > 0
        )

    def as_json(self) -> dict[str, object]:
        return {
            "pdfVersion": self.pdf_version,
            "pageCount": self.page_count,
            "encrypted": self.encrypted,
            "encryptionSummary": self.encryption_summary,
            "tagged": self.tagged,
            "attachmentCount": self.attachment_count,
            "annotationCount": self.annotation_count,
            "formFieldCount": self.form_field_count,
            "xfaPresent": self.xfa_present,
            "javaScriptPresent": self.javascript_present,
            "launchActionCount": self.launch_action_count,
            "uriActionCount": self.uri_action_count,
            "remoteGoToCount": self.remote_goto_count,
            "richMediaCount": self.rich_media_count,
            "signatureFieldCount": self.signature_field_count,
            "outlineCount": self.outline_count,
            "activeContentPresent": self.active_content_present,
        }


@dataclass(frozen=True, slots=True)
class EngineIdentity:
    """Enough to reproduce an analysis, and nothing host-specific (§101)."""

    analyzer_name: str
    analyzer_version: str
    pdfium_version: str
    pypdfium2_version: str
    pikepdf_version: str
    qpdf_version: str
    layout_algorithm_version: int = LAYOUT_ALGORITHM_VERSION
    coordinate_schema_version: int = COORDINATE_SCHEMA_VERSION

    def as_json(self) -> dict[str, object]:
        return {
            "analyzerName": self.analyzer_name,
            "analyzerVersion": self.analyzer_version,
            "pdfiumVersion": self.pdfium_version,
            "pypdfium2Version": self.pypdfium2_version,
            "pikepdfVersion": self.pikepdf_version,
            "qpdfVersion": self.qpdf_version,
            "layoutAlgorithmVersion": self.layout_algorithm_version,
            "coordinateSchemaVersion": self.coordinate_schema_version,
        }


@dataclass(frozen=True, slots=True)
class PdfStructuralModel:
    features: DocumentFeatures
    metadata: DocumentMetadata
    pages: tuple[PageModel, ...]
    fonts: tuple[FontIdentity, ...]
    engine: EngineIdentity
    text_layer: TextLayer
    reading_order_source: str
    model_version: int = PDF_MODEL_VERSION

    def as_json(self) -> dict[str, object]:
        return {
            # The envelope's structuralModel carries its own version, and the
            # kind discriminator is what lets a reader tell a PDF model from a
            # DOCX one without consulting the envelope.
            "kind": "PDF",
            "analysisSchemaVersion": self.model_version,
            "coordinateSchemaVersion": COORDINATE_SCHEMA_VERSION,
            "layoutAlgorithmVersion": LAYOUT_ALGORITHM_VERSION,
            "engine": self.engine.as_json(),
            "features": self.features.as_json(),
            "metadata": self.metadata.as_json(),
            "documentTextLayer": str(self.text_layer),
            "readingOrderSource": self.reading_order_source,
            "fonts": [f.as_json() for f in self.fonts],
            "pages": [p.as_json() for p in self.pages],
        }
