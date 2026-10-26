"""Telling a searchable PDF from a scan, honestly (§49-§52).

A PDF can be a page of text, a photograph of a page of text, or both, and the
difference decides which rules can be answered at all. PalCert classifies it
from evidence it can count, never from a guess about what the document is for,
and never by running OCR to find out (§51, §54).

The classifier is versioned because its thresholds are a judgement: a page with
four characters of text under a full-page image is a scan with a stray label on
it, and a page with four hundred is a real text layer. Where exactly that line
sits is a decision, and a stored artifact is interpreted through the version
that made it.

The whole-document answer is not "whichever page kind there are most of". A
thesis with one scanned appendix page is HYBRID, and saying it is searchable
would promise text coverage that one page cannot deliver (§52).
"""

from __future__ import annotations

from decimal import Decimal

from app.pdf.model import TextLayer

#: Bumped when the same page would classify differently.
CLASSIFIER_VERSION = 1

#: Below this many mapped characters, text sitting on top of a page-sized
#: image is a stray label rather than a text layer: a running head and a page
#: number alone come to roughly twenty, and a scan often carries exactly that.
#: The floor applies only in that case. A page with no page-sized image and a
#: short title on it is a title page, and its typography is real evidence -
#: refusing to read it because it is short would lose a genuine fact (§50).
MIN_NATIVE_CHARACTERS = 32

#: An image covering at least this fraction of the page is page-sized, which is
#: what a scan looks like.
PAGE_IMAGE_COVERAGE = Decimal("0.55")

#: Above this share of unmapped glyphs the text layer is present but unusable:
#: the characters extract as replacement marks, so there is nothing to read.
MAX_UNMAPPED_RATIO = Decimal("0.5")


def classify_page(
    *,
    native_characters: int,
    unmapped_characters: int,
    image_coverage: Decimal,
    text_object_count: int,
) -> TextLayer:
    """One page's text layer.

    Order matters. A page is only IMAGE_ONLY when it has a page-sized image
    *and* no usable text; a page with a big figure and a paragraph under it is
    NATIVE_TEXT, because the paragraph is readable.
    """
    usable = native_characters - unmapped_characters
    ratio = (
        Decimal(unmapped_characters) / Decimal(native_characters)
        if native_characters > 0
        else Decimal(0)
    )
    page_image = image_coverage >= PAGE_IMAGE_COVERAGE
    floor = MIN_NATIVE_CHARACTERS if page_image else 1
    has_text = usable >= floor and ratio <= MAX_UNMAPPED_RATIO

    if has_text:
        return TextLayer.NATIVE_TEXT
    if page_image:
        return TextLayer.IMAGE_ONLY
    if text_object_count > 0 or native_characters > 0:
        # Some ink, but not enough readable text to answer a text rule.
        return TextLayer.EMPTY_OR_UNKNOWN
    return TextLayer.EMPTY_OR_UNKNOWN


def classify_document(pages: tuple[TextLayer, ...]) -> TextLayer:
    """The document's text layer from its pages.

    A single scanned page in an otherwise searchable document makes the
    document HYBRID, not searchable: coverage is reported per page precisely so
    that one page's limitation is not averaged away (§52).
    """
    if not pages:
        return TextLayer.EMPTY_OR_UNKNOWN
    kinds = set(pages)
    if kinds == {TextLayer.NATIVE_TEXT}:
        return TextLayer.NATIVE_TEXT
    if kinds <= {TextLayer.IMAGE_ONLY, TextLayer.EMPTY_OR_UNKNOWN}:
        return TextLayer.IMAGE_ONLY if TextLayer.IMAGE_ONLY in kinds else TextLayer.EMPTY_OR_UNKNOWN
    if TextLayer.NATIVE_TEXT in kinds:
        return TextLayer.HYBRID
    return TextLayer.EMPTY_OR_UNKNOWN
