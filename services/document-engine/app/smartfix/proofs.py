"""Proving that a correction changed formatting and nothing else.

These are the reason a corrected document may be delivered at all. A plan says
what PalCert intended; a manifest says what it wrote; neither is evidence that
the thesis survived. So four projections of the package are computed the same
way before and after, and the transformation is refused unless all four match:

* **visible text** — every character a reader sees, in document order, across
  every story. This is the invariant that matters: *visible text before equals
  visible text after*. A formatting engine that changes a word has stopped
  being a formatting engine.
* **media** — the images, fonts and embedded objects, by content.
* **field instructions** — the code behind a table of contents or a page
  number. Rewriting one changes what the document will say the next time it is
  opened, which is a content change with a delay on it.
* **relationships** — what every part points at. A dropped relationship turns
  an image into a red X long after anyone would connect it to a font fix.

Every projection is a digest. None of them carries document text anywhere it
could be logged or stored: the hash is the evidence, and the text that produced
it is discarded.
"""

from __future__ import annotations

import hashlib
import posixpath
import zipfile
from dataclasses import dataclass
from xml.etree.ElementTree import Element

from app.docx.limits import AnalyzerLimits
from app.docx.namespaces import NS_PACKAGE_RELATIONSHIPS
from app.docx.xmlsafe import parse_xml_bytes

#: Parts that are XML by extension. Everything else is treated as media: its
#: bytes are hashed rather than parsed, which is both safer and the point.
_XML_SUFFIXES = (".xml", ".rels")


@dataclass(frozen=True, slots=True)
class PackageProjection:
    """Four digests over one package."""

    visible_text: str
    media_set: str
    field_instructions: str
    relationships: str


def _local(tag: str) -> str:
    return tag.rpartition("}")[2]


def _is_xml(name: str) -> bool:
    return name.lower().endswith(_XML_SUFFIXES)


def _visible_text_of(root: Element) -> list[str]:
    """Every ``w:t`` in document order.

    ``w:delText`` is a different element, so deleted text is excluded without
    a special case — which is correct: a reader does not see it. ``w:instrText``
    is excluded for the same reason and proven separately.
    """
    pieces: list[str] = []
    for element in root.iter():
        if _local(element.tag) == "t":
            pieces.append(element.text or "")
    return pieces


def _field_instructions_of(root: Element) -> list[str]:
    pieces: list[str] = []
    for element in root.iter():
        name = _local(element.tag)
        if name == "instrText":
            pieces.append(element.text or "")
        elif name == "fldSimple":
            for key, value in element.attrib.items():
                if _local(key) == "instr":
                    pieces.append(value)
    return pieces


def _relationships_of(root: Element) -> list[str]:
    expected = f"{{{NS_PACKAGE_RELATIONSHIPS}}}Relationship"
    rows: list[str] = []
    for child in root:
        if child.tag != expected:
            continue
        rows.append(
            "\x1f".join(
                (
                    child.get("Id") or "",
                    child.get("Type") or "",
                    child.get("Target") or "",
                    child.get("TargetMode") or "Internal",
                )
            )
        )
    # Sorted, because relationship order in the file is not meaningful and a
    # reordering is not a change the user needs to be told about.
    return sorted(rows)


def project(archive: zipfile.ZipFile, limits: AnalyzerLimits | None = None) -> PackageProjection:
    """The four digests of one package.

    Parts are visited in sorted name order so the projection depends on the
    package's content and not on the order a ZIP happens to list its entries.
    """
    effective = limits or AnalyzerLimits.default()

    text = hashlib.sha256()
    media = hashlib.sha256()
    instructions = hashlib.sha256()
    relationships = hashlib.sha256()

    for name in sorted(archive.namelist()):
        if name.endswith("/"):
            continue
        data = archive.read(name)
        if not _is_xml(name):
            media.update(name.encode("utf-8"))
            media.update(b"\x1f")
            media.update(hashlib.sha256(data).digest())
            continue

        try:
            root = parse_xml_bytes(data, effective)
        except Exception:
            # A part PalCert cannot read is still evidence: hashing its bytes
            # means an edit to it would be caught, which is the property this
            # projection exists to provide.
            media.update(name.encode("utf-8"))
            media.update(b"\x1f")
            media.update(hashlib.sha256(data).digest())
            continue

        if posixpath.basename(posixpath.dirname(name)) == "_rels":
            relationships.update(name.encode("utf-8"))
            relationships.update(b"\x1f")
            for row in _relationships_of(root):
                relationships.update(row.encode("utf-8"))
                relationships.update(b"\x1e")
            continue

        text.update(name.encode("utf-8"))
        text.update(b"\x1f")
        for piece in _visible_text_of(root):
            text.update(piece.encode("utf-8"))
            text.update(b"\x1e")

        instructions.update(name.encode("utf-8"))
        instructions.update(b"\x1f")
        for piece in _field_instructions_of(root):
            instructions.update(piece.encode("utf-8"))
            instructions.update(b"\x1e")

    return PackageProjection(
        visible_text=text.hexdigest(),
        media_set=media.hexdigest(),
        field_instructions=instructions.hexdigest(),
        relationships=relationships.hexdigest(),
    )
