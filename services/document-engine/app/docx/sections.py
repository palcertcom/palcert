"""Sections, page setup and header/footer references (§27-§30, §51).

WordprocessingML stores sections in a way that surprises everyone once: a
``w:sectPr`` inside a paragraph's properties does not *start* a section, it
**ends** the one that paragraph belongs to. The section properties for the
final stretch of the document live at the end of the body instead. Reading
them as "start markers" shifts every section's geometry by one.

Sections matter to PalCert because page geometry is per-section. A thesis with
a landscape table section genuinely has two page sizes, and a document whose
chapters disagree about margins genuinely has inconsistent margins — which is
something a standard may legitimately forbid. Collapsing them into one
averaged value would hide exactly the defect a rule is looking for (§29).
"""

from __future__ import annotations

from dataclasses import dataclass
from xml.etree.ElementTree import Element

from app.docx.limits import AnalyzerLimits, ResourceLimitExceededError
from app.docx.namespaces import Namespaces
from app.docx.units import parse_int


@dataclass(frozen=True, slots=True)
class HeaderFooterReference:
    """A ``w:headerReference`` / ``w:footerReference``."""

    #: "default", "first" or "even".
    reference_type: str
    relationship_id: str


@dataclass(frozen=True, slots=True)
class PageSetup:
    """Everything ``w:pgSz``, ``w:pgMar`` and ``w:cols`` declare, in twips."""

    width_twips: int | None = None
    height_twips: int | None = None
    #: "portrait" or "landscape" as declared. Absent means the document did
    #: not say; it is *not* inferred from width against height, because a
    #: custom page size can be wider than tall without being landscape.
    orientation: str | None = None
    margin_top_twips: int | None = None
    margin_bottom_twips: int | None = None
    margin_left_twips: int | None = None
    margin_right_twips: int | None = None
    header_distance_twips: int | None = None
    footer_distance_twips: int | None = None
    gutter_twips: int | None = None
    column_count: int | None = None
    column_space_twips: int | None = None
    section_break_type: str | None = None
    title_page: bool = False
    bidi: bool = False


@dataclass(frozen=True, slots=True)
class DocumentSection:
    """One section: its geometry, its header/footer references, its extent."""

    index: int
    page_setup: PageSetup
    headers: tuple[HeaderFooterReference, ...]
    footers: tuple[HeaderFooterReference, ...]
    #: True for the trailing ``w:sectPr`` at body level.
    is_final: bool

    def header_for(self, reference_type: str) -> str | None:
        for reference in self.headers:
            if reference.reference_type == reference_type:
                return reference.relationship_id
        return None

    def footer_for(self, reference_type: str) -> str | None:
        for reference in self.footers:
            if reference.reference_type == reference_type:
                return reference.relationship_id
        return None


def _on_off_child(element: Element, namespaces: Namespaces, tag: str) -> bool:
    child = element.find(namespaces.qn(tag))
    if child is None:
        return False
    value = child.get(namespaces.qn("w:val"))
    if value is None:
        return True
    return value.strip().lower() in {"1", "true", "on"}


def parse_page_setup(sect_pr: Element, namespaces: Namespaces) -> PageSetup:
    size = sect_pr.find(namespaces.qn("w:pgSz"))
    margins = sect_pr.find(namespaces.qn("w:pgMar"))
    columns = sect_pr.find(namespaces.qn("w:cols"))
    break_type = sect_pr.find(namespaces.qn("w:type"))

    return PageSetup(
        width_twips=parse_int(size.get(namespaces.qn("w:w"))) if size is not None else None,
        height_twips=parse_int(size.get(namespaces.qn("w:h"))) if size is not None else None,
        orientation=(
            (size.get(namespaces.qn("w:orient")) or "").strip().lower() or None
            if size is not None
            else None
        ),
        margin_top_twips=(
            parse_int(margins.get(namespaces.qn("w:top"))) if margins is not None else None
        ),
        margin_bottom_twips=(
            parse_int(margins.get(namespaces.qn("w:bottom"))) if margins is not None else None
        ),
        margin_left_twips=(
            parse_int(margins.get(namespaces.qn("w:left"))) if margins is not None else None
        ),
        margin_right_twips=(
            parse_int(margins.get(namespaces.qn("w:right"))) if margins is not None else None
        ),
        header_distance_twips=(
            parse_int(margins.get(namespaces.qn("w:header"))) if margins is not None else None
        ),
        footer_distance_twips=(
            parse_int(margins.get(namespaces.qn("w:footer"))) if margins is not None else None
        ),
        gutter_twips=(
            parse_int(margins.get(namespaces.qn("w:gutter"))) if margins is not None else None
        ),
        column_count=(
            parse_int(columns.get(namespaces.qn("w:num"))) if columns is not None else None
        ),
        column_space_twips=(
            parse_int(columns.get(namespaces.qn("w:space"))) if columns is not None else None
        ),
        section_break_type=(
            (break_type.get(namespaces.qn("w:val")) or "").strip() or None
            if break_type is not None
            else None
        ),
        title_page=_on_off_child(sect_pr, namespaces, "w:titlePg"),
        bidi=_on_off_child(sect_pr, namespaces, "w:bidi"),
    )


def _references(
    sect_pr: Element, namespaces: Namespaces, tag: str
) -> tuple[HeaderFooterReference, ...]:
    found: list[HeaderFooterReference] = []
    for element in sect_pr.findall(namespaces.qn(tag)):
        relationship_id = element.get(namespaces.qn("r:id"))
        if not relationship_id:
            continue
        reference_type = (element.get(namespaces.qn("w:type")) or "default").strip().lower()
        found.append(
            HeaderFooterReference(reference_type=reference_type, relationship_id=relationship_id)
        )
    return tuple(found)


def parse_section(
    sect_pr: Element, namespaces: Namespaces, index: int, is_final: bool
) -> DocumentSection:
    return DocumentSection(
        index=index,
        page_setup=parse_page_setup(sect_pr, namespaces),
        headers=_references(sect_pr, namespaces, "w:headerReference"),
        footers=_references(sect_pr, namespaces, "w:footerReference"),
        is_final=is_final,
    )


def collect_sections(
    body: Element, namespaces: Namespaces, limits: AnalyzerLimits
) -> tuple[DocumentSection, ...]:
    """Every section of the body, in document order.

    A ``w:sectPr`` inside a paragraph closes the section that paragraph is in;
    the one at body level closes the last. Both are collected here so the
    walker can attribute each paragraph to a section index without re-deriving
    the rule.
    """
    sections: list[DocumentSection] = []
    paragraph_tag = namespaces.qn("w:p")
    properties_tag = namespaces.qn("w:pPr")
    section_tag = namespaces.qn("w:sectPr")

    for child in body:
        if child.tag != paragraph_tag:
            continue
        properties = child.find(properties_tag)
        if properties is None:
            continue
        sect_pr = properties.find(section_tag)
        if sect_pr is None:
            continue
        if len(sections) >= limits.max_sections:
            raise ResourceLimitExceededError("max_sections", limits.max_sections)
        sections.append(parse_section(sect_pr, namespaces, len(sections), is_final=False))

    final = body.find(section_tag)
    if final is not None:
        sections.append(parse_section(final, namespaces, len(sections), is_final=True))

    return tuple(sections)


def inherit_references(sections: tuple[DocumentSection, ...]) -> tuple[DocumentSection, ...]:
    """Fill omitted header/footer references from the previous section (§51).

    OOXML inheritance: a section that does not declare a reference of a given
    type uses the previous section's. Without this, every section after the
    first would appear to have no header at all — which is the opposite of
    what the document does.
    """
    resolved: list[DocumentSection] = []
    inherited_headers: dict[str, str] = {}
    inherited_footers: dict[str, str] = {}

    for section in sections:
        headers = dict(inherited_headers)
        for reference in section.headers:
            headers[reference.reference_type] = reference.relationship_id
        footers = dict(inherited_footers)
        for reference in section.footers:
            footers[reference.reference_type] = reference.relationship_id

        resolved.append(
            DocumentSection(
                index=section.index,
                page_setup=section.page_setup,
                headers=tuple(
                    HeaderFooterReference(reference_type=key, relationship_id=value)
                    for key, value in sorted(headers.items())
                ),
                footers=tuple(
                    HeaderFooterReference(reference_type=key, relationship_id=value)
                    for key, value in sorted(footers.items())
                ),
                is_final=section.is_final,
            )
        )
        inherited_headers = headers
        inherited_footers = footers

    return tuple(resolved)
