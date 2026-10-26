"""Author-year citation and reference grammar (Phase 18, Checkpoint 11).

Checkpoint 10 recognized one citation family: a bracketed number. This adds
the other family a thesis actually uses — `(Smith, 2020)`, `Smith (2020)`,
`(Smith & Jones, 2021)`, `(Smith et al., 2022)` — and the reference-entry
shape that makes matching them possible.

Author-year is far more dangerous than numeric, and the whole of this module
is about that. `[12]` is punctuation nobody writes by accident; a capitalized
word next to a four-digit number in brackets is *extremely* common in prose
that has nothing to do with citing anything. `(March, 2020)` is a date.
`(Copyright, 2019)` is a notice. `(Smith v. Jones, 2020)` is a lawsuit.
`(Windows, 2000)` is a product.

So the grammar is anchored and total rather than searching: a parenthesised
group must parse *completely*, from its first character to its last, or it is
not a citation. There is no "find an author somewhere in here". A group with
one segment PalCert cannot read is rejected whole, because the alternative is
picking the part that looked familiar.

Matching is exact identity, never similarity. A surname is compared
case-insensitively and otherwise verbatim — no stemming, no transliteration,
no edit distance, no initial-only fallback. When an identity names more than
one entry the citation is AMBIGUOUS and stays AMBIGUOUS, whatever any
confidence says.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

#: A four-digit year is syntactically anything; a *plausible* publication year
#: is a narrower claim and earns its own confidence signal rather than being
#: enforced as a rule. `(Orwell, 1984)` is a citation; `(Ubuntu, 2204)` is
#: probably not, and PalCert records the difference instead of deciding it.
PLAUSIBLE_YEAR_RANGE = (1800, 2100)

#: Name particles that belong to the surname. Splitting `van Dijk` into `Dijk`
#: is how a match is lost, so they are kept attached — the same rule the
#: contract's own `CitationAuthorToken.normalizedFamily` states.
_PARTICLES = (
    "van",
    "von",
    "der",
    "den",
    "de",
    "del",
    "della",
    "da",
    "das",
    "dos",
    "di",
    "du",
    "la",
    "le",
    "ten",
    "ter",
    "bin",
    "ibn",
    "al",
)

_PARTICLE = "(?:" + "|".join(_PARTICLES) + ")"
#: One surname: up to two lowercase particles, then a capitalized word.
#:
#: The leading capital is doing almost all the safety work here. It is the
#: only deterministic signal a Latin-script text layer offers that separates a
#: name from an ordinary word, which is exactly why this module recognizes
#: nothing in Arabic script — see `docs/architecture/citations.md`.
_NAME_PUNCT = "'\\u2019\\u2010-\\u2015-"
_SURNAME = f"(?:{_PARTICLE}" + r"\s+" + "){0,2}" + f"[A-Z][A-Za-z{_NAME_PUNCT}]" + "{1,39}"

#: Words that pass the surname shape and are never an author. Closed, and
#: every entry earns its place from a false positive a real document produces.
_NEVER_AN_AUTHOR = frozenset(
    {
        # Dates. `(March, 2020)` is the single most common false positive.
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
        "jan",
        "feb",
        "mar",
        "apr",
        "jun",
        "jul",
        "aug",
        "sep",
        "sept",
        "oct",
        "nov",
        "dec",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "spring",
        "summer",
        "autumn",
        "winter",
        # Notices and front matter.
        "copyright",
        "copyrights",
        "revised",
        "updated",
        "accessed",
        "retrieved",
        "published",
        "submitted",
        "accepted",
        # Document furniture that is numbered and dated.
        "version",
        "revision",
        "edition",
        "volume",
        "issue",
        "chapter",
        "section",
        "appendix",
        "figure",
        "table",
        "equation",
        "page",
        "pages",
        "part",
        "draft",
        "release",
        "build",
    }
)

#: A segment naming a lawsuit. `(Smith v. Jones, 2020)` is a legal citation and
#: a different thing from an author-year one; PalCert declines rather than
#: reading the defendant as a co-author.
_LEGAL = re.compile(r"(?:^|\s)(?:v\.?|vs\.?)(?:\s|$)", re.IGNORECASE)

#: Separators between the author part and the year. The Arabic comma is here
#: because a bilingual document sets `(Smith، 2020)` with it, and the text
#: layer preserves it exactly.
_AUTHOR_YEAR_SEP = "[,،]?\\s*"

_YEAR = r"(\d{4}[a-z]?)"

#: `Smith`, `Smith & Jones`, `Smith and Jones`, `Smith et al.`
_AUTHORS = (
    rf"(?P<first>{_SURNAME})"
    rf"(?:\s*(?:&|and|و)\s*(?P<second>{_SURNAME})|\s*,?\s*(?P<etal>et\s+al\.?))?"
)

#: One parenthesised segment, anchored end to end. Nothing may precede the
#: author and nothing may follow the year.
_PARENTHETICAL = re.compile(rf"^\s*{_AUTHORS}{_AUTHOR_YEAR_SEP}{_YEAR}\s*$")

#: `Smith (2020)`, `Smith & Jones (2021)`, `Smith et al. (2022)`.
_NARRATIVE = re.compile(rf"{_AUTHORS}\s*\(\s*{_YEAR}\s*\)")

#: A parenthesised group, with no nesting. Bounded so a runaway open bracket
#: cannot make the scan quadratic.
_GROUP = re.compile("[(\\uFD3E]([^()\\uFD3E\\uFD3F]{1,200})[)\\uFD3F]")

#: Segment separators inside a group: `(Smith, 2020; Jones, 2021)`.
_SEGMENT_SPLIT = re.compile(r"[;؛]")

#: One author unit in a reference entry: a surname followed by initials.
#: Requiring the initials is what keeps an ordinary sentence out — a reference
#: list writes `Smith, J.` and prose does not.
_ENTRY_AUTHOR = re.compile(f"({_SURNAME})" + r",\s*(?:[A-Z]\.[\s\u2010-\u2015-]*)+")
#: The year a reference entry parenthesises: `Smith, J. (2020). Title.`
_ENTRY_YEAR = re.compile(rf"\(\s*{_YEAR}\s*\)")


class AuthorShape(StrEnum):
    """How many authors a citation or an entry names.

    Consulted **only** to break a tie between entries that already share an
    author-year identity. It never creates a match the identity did not
    already narrow, which is what keeps it a structural discriminator rather
    than a similarity score.
    """

    SINGLE = "SINGLE"
    PAIR = "PAIR"
    ET_AL = "ET_AL"


@dataclass(frozen=True, slots=True)
class AuthorYearCitation:
    """One recognized in-text author-year citation."""

    #: The surname as written, kept verbatim so normalization stays auditable.
    first_author: str
    #: The second surname, when the citation named exactly two authors.
    second_author: str | None
    shape: AuthorShape
    #: `2020`, or `2020a` when the document disambiguates that way.
    year: str
    #: Where in the line it was found, so the numeric family and this one can
    #: be kept from claiming the same characters.
    start: int
    end: int
    raw: str
    narrative: bool

    @property
    def identity(self) -> tuple[str, str]:
        return normalize_surname(self.first_author), self.year


@dataclass(frozen=True, slots=True)
class AuthorYearEntry:
    """A reference entry's parsed author-year identity, and nothing more.

    No title, no journal, no volume, no pages, no DOI. Every one of those is a
    separate parse with its own failure modes, and claiming one PalCert did
    not defensibly read would put invented bibliographic data in an artifact.
    """

    #: Every surname the entry names, in order, as written.
    authors: tuple[str, ...]
    shape: AuthorShape
    year: str
    #: Where the parenthesised year ended in the entry's text. Checkpoint 12
    #: anchors a title on it: what follows the year is the only place in an
    #: author-year entry where a title is structurally determined.
    year_end: int = 0

    @property
    def identity(self) -> tuple[str, str]:
        return normalize_surname(self.authors[0]), self.year


def normalize_surname(surname: str) -> str:
    """The identity token two surnames are compared by.

    Case folding and nothing else. No diacritic stripping, no transliteration,
    no initial-only fallback, no edit distance — every one of those turns a
    comparison into a judgement, and a wrong judgement here silently points a
    citation at the wrong work.
    """
    return " ".join(surname.split()).casefold()


def _shape(second: str | None, etal: str | None) -> AuthorShape:
    if etal:
        return AuthorShape.ET_AL
    return AuthorShape.PAIR if second else AuthorShape.SINGLE


def is_never_an_author(name: str) -> bool:
    """Is this word one that is never a surname?

    Exported so the Vancouver entry grammar shares the one closed list rather
    than growing a second that could drift from it.
    """
    return _rejected(name)


def _rejected(*names: str | None) -> bool:
    """Is any of these words something that is never an author?"""
    for name in names:
        if name is None:
            continue
        last = name.split()[-1] if name.split() else name
        if last.casefold() in _NEVER_AN_AUTHOR:
            return True
    return False


def parse_segment(segment: str) -> tuple[str, str | None, AuthorShape, str] | None:
    """One parenthesised segment, parsed completely or not at all."""
    if _LEGAL.search(segment):
        return None
    match = _PARENTHETICAL.match(segment)
    if match is None:
        return None
    first = match.group("first")
    second = match.group("second")
    if _rejected(first, second):
        return None
    return first, second, _shape(second, match.group("etal")), match.group(4)


def find_citations(text: str) -> list[AuthorYearCitation]:
    """Every author-year citation in one line, in the order they appear.

    Parenthesised groups first, then narrative forms in what is left. A
    narrative match inside a group already claimed is dropped: `(Smith, 2020)`
    and `Smith (2020)` are the same citation written two ways, never two
    citations.
    """
    found: list[tuple[int, int, AuthorYearCitation]] = []
    claimed: list[tuple[int, int]] = []
    order = 0

    for group in _GROUP.finditer(text):
        inner = group.group(1)
        parsed = [parse_segment(part) for part in _SEGMENT_SPLIT.split(inner)]
        if not parsed or any(item is None for item in parsed):
            # All of it or none of it. `(see Smith, 2020)` and
            # `(Smith, 2020; personal communication)` are refused whole rather
            # than harvested for the part that looked familiar.
            continue
        for item in parsed:
            if item is None:  # pragma: no cover - the guard above excludes it
                continue
            first, second, shape, year = item
            found.append(
                (
                    group.start(),
                    order,
                    AuthorYearCitation(
                        first_author=first,
                        second_author=second,
                        shape=shape,
                        year=year,
                        start=group.start(),
                        end=group.end(),
                        raw=group.group(0),
                        narrative=False,
                    ),
                )
            )
            order += 1
        claimed.append((group.start(), group.end()))

    for match in _NARRATIVE.finditer(text):
        if any(start < match.end() and match.start() < end for start, end in claimed):
            continue
        first = match.group("first")
        second = match.group("second")
        if _rejected(first, second):
            continue
        found.append(
            (
                match.start(),
                order,
                AuthorYearCitation(
                    first_author=first,
                    second_author=second,
                    shape=_shape(second, match.group("etal")),
                    year=match.group(4),
                    start=match.start(),
                    end=match.end(),
                    raw=match.group(0),
                    narrative=True,
                ),
            )
        )
        order += 1

    # Document order, and within one group the order the author wrote them.
    # `(Smith, 2020; Jones, 2021)` is two citations and Smith is the first.
    found.sort(key=lambda item: (item[0], item[1]))
    return [citation for _, _, citation in found]


def parse_entry(text: str) -> AuthorYearEntry | None:
    """A reference entry's authors and year, or nothing.

    The entry has to open with a surname and initials — `Smith, J.` — and
    parenthesise a year. That is narrow on purpose: it is the shape an
    author-year reference list uses and an ordinary paragraph does not, and
    widening it is how a body paragraph becomes a reference entry.
    """
    authors = [match.group(1) for match in _ENTRY_AUTHOR.finditer(text)]
    if not authors or _ENTRY_AUTHOR.match(text.lstrip()) is None:
        return None
    if _rejected(authors[0]):
        return None

    year_match = _ENTRY_YEAR.search(text)
    if year_match is None:
        return None

    if "et al" in text[: year_match.start()].casefold() or len(authors) >= 3:
        shape = AuthorShape.ET_AL
    elif len(authors) == 2:
        shape = AuthorShape.PAIR
    else:
        shape = AuthorShape.SINGLE

    return AuthorYearEntry(
        authors=tuple(authors),
        shape=shape,
        year=year_match.group(1),
        year_end=year_match.end(),
    )


def year_is_plausible(year: str) -> bool:
    low, high = PLAUSIBLE_YEAR_RANGE
    return low <= int(year[:4]) <= high
