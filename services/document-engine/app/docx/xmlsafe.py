"""Hardened XML parsing (§18).

Phase 5 proved the ZIP is not a bomb and that the package looks like a DOCX.
It proved nothing whatsoever about the XML inside, and the XML is attacker
controlled. Three classic attacks apply:

* **XXE** — an external entity that reads ``/etc/passwd`` or reaches a URL.
* **Billion laughs** — nested internal entities that expand exponentially.
* **Depth/size explosion** — legal XML that costs more than it looks.

The defence is deliberately blunt: *any* DOCTYPE declaration is refused
outright. OOXML has no legitimate use for one, so refusing the whole
construct removes both entity attacks at once and leaves no corner where a
parser flag might be read differently by a different libexpat. External
entity resolution and parameter-entity parsing are refused as independent
second layers, and depth, element count and byte count are bounded *while*
parsing rather than after it.

``expat`` is driven directly rather than through ``ElementTree.XMLParser``
because the C accelerator hides the underlying parser, and hiding it means no
handler can be installed — the security configuration would silently be the
default one.
"""

from __future__ import annotations

from typing import IO, Any
from xml.etree.ElementTree import Element, TreeBuilder
from xml.parsers import expat

from app.docx.errors import DocxAnalysisError, DocxErrorCode
from app.docx.limits import AnalyzerLimits, ResourceLimitExceededError

#: Bytes fed to the parser per iteration.
_CHUNK_BYTES = 256 * 1024

#: expat reports namespaced names as "uri<sep>local". "}" is the separator
#: ElementTree itself uses, which makes the result one prepended brace away
#: from Clark notation and keeps behaviour identical to the standard library.
_NS_SEPARATOR = "}"


def _clark(name: str) -> str:
    """expat's "uri}local" in ElementTree's "{uri}local" notation."""
    return f"{{{name}" if _NS_SEPARATOR in name else name


class _BoundedBuilder:
    """Builds an ElementTree while counting depth and elements.

    Enforcing depth after the tree exists is pointless: the memory is already
    spent. Counting in the handlers stops a pathological part at the moment it
    becomes pathological.
    """

    __slots__ = ("_builder", "_depth", "_elements", "_limits")

    def __init__(self, limits: AnalyzerLimits) -> None:
        self._limits = limits
        self._builder: TreeBuilder = TreeBuilder()
        self._depth = 0
        self._elements = 0

    def start(self, name: str, attributes: dict[str, str]) -> None:
        self._depth += 1
        self._elements += 1
        if self._depth > self._limits.max_xml_depth:
            raise ResourceLimitExceededError("max_xml_depth", self._limits.max_xml_depth)
        if self._elements > self._limits.max_xml_elements:
            raise ResourceLimitExceededError("max_xml_elements", self._limits.max_xml_elements)
        self._builder.start(_clark(name), {_clark(key): value for key, value in attributes.items()})

    def end(self, name: str) -> None:
        self._depth -= 1
        self._builder.end(_clark(name))

    def data(self, text: str) -> None:
        self._builder.data(text)

    def close(self) -> Element:
        return self._builder.close()


def _reject_doctype(name: str, sysid: str | None, pubid: str | None, internal: bool) -> None:
    raise DocxAnalysisError(
        DocxErrorCode.XML_INVALID, "a DOCTYPE declaration is not permitted in an OOXML part"
    )


def _reject_external_entity(
    context: str | None, base: str | None, sysid: str | None, pubid: str | None
) -> bool:
    raise DocxAnalysisError(
        DocxErrorCode.XML_INVALID, "external entity resolution is not permitted"
    )


def _reject_entity_declaration(*arguments: Any) -> None:
    raise DocxAnalysisError(
        DocxErrorCode.XML_INVALID, "entity declarations are not permitted in an OOXML part"
    )


def _hardened_parser(builder: _BoundedBuilder) -> Any:
    parser = expat.ParserCreate(namespace_separator=_NS_SEPARATOR)
    # Character data arrives whole rather than in fragments, matching what
    # ElementTree does and keeping text handling free of reassembly bugs.
    parser.buffer_text = True
    parser.StartElementHandler = builder.start
    parser.EndElementHandler = builder.end
    parser.CharacterDataHandler = builder.data
    # Refuse the whole DOCTYPE construct: no DTD, therefore no entity
    # declarations, therefore neither XXE nor billion laughs has an entry.
    parser.StartDoctypeDeclHandler = _reject_doctype
    parser.EntityDeclHandler = _reject_entity_declaration
    parser.ExternalEntityRefHandler = _reject_external_entity
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    return parser


def _finish(parser: Any, builder: _BoundedBuilder) -> Element:
    parser.Parse(b"", True)
    root = builder.close()
    if root is None:  # pragma: no cover - expat raises first
        raise DocxAnalysisError(DocxErrorCode.XML_INVALID, "empty part")
    return root


def parse_xml_bytes(data: bytes, limits: AnalyzerLimits | None = None) -> Element:
    """Parse one in-memory XML part under the hardened configuration."""
    effective = limits or AnalyzerLimits.default()
    if len(data) > effective.max_part_bytes:
        raise ResourceLimitExceededError("max_part_bytes", effective.max_part_bytes)

    builder = _BoundedBuilder(effective)
    parser = _hardened_parser(builder)
    try:
        parser.Parse(data, False)
        return _finish(parser, builder)
    except (ResourceLimitExceededError, DocxAnalysisError):
        raise
    except Exception as error:
        raise DocxAnalysisError(DocxErrorCode.XML_INVALID, type(error).__name__) from error


def parse_xml_stream(stream: IO[bytes], limits: AnalyzerLimits | None = None) -> Element:
    """Parse one XML part from a stream, bounded as it is read (§81).

    The part is never held as bytes *and* as a tree: chunks are fed to the
    parser and dropped. The tree is the only lasting cost, and the element
    count bounds that.
    """
    effective = limits or AnalyzerLimits.default()
    builder = _BoundedBuilder(effective)
    parser = _hardened_parser(builder)
    consumed = 0
    try:
        while True:
            chunk = stream.read(_CHUNK_BYTES)
            if not chunk:
                break
            consumed += len(chunk)
            if consumed > effective.max_part_bytes:
                raise ResourceLimitExceededError("max_part_bytes", effective.max_part_bytes)
            parser.Parse(chunk, False)
        return _finish(parser, builder)
    except (ResourceLimitExceededError, DocxAnalysisError):
        raise
    except Exception as error:
        raise DocxAnalysisError(DocxErrorCode.XML_INVALID, type(error).__name__) from error
