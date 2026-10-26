"""Font identity as the PDF declares it (§38-§42, §45, §46, §100).

The rule this module exists to enforce: **the font PalCert reports is the font
the document names, never the font the renderer found.** An unembedded
Helvetica is drawn with whatever the machine had available, and that choice
belongs to the machine. Reporting it as the document's font would make the same
PDF produce different compliance evidence on two servers, which is the one
thing analysis may never do.

Subset prefixes are stripped by exactly the rule in ISO 32000-2 9.6.4 — six
uppercase letters then a plus sign — and by nothing else. ``TimesNewRomanPSMT``
stays ``TimesNewRomanPSMT``; turning it into "Times New Roman" would be a guess
dressed as a fact. A standard that wants to accept both spellings needs an
explicit alias registry, which is a deliberate future feature, not a regex here.
"""

from __future__ import annotations

import re
from decimal import Decimal

from app.pdf.model import FontIdentity

#: ISO 32000-2 9.6.4: exactly six uppercase ASCII letters, then '+'.
_SUBSET_PREFIX = re.compile(r"^[A-Z]{6}\+")

#: PDF font descriptor flags (ISO 32000-2 9.8.2, Table 121).
FLAG_FIXED_PITCH = 1 << 0
FLAG_SERIF = 1 << 1
FLAG_SYMBOLIC = 1 << 2
FLAG_ITALIC = 1 << 6
FLAG_FORCE_BOLD = 1 << 18

#: The 14 standard fonts a conforming reader supplies (ISO 32000-2 9.6.2.2).
#: Never embedded by definition, so "not embedded" is not a defect for them —
#: but the glyphs still come from the reader, so substitution is still possible.
STANDARD_14 = frozenset(
    {
        "Times-Roman",
        "Times-Bold",
        "Times-Italic",
        "Times-BoldItalic",
        "Helvetica",
        "Helvetica-Bold",
        "Helvetica-Oblique",
        "Helvetica-BoldOblique",
        "Courier",
        "Courier-Bold",
        "Courier-Oblique",
        "Courier-BoldOblique",
        "Symbol",
        "ZapfDingbats",
    }
)


def strip_subset_prefix(raw_name: str) -> tuple[str, bool]:
    """The base name without a subset tag, and whether one was present."""
    if _SUBSET_PREFIX.match(raw_name):
        return raw_name[7:], True
    return raw_name, False


def is_standard_14(base_name: str) -> bool:
    return base_name in STANDARD_14


def build_identity(
    *,
    raw_name: str,
    embedded: bool,
    subtype: str | None = None,
    weight: int | None = None,
    italic_angle: float | Decimal | None = None,
    flags: int | None = None,
) -> FontIdentity:
    """One font as the document declares it.

    ``substitution_possible`` is true whenever the glyphs a reader sees did not
    come from the file — an unembedded font of any kind, standard-14 included.
    It is a statement about rendering, and never changes which font the
    compliance evidence names (§41).
    """
    base_name, subset = strip_subset_prefix(raw_name)
    angle: Decimal | None
    if italic_angle is None:
        angle = None
    else:
        angle = (
            italic_angle
            if isinstance(italic_angle, Decimal)
            else Decimal(repr(float(italic_angle)))
        )
    return FontIdentity(
        raw_name=raw_name,
        base_name=base_name,
        subset=subset,
        embedded=embedded,
        subtype=subtype,
        weight=weight if weight else None,
        italic_angle=angle,
        flags=flags,
        substitution_possible=not embedded,
    )


def derived_bold(font: FontIdentity) -> bool | None:
    """Whether this font is bold, or None when the document does not say (§45).

    Weight comes first because it is the document's own statement. The
    force-bold flag is a rendering instruction and is accepted as evidence when
    no weight is given. The *name* is never consulted: "Arial-BoldMT" is a
    string somebody chose, and a font called "Bolditalica" is not bold.
    """
    if font.weight is not None:
        return font.weight >= 600
    if font.flags is not None and font.flags & FLAG_FORCE_BOLD:
        return True
    return None


def derived_italic(font: FontIdentity) -> bool | None:
    """Whether this font is italic, or None when the document does not say (§46).

    The descriptor's italic angle and italic flag are the document's evidence.
    A name containing "Italic" or "Oblique" is not.
    """
    if font.italic_angle is not None:
        return font.italic_angle != 0
    if font.flags is not None:
        return bool(font.flags & FLAG_ITALIC)
    return None
