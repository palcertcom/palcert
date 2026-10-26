"""Document metadata (§68, §69).

Core properties carry a title, a subject, keywords — and a creator and a
"last modified by", which are personal data about a named human. They travel
inside the private analysis artifact and are never logged, never used as a
metric label, and never put in an error message (§71).

The extended part also carries Word's own saved statistics: a page count, a
word count, a character count. Those are **hints** and nothing more (§3, §60).
They were true whenever Word last recalculated them, which may be before the
document was edited by something else entirely. PalCert records them under
names that say what they are and computes its own counts separately.
"""

from __future__ import annotations

from xml.etree.ElementTree import Element

from app.docx.model import DocumentMetadata
from app.docx.namespaces import (
    NS_CORE_PROPERTIES,
    NS_DC,
    NS_DCTERMS,
    NS_EXTENDED_PROPERTIES,
)
from app.docx.namespaces import local_name as _local
from app.docx.units import parse_int


def _text(root: Element, namespace: str, name: str) -> str | None:
    element = root.find(f"{{{namespace}}}{name}")
    if element is None or element.text is None:
        return None
    value = element.text.strip()
    return value or None


def parse_core_properties(root: Element | None) -> DocumentMetadata:
    if root is None:
        return DocumentMetadata()
    return DocumentMetadata(
        title=_text(root, NS_DC, "title"),
        subject=_text(root, NS_DC, "subject"),
        creator=_text(root, NS_DC, "creator"),
        keywords=_text(root, NS_CORE_PROPERTIES, "keywords"),
        description=_text(root, NS_DC, "description"),
        language=_text(root, NS_DC, "language"),
        created=_text(root, NS_DCTERMS, "created"),
        modified=_text(root, NS_DCTERMS, "modified"),
        last_modified_by=_text(root, NS_CORE_PROPERTIES, "lastModifiedBy"),
    )


def merge_extended_properties(metadata: DocumentMetadata, root: Element | None) -> DocumentMetadata:
    """Add the application's saved statistics, labelled as what they are."""
    if root is None:
        return metadata

    values: dict[str, str] = {}
    for child in root:
        if child.tag.startswith(f"{{{NS_EXTENDED_PROPERTIES}}}") and child.text:
            values[_local(child.tag)] = child.text.strip()

    return DocumentMetadata(
        title=metadata.title,
        subject=metadata.subject,
        creator=metadata.creator,
        keywords=metadata.keywords,
        description=metadata.description,
        language=metadata.language,
        created=metadata.created,
        modified=metadata.modified,
        last_modified_by=metadata.last_modified_by,
        application_page_count=parse_int(values.get("Pages")),
        application_word_count=parse_int(values.get("Words")),
        application_character_count=parse_int(values.get("Characters")),
        application_name=values.get("Application"),
    )
