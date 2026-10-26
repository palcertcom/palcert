"""Structured parsing of a recognized reference entry (Phase 18, Checkpoint 12).

Checkpoints 10 and 11 found reference entries. This reads what is inside one.

Nothing here discovers a citation or changes a link. It takes an entry PalCert
has already segmented and pulls out the fields a reader would write down —
year, surnames, title, DOI, URL — under one rule that decides every case:

    **the raw text is the source of truth, and a field is emitted only when it
    is an exact substring of it.**

That is not a slogan. A parsed field is rendered by an evidence panel as
though PalCert read it, so a title assembled from fragments, a DOI with its
punctuation cleaned up, or a journal name inferred from position would all be
PalCert's prose presented as the document's. Every value here can be found in
``rawText`` with ``in``, and a test sweeps every entry to prove it.

Three consequences follow, and each is the conservative answer:

* **A title that cannot be delimited is absent.** The grammar cuts at the
  first sentence break, so `Water rights in the U.S. basin.` would yield
  `Water rights in the U.S` — a mangled title that still looks like one. Any
  candidate containing a period is refused outright.
* **An identifier whose end PalCert cannot determine carries no identity.** A
  DOI suffix may legitimately end in `.`, `,`, `;`, `)` or `]`, so a candidate
  ending in one of those is recorded with ``boundaryStatus: AMBIGUOUS`` and
  **no** ``normalized`` value. The evidence is kept; the identity is not
  claimed, and nothing can match on it.
* **Nothing is verified.** Every check is offline syntax. No resolver, no
  Crossref, no network of any kind — ``syntaxStatus`` says the shape is
  well-formed and never that the work exists.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: Maximal DOI shape: the `10.` prefix, a registrant code, a slash, a suffix.
#:
#: The suffix is taken greedily and trimmed afterwards rather than being
#: guessed at up front, because where a DOI ends is the genuinely hard part
#: and doing it in one pattern would bury that decision in a character class.
_DOI_CORE = re.compile(r"10\.\d{4,9}(?:\.\d+)*/\S+")

#: A `doi:` or `DOI -` label. What the contract calls LABEL_PREFIX: the
#: document saying outright that what follows is a DOI.
_DOI_LABEL = re.compile(r"\bdoi\s*[:\-]\s*", re.IGNORECASE)

#: The resolver hosts. What the contract calls RESOLVER_HOST.
_DOI_RESOLVER = re.compile(r"https?://(?:dx\.)?doi\.org/", re.IGNORECASE)

#: An explicit URL. A scheme is required — `www.example.com` is not promoted
#: to a URL here, because inferring the scheme is inventing part of the value.
_URL = re.compile(r"https?://\S+", re.IGNORECASE)

#: Characters a value may not be trusted to end on. Straight from the
#: contract: a DOI suffix may legitimately contain and end with any of them,
#: so PalCert cannot tell content from sentence punctuation.
_AMBIGUOUS_TAIL = ".,;)]"

#: Trailing characters that are never part of a value and carry no ambiguity:
#: quotation marks and whitespace close nothing a DOI or URL may contain.
_ALWAYS_TRIM = "\"'\u201c\u201d\u2018\u2019<>\u00a0 \t"

#: A title candidate ends at the first sentence break. Period-space, or the
#: end of the entry.
_SENTENCE_BREAK = re.compile(r"\.\s")

#: `Journal of Policy, 12(3), 45-67` — the shape that confirms the segment
#: before it is a container title rather than a publisher or a series. Volume,
#: issue and page range are parsed here as the *evidence* for that, and are
#: deliberately not emitted: they are outside this checkpoint's field list.
_VOLUME_ISSUE_PAGES = re.compile(
    r"^(?P<container>[^.,]{2,300}),\s*"
    r"\d{1,4}\s*(?:\(\s*\d{1,4}\s*\))?\s*,\s*"
    r"(?:[A-Za-z]?\d{1,6}\s*[\\u2010-\\u2015-]\s*[A-Za-z]?\d{1,6}|e?\d{1,9})\s*\.?\s*$"
)

MAX_IDENTIFIERS = 6
MAX_TITLE_CHARS = 400
MAX_CONTAINER_CHARS = 300
MAX_IDENTIFIER_CHARS = 200


class Scheme:
    DOI = "DOI"
    URL = "URL"


class Intent:
    LABEL_PREFIX = "LABEL_PREFIX"
    RESOLVER_HOST = "RESOLVER_HOST"
    URL_SCHEME = "URL_SCHEME"
    NONE = "NONE"


class Boundary:
    UNAMBIGUOUS = "UNAMBIGUOUS"
    AMBIGUOUS = "AMBIGUOUS"


class Syntax:
    VALID = "VALID"
    INVALID = "INVALID"


@dataclass(frozen=True, slots=True)
class Identifier:
    """One identifier observed in a reference entry.

    ``raw`` is always an exact substring of the entry. ``normalized`` is the
    identity other things may match on, and is **absent** whenever PalCert
    could not determine the value's end or its shape.
    """

    scheme: str
    raw: str
    normalized: str | None
    intent: str
    boundary: str
    syntax: str


@dataclass(frozen=True, slots=True)
class ParsedBibliography:
    """What a reference entry defensibly said about itself."""

    title: str | None = None
    container_title: str | None = None
    identifiers: tuple[Identifier, ...] = ()


def _trim(value: str) -> tuple[str, bool]:
    """Strip what is never part of a value; report whether the end is certain.

    Returns the trimmed text and whether its boundary is *ambiguous* — true
    when the remaining last character is one a DOI suffix could legitimately
    end with.
    """
    trimmed = value.strip(_ALWAYS_TRIM)
    return trimmed, bool(trimmed) and trimmed[-1] in _AMBIGUOUS_TAIL


def normalize_doi(core: str) -> str:
    """The identity value for a DOI, computed offline and nothing else.

    Case folding only. DOIs are case-insensitive for comparison, so folding is
    an identity-preserving transformation — unlike percent-decoding, which can
    change what the suffix says and is therefore left alone.
    """
    return core.casefold()


def normalize_url(url: str) -> str:
    """A URL's identity, normalized only where normalization is safe.

    The scheme and host are case-insensitive by RFC 3986, so folding them
    changes nothing. The path, query and fragment are case-*sensitive* and are
    left exactly as written — and nothing is resolved, expanded, followed or
    stripped, because every one of those changes what the value points at.
    """
    match = re.match(r"(https?)://([^/?#]*)(.*)", url, re.IGNORECASE)
    if match is None:  # pragma: no cover - the caller matched _URL first
        return url
    scheme, host, rest = match.groups()
    return f"{scheme.lower()}://{host.lower()}{rest}"


def _doi_at(text: str, start: int, intent: str) -> Identifier | None:
    """Read a DOI beginning at ``start``, with the intent already established."""
    match = _DOI_CORE.match(text, start)
    if match is None:
        return None
    raw, ambiguous = _trim(match.group(0))
    if not raw:
        return None
    return Identifier(
        scheme=Scheme.DOI,
        raw=raw[:MAX_IDENTIFIER_CHARS],
        # An identity is claimed only when the end of the value was
        # determinable. Otherwise the evidence stands and nothing may match
        # on it, which is what keeps an uncertain read out of a link.
        normalized=None if ambiguous else normalize_doi(raw)[:MAX_IDENTIFIER_CHARS],
        intent=intent,
        boundary=Boundary.AMBIGUOUS if ambiguous else Boundary.UNAMBIGUOUS,
        syntax=Syntax.VALID,
    )


def _malformed_doi(text: str, label_end: int) -> Identifier | None:
    """A `doi:` label whose value is not a DOI.

    Recorded rather than dropped: the document explicitly said "DOI" and then
    wrote something that is not one, which is a real observation about the
    document. It carries no ``normalized`` value, so nothing can match on it.
    """
    token = text[label_end:].split()[0] if text[label_end:].split() else ""
    raw, _ = _trim(token)
    if not raw:
        return None
    return Identifier(
        scheme=Scheme.DOI,
        raw=raw[:MAX_IDENTIFIER_CHARS],
        normalized=None,
        intent=Intent.LABEL_PREFIX,
        boundary=Boundary.UNAMBIGUOUS,
        syntax=Syntax.INVALID,
    )


def find_identifiers(text: str) -> list[Identifier]:
    """Every DOI and URL the entry states explicitly, in the order written.

    Three DOI forms, ranked by how plainly the document declares its intent: a
    resolver URL, a `doi:` label, and a bare `10.xxxx/...`. A bare one is
    recorded with ``intentEvidence: NONE``, exactly as the contract provides
    for — the shape is distinctive enough to be evidence and not distinctive
    enough to be a declaration.

    A resolver URL is a DOI, not also a plain URL: reporting it twice would
    make one identifier look like two pieces of evidence.
    """
    found: list[Identifier] = []
    claimed: list[tuple[int, int]] = []

    def take(identifier: Identifier | None, start: int, end: int) -> None:
        if identifier is None:
            return
        if any(low < end and start < high for low, high in claimed):
            return
        found.append(identifier)
        claimed.append((start, end))

    # 1. Resolver URLs, which say "DOI" through their host.
    for match in _DOI_RESOLVER.finditer(text):
        identifier = _doi_at(text, match.end(), Intent.RESOLVER_HOST)
        if identifier is None:
            continue
        whole, ambiguous = _trim(text[match.start() : match.end() + len(identifier.raw)])
        take(
            Identifier(
                scheme=Scheme.DOI,
                # The raw value is what the document wrote, resolver and all,
                # so the normalization to a bare core stays auditable.
                raw=whole[:MAX_IDENTIFIER_CHARS],
                normalized=None if ambiguous else identifier.normalized,
                intent=Intent.RESOLVER_HOST,
                boundary=Boundary.AMBIGUOUS if ambiguous else Boundary.UNAMBIGUOUS,
                syntax=Syntax.VALID,
            ),
            match.start(),
            match.end() + len(identifier.raw),
        )

    # 2. `doi:` labels.
    for match in _DOI_LABEL.finditer(text):
        identifier = _doi_at(text, match.end(), Intent.LABEL_PREFIX)
        if identifier is not None:
            take(identifier, match.start(), match.end() + len(identifier.raw))
        else:
            malformed = _malformed_doi(text, match.end())
            if malformed is not None:
                take(malformed, match.start(), match.end() + len(malformed.raw))

    # 3. Explicit URLs that are not DOI resolvers, claimed **before** bare
    #    DOIs. A URL owns its whole extent, and a path segment that happens to
    #    look like a DOI — `https://example.org/papers/10.1234/abc.pdf` — is
    #    part of the address, not an identifier the document stated. Reading
    #    it as one would invent a DOI and lose the URL at the same time.
    for match in _URL.finditer(text):
        raw, ambiguous = _trim(match.group(0))
        if not raw or _DOI_RESOLVER.match(raw):
            continue
        take(
            Identifier(
                scheme=Scheme.URL,
                raw=raw[:MAX_IDENTIFIER_CHARS],
                normalized=None if ambiguous else normalize_url(raw)[:MAX_IDENTIFIER_CHARS],
                intent=Intent.URL_SCHEME,
                boundary=Boundary.AMBIGUOUS if ambiguous else Boundary.UNAMBIGUOUS,
                syntax=Syntax.VALID,
            ),
            match.start(),
            match.start() + len(raw),
        )

    # 4. Bare DOIs, in whatever text nothing else has claimed.
    for match in _DOI_CORE.finditer(text):
        take(_doi_at(text, match.start(), Intent.NONE), match.start(), match.end())

    found.sort(key=lambda item: text.find(item.raw))
    return found[:MAX_IDENTIFIERS]


def parse_title(text: str, *, after: int) -> tuple[str | None, int]:
    """The sentence following the year, when it can be delimited at all.

    Returns the title and where it ended, so a caller can look for a container
    after it without re-splitting the entry.

    A candidate containing a period is refused. The grammar cuts at the first
    sentence break, so `Water rights in the U.S. basin.` cuts to
    `Water rights in the U.S` — which still *looks* like a title, and is the
    exact failure this rule exists to prevent. Refusing every candidate with
    an internal period costs the titles that legitimately contain one and
    buys never publishing a mangled one.
    """
    remainder = text[after:]
    break_match = _SENTENCE_BREAK.search(remainder)
    candidate = remainder[: break_match.start()] if break_match else remainder.rstrip(". ")
    end = after + (break_match.end() if break_match else len(remainder))

    candidate = candidate.strip().strip("“”\"'").strip()
    if not candidate or "." in candidate:
        return None, end
    if len(candidate) < 2 or len(candidate) > MAX_TITLE_CHARS:
        return None, end
    if not any(character.isalpha() for character in candidate):
        return None, end
    return candidate, end


def parse_container(text: str, *, after: int) -> str | None:
    """The journal, but only when volume, issue and pages confirm it is one.

    A segment sitting after the title could be a journal, a publisher, a
    series, a conference or a thesis institution, and position alone does not
    say which. `Journal of Policy, 12(3), 45-67` does say: the
    volume-issue-pages shape is a journal article's and nothing else's.

    That shape is parsed here purely as the confirmation. Volume, issue and
    pages are not emitted — they are outside this checkpoint's field list, and
    claiming a field because it happened to be parseable is how scope creeps
    into an artifact.
    """
    remainder = text[after:].strip()
    if not remainder:
        return None
    match = _VOLUME_ISSUE_PAGES.match(remainder)
    if match is None:
        return None
    container = match.group("container").strip()
    if len(container) < 2 or len(container) > MAX_CONTAINER_CHARS:
        return None
    if not any(character.isalpha() for character in container):
        return None
    return container


def parse_entry_text(text: str, *, year_end: int | None) -> ParsedBibliography:
    """Everything this module reads out of one reference entry.

    ``year_end`` is where the entry's parenthesised year finished, which the
    author-year parser already established. Without it there is no anchor for
    a title, so only identifiers are read — position means nothing in an entry
    PalCert could not find a year in.
    """
    identifiers = tuple(find_identifiers(text))
    if year_end is None:
        return ParsedBibliography(identifiers=identifiers)

    after_year = text[year_end:].lstrip(". \u00a0")
    offset = year_end + (len(text[year_end:]) - len(after_year))
    title, title_end = parse_title(text, after=offset)
    container = parse_container(text, after=title_end) if title is not None else None
    return ParsedBibliography(title=title, container_title=container, identifiers=identifiers)
