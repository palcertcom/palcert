"""Theme font resolution (§37).

``<w:rFonts w:asciiTheme="minorHAnsi"/>`` does not say the font is
"minorHAnsi". It says "whatever the theme's minor Latin typeface is", and the
answer lives in ``theme1.xml``. Reporting the token itself as a font family
would be reporting a pointer as if it were a value — and it would make a
perfectly ordinary Word document, where nearly every run uses theme fonts,
fail every font rule PalCert has.

A missing or unresolvable theme is a warning and an *unresolved* font, never
a substituted one: PalCert reports what the document can prove (§36).
"""

from __future__ import annotations

from dataclasses import dataclass
from xml.etree.ElementTree import Element

from app.docx.namespaces import Namespaces, local_name
from app.docx.warnings import WarningCode, WarningCollector

#: ``w:rFonts`` theme attribute values, mapped to (scheme, script) in the
#: theme's font scheme. "Ascii" and "HAnsi" both resolve to the Latin
#: typeface: the theme has one Latin face, and OOXML's two attributes exist to
#: let a document point each half of the Latin range at a different scheme.
_THEME_TOKENS: dict[str, tuple[str, str]] = {
    "majorAscii": ("major", "latin"),
    "majorHAnsi": ("major", "latin"),
    "majorEastAsia": ("major", "ea"),
    "majorBidi": ("major", "cs"),
    "minorAscii": ("minor", "latin"),
    "minorHAnsi": ("minor", "latin"),
    "minorEastAsia": ("minor", "ea"),
    "minorBidi": ("minor", "cs"),
}


@dataclass(frozen=True, slots=True)
class FontScheme:
    """One theme scheme's three typefaces."""

    latin: str | None
    east_asian: str | None
    complex_script: str | None

    def typeface(self, script: str) -> str | None:
        return {"latin": self.latin, "ea": self.east_asian, "cs": self.complex_script}[script]


@dataclass(frozen=True, slots=True)
class DocumentTheme:
    """The font scheme of one document, or the empty theme."""

    major: FontScheme
    minor: FontScheme
    present: bool

    @staticmethod
    def absent() -> DocumentTheme:
        empty = FontScheme(latin=None, east_asian=None, complex_script=None)
        return DocumentTheme(major=empty, minor=empty, present=False)

    def resolve(self, token: str, warnings: WarningCollector) -> str | None:
        """The typeface a theme token names, or None with a warning.

        None means "the document points at a theme entry that is not there".
        The caller must leave the font unresolved rather than choose one.
        """
        mapping = _THEME_TOKENS.get(token)
        if mapping is None:
            warnings.add(WarningCode.THEME_REFERENCE_UNRESOLVED, token=token)
            return None
        if not self.present:
            warnings.add(WarningCode.THEME_MISSING, token=token)
            return None

        scheme_name, script = mapping
        scheme = self.major if scheme_name == "major" else self.minor
        typeface = scheme.typeface(script)
        if typeface is None or not typeface.strip():
            warnings.add(WarningCode.THEME_REFERENCE_UNRESOLVED, token=token)
            return None
        return typeface


def _scheme_from(element: Element | None) -> FontScheme:
    if element is None:
        return FontScheme(latin=None, east_asian=None, complex_script=None)

    typefaces: dict[str, str | None] = {"latin": None, "ea": None, "cs": None}
    for child in element:
        tag = local_name(child.tag)
        if tag in typefaces:
            value = child.get("typeface")
            typefaces[tag] = value if value else None
    return FontScheme(
        latin=typefaces["latin"],
        east_asian=typefaces["ea"],
        complex_script=typefaces["cs"],
    )


def parse_theme(root: Element | None, namespaces: Namespaces) -> DocumentTheme:
    """Read the font scheme from a ``theme1.xml`` root, if there is one.

    Matched by local name: the DrawingML namespace differs between the Strict
    and Transitional profiles, and a theme is a theme in both.
    """
    if root is None:
        return DocumentTheme.absent()

    font_scheme: Element | None = None
    for elements in root.iter():
        if local_name(elements.tag) == "fontScheme":
            font_scheme = elements
            break
    if font_scheme is None:
        return DocumentTheme.absent()

    major: Element | None = None
    minor: Element | None = None
    for child in font_scheme:
        tag = local_name(child.tag)
        if tag == "majorFont":
            major = child
        elif tag == "minorFont":
            minor = child

    return DocumentTheme(major=_scheme_from(major), minor=_scheme_from(minor), present=True)
