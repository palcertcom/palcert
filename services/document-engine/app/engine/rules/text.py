"""Deterministic text normalization for string comparison.

There is no single correct normalization, and applying one everywhere would be
wrong in both directions:

* A **font family** should compare case-insensitively and ignore surrounding
  whitespace. "times new roman" and "Times New Roman" are the same typeface,
  and rejecting a document over the capital T would be nonsense.
* A **required phrase** — a declaration a journal insists appears verbatim —
  must compare far more strictly. Silently accepting a different capitalisation
  of a legal statement is not a kindness.

So normalization is *named*, chosen per rule property, and never implicit. The
default is the conservative one.

Unicode normalization to NFC is applied in every mode. Two byte sequences that
render identically are the same text to a reader, and treating them as
different would make a rule impossible to satisfy for reasons invisible on
screen. That is a correctness fix, not a leniency.
"""

from __future__ import annotations

import re
import unicodedata
from enum import StrEnum

_WHITESPACE_RUN = re.compile(r"\s+")


class TextComparison(StrEnum):
    """How two strings are compared.

    ``EXACT`` is the default because it is the mode that cannot silently accept
    something the author did not write.
    """

    #: NFC only. Byte-for-byte thereafter, whitespace and case significant.
    EXACT = "EXACT"
    #: NFC, then trim the ends. Internal whitespace and case significant.
    TRIMMED = "TRIMMED"
    #: NFC, trim, case-fold. Internal whitespace significant.
    CASE_INSENSITIVE = "CASE_INSENSITIVE"
    #: NFC, trim, collapse internal whitespace runs to one space, case-fold.
    #: The mode for names of things — typefaces, styles, section headings.
    NORMALIZED = "NORMALIZED"


#: Properties whose comparison mode differs from the default.
#:
#: Keyed by the scope property name so the choice is visible and reviewable in
#: one place, rather than hidden in an evaluator. A property absent from this
#: map compares EXACTly.
_PROPERTY_COMPARISON: dict[str, TextComparison] = {
    "fontFamily": TextComparison.NORMALIZED,
    "fontName": TextComparison.NORMALIZED,
    "styleName": TextComparison.NORMALIZED,
    "alignment": TextComparison.CASE_INSENSITIVE,
    "language": TextComparison.CASE_INSENSITIVE,
    "citationStyle": TextComparison.CASE_INSENSITIVE,
    "numberingFormat": TextComparison.CASE_INSENSITIVE,
    "heading": TextComparison.NORMALIZED,
    "title": TextComparison.TRIMMED,
    "author": TextComparison.TRIMMED,
}


def comparison_for_property(property_name: str | None) -> TextComparison:
    """The comparison mode for a scope property."""
    if property_name is None:
        return TextComparison.EXACT
    return _PROPERTY_COMPARISON.get(property_name, TextComparison.EXACT)


def normalize(value: str, comparison: TextComparison) -> str:
    """Apply a named normalization.

    Deterministic and idempotent: normalizing twice gives the same result, so
    the mode can be applied at any layer without changing the outcome.
    """
    result = unicodedata.normalize("NFC", value)

    if comparison is TextComparison.EXACT:
        return result

    result = result.strip()
    if comparison is TextComparison.TRIMMED:
        return result

    if comparison is TextComparison.NORMALIZED:
        result = _WHITESPACE_RUN.sub(" ", result)

    # casefold rather than lower: it handles the cases lower() does not, such
    # as the German sharp s, and is the Unicode-defined operation for
    # caseless matching.
    return result.casefold()


def equals(left: str, right: str, comparison: TextComparison) -> bool:
    return normalize(left, comparison) == normalize(right, comparison)


def contains(haystack: str, needle: str, comparison: TextComparison) -> bool:
    return normalize(needle, comparison) in normalize(haystack, comparison)
