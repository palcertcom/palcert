"""What the PDF analyzer reports when the document is less than it should be (§78).

Two kinds live here and the difference matters. A *partial* warning says one
domain of evidence is weaker than usual — an unresolved font, an untagged
document, a page with no text layer — and the analysis continues with the
coverage for that domain degraded. A *fatal* condition is not a warning at all:
it raises, the analysis fails, and Phase 11 releases the reservation without
charging (§79).

The codes are a closed set shared with the API through the analysis artifact
schema, so nothing downstream ever parses prose.
"""

from __future__ import annotations

from enum import StrEnum


class PdfWarning(StrEnum):
    TEXT_MAPPING_INCOMPLETE = "PDF_TEXT_MAPPING_INCOMPLETE"
    UNTAGGED = "PDF_UNTAGGED"
    PAGE_BOX_INVALID = "PDF_PAGE_BOX_INVALID"
    FONT_IDENTITY_UNRESOLVED = "PDF_FONT_IDENTITY_UNRESOLVED"
    FONT_SUBSTITUTION_POSSIBLE = "PDF_FONT_SUBSTITUTION_POSSIBLE"
    READING_ORDER_DERIVED = "PDF_READING_ORDER_DERIVED"
    LAYOUT_PARTIAL = "PDF_LAYOUT_PARTIAL"
    IMAGE_ONLY_PAGE = "PDF_IMAGE_ONLY_PAGE"
    HYBRID_TEXT_LAYER = "PDF_HYBRID_TEXT_LAYER"
    ACTIVE_CONTENT_PRESENT = "PDF_ACTIVE_CONTENT_PRESENT"
    ATTACHMENT_PRESENT = "PDF_ATTACHMENT_PRESENT"
    XFA_PRESENT = "PDF_XFA_PRESENT"
    SIGNATURE_PRESENT = "PDF_SIGNATURE_PRESENT"
    UNSUPPORTED_OBJECT = "PDF_UNSUPPORTED_OBJECT"
    RENDER_LIMIT_REACHED = "PDF_RENDER_LIMIT_REACHED"
    ENCRYPTED_DOCUMENT = "PDF_ENCRYPTED_DOCUMENT"
    METADATA_CONFLICT = "PDF_METADATA_CONFLICT"
    FORM_DEPTH_LIMIT_REACHED = "PDF_FORM_DEPTH_LIMIT_REACHED"
    OBJECT_LIMIT_REACHED = "PDF_OBJECT_LIMIT_REACHED"
