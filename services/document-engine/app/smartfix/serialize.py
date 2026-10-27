"""Writing an edited package back out, changing as little as possible.

Two properties matter here and neither is automatic.

**Untouched parts stay byte-identical.** Every entry PalCert did not edit is
copied across verbatim, with its original compression and its original ZIP
metadata. A document is a legal record of somebody's work; re-encoding the
half of it nobody asked about would make the diff meaningless and could
quietly drop something the analyzer never modelled.

**The output is deterministic.** No wall-clock timestamp reaches the archive:
each entry keeps the modification time it already had, so running SmartFix
twice over the same source with the same plan produces the same bytes. A
mutation engine whose output depends on when it ran cannot be tested for
idempotency, and cannot be reasoned about after the fact.

Serializing a part back to XML is where the real risk lives. ElementTree
stores tags as ``{namespace}local`` and invents prefixes (``ns0``) on output,
which would be harmless if OOXML did not also put prefixes inside *attribute
values* — ``mc:Ignorable="w14 wp14"`` names them. So the original root start
tag, with its exact namespace declarations, is put back verbatim and only the
element content is regenerated.
"""

from __future__ import annotations

import io
import re
import threading
import zipfile
from xml.etree import ElementTree as ET
from xml.etree.ElementTree import Element, tostring

#: Matches the root element's start tag, including any attributes, in a part
#: whose prologue may carry a declaration, comments or processing
#: instructions. Deliberately conservative: anything it does not recognise
#: leaves the part untouched rather than half-rewritten.
_ROOT_START = re.compile(rb"<([A-Za-z_][-\w.:]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*?)(/?)>", re.S)

_XMLNS = re.compile(rb"""xmlns(?::([A-Za-z_][-\w.]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')""")

XML_DECLARATION = b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
_NAMESPACE_LOCK = threading.RLock()


class PartSerializationError(ValueError):
    """A part could not be rewritten without risking its meaning."""


def _root_start_tag(data: bytes) -> tuple[int, int, bytes]:
    """The byte range and text of the root element's start tag.

    The prologue is skipped explicitly — declaration, comments, processing
    instructions and any DOCTYPE — rather than by pattern, so a ``<w:p>``
    written inside a comment can never be mistaken for the root.
    """
    position = 0
    length = len(data)
    while position < length:
        if data[position : position + 1].isspace():
            position += 1
            continue
        if data.startswith(b"<?", position):
            closing = data.find(b"?>", position)
            if closing < 0:
                raise PartSerializationError("an unterminated processing instruction")
            position = closing + 2
            continue
        if data.startswith(b"<!--", position):
            closing = data.find(b"-->", position)
            if closing < 0:
                raise PartSerializationError("an unterminated comment")
            position = closing + 3
            continue
        if data.startswith(b"<!", position):
            # Phase 6 refuses a part with a DOCTYPE long before this point;
            # refusing again here keeps the rule local to the code that would
            # otherwise have to interpret one.
            raise PartSerializationError("a declaration PalCert does not rewrite")
        if data.startswith(b"<", position):
            match = _ROOT_START.match(data, position)
            if match is None:
                raise PartSerializationError("the root element could not be read")
            return match.start(), match.end(), match.group(0)
        raise PartSerializationError("content before the root element")
    raise PartSerializationError("the part has no element to rewrite")


def _declared_namespaces(start_tag: bytes) -> dict[str, str]:
    """Namespace declarations on the root, as prefix → URI (``""`` default)."""
    declared: dict[str, str] = {}
    for match in _XMLNS.finditer(start_tag):
        prefix = (match.group(1) or b"").decode("utf-8")
        uri = (match.group(2) if match.group(2) is not None else match.group(3) or b"").decode(
            "utf-8"
        )
        declared[prefix] = uri
    return declared


def serialize_part(original: bytes, root: Element) -> bytes:
    """Re-serialize one edited XML part, preserving its namespace prologue.

    The root's own start tag is copied from the source rather than
    regenerated, because it carries the document's prefix bindings and
    ``mc:Ignorable`` names those prefixes in an attribute *value* — a renamed
    prefix would leave the file referring to a namespace it no longer
    declares. Any namespace ElementTree needed that the original root did not
    declare is appended to that tag, so nothing ends up undeclared either.
    """
    start, _, original_start = _root_start_tag(original)
    declared = _declared_namespaces(original_start)

    # QName-valued attributes (Requires, Ignorable) may use declarations from
    # nested elements too. Hoist unambiguous bindings and preserve their names.
    bindings = dict(declared)
    # _root_start_tag above refuses every DOCTYPE; the package parser has also
    # enforced XML resource limits before this serialization boundary.
    for _, (prefix, uri) in ET.iterparse(io.BytesIO(original), events=("start-ns",)):  # noqa: S314
        if prefix == "" and prefix not in declared and uri:
            raise PartSerializationError("a nested default namespace cannot be hoisted")
        if prefix in bindings and bindings[prefix] != uri:
            raise PartSerializationError("a namespace prefix is rebound in this part")
        bindings[prefix] = uri
    with _NAMESPACE_LOCK:
        for prefix, uri in bindings.items():
            chosen = prefix
            if re.fullmatch(r"ns\d+", chosen):
                # ElementTree reserves nsN. Keep its original declaration for
                # attribute values while writing element names with a fresh one.
                chosen = "palcert_" + chosen
                while chosen in bindings:
                    chosen += "_"
            if chosen or prefix in declared:
                ET.register_namespace(chosen, uri)
        produced: bytes = tostring(root, encoding="utf-8", xml_declaration=False)
    _, produced_end, produced_tag = _root_start_tag(produced)

    missing = {
        prefix: uri
        for prefix, uri in {**bindings, **_declared_namespaces(produced_tag)}.items()
        if declared.get(prefix) != uri
    }
    replacement = original_start
    if missing:
        # Appended, never substituted: the original declarations are what the
        # rest of the document's attribute values refer to.
        extra = "".join(
            f' xmlns{":" + prefix if prefix else ""}="{uri}"'
            for prefix, uri in sorted(missing.items())
        ).encode("utf-8")
        closing = b"/>" if replacement.endswith(b"/>") else b">"
        replacement = replacement[: -len(closing)] + extra + closing

    body = produced[produced_end:]
    original_match, produced_match = (
        _ROOT_START.match(original_start),
        _ROOT_START.match(produced_tag),
    )
    if original_match is None or produced_match is None:
        raise PartSerializationError("the root name could not be preserved")
    original_name, produced_name = original_match.group(1), produced_match.group(1)
    if produced_name != original_name and body.endswith(b"</" + produced_name + b">"):
        body = body[: -len(produced_name) - 3] + b"</" + original_name + b">"
    prologue = original[:start]
    if not prologue.strip():
        prologue = XML_DECLARATION
    return prologue + replacement + body


def rewrite_package(
    source: zipfile.ZipFile,
    replacements: dict[str, bytes],
) -> bytes:
    """A new package with some parts replaced and everything else copied.

    Entry order, compression method and modification times are taken from the
    source, so the output differs from the input in exactly the parts that
    were edited — and differs not at all when nothing was.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as target:
        for info in source.infolist():
            data = replacements.get(info.filename)
            if data is None:
                data = source.read(info.filename)
            # A fresh ZipInfo copying the original's metadata: reusing the
            # source's object would carry its header offsets into a different
            # archive.
            entry = zipfile.ZipInfo(filename=info.filename, date_time=info.date_time)
            entry.compress_type = info.compress_type
            entry.external_attr = info.external_attr
            entry.internal_attr = info.internal_attr
            entry.create_system = info.create_system
            target.writestr(entry, data)
    return buffer.getvalue()
