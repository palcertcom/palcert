"""Deterministic structural locators (§24, §25, §26).

A node id must name the same element on every run, on every machine, for ever
— because a Phase 7 finding, a Phase 12 SmartFix edit and a report highlight
will all point at one. Anything derived from a UUID, a database sequence, a
clock or the text content itself fails that test the moment a document is
re-analyzed or edited.

So a node id is a **structural coordinate**: the story it lives in, then the
ordinal path of element kinds from that story's root.

    main/body/p:17              the 17th paragraph child of the body
    main/body/p:17/r:2          its 2nd run
    main/body/tbl:1/tr:3/tc:2/p:1
    header:default:1/p:3        3rd paragraph of the default header of section 1
    footnote:4/p:2
    endnote:4/p:2
    main/body/p:5/r:1/txbx:1/p:1

Ordinals are 1-based and counted **per element kind within the same parent**,
so inserting a table before a paragraph does not renumber the paragraphs.

Node ids are locators, never selectors (§25). Nothing in PalCert evaluates
them as XPath, and nothing accepts one from a client to address a document:
they are parsed only by the code in this module.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from enum import StrEnum

#: The shared Location contract caps nodeId at 200 characters and path at 32
#: segments; staying inside both is the analyzer's responsibility.
MAX_NODE_ID_LENGTH = 200
MAX_PATH_SEGMENTS = 32


class Story(StrEnum):
    """A WordprocessingML story: an independent flow of content (§22)."""

    MAIN_DOCUMENT = "MAIN_DOCUMENT"
    HEADER = "HEADER"
    FOOTER = "FOOTER"
    FOOTNOTE = "FOOTNOTE"
    ENDNOTE = "ENDNOTE"
    TEXTBOX = "TEXTBOX"
    COMMENT = "COMMENT"


#: Element-kind abbreviations used in a path segment. Short on purpose: node
#: ids are stored on every fact, and the 200-character budget is real.
KIND_PARAGRAPH = "p"
KIND_RUN = "r"
KIND_TABLE = "tbl"
KIND_ROW = "tr"
KIND_CELL = "tc"
KIND_TEXTBOX = "txbx"
KIND_DRAWING = "drw"
KIND_EQUATION = "math"
KIND_FIELD = "fld"
KIND_SDT = "sdt"
KIND_HYPERLINK = "hl"


def story_prefix(story: Story, *, key: str = "") -> str:
    """The path segment that opens a story.

    ``key`` distinguishes instances: which header type and section for a
    header, which note id for a note.
    """
    if story is Story.MAIN_DOCUMENT:
        return "main"
    prefix = {
        Story.HEADER: "header",
        Story.FOOTER: "footer",
        Story.FOOTNOTE: "footnote",
        Story.ENDNOTE: "endnote",
        Story.TEXTBOX: "textbox",
        Story.COMMENT: "comment",
    }[story]
    return f"{prefix}:{key}" if key else prefix


@dataclass(slots=True)
class NodePath:
    """An immutable-by-convention path under construction.

    Held as a list of segments so a walker can push and pop while descending,
    and copied whenever an element records its own location.
    """

    segments: list[str] = field(default_factory=list)
    #: Per-parent, per-kind counters. Keyed by the parent's joined path.
    _counters: dict[tuple[str, str], int] = field(default_factory=lambda: defaultdict(int))

    def next_ordinal(self, kind: str) -> int:
        """The next 1-based ordinal for ``kind`` under the current parent."""
        key = ("/".join(self.segments), kind)
        self._counters[key] += 1
        return self._counters[key]

    def push(self, kind: str, ordinal: int | None = None) -> int:
        """Descend into a child of the given kind; returns its ordinal."""
        index = self.next_ordinal(kind) if ordinal is None else ordinal
        self.segments.append(f"{kind}:{index}")
        return index

    def push_literal(self, segment: str) -> None:
        self.segments.append(segment)

    def pop(self) -> None:
        self.segments.pop()

    def snapshot(self) -> tuple[str, ...]:
        return tuple(self.segments)


@dataclass(frozen=True, slots=True)
class NodeLocator:
    """One element's address: its id, its path and the story it belongs to."""

    node_id: str
    path: tuple[str, ...]
    story: Story
    truncated: bool = False

    def to_json(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "nodeId": self.node_id,
            "path": list(self.path),
            "story": str(self.story),
        }
        if self.truncated:
            payload["truncated"] = True
        return payload


def build_locator(story: Story, path: tuple[str, ...]) -> NodeLocator:
    """Join a path into a node id, keeping inside the contract's limits.

    Over-long or over-deep paths are truncated *from the front* — the deepest
    segments are what identify the element, and the story prefix is preserved
    so the result still says where it lives. Truncation is flagged so the
    caller can record a warning rather than pretend the id is complete.
    """
    truncated = False
    segments = list(path)

    if len(segments) > MAX_PATH_SEGMENTS:
        truncated = True
        segments = [segments[0], "…", *segments[-(MAX_PATH_SEGMENTS - 2) :]]

    node_id = "/".join(segments)
    if len(node_id) > MAX_NODE_ID_LENGTH:
        truncated = True
        head = segments[0]
        tail: list[str] = []
        length = len(head) + 2  # head + "/…"
        for segment_text in reversed(segments[1:]):
            if length + len(segment_text) + 1 > MAX_NODE_ID_LENGTH:
                break
            tail.insert(0, segment_text)
            length += len(segment_text) + 1
        segments = [head, "…", *tail]
        node_id = "/".join(segments)

    return NodeLocator(node_id=node_id, path=tuple(segments), story=story, truncated=truncated)
