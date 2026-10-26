"""Document settings that change how other parts are interpreted (§30, §51, §55).

A handful of document-level switches decide what the rest of the package
means. ``w:evenAndOddHeaders`` decides whether the even-page header reference
is used at all; ``w:mirrorMargins`` turns left and right margins into inside
and outside, which cannot be mapped to physical sides without knowing page
parity — something structural analysis does not know (§30).
"""

from __future__ import annotations

from dataclasses import dataclass
from xml.etree.ElementTree import Element

from app.docx.namespaces import Namespaces


@dataclass(frozen=True, slots=True)
class DocumentSettings:
    even_and_odd_headers: bool = False
    mirror_margins: bool = False
    gutter_at_top: bool = False
    #: ``w:trackChanges``: revision *recording* is on. Says nothing about
    #: whether the document currently contains revisions.
    track_changes_enabled: bool = False
    rtl_gutter: bool = False
    present: bool = False

    @staticmethod
    def absent() -> DocumentSettings:
        return DocumentSettings()


def _flag(root: Element, namespaces: Namespaces, tag: str) -> bool:
    element = root.find(namespaces.qn(tag))
    if element is None:
        return False
    value = element.get(namespaces.qn("w:val"))
    if value is None:
        return True
    return value.strip().lower() in {"1", "true", "on"}


def parse_settings(root: Element | None, namespaces: Namespaces) -> DocumentSettings:
    if root is None:
        return DocumentSettings.absent()
    return DocumentSettings(
        even_and_odd_headers=_flag(root, namespaces, "w:evenAndOddHeaders"),
        mirror_margins=_flag(root, namespaces, "w:mirrorMargins"),
        gutter_at_top=_flag(root, namespaces, "w:gutterAtTop"),
        track_changes_enabled=_flag(root, namespaces, "w:trackChanges"),
        rtl_gutter=_flag(root, namespaces, "w:rtlGutter"),
        present=True,
    )
