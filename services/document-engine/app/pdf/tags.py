"""The tagged-PDF structure tree, and what it is allowed to prove (§33-§37).

A tagged PDF carries an author-declared logical structure: this run of content
is a heading, that one is a table cell, this is a figure. That is real semantic
evidence and PalCert uses it.

An untagged PDF carries no such thing, and this module will not invent one. A
line that is large, bold and centred is a line that is large, bold and centred;
calling it a heading would be PalCert asserting something the document never
said, and a standard that requires "Heading 1 is 16pt bold" would then be
checked against PalCert's own guess rather than against the document (§35).
The same refusal applies to tables drawn with ruling lines (§36) and to image
objects that happen to sit under a caption (§37).

The mapping below is the standard structure namespace of ISO 32000-2 14.8.4.
Roles outside it are recorded verbatim but map to nothing, so a custom role
never becomes a PalCert element type by accident.
"""

from __future__ import annotations

import contextlib
from typing import Any

import pikepdf

#: Standard structure types to PalCert element types. Only these transfer.
ROLE_TO_ELEMENT: dict[str, str] = {
    "/H1": "HEADING",
    "/H2": "HEADING",
    "/H3": "HEADING",
    "/H4": "HEADING",
    "/H5": "HEADING",
    "/H6": "HEADING",
    "/H": "HEADING",
    "/P": "PARAGRAPH",
    "/Table": "TABLE",
    "/TR": "TABLE",
    "/TH": "TABLE",
    "/TD": "TABLE",
    "/Figure": "FIGURE",
    "/Caption": "CAPTION",
    "/L": "LIST",
    "/LI": "LIST",
    "/Lbl": "LIST",
    "/LBody": "LIST",
    "/Note": "FOOTNOTE",
}

#: Structure roles that identify citation evidence (ISO 32000-2 14.8.4.3).
#:
#: Deliberately *not* in ROLE_TO_ELEMENT. A /Reference is not a paragraph, a
#: heading or any other PalCert element type, and adding it there would change
#: what the analyzer emits facts about. These roles are collected separately,
#: for citation evidence only.
#:
#: What they mean is the standard's own definition: /Reference is "a citation
#: to content elsewhere in the document", and /BibEntry is "a reference
#: identifying the external source of some cited content". That is an
#: author's declaration, not PalCert's reading of the page — which is the only
#: reason a PDF can carry citation evidence at all.
CITATION_ROLES: dict[str, str] = {
    "/Reference": "CITATION",
    "/BibEntry": "REFERENCE_ENTRY",
}

#: The role that carries an author-declared label, e.g. the "[12]" of a
#: numbered reference list (ISO 32000-2 14.8.4.3.3).
LABEL_ROLE = "/Lbl"

#: The list-item role a labelled bibliography entry conventionally sits in.
LIST_ITEM_ROLE = "/LI"

#: Heading levels, so a rule about "Heading 2" can select one.
ROLE_TO_LEVEL: dict[str, int] = {f"/H{n}": n for n in range(1, 7)}

#: A structure tree deeper than this is malformed or hostile; the walk stops
#: and the document is reported as partially tagged rather than followed.
MAX_STRUCTURE_DEPTH = 64
MAX_STRUCTURE_NODES = 200_000


class StructureTree:
    """What the structure tree says, flattened into something usable.

    ``elements`` is the ordered list of (role, element type, level, page index)
    the tree declares. ``order_by_page`` is the author-declared reading order
    per page, which takes priority over any geometric ordering PalCert could
    compute (§33).
    """

    def __init__(self) -> None:
        self.elements: list[dict[str, Any]] = []
        self.order_by_page: dict[int, list[int]] = {}
        #: page index -> marked-content id -> PalCert element type. Populated
        #: only from /K entries the author wrote, and only for roles in the
        #: standard namespace, so nothing PalCert invented can reach it (§34).
        self.roles_by_mcid: dict[int, dict[int, str]] = {}
        self.levels_by_mcid: dict[int, dict[int, int]] = {}
        #: Author-declared citation evidence, in document order. Each entry
        #: carries the marked-content ids of the element itself and of the
        #: label that identifies it, so the analyzer can bind both to text.
        self.citation_elements: list[dict[str, Any]] = []
        #: Structure element object id -> index into ``citation_elements``.
        #: An annotation names its owning structure element through
        #: /StructParent and the parent tree; this is what turns that element
        #: back into a citation PalCert already declared.
        self.citation_by_objgen: dict[Any, int] = {}
        #: The raw /ParentTree number tree, for that same lookup.
        self.parent_tree: dict[int, Any] = {}
        self.truncated = False
        self.present = False

    @property
    def roles(self) -> tuple[str, ...]:
        return tuple(e["role"] for e in self.elements)

    def counts(self) -> dict[str, int]:
        """How many of each element type the author declared."""
        totals: dict[str, int] = {}
        for element in self.elements:
            kind = element["elementType"]
            if kind is not None:
                totals[kind] = totals.get(kind, 0) + 1
        return totals

    def as_json(self) -> dict[str, object]:
        return {
            "present": self.present,
            "truncated": self.truncated,
            "elements": self.elements,
            "counts": self.counts(),
        }


def _marked_content_ids(node: Any) -> tuple[int, ...]:
    """The marked-content ids this element claims, from its /K entry.

    /K is either an integer (a marked-content id on the element's own page), a
    dictionary that may be an /MCR pointing at one, or an array mixing those
    with child elements (ISO 32000-2 14.7.4.2). Child elements are walked
    separately and are deliberately not collected here: a section's role must
    not be stamped onto the paragraphs inside it.
    """
    ids: list[int] = []
    kids: Any = None
    with contextlib.suppress(Exception):
        kids = node.get("/K")
    if kids is None:
        return ()
    children = kids if isinstance(kids, pikepdf.Array) else [kids]
    for child in children:
        with contextlib.suppress(Exception):
            if isinstance(child, int) or (isinstance(child, pikepdf.Object) and child.is_integer):
                ids.append(int(child))
            elif isinstance(child, pikepdf.Dictionary) and "/MCID" in child and "/S" not in child:
                ids.append(int(child["/MCID"]))
    return tuple(sorted(set(ids)))


def _label_marked_content_ids(node: Any, parent: Any) -> tuple[int, ...]:
    """The marked content of the label that names this element, or ``()``.

    Two shapes, both of them the author's own declaration:

    * a ``/Lbl`` child of the element itself;
    * a ``/Lbl`` child of the ``/LI`` the element sits in, which is how a
      numbered reference list is conventionally tagged.

    Nothing else counts. A label PalCert found by reading the text next to an
    entry would be PalCert's guess about which number belongs to which
    reference, and a wrong guess links a citation to the wrong work.
    """
    for candidate in (node, parent):
        if candidate is None:
            continue
        if candidate is parent:
            role = None
            with contextlib.suppress(Exception):
                role = str(candidate["/S"]) if "/S" in candidate else None
            if role != LIST_ITEM_ROLE:
                continue
        kids: Any = None
        with contextlib.suppress(Exception):
            kids = candidate.get("/K")
        if kids is None:
            continue
        children = kids if isinstance(kids, pikepdf.Array) else [kids]
        for child in children:
            if not isinstance(child, pikepdf.Dictionary):
                continue
            with contextlib.suppress(Exception):
                if "/S" in child and str(child["/S"]) == LABEL_ROLE:
                    found = _marked_content_ids(child)
                    if found:
                        return found
    return ()


def _page_index_map(pdf: pikepdf.Pdf) -> dict[Any, int]:
    mapping: dict[Any, int] = {}
    for index, page in enumerate(pdf.pages):
        with contextlib.suppress(Exception):
            mapping[page.obj.objgen] = index
    return mapping


#: A parent tree deeper or wider than this is malformed; the lookup stops.
MAX_NUMBER_TREE_NODES = 100_000


def _read_number_tree(node: Any, depth: int = 0) -> dict[int, Any]:
    """The /ParentTree as a plain mapping, bounded.

    A number tree is either a leaf holding /Nums or a branch holding /Kids
    (ISO 32000-2 7.9.7). Walked rather than assumed to be a single leaf,
    because a document with many pages legitimately has a branching one.
    """
    found: dict[int, Any] = {}
    if node is None or depth > MAX_STRUCTURE_DEPTH or len(found) > MAX_NUMBER_TREE_NODES:
        return found
    with contextlib.suppress(Exception):
        nums = node.get("/Nums")
        if nums is not None:
            entries = list(nums)
            for index in range(0, len(entries) - 1, 2):
                key = entries[index]
                if isinstance(key, int) or (isinstance(key, pikepdf.Object) and key.is_integer):
                    found[int(key)] = entries[index + 1]
    with contextlib.suppress(Exception):
        kids = node.get("/Kids")
        if kids is not None:
            for kid in kids:
                if isinstance(kid, pikepdf.Dictionary):
                    found.update(_read_number_tree(kid, depth + 1))
    return found


def read_structure(pdf: pikepdf.Pdf) -> StructureTree:
    """Walk the structure tree, bounded, recording roles in document order."""
    tree = StructureTree()
    try:
        root = pdf.Root.get("/StructTreeRoot")
    except Exception:  # a malformed catalog is data, not a crash
        return tree
    if root is None:
        return tree
    tree.present = True

    pages = _page_index_map(pdf)
    with contextlib.suppress(Exception):
        tree.parent_tree = _read_number_tree(root.get("/ParentTree"))
    seen = 0

    def walk(node: Any, depth: int, page_hint: int | None, parent: Any = None) -> None:
        nonlocal seen
        if depth > MAX_STRUCTURE_DEPTH or seen > MAX_STRUCTURE_NODES:
            tree.truncated = True
            return
        seen += 1
        role = None
        page_index = page_hint
        with contextlib.suppress(Exception):
            if "/S" in node:
                role = str(node["/S"])
            if "/Pg" in node:
                page_index = pages.get(node["/Pg"].objgen, page_hint)
        if role is not None:
            element_type = ROLE_TO_ELEMENT.get(role)
            tree.elements.append(
                {
                    "role": role,
                    "elementType": element_type,
                    "level": ROLE_TO_LEVEL.get(role),
                    "pageIndex": page_index,
                    "order": len(tree.elements),
                }
            )
            if role in CITATION_ROLES and page_index is not None:
                mcids = _marked_content_ids(node)
                if mcids:
                    tree.citation_elements.append(
                        {
                            "role": role,
                            "kind": CITATION_ROLES[role],
                            "pageIndex": page_index,
                            "mcids": mcids,
                            "labelMcids": _label_marked_content_ids(node, parent),
                            "order": len(tree.citation_elements),
                        }
                    )
                    with contextlib.suppress(Exception):
                        tree.citation_by_objgen[node.objgen] = len(tree.citation_elements) - 1
            if page_index is not None:
                tree.order_by_page.setdefault(page_index, []).append(len(tree.elements) - 1)
                if element_type is not None:
                    for mcid in _marked_content_ids(node):
                        tree.roles_by_mcid.setdefault(page_index, {})[mcid] = element_type
                        level = ROLE_TO_LEVEL.get(role)
                        if level is not None:
                            tree.levels_by_mcid.setdefault(page_index, {})[mcid] = level
        kids = None
        with contextlib.suppress(Exception):
            kids = node.get("/K")
        if kids is None:
            return
        children = kids if isinstance(kids, pikepdf.Array) else [kids]
        for child in children:
            if not isinstance(child, pikepdf.Dictionary):
                continue
            walk(child, depth + 1, page_index, node)

    with contextlib.suppress(Exception):
        top = root.get("/K")
        if top is not None:
            children = top if isinstance(top, pikepdf.Array) else [top]
            for child in children:
                if isinstance(child, pikepdf.Dictionary):
                    walk(child, 1, None, None)
    return tree
