"""Conservative numeric-style citation discovery for untagged PDFs (Checkpoint 10).

Checkpoints 6 to 9 read only what the author *declared*: ``/Reference``,
``/BibEntry``, ``/Lbl``, link annotations with internal destinations. That is
exact evidence, and most real PDFs carry none of it — a thesis exported from
Word arrives with a perfect reference list and no structure tree at all, and
PalCert could see nothing in it.

This module recovers some of that, and the whole design is about how little it
claims. Everything here is ``sourceKind: HEURISTIC``, everything carries a
``confidence``, and none of it is projected into a fact. It is PalCert
classifying rather than reading, and the artifact says so on every object.

Three rules shape it.

**Narrow before clever.** One citation family: a bracketed numeric marker,
``[12]``, ``[3, 7, 11]``, ``[4-6]``. No author-year, no fuzzy matching, no
similarity, no model. A form PalCert cannot normalize deterministically is a
form it does not recognize, not a form it guesses at.

**No single signal is proof.** A line reading "References" is a heading
vocabulary match and nothing more — a paper *about* bibliographies has that
word in its prose. A region is accepted only when heading vocabulary and
numbered-entry structure both hold, and the confidence is the sum of the
signals that did.

**Exact evidence outranks it everywhere.** A heuristic observation whose spans
are already claimed by a declared element is dropped rather than merged: two
objects for one citation is worse than one, and an exact object quietly
acquiring heuristic provenance is worse than both. The overlap test is span
node identity, never textual similarity.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from itertools import pairwise

from app.pdf.author_year import (
    AuthorShape,
    AuthorYearCitation,
    find_citations,
    normalize_surname,
    parse_entry,
    year_is_plausible,
)
from app.pdf.author_year import (
    is_never_an_author as _rejected_author,
)
from app.pdf.bibliography import Identifier, parse_entry_text
from app.pdf.model import BBox, PageModel, PdfStructuralModel, TextLayer
from app.pdf.superscript import find_raised_markers, reads_as_a_variable

#: Bounds, so a pathological document cannot turn discovery into a denial of
#: service. Deliberately below the artifact's own limits.
#: Mirrors the artifact's own reference text bound, so every parsed field
#: lands inside the `rawText` a reader can check it against.
MAX_REFERENCE_TEXT_CHARS = 1_200
MAX_HEURISTIC_REFERENCES = 2_000
MAX_HEURISTIC_CITATIONS = 10_000
MAX_REGION_LINES = 6_000
#: A label above this is not a reference number. It also removes every
#: four-digit year from consideration without a rule that mentions years.
MAX_LABEL = 999
#: How many reference regions one document may carry. A bound, not a rule:
#: a document with more lists than this has something stranger going on than
#: per-chapter bibliographies.
MAX_REFERENCE_REGIONS = 64

#: How many entry openings a region must show before it is a region at all.
#: The same bar for both families: a heading with two lines under it is not a
#: reference list in either shape.
MIN_ENTRIES = 3

#: Headings that *may* introduce a reference region, normalized and compared
#: whole. A closed list: "another configured heading" is a configuration
#: change, not a pattern that grows on its own.
#:
#: Arabic is here from the start rather than as a later widening — a heading
#: vocabulary that only knows English would make every Arabic thesis look
#: like a document with no reference list.
REFERENCE_HEADINGS: frozenset[str] = frozenset(
    {
        "references",
        "reference",
        "referencelist",
        "listofreferences",
        "bibliography",
        "workscited",
        "literaturecited",
        "المراجع",
        "قائمةالمراجع",
        "ثبتالمراجع",
        "المصادر",
        "المصادروالمراجع",
        "قائمةالمصادر",
    }
)

#: Arabic-Indic and Eastern Arabic-Indic digits, folded to ASCII before any
#: number is read. A deterministic transliteration of a digit, not a guess at
#: what a glyph might be.
_DIGIT_FOLD: dict[str, str] = {
    **{chr(0x0660 + n): str(n) for n in range(10)},
    **{chr(0x06F0 + n): str(n) for n in range(10)},
}
_DIGIT_TABLE = str.maketrans(_DIGIT_FOLD)

#: Characters stripped before a heading is compared. Spaces included: the PDF
#: text layer may or may not carry them, and a heading is the same heading
#: either way.
_HEADING_STRIP = re.compile("[\\s\u200f\u200e.:\\-\u2013\u2014_*0-9]+")

#: One bracketed numeric group. Written out rather than assembled so the exact
#: syntax accepted is readable in one place:
#:
#: * an opening bracket, digits, then any number of separated further digits;
#: * separators are comma or semicolon (a list) or hyphen/en dash/em dash (a
#:   range);
#: * a closing bracket.
#:
#: Nothing else. `[12a]`, `[see 12]`, `(12)` and a bare `12` are not matched,
#: because each of them would need PalCert to decide what the author meant.
#:
#: Both bracket orders are accepted, and that is not a loosening. `[` and `]`
#: carry the Unicode Bidi_Mirrored property, so the same marker inside a
#: right-to-left run reaches a reader as `]12[`. PalCert never reorders
#: extracted text - a Phase 13 rule, and the right one - so which order a
#: detector sees depends on the producer, and a detector that knew only one of
#: them would read Latin documents and not Arabic ones. A reversal is an exact,
#: information-preserving transformation of the same characters: nothing is
#: made fuzzier by accepting both.
#:
#: A marker directly attached to an ASCII identifier is not one. `arr[12]` and
#: `data[100]` in a code listing are subscripts, and a thesis with listings
#: and a bibliography would otherwise cite its own array indexes. The guard is
#: deliberately ASCII-only: Arabic typesetting attaches a marker straight to
#: the preceding word, so excluding every preceding letter would read Latin
#: documents and not Arabic ones.
_GROUP_BODY = "\\s*\\d{1,4}(?:\\s*[,;\u2013\u2014-]\\s*\\d{1,4})*\\s*"
_MARKER = re.compile(f"\\[{_GROUP_BODY}\\]|\\]{_GROUP_BODY}\\[")

#: The parenthesised Vancouver marker: `(3)`, `(3,5,7)`, `(3-5)`. Three digits
#: at most, so a year in parentheses can never match — `(2020)` is an
#: author-year citation and is left to that family.
_PAREN_BODY = "\\s*\\d{1,3}(?:\\s*[,;\u2013\u2014-]\\s*\\d{1,3})*\\s*"
_PAREN_MARKER = re.compile(f"\\({_PAREN_BODY}\\)")

#: What a parenthesised group may not follow. `x = (3)`, `n + (4)` and
#: `y ≤ (2)` are arithmetic, and the operator is the only thing that says so
#: once the brackets are round rather than square. A closed list of operator
#: characters, not a distance or a score.
_OPERATOR_TAIL = re.compile("[=+\\-*/^<>\u00d7\u00f7\u00b1\u2264\u2265\u2248]\\s*$")

#: Characters that essentially never appear in running prose but open and
#: close every display equation. A parenthesised group on a line carrying one
#: of these *anywhere* before it is an equation number, not a citation —
#: `E = mc² (2)` sets its number after the formula rather than alone at the
#: margin, so the tail check above does not see it. Hyphen, plus, slash and
#: the angle brackets are deliberately absent: prose uses all of them.
_MATH_ANYWHERE = re.compile("[=\u00d7\u00f7\u00b1\u2264\u2265\u2248]")

#: A letter, in either script PalCert reads. Used to require that a
#: parenthesised group *follows prose* rather than opening a line, which is
#: what separates a citation from a numbered-list marker or an equation
#: number set alone at the right margin.
_ANY_LETTER = re.compile("[A-Za-z\u0600-\u06ff]")
#: The same shape, anchored at the start of a line, for a reference entry's own
#: label. A single number only: `[1-2]` does not begin an entry. Mirrored
#: brackets again, for the same reason.
_ENTRY_LABEL = re.compile("^(?:\\[\\s*(\\d{1,4})\\s*\\]|\\]\\s*(\\d{1,4})\\s*\\[)")


def fold_digits(text: str) -> str:
    """ASCII digits for Arabic-Indic ones, and nothing else changed."""
    return text.translate(_DIGIT_TABLE)


def normalize_heading(text: str) -> str:
    """A heading reduced to the letters a vocabulary match compares.

    Case, spacing, ordinal numbering ("5. References"), bidi marks and
    trailing punctuation all vary between producers and none of them changes
    which heading it is.
    """
    return _HEADING_STRIP.sub("", text).strip().lower()


def is_reference_heading(text: str) -> bool:
    """Does this line say "References", in either reading direction?

    The reversed reading is tested for the same reason the mirrored brackets
    are: a PDF's text layer may present a right-to-left run in visual order
    and PalCert does not reorder it. Reversing is exact and
    information-preserving, and a Latin heading read backwards matches nothing
    in the vocabulary either, so precision is untouched.
    """
    normalized = normalize_heading(text)
    return normalized in REFERENCE_HEADINGS or normalized[::-1] in REFERENCE_HEADINGS


#: A numbered entry's own label, stripped before the author-year parse reads
#: what follows it.
_LABEL_PREFIX = re.compile(r"^\s*(?:\[\s*\d{1,4}\s*\]|\]\s*\d{1,4}\s*\[)\s*")

#: The same, for the unbracketed Vancouver opening `1. ` or `1) `. Only
#: applied to a line `vancouver_label` already accepted, so it never strips a
#: leading number off a line that merely starts with one.
_VANCOUVER_PREFIX = re.compile(r"^\s*\d{1,3}\s*[.)]\s*")

#: What a marker may not be glued to on its left.
_IDENTIFIER_TAIL = re.compile("[A-Za-z0-9_]$")


#: `1. Smith J, Jones A. Title.` — a numbered entry whose author is written
#: Vancouver style: surname, space, bare initials, no periods between them.
#:
#: The author shape is doing all the work. `1. Collect the samples` and
#: `2. Weigh them` are an ordinary numbered list and match nothing here, which
#: is the distinction Checkpoint 10 declined to make and this grammar earns:
#: the number says "list", the `Surname AB` says "reference".
_VANCOUVER_ENTRY = re.compile(
    r"^\s*(\d{1,3})\s*[.)]\s+"
    r"(?P<surname>(?:[A-Z][A-Za-z'\u2019-]{1,39}))"
    r"\s+[A-Z]{1,3}\s*[,.;]"
)


def vancouver_label(text: str) -> int | None:
    """The number a Vancouver-style entry opens with, or None.

    Requires the author shape as well as the number. A line that merely
    begins `1.` is a list item; a line that begins `1. Smith J,` is a
    reference, and the difference is the only reason this family is
    supportable at all.
    """
    match = _VANCOUVER_ENTRY.match(fold_digits(text))
    if match is None:
        return None
    if _rejected_author(match.group("surname")):
        return None
    label = int(match.group(1))
    return label if 0 < label <= MAX_LABEL else None


def _starts_another_region(lines: list[LineRef], heading: LineRef, line: LineRef) -> bool:
    """Is this line at or past the next reference heading after ``heading``?

    One chapter's list must not absorb the next chapter's. The boundary is the
    next heading in the vocabulary, which is document structure rather than a
    page gap or a distance.
    """
    for candidate in lines:
        if candidate.document_index <= heading.document_index:
            continue
        if is_reference_heading(candidate.text):
            return line.document_index >= candidate.document_index
    return False


def entry_label(text: str) -> int | None:
    """The number a reference entry's own label names, or None.

    A line begins an entry only when it *opens* with a bracketed single
    number. A label outside the plausible range is no label at all, which is
    what stops a line beginning with a year from starting one.
    """
    match = _ENTRY_LABEL.match(fold_digits(text).lstrip())
    if match is None:
        return None
    label = int(match.group(1) or match.group(2))
    return label if 0 < label <= MAX_LABEL else None


# --- the one scoring policy -------------------------------------------------

#: Every signal PalCert can observe, with the weight it carries. One table, so
#: a confidence is always the sum of named evidence rather than a constant
#: somebody chose in the middle of a function.
#:
#: Within each group the weights sum to 1, so a confidence is a fraction of the
#: evidence that *could* have been present. Monotonicity follows from every
#: weight being non-negative: a candidate that satisfies a superset of another
#: candidate's signals can never score lower.
#:
#: The groups are declared rather than derived from a name prefix. Checkpoint
#: 11 added two families whose signals do not share a first word with the ones
#: they sit beside, and a grouping that depended on spelling would have
#: silently merged them into a group summing to more than 1.
SIGNAL_GROUPS: dict[str, dict[str, Decimal]] = {
    # A reference region, whichever family its entries belong to.
    "REGION": {
        "REGION_HEADING_VOCABULARY": Decimal("0.30"),
        # Satisfied by a numbered list *or* by an author-year one. Which
        # family it was is recorded on the region itself rather than as a
        # signal: a confidence says how much evidence there was, not what kind.
        "REGION_ENTRY_STRUCTURE": Decimal("0.30"),
        "REGION_LATTER_DOCUMENT_POSITION": Decimal("0.15"),
        "REGION_LABEL_SEQUENCE_COHERENT": Decimal("0.15"),
        "REGION_TYPOGRAPHY_CONTINUITY": Decimal("0.10"),
    },
    # One numbered reference entry inside an accepted region.
    "NUMERIC_ENTRY": {
        "ENTRY_REGION_ACCEPTED": Decimal("0.40"),
        "ENTRY_BRACKETED_LABEL_AT_START": Decimal("0.30"),
        "ENTRY_LABEL_IN_SEQUENCE": Decimal("0.20"),
        "ENTRY_TYPOGRAPHY_MATCHES_REGION": Decimal("0.10"),
    },
    # One Vancouver-style entry: `1. Smith J, Jones A. Title.` The author
    # shape carries more weight than the number, and deliberately so. The
    # number alone is what an ordinary numbered list also has, so it is the
    # `Surname AB` following it that makes this a reference rather than a
    # step; a confidence that leaned on the label would rate a recipe as
    # highly as a bibliography.
    "VANCOUVER_ENTRY": {
        "VANC_ENTRY_REGION_ACCEPTED": Decimal("0.35"),
        "VANC_ENTRY_AUTHOR_SHAPE_AFTER_LABEL": Decimal("0.25"),
        "VANC_ENTRY_UNBRACKETED_LABEL_AT_START": Decimal("0.20"),
        "VANC_ENTRY_LABEL_IN_SEQUENCE": Decimal("0.10"),
        "VANC_ENTRY_TYPOGRAPHY_MATCHES_REGION": Decimal("0.10"),
    },
    # One numeric in-text marker.
    "NUMERIC_CITATION": {
        "CITATION_REGION_ACCEPTED": Decimal("0.40"),
        "CITATION_BRACKETED_NUMERIC_SYNTAX": Decimal("0.30"),
        "CITATION_LABEL_WITHIN_REFERENCE_RANGE": Decimal("0.20"),
        "CITATION_CORROBORATED_ON_PAGE": Decimal("0.10"),
    },
    # One author-year reference entry.
    "AUTHOR_YEAR_ENTRY": {
        "AY_ENTRY_REGION_ACCEPTED": Decimal("0.40"),
        "AY_ENTRY_SURNAME_AND_INITIALS_AT_START": Decimal("0.30"),
        "AY_ENTRY_YEAR_PLAUSIBLE": Decimal("0.20"),
        "AY_ENTRY_TYPOGRAPHY_MATCHES_REGION": Decimal("0.10"),
    },
    # One raised numeric marker. Two of these five are about whether the
    # marker names something: a raised numeral is only recognizable as a
    # citation *because* it points at a numbered entry, so a marker naming
    # nothing is not emitted at all and the remaining signals grade how well
    # the rest of the evidence holds up.
    "SUPERSCRIPT_CITATION": {
        "SUP_RAISED_ABOVE_RUNNING_TEXT": Decimal("0.25"),
        "SUP_SMALLER_THAN_RUNNING_TEXT": Decimal("0.20"),
        "SUP_NUMERIC_GROUP_SYNTAX": Decimal("0.20"),
        "SUP_LABEL_IN_REGION": Decimal("0.25"),
        "SUP_OUTSIDE_EVERY_REGION": Decimal("0.10"),
    },
    # One parenthesised Vancouver marker. Four of these six are gates rather
    # than gradations — nothing without them is emitted at all — and they are
    # weighted anyway, because a reader comparing two numbers should see the
    # same arithmetic behind both.
    "PAREN_CITATION": {
        "PAREN_REGION_ACCEPTED": Decimal("0.20"),
        "PAREN_DOCUMENT_USES_UNBRACKETED_NUMBERING": Decimal("0.25"),
        "PAREN_NUMERIC_GROUP_SYNTAX": Decimal("0.15"),
        "PAREN_LABEL_IN_REGION": Decimal("0.20"),
        "PAREN_FOLLOWS_RUNNING_TEXT": Decimal("0.10"),
        "PAREN_CORROBORATED_ON_PAGE": Decimal("0.10"),
    },
    # One author-year in-text citation. Two of these five are about whether
    # the citation found anything, which is deliberate: an author-year form
    # PalCert cannot tie to a reference it also recognized is much weaker
    # evidence than one it can, and the number should say so.
    "AUTHOR_YEAR_CITATION": {
        "AY_CITATION_REGION_ACCEPTED": Decimal("0.30"),
        "AY_CITATION_SYNTAX": Decimal("0.25"),
        "AY_CITATION_YEAR_PLAUSIBLE": Decimal("0.15"),
        "AY_CITATION_IDENTITY_MATCHES_REFERENCE": Decimal("0.20"),
        "AY_CITATION_IDENTITY_UNIQUE": Decimal("0.10"),
    },
}

#: Flattened, because a score is computed from signal names and a signal name
#: belongs to exactly one group.
SIGNAL_WEIGHTS: dict[str, Decimal] = {
    name: weight for group in SIGNAL_GROUPS.values() for name, weight in group.items()
}

#: The ceiling every heuristic confidence is scaled to.
#:
#: A candidate can satisfy every signal PalCert knows how to look for and
#: still be wrong: the signals are the evidence this detector can see, not the
#: evidence that exists. So 1.0 is not reachable, and the reserved headroom is
#: that residual said out loud. Scaling by a positive constant leaves the
#: ordering — and therefore the monotonicity — of every score untouched.
HEURISTIC_CEILING = Decimal("0.95")

#: The two a region cannot be accepted without. A heading alone is never
#: proof — that is the rule this pair encodes.
REQUIRED_REGION_SIGNALS = ("REGION_HEADING_VOCABULARY", "REGION_ENTRY_STRUCTURE")


def score(signals: frozenset[str]) -> Decimal:
    """The confidence a set of observed signals earns.

    Deterministic, order-independent and monotone in the signal set. Quantized
    to six decimal places, which is what the contract's ``CitationConfidence``
    pattern accepts.
    """
    total = sum((SIGNAL_WEIGHTS[name] for name in sorted(signals)), Decimal(0))
    if total > 1:  # pragma: no cover - the tables sum to 1 per group
        total = Decimal(1)
    return (total * HEURISTIC_CEILING).quantize(Decimal("0.000001"))


def format_confidence(value: Decimal) -> str:
    """The decimal string the artifact carries, normalized and bounded."""
    text = format(value.quantize(Decimal("0.000001")), "f")
    text = text.rstrip("0").rstrip(".") if "." in text else text
    return text or "0"


# --- what a detector produces ----------------------------------------------


@dataclass(frozen=True, slots=True)
class LineRef:
    """One layout line, with everything a detector needs and nothing else."""

    page_index: int
    #: Index of this line within the whole document's reading order.
    document_index: int
    node_id: str
    span_node_ids: tuple[str, ...]
    text: str
    font_size: Decimal | None
    bbox: BBox


class RegionFamily(StrEnum):
    """Which entry shape a reference list uses.

    Not a confidence signal: a confidence says how much evidence there was,
    and this says what kind. Recorded on the region so entry segmentation and
    citation detection read one decision rather than each re-deciding.
    """

    NUMBERED = "NUMBERED"
    AUTHOR_YEAR = "AUTHOR_YEAR"
    #: `1. Smith J, Jones A. Title. Journal. 2020;5:10-20.` — a numbered list
    #: whose entries open with Vancouver author initials rather than a
    #: bracketed label. Distinguished from an ordinary numbered list by that
    #: author shape, never by the number alone.
    VANCOUVER = "VANCOUVER"


@dataclass(frozen=True, slots=True)
class ReferenceRegion:
    """A span of lines PalCert believes is a reference list.

    A document may hold several: a per-chapter bibliography, an article
    collection, an appendix with its own sources. Each keeps its own
    boundaries, heading evidence, entry family and confidence, and they are
    never merged — merging two chapters' lists would invent a single
    population the document never had, and a label appearing in both would
    then look uniquely resolved.
    """

    #: Position among the regions of this document, in reading order. Stable,
    #: so an entry can name the region it came from without carrying it.
    ordinal: int
    family: RegionFamily
    heading_index: int
    first_entry_index: int
    last_index: int
    signals: frozenset[str]
    confidence: Decimal
    dominant_font_size: Decimal | None
    #: The heading line PalCert read the region from, addressed the way every
    #: other PDF finding is, so a reader can go and look at the evidence.
    heading_node_id: str = ""
    heading_page_index: int = 0
    #: The pages the region occupies, from its heading to its last absorbed
    #: line. Boundaries the region keeps rather than recomputes: two regions
    #: on one page are two regions, and a page range is how a reader checks
    #: that PalCert did not run one list into the next.
    first_page_index: int = 0
    last_page_index: int = 0

    def contains(self, document_index: int) -> bool:
        return self.heading_index <= document_index <= self.last_index


@dataclass(frozen=True, slots=True)
class HeuristicReference:
    #: The bracketed number, for a numbered list. An author-year list has none.
    label: int | None
    ordinal: int
    text: str
    line: LineRef
    span_node_ids: tuple[str, ...]
    signals: frozenset[str]
    confidence: Decimal
    #: Surnames as written, in order, when the entry parsed as author-year.
    #: Every one is traceable to this entry's own ``text``.
    authors: tuple[str, ...] = ()
    author_shape: AuthorShape | None = None
    year: str | None = None
    #: Which region family produced this entry. Checkpoint 12 parses author
    #: and year out of a *numbered* entry too, and this is what stops that
    #: enrichment from silently widening Checkpoint 11's matching: only an
    #: entry from an author-year list is a candidate for an author-year
    #: citation, exactly as before.
    family: RegionFamily = RegionFamily.AUTHOR_YEAR
    #: Which region produced this entry, by that region's ordinal. A citation
    #: resolves against one region's population, so an entry has to say which
    #: population it belongs to.
    region_ordinal: int = 1
    #: Structured fields, each an exact substring of ``text``.
    title: str | None = None
    container_title: str | None = None
    identifiers: tuple[Identifier, ...] = ()

    @property
    def matchable_by_author_year(self) -> bool:
        """May an author-year citation resolve to this entry?

        Only when the entry came from an author-year reference list. A
        numbered entry now carries the same parsed identity, and letting it
        match would turn Checkpoint 11's NOT_ATTEMPTED into a link — a change
        to matching semantics, which this checkpoint is told not to make
        implicitly.
        """
        return (
            self.family is RegionFamily.AUTHOR_YEAR and bool(self.authors) and self.year is not None
        )


@dataclass(frozen=True, slots=True)
class HeuristicAuthorYearCitation:
    """One recognized author-year marker, bound to the line it was read from."""

    parsed: AuthorYearCitation
    line: LineRef
    span_node_ids: tuple[str, ...]
    signals: frozenset[str]
    confidence: Decimal


@dataclass(frozen=True, slots=True)
class HeuristicCitation:
    label: int
    #: The bracketed group this marker came from, kept verbatim so expanding
    #: `[4-6]` into three citations stays auditable.
    raw_group: str
    text: str
    line: LineRef
    span_node_ids: tuple[str, ...]
    signals: frozenset[str]
    confidence: Decimal
    #: Where this marker sits in reading order, so the linker can ask which
    #: region's list closes the stretch of text it belongs to.
    document_index: int = 0
    #: True when a raised, smaller span carried it rather than brackets.
    superscript: bool = False


@dataclass(frozen=True, slots=True)
class HeuristicDiscovery:
    """Everything this module found, and whether it ran at all."""

    attempted: bool
    regions: tuple[ReferenceRegion, ...] = ()
    references: tuple[HeuristicReference, ...] = ()
    citations: tuple[HeuristicCitation, ...] = ()
    author_year_citations: tuple[HeuristicAuthorYearCitation, ...] = ()
    truncated: bool = False


# --- reading the document as lines ------------------------------------------


def document_lines(model: PdfStructuralModel) -> list[LineRef]:
    """Every layout line, in reading order, flattened across pages.

    Reads the representation Phase 13 already built. There is deliberately no
    second parse of the file here: a detector that re-read the bytes could
    disagree with the model every other part of PalCert reports from.
    """
    lines: list[LineRef] = []
    index = 0
    for page in model.pages:
        sizes = _span_sizes(page)
        for line in page.lines:
            lines.append(
                LineRef(
                    page_index=page.page_index,
                    document_index=index,
                    node_id=line.node_id,
                    span_node_ids=tuple(line.span_ids),
                    text=line.text,
                    font_size=_dominant(tuple(sizes.get(span_id) for span_id in line.span_ids)),
                    bbox=line.display_bbox,
                )
            )
            index += 1
            if index >= MAX_REGION_LINES:
                return lines
    return lines


def _span_sizes(page: PageModel) -> dict[str, Decimal | None]:
    return {span.node_id: span.font_size for span in page.spans}


def _dominant(values: tuple[Decimal | None, ...]) -> Decimal | None:
    """The most common size among a line's spans, ties broken by the smallest.

    A deterministic choice rather than "the first one": a line whose spans
    arrive in a different order must still report the same size.
    """
    present = [value for value in values if value is not None]
    if not present:
        return None
    counts: dict[Decimal, int] = {}
    for value in present:
        counts[value] = counts.get(value, 0) + 1
    best = max(counts.items(), key=lambda item: (item[1], -item[0]))
    return best[0]


# --- the reference region ---------------------------------------------------


def detect_reference_regions(lines: list[LineRef]) -> list[ReferenceRegion]:
    """Every heading that actually introduces reference entries, in order.

    Checkpoints 10 to 13 took the last one and called it *the* bibliography.
    That is right for a thesis and wrong for a book of chapters, a collection
    of articles, or a document whose appendix carries its own sources — and
    being wrong there is not a missing region but a silently mis-scoped one:
    a citation in chapter 2 resolving against chapter 5's list.

    Each candidate heading is still tested against the lines that follow it,
    so a heading followed by prose is not a region and the heading alone still
    decides nothing. Scanning forward rather than backward now, because every
    match matters rather than only the last.

    Regions never overlap: a heading inside a region already accepted belongs
    to that region's text, not to a new one.
    """
    regions: list[ReferenceRegion] = []
    for heading in lines:
        if not is_reference_heading(heading.text):
            continue
        if any(region.contains(heading.document_index) for region in regions):
            continue
        region = _region_from(lines, heading, ordinal=len(regions) + 1)
        if region is not None:
            regions.append(region)
        if len(regions) >= MAX_REFERENCE_REGIONS:
            break
    return regions


def region_for_citation(
    regions: list[ReferenceRegion], document_index: int
) -> ReferenceRegion | None:
    """The region a citation at this position may defensibly resolve against.

    The first region that *begins after* the citation. A reference list serves
    the text it follows — that is what a per-chapter bibliography is — so
    ordinal containment, not distance, decides. There is no nearest-region
    rule and no page-gap threshold: a citation is either inside the stretch of
    text a given list closes, or it is not.

    ``None`` when no region follows, which is a document whose only lists sit
    before the citation. That is not an assignment PalCert can defend, and the
    caller widens to every region and reports ambiguity rather than choosing.
    """
    following = [region for region in regions if region.heading_index > document_index]
    return following[0] if following else None


def _region_from(lines: list[LineRef], heading: LineRef, *, ordinal: int) -> ReferenceRegion | None:
    """Test one candidate heading against the lines that follow it.

    Three entry families are recognized and the bracketed-numeric one is tried
    first, so a document Checkpoints 10 to 13 already read is read
    identically. A list is one family or another; a heading followed by none
    of them is not a region.

    Only the lines up to the *next* reference heading are considered, so one
    chapter's list cannot absorb the next chapter's.
    """
    body = [
        line
        for line in lines
        if line.document_index > heading.document_index
        and not _starts_another_region(lines, heading, line)
    ]

    labelled = [(line, label) for line in body if (label := entry_label(line.text)) is not None]
    if len(labelled) >= MIN_ENTRIES:
        family = RegionFamily.NUMBERED
        openings = labelled
    elif len(vancouver := [line for line in body if vancouver_label(line.text) is not None]) >= (
        MIN_ENTRIES
    ):
        family = RegionFamily.VANCOUVER
        openings = [(line, vancouver_label(line.text) or 0) for line in vancouver]
    else:
        author_year = [line for line in body if parse_entry(line.text) is not None]
        if len(author_year) < MIN_ENTRIES:
            return None
        family = RegionFamily.AUTHOR_YEAR
        openings = [(line, 0) for line in author_year]

    labelled = openings
    dominant_size = _dominant(tuple(line.font_size for line, _ in labelled))
    signals = {"REGION_HEADING_VOCABULARY", "REGION_ENTRY_STRUCTURE"}

    # Latter part of the document. A reference list at the front of a file is
    # possible and is not what this signal is about: it says *this* candidate
    # sits where a reference list usually sits, and a candidate that does not
    # simply scores lower.
    if heading.document_index * 2 >= len(lines):
        signals.add("REGION_LATTER_DOCUMENT_POSITION")

    # Where the list stops, which is the hard part: the final entry has no
    # next label to close it, and running the region to the end of the
    # document swallows an appendix into that entry's raw text and hides every
    # citation after it.
    #
    # The bound is taken from the list itself rather than from a constant. The
    # longest continuation run between two labels is how far *this* list's
    # entries wrap, so the last entry is allowed exactly that much and no
    # more; a one-line-per-entry list absorbs nothing. Absorption also stops
    # early at another heading or a change of typeface.
    indices = [line.document_index for line, _ in labelled]
    longest_run = max(after - before - 1 for before, after in pairwise(indices))
    last_label_at = indices[-1]
    end = last_label_at
    for line in body:
        if line.document_index <= last_label_at:
            continue
        if line.document_index > last_label_at + longest_run:
            break
        if is_reference_heading(line.text):
            break
        if dominant_size is None or line.font_size != dominant_size:
            break
        end = line.document_index

    if family is not RegionFamily.AUTHOR_YEAR and _mostly_ascending(
        [label for _, label in labelled]
    ):
        # An author-year list is alphabetical by surname, not numbered, so
        # there is no sequence to be coherent and the signal is simply absent.
        signals.add("REGION_LABEL_SEQUENCE_COHERENT")

    if dominant_size is not None and all(
        line.font_size == dominant_size for line, _ in labelled
    ):  # every entry set the same way
        signals.add("REGION_TYPOGRAPHY_CONTINUITY")

    frozen = frozenset(signals)
    # The pages the region actually occupies, taken from the lines it holds
    # rather than assumed to be one: a long bibliography runs across pages,
    # and the last line absorbed above is where it stops.
    held = [line for line in lines if heading.document_index <= line.document_index <= end]
    pages = [line.page_index for line in held]
    return ReferenceRegion(
        ordinal=ordinal,
        family=family,
        heading_index=heading.document_index,
        first_entry_index=labelled[0][0].document_index,
        last_index=end,
        signals=frozen,
        confidence=score(frozen),
        dominant_font_size=dominant_size,
        heading_node_id=heading.node_id,
        heading_page_index=heading.page_index,
        first_page_index=min(pages) if pages else heading.page_index,
        last_page_index=max(pages) if pages else heading.page_index,
    )


def _mostly_ascending(labels: list[int]) -> bool:
    """Do the labels climb, allowing for the occasional misread?

    Not "strictly 1..n": a two-column list, a page break or an entry PalCert
    failed to segment all leave a gap, and demanding perfection would reject
    every real bibliography. A clear majority of adjacent pairs ascending is
    the signal; anything less and the signal is simply absent.
    """
    if len(labels) < 2:
        return False
    ascending = sum(1 for before, after in pairwise(labels) if after > before)
    return ascending * 4 >= (len(labels) - 1) * 3


# --- numbered reference entries ---------------------------------------------


def segment_entries(
    lines: list[LineRef], region: ReferenceRegion, *, claimed_spans: frozenset[str]
) -> list[HeuristicReference]:
    """One entry per bracketed label, continuation lines folded into it.

    An entry starts where a label starts and ends where the next one does. A
    line after the heading that carries no label is not an entry of its own —
    it is the rest of the previous one, wrapped — and a region whose lines
    carry no labels at all produced no entries, which is why arbitrary
    paragraphs under a "References" heading never become entries here.
    """
    collected: list[tuple[int | None, LineRef, list[LineRef]]] = []
    for line in lines:
        if not region.contains(line.document_index) or line.document_index <= region.heading_index:
            continue
        if region.family is RegionFamily.NUMBERED:
            opens: int | None = entry_label(line.text)
            starts = opens is not None
        elif region.family is RegionFamily.VANCOUVER:
            # The same segmentation as the bracketed family — an entry starts
            # where a label starts — over a different opening grammar. The
            # grammar is the whole safeguard: `vancouver_label` accepts a
            # number only when an author shape follows it, so a wrapped
            # continuation line beginning with a year or a page range is
            # folded into the previous entry rather than opening a new one.
            opens = vancouver_label(line.text)
            starts = opens is not None
        else:
            opens = None
            starts = parse_entry(line.text) is not None
        if starts:
            collected.append((opens, line, [line]))
        elif collected:
            collected[-1][2].append(line)

    entries: list[HeuristicReference] = []
    for ordinal, (label, first, members) in enumerate(collected, start=1):
        spans = tuple(span for member in members for span in member.span_node_ids)
        if claimed_spans.intersection(spans):
            # An entry the author already declared. Exact evidence keeps it,
            # and a second object for the same text is suppressed rather than
            # merged into the first.
            continue
        text = " ".join(member.text.strip() for member in members).strip()
        typography_matches = (
            region.dominant_font_size is not None and first.font_size == region.dominant_font_size
        )

        if region.family in {RegionFamily.NUMBERED, RegionFamily.VANCOUVER}:
            if region.family is RegionFamily.NUMBERED:
                signals = {"ENTRY_REGION_ACCEPTED", "ENTRY_BRACKETED_LABEL_AT_START"}
                if label == ordinal:
                    signals.add("ENTRY_LABEL_IN_SEQUENCE")
                if typography_matches:
                    signals.add("ENTRY_TYPOGRAPHY_MATCHES_REGION")
                prefix_pattern = _LABEL_PREFIX
            else:
                # `VANC_ENTRY_AUTHOR_SHAPE_AFTER_LABEL` is unconditional here
                # and is not a free point: nothing without that shape reached
                # this line, because it is what `vancouver_label` requires
                # before it returns a number at all.
                signals = {
                    "VANC_ENTRY_REGION_ACCEPTED",
                    "VANC_ENTRY_AUTHOR_SHAPE_AFTER_LABEL",
                    "VANC_ENTRY_UNBRACKETED_LABEL_AT_START",
                }
                if label == ordinal:
                    signals.add("VANC_ENTRY_LABEL_IN_SEQUENCE")
                if typography_matches:
                    signals.add("VANC_ENTRY_TYPOGRAPHY_MATCHES_REGION")
                prefix_pattern = _VANCOUVER_PREFIX
            frozen = frozenset(signals)
            # A numbered entry is usually an author-year entry with a label in
            # front of it, so the same parse applies once the label is gone.
            # What the parse must *not* do is make it matchable: see
            # `matchable_by_author_year`.
            prefix = prefix_pattern.match(text)
            label_end = prefix.end() if prefix is not None else 0
            parsed = parse_entry(text[label_end:])
            bibliography = parse_entry_text(
                text[:MAX_REFERENCE_TEXT_CHARS],
                year_end=None if parsed is None else label_end + parsed.year_end,
            )
            entries.append(
                HeuristicReference(
                    label=label,
                    ordinal=ordinal,
                    text=text,
                    line=first,
                    span_node_ids=spans,
                    signals=frozen,
                    confidence=score(frozen),
                    family=region.family,
                    region_ordinal=region.ordinal,
                    authors=() if parsed is None else parsed.authors,
                    author_shape=None if parsed is None else parsed.shape,
                    year=None if parsed is None else parsed.year,
                    title=bibliography.title,
                    container_title=bibliography.container_title,
                    identifiers=bibliography.identifiers,
                )
            )
        else:
            # Parsed from the whole entry rather than from its first line:
            # `Smith, J., Khatib, A., &` can wrap before the second surname,
            # and an author the entry names is an author whichever line it
            # landed on.
            parsed = parse_entry(text) or parse_entry(first.text)
            if parsed is None:  # pragma: no cover - the line opened the entry
                continue
            signals = {"AY_ENTRY_REGION_ACCEPTED", "AY_ENTRY_SURNAME_AND_INITIALS_AT_START"}
            if year_is_plausible(parsed.year):
                signals.add("AY_ENTRY_YEAR_PLAUSIBLE")
            if typography_matches:
                signals.add("AY_ENTRY_TYPOGRAPHY_MATCHES_REGION")
            frozen = frozenset(signals)
            # Parsed from exactly the text the artifact will carry. A field
            # read past the truncation point would be a value no reader could
            # find in `rawText`, which is the one guarantee this layer makes.
            bibliography = parse_entry_text(
                text[:MAX_REFERENCE_TEXT_CHARS], year_end=parsed.year_end
            )
            entries.append(
                HeuristicReference(
                    label=None,
                    ordinal=ordinal,
                    text=text,
                    line=first,
                    span_node_ids=spans,
                    signals=frozen,
                    confidence=score(frozen),
                    family=RegionFamily.AUTHOR_YEAR,
                    region_ordinal=region.ordinal,
                    authors=parsed.authors,
                    author_shape=parsed.shape,
                    year=parsed.year,
                    title=bibliography.title,
                    container_title=bibliography.container_title,
                    identifiers=bibliography.identifiers,
                )
            )
        if len(entries) >= MAX_HEURISTIC_REFERENCES:
            break
    return entries


# --- in-text numeric citations ----------------------------------------------


def expand_marker(group: str) -> list[int] | None:
    """The numbers a bracketed group names, or None if it is not citation syntax.

    ``[12]`` is one, ``[3, 7, 11]`` is three, ``[4-6]`` is 4, 5 and 6. A range
    that does not ascend is not a range — ``[6-4]`` and ``[5-5]`` are somebody
    writing something else — and every number has to be a plausible reference
    label, which is what keeps a year out without a rule about years.
    """
    # Strip whichever bracket order the run used. The *content* is the same
    # digits in the same order either way: bidi mirrors the brackets, it does
    # not renumber what is between them.
    inner = fold_digits(group)[1:-1].strip()
    if not inner:
        return None

    numbers: list[int] = []
    for part in re.split(r"\s*[,;]\s*", inner):
        if not part:
            return None
        bounds = re.split("\\s*[\u2013\u2014-]\\s*", part)
        if len(bounds) == 1:
            if not bounds[0].isdigit():
                return None
            numbers.append(int(bounds[0]))
        elif len(bounds) == 2:
            if not (bounds[0].isdigit() and bounds[1].isdigit()):
                return None
            low, high = int(bounds[0]), int(bounds[1])
            # A descending or empty range is not citation syntax. Neither is a
            # long one: `[1-400]` in prose is a measurement, not 400 citations.
            if low >= high or high - low > 50:
                return None
            numbers.extend(range(low, high + 1))
        else:
            return None

    if not numbers:
        return None
    if any(number < 1 or number > MAX_LABEL for number in numbers):
        # Out of label range. A four-digit year cannot reach this far, and
        # neither can a page count or an equation number of any size.
        return None
    return numbers


def detect_citations(
    lines: list[LineRef],
    regions: list[ReferenceRegion],
    *,
    known_labels: frozenset[int],
    claimed_spans: frozenset[str],
) -> tuple[list[HeuristicCitation], dict[int, list[tuple[int, int]]]]:
    """Bracketed numeric markers in the body, and never in the reference list.

    The region is excluded outright. Every entry in a numbered bibliography
    opens with ``[7]``, and rediscovering those as in-text citations would
    have every document citing its own reference list.

    Discovery is attempted only inside a document whose reference region was
    accepted. A bracketed number in a file with no bibliography is far more
    likely to be a footnote marker, a form field or a measurement, and
    PalCert has nothing to link it to in any case.
    """
    per_page: dict[int, int] = {}
    found: list[tuple[LineRef, str, list[int]]] = []
    claimed_offsets: dict[int, list[tuple[int, int]]] = {}

    for line in lines:
        if any(region.contains(line.document_index) for region in regions):
            continue
        if claimed_spans.intersection(line.span_node_ids):
            # Already declared by the author, and read exactly.
            continue
        folded = fold_digits(line.text)
        for match in _MARKER.finditer(folded):
            if _IDENTIFIER_TAIL.search(folded[: match.start()]):
                # A subscript, not a citation.
                continue
            numbers = expand_marker(match.group(0))
            if numbers is None:
                continue
            found.append((line, match.group(0), numbers))
            claimed_offsets.setdefault(line.document_index, []).append((match.start(), match.end()))
            per_page[line.page_index] = per_page.get(line.page_index, 0) + 1

    citations: list[HeuristicCitation] = []
    for line, group, numbers in found:
        for number in numbers:
            signals = {"CITATION_REGION_ACCEPTED", "CITATION_BRACKETED_NUMERIC_SYNTAX"}
            if number in known_labels:
                signals.add("CITATION_LABEL_WITHIN_REFERENCE_RANGE")
            if per_page.get(line.page_index, 0) > 1:
                signals.add("CITATION_CORROBORATED_ON_PAGE")
            frozen = frozenset(signals)
            citations.append(
                HeuristicCitation(
                    label=number,
                    raw_group=group,
                    text=group,
                    line=line,
                    span_node_ids=line.span_node_ids,
                    signals=frozen,
                    confidence=score(frozen),
                    document_index=line.document_index,
                )
            )
            if len(citations) >= MAX_HEURISTIC_CITATIONS:
                return citations, claimed_offsets
    return citations, claimed_offsets


def detect_author_year_citations(
    lines: list[LineRef],
    regions: list[ReferenceRegion],
    *,
    entries: list[HeuristicReference],
    claimed_spans: frozenset[str],
    claimed_offsets: dict[int, list[tuple[int, int]]],
) -> list[HeuristicAuthorYearCitation]:
    """Author-year markers in the body, and never in the reference list.

    Three exclusions, each for a different reason.

    The **region** is excluded because every entry in an author-year
    bibliography opens with `Smith, J. (2020)`, which the narrative grammar
    reads as a citation — a document would cite its own reference list once
    per entry.

    **Spans the author declared** are excluded because exact evidence wins:
    a tagged `/Reference` is not re-found by pattern.

    **Character ranges the numeric family already claimed** are excluded so
    the two families can never produce two citations for one marker. Numeric
    runs first and this one takes what is left, which also means an existing
    `NUMERIC_LABEL` citation is never reinterpreted as author-year.
    """
    by_identity: dict[tuple[str, str], list[HeuristicReference]] = {}
    for entry in entries:
        if entry.matchable_by_author_year and entry.year is not None:
            key = (normalize_surname(entry.authors[0]), entry.year)
            by_identity.setdefault(key, []).append(entry)

    found: list[HeuristicAuthorYearCitation] = []
    for line in lines:
        if any(region.contains(line.document_index) for region in regions):
            continue
        if claimed_spans.intersection(line.span_node_ids):
            continue
        taken = claimed_offsets.get(line.document_index, [])
        for parsed in find_citations(fold_digits(line.text)):
            if any(start < parsed.end and parsed.start < end for start, end in taken):
                continue
            matches = by_identity.get((normalize_surname(parsed.first_author), parsed.year), [])
            signals = {"AY_CITATION_REGION_ACCEPTED", "AY_CITATION_SYNTAX"}
            if year_is_plausible(parsed.year):
                signals.add("AY_CITATION_YEAR_PLAUSIBLE")
            if matches:
                signals.add("AY_CITATION_IDENTITY_MATCHES_REFERENCE")
            if len(_narrow(matches, parsed.shape)) == 1:
                signals.add("AY_CITATION_IDENTITY_UNIQUE")
            frozen = frozenset(signals)
            found.append(
                HeuristicAuthorYearCitation(
                    parsed=parsed,
                    line=line,
                    span_node_ids=line.span_node_ids,
                    signals=frozen,
                    confidence=score(frozen),
                )
            )
            if len(found) >= MAX_HEURISTIC_CITATIONS:
                return found
    return found


def detect_superscript_citations(
    model: PdfStructuralModel,
    lines: list[LineRef],
    regions: list[ReferenceRegion],
    *,
    entries: list[HeuristicReference],
    claimed_spans: frozenset[str],
    claimed_offsets: dict[int, list[tuple[int, int]]],
) -> list[HeuristicCitation]:
    """Raised numerals that name a reference entry, and no other raised numeral.

    Geometry says a span is raised and small; it does not say whether the
    author meant a citation, an exponent or a footnote marker. So two further
    conditions decide, and both are about evidence rather than shape:

    * the number must name an entry in the region that serves this part of
      the document. A raised numeral matching nothing is reported as nothing —
      the reference it pointed at was the only reason to read it as a citation.
    * the running text it is attached to must not end in a lone letter, which
      is what an exponent is attached to.

    Everything a declared element already covers is skipped, and so is every
    character range the bracketed detector claimed, so one marker can never
    become two citations.
    """
    by_index = {line.node_id: line for line in lines}
    spans_to_line = {span_id: line for line in lines for span_id in line.span_node_ids}
    found: list[HeuristicCitation] = []

    for page in model.pages:
        for marker in find_raised_markers(page):
            span_id = marker.span.node_id
            if span_id in claimed_spans:
                # Declared by the author and read exactly.
                continue
            line = spans_to_line.get(span_id)
            if line is None:  # pragma: no cover - every span belongs to a line
                continue
            if any(region.contains(line.document_index) for region in regions):
                # A reference list's own numbering is not an in-text citation.
                continue
            if any(
                start < len(line.text) and end > 0
                for start, end in claimed_offsets.get(line.document_index, [])
            ):
                # The bracketed detector already read this line's markers.
                continue
            if reads_as_a_variable(marker.preceding_text):
                continue

            region = region_for_citation(regions, line.document_index)
            population = _labels_in(entries, region)
            for label in marker.labels:
                if label not in population:
                    # The marker names nothing this document lists, so there
                    # is no evidence it is a citation rather than an exponent,
                    # an ordinal or a footnote marker.
                    continue
                signals = frozenset(
                    {
                        "SUP_RAISED_ABOVE_RUNNING_TEXT",
                        "SUP_SMALLER_THAN_RUNNING_TEXT",
                        "SUP_NUMERIC_GROUP_SYNTAX",
                        "SUP_LABEL_IN_REGION",
                        "SUP_OUTSIDE_EVERY_REGION",
                    }
                )
                found.append(
                    HeuristicCitation(
                        label=label,
                        raw_group=marker.raw,
                        text=marker.raw,
                        line=by_index.get(line.node_id, line),
                        span_node_ids=(span_id,),
                        signals=signals,
                        confidence=score(signals),
                        document_index=line.document_index,
                        superscript=True,
                    )
                )
                if len(found) >= MAX_HEURISTIC_CITATIONS:
                    return found
    return found


def detect_parenthesized_citations(
    lines: list[LineRef],
    regions: list[ReferenceRegion],
    *,
    entries: list[HeuristicReference],
    claimed_spans: frozenset[str],
    claimed_offsets: dict[int, list[tuple[int, int]]],
) -> list[HeuristicCitation]:
    """Vancouver's other in-text form: `(3)`, `(3,5,7)`, `(3-5)`.

    Round brackets are the hardest numeric form to read, because the shape is
    shared with three things that are not citations: an equation number, a
    numbered-list marker, and a function or array subscript. Checkpoint 10
    declined the form entirely for that reason. What makes it supportable is
    not a better pattern but a document-derived precondition.

    **The document must number its own reference list without brackets.** A
    document whose bibliography reads `[7] Smith, J.` writes its markers
    `[7]`; `(7)` in that document is something else, and reading it as a
    citation would be reading against the author's own established style. A
    Vancouver document — `7. Smith J, Jones A.` — is precisely the one whose
    markers are written `(7)` or raised. So the reference list decides whether
    this detector runs at all, which is a fact about the file rather than a
    tuned preference.

    Four further conditions, each removing one of the look-alikes:

    * every number must name an entry in the region serving this position, so
      a marker pointing at nothing is not a citation;
    * the group must not be glued to an identifier — `f(3)`, `arr(12)`;
    * it must not follow an arithmetic operator — `x = (3)`, `n + (4)`;
    * some letter must precede it on the line, so a line *opening* `(3)` is a
      list marker and an isolated `(3)` at the right margin is an equation
      number.

    None of those is a threshold. Each is a closed textual condition that
    either holds or does not.
    """
    if not any(region.family is RegionFamily.VANCOUVER for region in regions):
        # The document brackets its own reference labels, or has no numbered
        # list at all. Either way `(3)` is not this author's citation form.
        return []

    per_page: dict[int, int] = {}
    found: list[tuple[LineRef, str, list[int]]] = []

    for line in lines:
        if any(region.contains(line.document_index) for region in regions):
            continue
        if claimed_spans.intersection(line.span_node_ids):
            continue
        taken = claimed_offsets.get(line.document_index, [])
        folded = fold_digits(line.text)
        region = region_for_citation(regions, line.document_index)
        population = _labels_in(entries, region)
        for match in _PAREN_MARKER.finditer(folded):
            if any(start < match.end() and match.start() < end for start, end in taken):
                # The bracketed or author-year family already read this text.
                continue
            before = folded[: match.start()]
            if _IDENTIFIER_TAIL.search(before) or _OPERATOR_TAIL.search(before):
                continue
            if _MATH_ANYWHERE.search(before):
                continue
            if not _ANY_LETTER.search(before):
                continue
            numbers = expand_marker(match.group(0))
            if numbers is None:
                continue
            if not population or any(number not in population for number in numbers):
                # One unknown number disqualifies the whole group. A partly
                # recognized group is much more likely to be a coordinate pair
                # or a range of something else than a citation list with a typo.
                continue
            found.append((line, match.group(0), numbers))
            claimed_offsets.setdefault(line.document_index, []).append((match.start(), match.end()))
            per_page[line.page_index] = per_page.get(line.page_index, 0) + 1

    citations: list[HeuristicCitation] = []
    for line, group, numbers in found:
        for number in numbers:
            signals = {
                "PAREN_REGION_ACCEPTED",
                "PAREN_DOCUMENT_USES_UNBRACKETED_NUMBERING",
                "PAREN_NUMERIC_GROUP_SYNTAX",
                "PAREN_LABEL_IN_REGION",
                "PAREN_FOLLOWS_RUNNING_TEXT",
            }
            if per_page.get(line.page_index, 0) > 1:
                signals.add("PAREN_CORROBORATED_ON_PAGE")
            frozen = frozenset(signals)
            citations.append(
                HeuristicCitation(
                    label=number,
                    raw_group=group,
                    text=group,
                    line=line,
                    span_node_ids=line.span_node_ids,
                    signals=frozen,
                    confidence=score(frozen),
                    document_index=line.document_index,
                )
            )
            if len(citations) >= MAX_HEURISTIC_CITATIONS:
                return citations
    return citations


def _labels_in(entries: list[HeuristicReference], region: ReferenceRegion | None) -> frozenset[int]:
    """Every numeric label the given region lists, or every one at all.

    ``None`` means no region defensibly serves this position, and the caller
    is then working with the document-wide population — which the linker
    treats as ambiguous rather than unique when more than one region answers.
    """
    return frozenset(
        entry.label
        for entry in entries
        if entry.label is not None and (region is None or entry.region_ordinal == region.ordinal)
    )


def _narrow(matches: list[HeuristicReference], shape: AuthorShape) -> list[HeuristicReference]:
    """Entries sharing an identity, narrowed by author shape when it helps.

    The shape is consulted **only** when the author-year identity already
    names more than one entry, and it can only ever remove candidates. It
    never creates a match the identity did not narrow, which is what keeps it
    a structural discriminator rather than a ranking: two entries by the same
    author in the same year, both single-authored, stay two candidates and the
    citation stays AMBIGUOUS.
    """
    if len(matches) <= 1:
        return matches
    narrowed = [entry for entry in matches if entry.author_shape is shape]
    return narrowed if len(narrowed) == 1 else matches


def resolve_author_year(
    citation: AuthorYearCitation, entries: list[HeuristicReference]
) -> list[HeuristicReference]:
    """Every entry this citation's identity defensibly names.

    One entry is a link, several are candidates, none is an unresolved
    attempt. The caller turns that into the frozen graph states; nothing here
    chooses between candidates.
    """
    matches = [
        entry
        for entry in entries
        if entry.matchable_by_author_year
        and (normalize_surname(entry.authors[0]), entry.year) == citation.identity
    ]
    return _narrow(matches, citation.shape)


# --- the whole pass ---------------------------------------------------------


def discover(
    model: PdfStructuralModel, *, claimed_spans: frozenset[str] = frozenset()
) -> HeuristicDiscovery:
    """Run every detector, or none of them.

    ``attempted`` is what the coverage reads. A scan has no text to classify
    and a discovery that never ran must not be reported as one that found
    nothing — those are different statements and only one of them is true.
    """
    if model.text_layer in {TextLayer.IMAGE_ONLY, TextLayer.EMPTY_OR_UNKNOWN}:
        return HeuristicDiscovery(attempted=False)

    lines = document_lines(model)
    scan_truncated = len(lines) >= MAX_REGION_LINES
    regions = detect_reference_regions(lines)
    if not regions:
        return HeuristicDiscovery(attempted=True, truncated=scan_truncated)

    # Each region is segmented on its own and the results are concatenated in
    # region order. Never merged: two chapters' lists are two populations, and
    # a label in both is ambiguous rather than resolved.
    references: list[HeuristicReference] = []
    for region in regions:
        references.extend(segment_entries(lines, region, claimed_spans=claimed_spans))

    citations, claimed_offsets = detect_citations(
        lines,
        regions,
        known_labels=frozenset(entry.label for entry in references if entry.label is not None),
        claimed_spans=claimed_spans,
    )
    author_year = detect_author_year_citations(
        lines,
        regions,
        entries=references,
        claimed_spans=claimed_spans,
        claimed_offsets=claimed_offsets,
    )
    raised = detect_superscript_citations(
        model,
        lines,
        regions,
        entries=references,
        claimed_spans=claimed_spans,
        claimed_offsets=claimed_offsets,
    )
    # Last of the numeric family, so every character range the bracketed and
    # author-year detectors claimed is already recorded and one marker can
    # never become two citations.
    parenthesized = detect_parenthesized_citations(
        lines,
        regions,
        entries=references,
        claimed_spans=claimed_spans,
        claimed_offsets=claimed_offsets,
    )
    numeric = citations + raised + parenthesized
    return HeuristicDiscovery(
        attempted=True,
        regions=tuple(regions),
        references=tuple(references[:MAX_HEURISTIC_REFERENCES]),
        citations=tuple(numeric[:MAX_HEURISTIC_CITATIONS]),
        author_year_citations=tuple(author_year),
        truncated=scan_truncated
        or len(references) >= MAX_HEURISTIC_REFERENCES
        or len(numeric) >= MAX_HEURISTIC_CITATIONS
        or len(author_year) >= MAX_HEURISTIC_CITATIONS,
    )
