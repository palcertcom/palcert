"""OOXML namespaces and profile detection (§20).

Two WordprocessingML profiles are in the wild. *Transitional* is what every
version of Word writes by default; *Strict* is the ISO profile, chosen by a
handful of institutions and government templates, and it differs in exactly
one way that matters here: the namespace URIs.

Parsing a Strict package with Transitional namespace names does not fail. It
finds nothing, and an analyzer that does not check would confidently report an
empty document with COMPLETE coverage — a wrong answer that looks like a
right one. Hence detection, and hence an explicit failure for anything else
(§20: never silently parse a different namespace as an empty document).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

# Transitional (ECMA-376 1st edition and Word's default output).
W_TRANSITIONAL = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
# Strict (ISO/IEC 29500 Strict).
W_STRICT = "http://purl.oclc.org/ooxml/wordprocessingml/main"

R_TRANSITIONAL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
R_STRICT = "http://purl.oclc.org/ooxml/officeDocument/relationships"

A_TRANSITIONAL = "http://schemas.openxmlformats.org/drawingml/2006/main"
A_STRICT = "http://purl.oclc.org/ooxml/drawingml/main"

WP_TRANSITIONAL = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
WP_STRICT = "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing"

#: Namespaces that do not vary between profiles.
NS_PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"
NS_MARKUP_COMPATIBILITY = "http://schemas.openxmlformats.org/markup-compatibility/2006"
NS_OFFICE_MATH = "http://schemas.openxmlformats.org/officeDocument/2006/math"
NS_VML = "urn:schemas-microsoft-com:vml"
NS_WORD_2010 = "http://schemas.microsoft.com/office/word/2010/wordml"
NS_WORD_2010_DRAWING = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape"

NS_DC = "http://purl.org/dc/elements/1.1/"
NS_DCTERMS = "http://purl.org/dc/terms/"
NS_CORE_PROPERTIES = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
NS_EXTENDED_PROPERTIES = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
NS_CUSTOM_PROPERTIES = "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"

#: Relationship *types* also differ by profile; both forms are accepted and
#: compared by their final segment, which is stable across profiles.
REL_TYPE_PREFIXES = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/",
    "http://purl.oclc.org/ooxml/officeDocument/relationships/",
    "http://schemas.microsoft.com/office/2007/relationships/",
)


class OoxmlProfile(StrEnum):
    TRANSITIONAL = "TRANSITIONAL"
    STRICT = "STRICT"


@dataclass(frozen=True, slots=True)
class Namespaces:
    """The namespace set for one package, resolved once at open time."""

    profile: OoxmlProfile
    w: str
    r: str
    a: str
    wp: str

    @staticmethod
    def for_profile(profile: OoxmlProfile) -> Namespaces:
        if profile is OoxmlProfile.STRICT:
            return Namespaces(profile=profile, w=W_STRICT, r=R_STRICT, a=A_STRICT, wp=WP_STRICT)
        return Namespaces(
            profile=profile,
            w=W_TRANSITIONAL,
            r=R_TRANSITIONAL,
            a=A_TRANSITIONAL,
            wp=WP_TRANSITIONAL,
        )

    def qn(self, name: str) -> str:
        """``w:p`` -> ``{namespace}p``, for the profile actually in use."""
        prefix, _, local = name.partition(":")
        namespace = {
            "w": self.w,
            "r": self.r,
            "a": self.a,
            "wp": self.wp,
            "mc": NS_MARKUP_COMPATIBILITY,
            "m": NS_OFFICE_MATH,
            "v": NS_VML,
            "w14": NS_WORD_2010,
            "wps": NS_WORD_2010_DRAWING,
            "dc": NS_DC,
            "dcterms": NS_DCTERMS,
            "cp": NS_CORE_PROPERTIES,
            "ep": NS_EXTENDED_PROPERTIES,
            "custom": NS_CUSTOM_PROPERTIES,
        }[prefix]
        return f"{{{namespace}}}{local}"


def detect_profile(root_tag: str) -> OoxmlProfile | None:
    """The profile a ``w:document`` root element belongs to, or None."""
    if root_tag.startswith(f"{{{W_TRANSITIONAL}}}"):
        return OoxmlProfile.TRANSITIONAL
    if root_tag.startswith(f"{{{W_STRICT}}}"):
        return OoxmlProfile.STRICT
    return None


def local_name(tag: str) -> str:
    """The local part of a Clark-notation tag."""
    return tag.rpartition("}")[2]


def relationship_kind(relationship_type: str) -> str:
    """The final segment of a relationship type, e.g. ``styles``.

    Comparing whole URIs would make every lookup profile-dependent for no
    benefit: the segment is identical in Transitional, Strict and Microsoft's
    own extension namespace.
    """
    for prefix in REL_TYPE_PREFIXES:
        if relationship_type.startswith(prefix):
            return relationship_type[len(prefix) :]
    return relationship_type.rpartition("/")[2]
