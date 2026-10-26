"""What the PDF file says about itself, read through pikepdf/qpdf (§15-§19, §34, §71-§77).

This is the structural half of the analyzer: the catalog, the metadata, the
structure tree, and the inventory of things a PDF can carry that are not text.
Nothing here is opened, followed, fetched, launched or executed. An embedded
file is counted. A URI action is counted. JavaScript is counted. That is the
entire interaction with active content, and the counting exists so a report can
say "this document contains JavaScript", which is a security observation a
reader deserves (§18, §77).

Two claims are deliberately *not* made:

**Signature validity.** A signature field is counted and its ByteRange noted.
Whether the signature verifies, who signed, and whether their certificate is
trusted are cryptographic questions this phase does not answer, so it says
nothing about them (§16).

**PDF/A conformance.** A document may claim a PDF/A part and level in its XMP.
The claim is recorded as a claim. PalCert does not repeat it as a fact, because
validating PDF/A means checking hundreds of requirements this phase does not
implement (§17).
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
from typing import Any

import pikepdf

from app.pdf.errors import PdfAnalysisError, PdfFailure
from app.pdf.model import DocumentFeatures, DocumentMetadata

#: DocumentInfo keys PalCert reads, mapped to canonical property names.
_INFO_KEYS = {
    "/Title": "title",
    "/Author": "creator",
    "/Subject": "subject",
    "/Keywords": "keywords",
    "/Creator": "creatorTool",
    "/Producer": "producer",
    "/CreationDate": "created",
    "/ModDate": "modified",
}

#: XMP properties PalCert reads, mapped to the same canonical names, so the two
#: sources can be compared rather than concatenated (§72).
_XMP_KEYS = {
    "dc:title": "title",
    "dc:creator": "creator",
    "dc:description": "subject",
    "pdf:Keywords": "keywords",
    "xmp:CreatorTool": "creatorTool",
    "pdf:Producer": "producer",
    "xmp:CreateDate": "created",
    "xmp:ModifyDate": "modified",
}

#: Where the two sources disagree, XMP wins. ISO 32000-2 14.3.2 makes XMP the
#: richer, later-specified home for metadata, and a document that carries both
#: has usually had DocumentInfo left behind by an older tool. The losing value
#: is still recorded and the disagreement is reported (§72).
METADATA_PRECEDENCE = ("xmp", "documentInfo")


def open_document(data: bytes) -> pikepdf.Pdf:
    """Open the bytes, or fail with a stable code.

    A password-protected document is refused rather than guessed at: PalCert
    does not collect, store or brute-force PDF passwords (§19).
    """
    try:
        return pikepdf.Pdf.open(_as_stream(data))
    except pikepdf.PasswordError as error:
        raise PdfAnalysisError(PdfFailure.PASSWORD_REQUIRED, "a password is required") from error
    except pikepdf.PdfError as error:
        text = str(error).lower()
        if "encrypt" in text and "support" in text:
            raise PdfAnalysisError(
                PdfFailure.ENCRYPTION_UNSUPPORTED, "unsupported encryption"
            ) from error
        raise PdfAnalysisError(
            PdfFailure.DOCUMENT_INVALID, "the file could not be opened"
        ) from error


def _as_stream(data: bytes) -> Any:
    import io

    return io.BytesIO(data)


def _text_of(value: Any) -> str | None:
    try:
        if isinstance(value, pikepdf.String):
            return str(value)
        if isinstance(value, pikepdf.Name):
            return str(value)
        if isinstance(value, (str, int, float)):
            return str(value)
    except Exception:
        return None
    return None


def read_metadata(pdf: pikepdf.Pdf) -> DocumentMetadata:
    """Both metadata sources, their conflicts, and the effective value.

    Values are carried in the model because a rule may legitimately check a
    title; they are never logged, never put in a metric label and never sent to
    an audit event (§73, §107).
    """
    doc_info: dict[str, str] = {}
    try:
        info = pdf.trailer.get("/Info")
        if info is not None:
            for key, canonical in _INFO_KEYS.items():
                if key in info:
                    text = _text_of(info[key])
                    if text:
                        doc_info[canonical] = text
    except Exception:  # noqa: S110 - malformed metadata is data about the document, not a failure
        pass

    xmp: dict[str, str] = {}
    claimed_part: str | None = None
    claimed_level: str | None = None
    try:
        with pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=False) as meta:
            for key, canonical in _XMP_KEYS.items():
                if key in meta:
                    value = meta[key]
                    if isinstance(value, list):
                        value = value[0] if value else None
                    if value:
                        xmp[canonical] = str(value)
            claimed_part = str(meta["pdfaid:part"]) if "pdfaid:part" in meta else None
            claimed_level = (
                str(meta["pdfaid:conformance"]) if "pdfaid:conformance" in meta else None
            )
    except Exception:  # noqa: S110 - malformed metadata is data about the document, not a failure
        pass

    effective: dict[str, str] = {}
    chosen: dict[str, str] = {}
    conflicts: list[str] = []
    for canonical in sorted(set(doc_info) | set(xmp)):
        from_xmp = xmp.get(canonical)
        from_info = doc_info.get(canonical)
        if from_xmp is not None and from_info is not None and from_xmp != from_info:
            conflicts.append(canonical)
        if from_xmp is not None:
            effective[canonical] = from_xmp
            chosen[canonical] = "xmp"
        elif from_info is not None:
            effective[canonical] = from_info
            chosen[canonical] = "documentInfo"

    language: str | None = None
    with contextlib.suppress(Exception):
        if "/Lang" in pdf.Root:
            language = _text_of(pdf.Root["/Lang"])

    return DocumentMetadata(
        xmp=xmp,
        doc_info=doc_info,
        effective=effective,
        chosen_source=chosen,
        conflicts=tuple(conflicts),
        language=language,
        claimed_pdfa_part=claimed_part,
        claimed_pdfa_conformance=claimed_level,
    )


def _count_names_tree(pdf: pikepdf.Pdf, name: str) -> int:
    try:
        names = pdf.Root.get("/Names")
        if names is None or name not in names:
            return 0
        node = names[name]
        total = 0
        stack = [node]
        seen = 0
        while stack and seen < 10_000:
            seen += 1
            current = stack.pop()
            if "/Names" in current:
                total += len(current["/Names"]) // 2
            if "/Kids" in current:
                stack.extend(list(current["/Kids"]))
        return total
    except Exception:
        return 0


def _outline_count(pdf: pikepdf.Pdf) -> int:
    try:
        outlines = pdf.Root.get("/Outlines")
        if outlines is None:
            return 0
        count = outlines.get("/Count")
        return abs(int(count)) if count is not None else 0
    except Exception:
        return 0


@dataclass(frozen=True, slots=True)
class PageAttributes:
    """Per-page facts PDFium does not report."""

    user_unit: float = 1.0
    annotation_count: int = 0


def read_page_attributes(pdf: pikepdf.Pdf) -> tuple[PageAttributes, ...]:
    """Per-page facts only the file itself states.

    PDFium renders; it does not report /UserUnit, and a reader that assumes 1.0
    describes an A0 plan as an A4 sheet (ISO 32000-2 7.7.3.3, §24). Annotation
    counts are per page for the same reason - a document total cannot answer
    "which page carries the comment".
    """
    attributes: list[PageAttributes] = []
    for page in pdf.pages:
        user_unit = 1.0
        annotations = 0
        with contextlib.suppress(Exception):
            declared = page.obj.get("/UserUnit")
            if declared is not None:
                value = float(declared)
                # A non-positive scale is meaningless; the default stands and
                # the page is not silently reported as zero-sized.
                if value > 0:
                    user_unit = value
        with contextlib.suppress(Exception):
            annots = page.obj.get("/Annots")
            if annots is not None:
                annotations = len(annots)
        attributes.append(PageAttributes(user_unit=user_unit, annotation_count=annotations))
    return tuple(attributes)


def read_features(pdf: pikepdf.Pdf) -> DocumentFeatures:
    """The document-level inventory (§15).

    Annotations and their actions are walked per page because that is where
    they live; the walk counts and classifies, and touches nothing.
    """
    annotations = 0
    launch = uri = remote = rich = signatures = 0
    for page in pdf.pages:
        annots = None
        with contextlib.suppress(Exception):
            annots = page.get("/Annots")
        if annots is None:
            continue
        for annot in annots:
            annotations += 1
            try:
                subtype = str(annot.get("/Subtype", ""))
                if subtype == "/RichMedia":
                    rich += 1
                if subtype == "/Widget" and "/FT" in annot and str(annot["/FT"]) == "/Sig":
                    signatures += 1
                action = annot.get("/A")
                if action is not None and "/S" in action:
                    kind = str(action["/S"])
                    if kind == "/Launch":
                        launch += 1
                    elif kind == "/URI":
                        uri += 1
                    elif kind == "/GoToR":
                        remote += 1
            except Exception:  # noqa: S112 - one unreadable annotation must not lose the rest
                continue

    form_fields = 0
    xfa = False
    try:
        acro = pdf.Root.get("/AcroForm")
        if acro is not None:
            xfa = "/XFA" in acro
            fields = acro.get("/Fields")
            if fields is not None:
                form_fields = len(fields)
                for field in fields:
                    try:
                        if "/FT" in field and str(field["/FT"]) == "/Sig":
                            signatures += 1
                    except Exception:  # noqa: S112 - one unreadable field must not lose the rest
                        continue
    except Exception:  # noqa: S110 - malformed metadata is data about the document, not a failure
        pass

    javascript = _count_names_tree(pdf, "/JavaScript") > 0
    if not javascript:
        try:
            open_action = pdf.Root.get("/OpenAction")
            javascript = open_action is not None and "/JS" in open_action
        except Exception:
            javascript = False

    tagged = False
    with contextlib.suppress(Exception):
        tagged = "/StructTreeRoot" in pdf.Root

    return DocumentFeatures(
        pdf_version=str(pdf.pdf_version),
        page_count=len(pdf.pages),
        encrypted=bool(pdf.is_encrypted),
        encryption_summary=_encryption_summary(pdf),
        tagged=tagged,
        attachment_count=_count_names_tree(pdf, "/EmbeddedFiles"),
        annotation_count=annotations,
        form_field_count=form_fields,
        xfa_present=xfa,
        javascript_present=javascript,
        launch_action_count=launch,
        uri_action_count=uri,
        remote_goto_count=remote,
        rich_media_count=rich,
        signature_field_count=signatures,
        outline_count=_outline_count(pdf),
    )


def _encryption_summary(pdf: pikepdf.Pdf) -> str | None:
    """A safe description of how the file is encrypted, never a key or password."""
    try:
        if not pdf.is_encrypted:
            return None
        enc = pdf.encryption
        return f"R{enc.R} V{enc.V}"
    except Exception:
        return "unknown"
