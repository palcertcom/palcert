"""Resolving a Phase 6 node id back to the element it names.

A node id is a *locator*, never a selector. Nothing evaluates it as XPath and
nothing accepts one from a client to address a document — it is resolved only
here, and only against a package PalCert opened itself.

The index is built by the Phase 6 walker, not by a second walker written to
the same rules. That is the whole point: the code that assigns
``main/body/p:17/r:2`` hands back the element it assigned it to, so an edit
can never land on a different paragraph than the one the plan named. A second
implementation would be a second chance to get the ordinal rules subtly wrong,
and the cost of being wrong is an edit to the wrong sentence of somebody's
thesis.
"""

from __future__ import annotations

import zipfile
from dataclasses import dataclass
from typing import IO
from xml.etree.ElementTree import Element

from app.docx.document import read_document
from app.docx.limits import AnalyzerLimits
from app.docx.model import StructuralModel
from app.docx.namespaces import Namespaces
from app.docx.package import REL_NUMBERING, DocxPackage, resolve_namespaces
from app.docx.sections import collect_sections
from app.docx.styles import StyleCatalogue
from app.docx.warnings import WarningCollector


@dataclass(frozen=True, slots=True)
class SectionTarget:
    """One section's properties, and the part they live in."""

    index: int
    part_name: str
    sect_pr: Element


@dataclass(slots=True)
class DocumentIndex:
    """Everything the mutator needs to find and rewrite an element."""

    namespaces: Namespaces
    model: StructuralModel
    #: node id → (part name, element), for paragraphs and runs.
    elements: dict[str, tuple[str, Element]]
    #: Parsed root of every part the index refers to, keyed by part name.
    roots: dict[str, Element]
    #: Section properties, in the same order `collect_sections` reports them.
    sections: tuple[SectionTarget, ...]
    main_part: str
    styles: StyleCatalogue
    numbering_part: str | None

    def element_for(self, node_id: str) -> tuple[str, Element] | None:
        return self.elements.get(node_id)

    def section_for(self, index: int) -> SectionTarget | None:
        if 0 <= index < len(self.sections):
            return self.sections[index]
        return None


def collect_section_properties(body: Element, namespaces: Namespaces) -> tuple[Element, ...]:
    """Every ``w:sectPr`` of a body, in the order Phase 6 numbers sections.

    A ``w:sectPr`` inside a paragraph closes the section that paragraph is in;
    the one at body level closes the last. `collect_sections` applies exactly
    this rule when it assigns section indices, and `test_locate.py` asserts
    the two agree in count and order — an off-by-one here would move the wrong
    section's margins.
    """
    paragraph_tag = namespaces.qn("w:p")
    properties_tag = namespaces.qn("w:pPr")
    section_tag = namespaces.qn("w:sectPr")

    found: list[Element] = []
    for child in body:
        if child.tag != paragraph_tag:
            continue
        properties = child.find(properties_tag)
        if properties is None:
            continue
        sect_pr = properties.find(section_tag)
        if sect_pr is not None:
            found.append(sect_pr)

    final = body.find(section_tag)
    if final is not None:
        found.append(final)
    return tuple(found)


class _IndexingPackage(DocxPackage):
    """A package that remembers the element tree of every part it parses.

    The analyzer parses each part, walks it and lets it go; the mutator has to
    keep the trees, because the element it edits and the tree it serializes
    have to be the same objects. Subclassing rather than changing the analyzer
    keeps that cost on the code that needs it.
    """

    def __init__(
        self, archive: zipfile.ZipFile, limits: AnalyzerLimits, warnings: WarningCollector
    ) -> None:
        super().__init__(archive, limits, warnings)
        self.roots: dict[str, Element] = {}

    def parse_part(self, part_name: str) -> Element:
        cached = self.roots.get(part_name)
        if cached is not None:
            return cached
        root = super().parse_part(part_name)
        self.roots[part_name] = root
        return root


def build_index(
    source: str | IO[bytes] | zipfile.ZipFile,
    limits: AnalyzerLimits,
    warnings: WarningCollector,
) -> tuple[DocumentIndex, _IndexingPackage]:
    """Read a package and index every addressable element in it.

    Returns the package as well, because its parsed trees are what the caller
    will serialize; closing it before writing would throw away the edits.
    """
    package = _IndexingPackage.open(source, limits, warnings)

    main_part = package.main_document_part()
    root = package.parse_part(main_part)
    namespaces = resolve_namespaces(root.tag)
    body = root.find(namespaces.qn("w:body"))
    if body is None:  # pragma: no cover - read_document raises on this first
        raise ValueError("the document has no body")

    result = read_document(package, limits, warnings, index_elements=True)
    elements: dict[str, tuple[str, Element]] = dict(result.context.elements or {})

    sect_prs = collect_section_properties(body, namespaces)
    declared = collect_sections(body, namespaces, limits)
    sections = tuple(
        SectionTarget(index=section.index, part_name=main_part, sect_pr=sect_pr)
        for section, sect_pr in zip(declared, sect_prs, strict=True)
    )

    index = DocumentIndex(
        namespaces=namespaces,
        model=result.model,
        elements=elements,
        roots=package.roots,
        sections=sections,
        main_part=main_part,
        styles=result.context.styles,
        numbering_part=(
            relation.part_name
            if (relation := package.relationships_of(main_part).first_of_kind(REL_NUMBERING))
            else None
        ),
    )
    return index, package
