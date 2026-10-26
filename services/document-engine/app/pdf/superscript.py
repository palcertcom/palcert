"""Raised numeric citations, read from span geometry (Phase 18, Checkpoint 14).

Vancouver and Nature styles set a citation as a raised numeral: `…contested³`,
`…both³,⁵,⁷`, `…a range⁴⁻⁶`. Checkpoints 10 to 13 could not see any of it,
because every detector they have reads *text* and a raised numeral is plain
digits — indistinguishable, as characters, from an exponent or a footnote
marker.

What distinguishes it is geometry, and PalCert already has it: each span
carries its own font size and its own box. So this module works at span level
rather than line level, which is also where the layout grouper leaves a
superscript — its baseline differs from the running text by far more than the
line tolerance, so it arrives as a line of its own with the digits alone.

**No threshold decides anything here.** A span is raised when its bottom is
strictly above a body span's, small when its size is strictly smaller, and on
the same visual line when their vertical extents overlap. Strict inequalities
and interval overlap — no point distance, no font-size ratio, no tuned gap.
That matters because a tuned number is exactly what would make this detector
quietly wrong on the next document.

Geometry alone is still not enough, and the rest of the module is about that.
A mathematical exponent has the identical shape: `x²` is a smaller digit
raised above a body span. So a raised numeral becomes a citation only when it
**also names a reference entry that exists** in the region serving that part
of the document, and only when the text it is attached to does not read like
a variable. A raised numeral matching nothing is reported as nothing, because
the only reason to read it as a citation in the first place was the reference
it pointed at.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal

from app.pdf.model import PageModel, TextSpan

#: A raised group: digits, optionally several separated by commas or a range
#: dash. `3`, `3,5,7`, `4-6`. Anchored end to end — a raised span carrying
#: anything else is not a citation marker.
_RAISED_GROUP = re.compile("^\\s*\\d{1,4}(?:\\s*[,;\u2013\u2014-]\\s*\\d{1,4})*\\s*$")

#: The last word of the text a marker is attached to. A lone letter reads as a
#: variable, which is what an exponent is attached to.
_TRAILING_TOKEN = re.compile(r"([A-Za-z؀-ۿ]+)\s*$")

#: How far a range may run before it stops being a citation list.
MAX_RANGE_SPAN = 50


@dataclass(frozen=True, slots=True)
class RaisedMarker:
    """One raised numeric span, with the numbers it names."""

    span: TextSpan
    page_index: int
    labels: tuple[int, ...]
    raw: str
    #: The running text this marker sits against, when there is any on its
    #: visual line. Kept so an exponent's variable can be recognized.
    preceding_text: str


def _overlaps(low_a: Decimal, high_a: Decimal, low_b: Decimal, high_b: Decimal) -> bool:
    """Do two closed vertical extents share any point at all?"""
    return low_a <= high_b and low_b <= high_a


def expand_raised(group: str) -> tuple[int, ...] | None:
    """The numbers a raised group names, or None if it is not citation syntax.

    The same shape the bracketed detector accepts, minus the brackets: a
    descending or implausibly wide range is not a range, and every number has
    to be a plausible reference label.
    """
    inner = group.strip()
    if not _RAISED_GROUP.match(inner):
        return None

    numbers: list[int] = []
    for part in re.split(r"\s*[,;]\s*", inner):
        bounds = re.split("\\s*[\u2013\u2014-]\\s*", part.strip())
        if len(bounds) == 1:
            if not bounds[0].isdigit():
                return None
            numbers.append(int(bounds[0]))
        elif len(bounds) == 2 and bounds[0].isdigit() and bounds[1].isdigit():
            low, high = int(bounds[0]), int(bounds[1])
            if low >= high or high - low > MAX_RANGE_SPAN:
                return None
            numbers.extend(range(low, high + 1))
        else:
            return None
    return tuple(numbers) if numbers else None


def _body_spans_on_line(page: PageModel, raised: TextSpan) -> list[TextSpan]:
    """Running text sharing this span's visual line.

    "Sharing a line" is vertical overlap, which needs no tolerance: two boxes
    either share a point of height or they do not. "Running text" is any span
    set larger than this one, which is what makes the smaller one raised
    rather than simply small.
    """
    if raised.font_size is None:
        return []
    return [
        span
        for span in page.spans
        if span.node_id != raised.node_id
        and span.font_size is not None
        and span.font_size > raised.font_size
        and _overlaps(
            raised.display_bbox.top,
            raised.display_bbox.bottom,
            span.display_bbox.top,
            span.display_bbox.bottom,
        )
    ]


def find_raised_markers(page: PageModel) -> list[RaisedMarker]:
    """Every raised numeric span on one page, in reading order.

    Three conditions, all strict and none tuned:

    * the span's text is a numeric group and nothing else;
    * some span on its visual line is set **larger** — so it is small
      relative to running text rather than merely small;
    * its bottom sits strictly **above** that span's — so it is raised.

    The third is what separates a citation from chemical notation: `H₂O` sets
    the 2 *below* the baseline, so it fails here and never reaches the rest of
    the checks.
    """
    markers: list[RaisedMarker] = []
    for span in sorted(page.spans, key=lambda item: (item.display_bbox.left, item.node_id)):
        if span.font_size is None or not _RAISED_GROUP.match(span.text):
            continue
        body = _body_spans_on_line(page, span)
        if not body:
            continue
        raised_above = [
            other for other in body if span.display_bbox.bottom < other.display_bbox.bottom
        ]
        if not raised_above:
            continue

        labels = expand_raised(span.text)
        if labels is None:
            continue

        # The nearest running text to the left, by ordering rather than by
        # distance: whichever qualifying span ends furthest right before this
        # one starts. Used only to read what the marker is attached to.
        before = [
            other for other in raised_above if other.display_bbox.right <= span.display_bbox.left
        ]
        preceding = max(before, key=lambda item: item.display_bbox.right).text if before else ""
        markers.append(
            RaisedMarker(
                span=span,
                page_index=page.page_index,
                labels=labels,
                raw=span.text.strip(),
                preceding_text=preceding,
            )
        )
    return markers


def reads_as_a_variable(preceding_text: str) -> bool:
    """Does the text this marker is attached to end in a lone letter?

    `x²` and `e^n` attach a raised digit to a single-letter variable, and that
    is the one textual signal separating an exponent from a citation set the
    same way. A word does not read as a variable, so `contested³` survives and
    `x²` does not.
    """
    match = _TRAILING_TOKEN.search(preceding_text)
    return match is not None and len(match.group(1)) == 1
