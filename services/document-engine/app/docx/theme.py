"""Theme font resolution (§37).

``<w:rFonts w:asciiTheme="minorHAnsi"/>`` does not say the font is
"minorHAnsi". It selects the theme's minor Latin region, with a supplemental
font selected by ``settings.xml``'s ``themeFontLang`` when declared. Reporting
the token itself as a font family
would be reporting a pointer as if it were a value — and it would make a
perfectly ordinary Word document, where nearly every run uses theme fonts,
fail every font rule PalCert has.

A missing or unresolvable theme is a warning and an *unresolved* font, never
a substituted one: PalCert reports what the document can prove (§36).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from xml.etree.ElementTree import Element

from app.docx.namespaces import Namespaces, local_name
from app.docx.warnings import WarningCode, WarningCollector

#: ``w:rFonts`` theme attribute values, mapped to (scheme, script) in the
#: theme's font scheme. "Ascii" and "HAnsi" both use the Latin region and
#: themeFontLang/@val; each can point to a different major/minor scheme.
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

# Bounded language-to-script mapping. An explicit BCP 47 script takes precedence;
# ambiguous/unsupported languages stay unresolved instead of using a host locale.
_LANGUAGE_SCRIPTS = {
    **dict.fromkeys(("ar", "fa", "ur", "ps"), "Arab"),
    **dict.fromkeys(("he", "iw", "yi"), "Hebr"),
    **dict.fromkeys(
        (
            "en",
            "fr",
            "de",
            "es",
            "it",
            "pt",
            "nl",
            "da",
            "sv",
            "no",
            "nb",
            "nn",
            "fi",
            "is",
            "pl",
            "cs",
            "sk",
            "sl",
            "hr",
            "ro",
            "hu",
            "tr",
            "vi",
            "id",
            "ms",
            "sw",
        ),
        "Latn",
    ),
    **dict.fromkeys(("ru", "uk", "bg", "be", "mk"), "Cyrl"),
    **dict.fromkeys(("hi", "mr", "ne", "sa"), "Deva"),
    **dict.fromkeys(("bn", "as"), "Beng"),
    "ja": "Jpan",
    "ko": "Hang",
    "el": "Grek",
    "th": "Thai",
    "ta": "Taml",
    "te": "Telu",
    "kn": "Knda",
    "ml": "Mlym",
    "gu": "Gujr",
    "hy": "Armn",
    "ka": "Geor",
    "km": "Khmr",
    "lo": "Laoo",
    "syr": "Syrc",
}


def _language_script(language: str) -> str | None:
    parts = language.lower().split("-")
    # Extensions/private-use subtags cannot supply a script or region.
    core: list[str] = []
    for part in parts:
        if len(part) == 1:
            break
        core.append(part)
    if not core:
        return None
    for part in core[1:]:
        if len(part) == 4 and part.isascii() and part.isalpha():
            return part.title()
    if core[0] == "zh":
        if any(region in core[1:] for region in ("cn", "sg")):
            return "Hans"
        if any(region in core[1:] for region in ("tw", "hk", "mo")):
            return "Hant"
        return None
    return _LANGUAGE_SCRIPTS.get(core[0])


@dataclass(frozen=True, slots=True)
class FontScheme:
    """One theme scheme's regional defaults and supplemental script fonts."""

    latin: str | None
    east_asian: str | None
    complex_script: str | None
    supplemental: dict[str, str] = field(default_factory=dict)

    def typeface(self, script: str) -> str | None:
        return {"latin": self.latin, "ea": self.east_asian, "cs": self.complex_script}[script]


@dataclass(frozen=True, slots=True)
class DocumentTheme:
    """The font scheme of one document, or the empty theme."""

    major: FontScheme
    minor: FontScheme
    present: bool
    languages: dict[str, str] = field(default_factory=dict)

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
        typeface: str | None = scheme.typeface(script)
        language = self.languages.get(script)
        if language is not None:
            selected_script = _language_script(language)
            if selected_script is None:
                warnings.add(WarningCode.THEME_REFERENCE_UNRESOLVED, token=token)
                return None
            # ISO/IEC 29500-1 §17.15.1.87: themeFontLang selects a:font,
            # including major/minorAscii when val names a non-Latin language.
            if selected_script in scheme.supplemental:
                typeface = scheme.supplemental[selected_script]
        if typeface is None or not typeface.strip():
            warnings.add(WarningCode.THEME_REFERENCE_UNRESOLVED, token=token)
            return None
        return typeface.strip()


def _scheme_from(element: Element | None) -> FontScheme:
    if element is None:
        return FontScheme(latin=None, east_asian=None, complex_script=None)

    typefaces: dict[str, str | None] = {"latin": None, "ea": None, "cs": None}
    supplemental: dict[str, str] = {}
    for child in element:
        tag = local_name(child.tag)
        if tag in typefaces:
            value = child.get("typeface")
            typefaces[tag] = value if value else None
        elif tag == "font":
            script = (child.get("script") or "").strip()
            face = (child.get("typeface") or "").strip()
            if script:
                # Conflicting duplicate definitions are ambiguous, not last-wins.
                if script in supplemental and supplemental[script] != face:
                    supplemental[script] = ""
                else:
                    supplemental[script] = face
    return FontScheme(
        latin=typefaces["latin"],
        east_asian=typefaces["ea"],
        complex_script=typefaces["cs"],
        supplemental=supplemental,
    )


def parse_theme(
    root: Element | None,
    namespaces: Namespaces,
    languages: dict[str, str] | None = None,
) -> DocumentTheme:
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

    return DocumentTheme(
        major=_scheme_from(major),
        minor=_scheme_from(minor),
        present=True,
        languages=dict(languages or {}),
    )
