"""Link annotations whose destination names a declared reference entry.

The one exact relationship Checkpoint 6 found and could not record: a PDF
``/Link`` annotation over a citation, carrying a ``/GoTo`` action whose
destination lands on the bibliography entry the citation refers to. It is
machine-readable, it is the author's own declaration, and Checkpoint 7 gives
it a link method of its own rather than filing it under one that would say
something false about how the target was established.

Both ends are resolved exactly, and neither end is resolved by proximity:

* the **source** is the citation the structure tree says the annotation
  belongs to. An annotation names its owning structure element through
  ``/StructParent`` and the parent tree (ISO 32000-2 14.7.4.4), and that
  element must be, or must contain, exactly one declared ``/Reference``. An
  annotation with no ``/StructParent`` is not consumed at all: there is no
  second way to find out whose it is that does not amount to guessing from
  where it sits on the page.
* the **destination** is resolved through the PDF's own machinery — a
  structure destination when the file gives one, otherwise an explicit
  destination array, resolved through the name tree when it is named. The
  target must land inside the extent of a declared ``/BibEntry``. Nothing
  here looks for the nearest entry, the nearest heading or the likeliest
  block: a destination landing on no declared entry is UNRESOLVED and one
  landing on several is AMBIGUOUS.
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import pikepdf

from app.pdf.tags import CITATION_ROLES, MAX_STRUCTURE_DEPTH, StructureTree

#: Annotations read at all. A /Link is the only annotation that carries an
#: internal destination to somewhere else in the same document.
LINK_SUBTYPE = "/Link"

#: A document with more link annotations than this is not read further; the
#: analyzer already bounds every other walk the same way.
MAX_LINK_ANNOTATIONS = 50_000


@dataclass(frozen=True, slots=True)
class InternalDestinationLink:
    """One annotation, with both ends resolved exactly or not at all."""

    #: Index into the structure tree's declared citation elements.
    citation_element_index: int
    #: The page the destination lands on, or None when it did not resolve.
    target_page_index: int | None
    #: The destination point in PDF user space, or None for a structure
    #: destination, which names an element rather than a place.
    target_point: tuple[Decimal, Decimal] | None
    #: The declared element a structure destination named, when it gave one.
    target_element_index: int | None


def _structure_element_for_annotation(annotation: Any, structure: StructureTree) -> Any | None:
    """The structure element that owns this annotation, or None.

    ``/StructParent`` is an integer key into the parent tree whose value is
    the element referring to the annotation. That is an identity the author
    wrote, which is the only reason this is allowed to decide whose citation
    an annotation belongs to.
    """
    key = None
    with contextlib.suppress(Exception):
        if "/StructParent" in annotation:
            key = int(annotation["/StructParent"])
    if key is None:
        return None
    entry = structure.parent_tree.get(key)
    if entry is None:
        return None
    # The parent tree's value is an element for an annotation, or an array of
    # them for marked content. An array here is not this annotation's owner.
    if isinstance(entry, pikepdf.Dictionary):
        return entry
    return None


def _declared_citations_under(node: Any, structure: StructureTree, depth: int = 0) -> list[int]:
    """Every declared citation in this element's subtree, itself included."""
    found: list[int] = []
    if node is None or depth > MAX_STRUCTURE_DEPTH:
        return found
    with contextlib.suppress(Exception):
        index = structure.citation_by_objgen.get(node.objgen)
        if index is not None and structure.citation_elements[index]["kind"] == "CITATION":
            found.append(index)
    kids = None
    with contextlib.suppress(Exception):
        kids = node.get("/K")
    if kids is None:
        return found
    children = kids if isinstance(kids, pikepdf.Array) else [kids]
    for child in children:
        if isinstance(child, pikepdf.Dictionary) and "/S" in child:
            found.extend(_declared_citations_under(child, structure, depth + 1))
    return found


def _named_destination(pdf: pikepdf.Pdf, name: Any) -> Any | None:
    """A named destination, through /Dests or the /Names name tree."""
    key = str(name)
    bare = key.lstrip("/")
    with contextlib.suppress(Exception):
        dests = pdf.Root.get("/Dests")
        if dests is not None and key in dests:
            return dests[key]
    with contextlib.suppress(Exception):
        names = pdf.Root.get("/Names")
        if names is not None:
            tree = names.get("/Dests")
            if tree is not None:
                found = _walk_name_tree(tree, bare)
                if found is not None:
                    return found
    return None


def _walk_name_tree(node: Any, target: str, depth: int = 0) -> Any | None:
    if node is None or depth > MAX_STRUCTURE_DEPTH:
        return None
    with contextlib.suppress(Exception):
        names = node.get("/Names")
        if names is not None:
            entries = list(names)
            for index in range(0, len(entries) - 1, 2):
                if str(entries[index]).strip("()/") == target:
                    return entries[index + 1]
    with contextlib.suppress(Exception):
        kids = node.get("/Kids")
        if kids is not None:
            for kid in kids:
                found = _walk_name_tree(kid, target, depth + 1)
                if found is not None:
                    return found
    return None


def _resolve_destination(
    pdf: pikepdf.Pdf,
    annotation: Any,
    structure: StructureTree,
    page_index_by_objgen: dict[Any, int],
) -> tuple[int | None, tuple[Decimal, Decimal] | None, int | None]:
    """``(page index, point, declared element index)`` for one annotation."""
    action = None
    destination = None
    with contextlib.suppress(Exception):
        action = annotation.get("/A")
    with contextlib.suppress(Exception):
        if "/Dest" in annotation:
            destination = annotation["/Dest"]

    if action is not None:
        with contextlib.suppress(Exception):
            if "/S" not in action or str(action["/S"]) != "/GoTo":
                return None, None, None
        # A structure destination names an element outright, which is the
        # exact form: no coordinates and nothing to fall inside of.
        with contextlib.suppress(Exception):
            structure_destination = action.get("/SD")
            if structure_destination is not None:
                index = _element_index_of(structure_destination, structure)
                if index is not None:
                    element = structure.citation_elements[index]
                    return int(element["pageIndex"]), None, index
        with contextlib.suppress(Exception):
            if destination is None and "/D" in action:
                destination = action["/D"]

    if destination is None:
        return None, None, None
    if isinstance(destination, (pikepdf.Name, pikepdf.String, str)):
        destination = _named_destination(pdf, destination)
    if destination is None:
        return None, None, None

    with contextlib.suppress(Exception):
        entries = list(destination)
        if not entries:
            return None, None, None
        page_index = page_index_by_objgen.get(entries[0].objgen)
        if page_index is None:
            return None, None, None
        point = _explicit_point(entries)
        return page_index, point, None
    return None, None, None


def _element_index_of(structure_destination: Any, structure: StructureTree) -> int | None:
    """The declared element a structure destination names, if it names one."""
    node = structure_destination
    with contextlib.suppress(Exception):
        if isinstance(structure_destination, pikepdf.Array) and len(structure_destination) > 0:
            node = structure_destination[0]
    with contextlib.suppress(Exception):
        return structure.citation_by_objgen.get(node.objgen)
    return None


def _explicit_point(entries: list[Any]) -> tuple[Decimal, Decimal] | None:
    """The point an explicit destination names, for the forms that name one.

    ``/XYZ left top zoom`` and ``/FitH top`` are the destination types that
    state where on the page they land. ``/Fit`` and friends name the whole
    page and therefore land on no particular entry, which is not a failure to
    read them — it is the destination not saying.
    """
    with contextlib.suppress(Exception):
        kind = str(entries[1]) if len(entries) > 1 else ""
        if kind == "/XYZ" and len(entries) >= 4:
            left, top = entries[2], entries[3]
            if left is None or top is None:
                return None
            return Decimal(str(left)), Decimal(str(top))
    return None


def read_internal_destination_links(
    pdf: pikepdf.Pdf, structure: StructureTree
) -> list[InternalDestinationLink]:
    """Every /Link annotation whose source binds exactly to a declared citation.

    An annotation is dropped, silently and deliberately, when it has no
    ``/StructParent``, when its owning element contains no declared citation,
    or when it contains more than one: choosing between two citations because
    one of them is closer to the annotation's rectangle is exactly the
    guessing this refuses to do.
    """
    if not structure.present or not structure.citation_elements:
        return []

    page_index_by_objgen: dict[Any, int] = {}
    for index, page in enumerate(pdf.pages):
        with contextlib.suppress(Exception):
            page_index_by_objgen[page.obj.objgen] = index

    links: list[InternalDestinationLink] = []
    seen = 0
    for page in pdf.pages:
        annotations = None
        with contextlib.suppress(Exception):
            annotations = page.get("/Annots")
        if annotations is None:
            continue
        for annotation in annotations:
            if seen >= MAX_LINK_ANNOTATIONS:
                return links
            seen += 1
            try:
                if str(annotation.get("/Subtype", "")) != LINK_SUBTYPE:
                    continue
                owner = _structure_element_for_annotation(annotation, structure)
                if owner is None:
                    continue
                citations = _declared_citations_under(owner, structure)
                if len(citations) != 1:
                    # Zero means the annotation belongs to no declared
                    # citation; more than one means PalCert would have to pick.
                    continue
                target_page, point, element_index = _resolve_destination(
                    pdf, annotation, structure, page_index_by_objgen
                )
                links.append(
                    InternalDestinationLink(
                        citation_element_index=citations[0],
                        target_page_index=target_page,
                        target_point=point,
                        target_element_index=element_index,
                    )
                )
            except Exception:  # noqa: S112 - one unreadable annotation must not lose the rest
                continue

    links.sort(key=lambda link: link.citation_element_index)
    return links


def declared_citation_roles() -> dict[str, str]:
    """Re-exported so a reader can see this module reads only declared roles."""
    return dict(CITATION_ROLES)
