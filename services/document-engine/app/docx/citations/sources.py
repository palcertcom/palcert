"""The Word bibliography source store (Phase 18, Checkpoint 3).

Word keeps the sources an author entered in its source manager as a *custom
XML part*. Nothing in the package says "bibliography": the part is reached
through an ordinary ``customXml`` relationship, exactly like any other custom
XML a document carries, and its path is whatever the producer chose. Both
facts matter, because the two obvious shortcuts are wrong:

* there is no bibliography relationship type to look up, so the relationship
  kind cannot identify the part;
* ``customXml/item1.xml`` is a convention Word happens to follow and other
  producers do not, so the path cannot identify it either.

What identifies it is the part's own root element: ``Sources`` in the
bibliography namespace. So every ``customXml`` relationship is resolved and
the root of each is *peeked at*, and the part that says what it is becomes the
source store. A part that says something else is left alone.

The discovery outcome is then coverage, not a guess:

* exactly one classified part → the source set is exact;
* no ``customXml`` part is a source store → the store is proven absent, and
  zero sources is a true zero rather than a missing answer;
* more than one → PalCert cannot say which store the document's citations
  resolve against, so the count is UNAVAILABLE rather than a sum;
* a part that will not parse → UNAVAILABLE, never "the ones we could read".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from xml.etree.ElementTree import Element

from app.docx.package import DocxPackage
from app.engine.rules.patterns import PatternName, match_pattern

#: Word's bibliography namespace. The 2004/10 URI is what Word writes and what
#: every version since has kept; it is the element's identity, not a version
#: of PalCert's.
NS_BIBLIOGRAPHY = "http://schemas.microsoft.com/office/word/2004/10/bibliography"

#: The relationship kind custom XML parts arrive under — an ordinary one.
REL_CUSTOM_XML = "customXml"

_SOURCES_ROOT = f"{{{NS_BIBLIOGRAPHY}}}Sources"

#: How many sources one store may contribute before the store is truncated.
MAX_SOURCES = 5000
#: Contract bounds that are reproduced here so a long value is trimmed rather
#: than failing the artifact contract at the last moment.
MAX_TAG_CHARS = 64
MAX_TITLE_CHARS = 400
MAX_CONTAINER_CHARS = 300
MAX_PUBLISHER_CHARS = 200
MAX_YEAR_CHARS = 8
MAX_AUTHORS = 32
MAX_IDENTIFIERS = 6
MAX_IDENTIFIER_CHARS = 200
MAX_SOURCE_TYPE_CHARS = 40


class SourceStoreStatus(StrEnum):
    """What discovery established about the store as a whole."""

    #: One store, read completely. The source set is exact.
    EXACT = "EXACT"
    #: No custom XML part is a bibliography source store.
    ABSENT = "ABSENT"
    #: More than one store, so no single set is the document's.
    AMBIGUOUS = "AMBIGUOUS"
    #: A store exists and could not be read.
    UNREADABLE = "UNREADABLE"


@dataclass(frozen=True, slots=True)
class SourceAuthor:
    raw: str
    normalized_family: str | None
    corporate: bool


@dataclass(frozen=True, slots=True)
class SourceIdentifier:
    scheme: str
    raw: str
    normalized: str | None
    syntax_status: str


@dataclass(frozen=True, slots=True)
class BibliographySourceRecord:
    tag: str
    source_type: str | None
    title: str | None
    container_title: str | None
    publisher: str | None
    year: str | None
    authors: tuple[SourceAuthor, ...]
    identifiers: tuple[SourceIdentifier, ...]


@dataclass(frozen=True, slots=True)
class SourceStore:
    status: SourceStoreStatus
    sources: tuple[BibliographySourceRecord, ...] = ()
    truncated: bool = False
    #: Tags that appeared on more than one source record. A duplicate tag
    #: makes tag matching ambiguous for those tags specifically, which is a
    #: different thing from the store being unreadable.
    duplicate_tags: tuple[str, ...] = field(default_factory=tuple)

    @property
    def exact(self) -> bool:
        return self.status is SourceStoreStatus.EXACT and not self.truncated


def discover_source_store(package: DocxPackage, main_part: str) -> SourceStore:
    """Find and read the bibliography source store, or say why there is none."""
    candidates: list[Element] = []
    unreadable = False

    for relationship in package.relationships_of(main_part).of_kind(REL_CUSTOM_XML):
        if not package.has_part(relationship.part_name):
            # A dangling custom XML relationship is already reported by the
            # package reader; for this purpose it is simply not a store.
            continue
        root = package.parse_optional_part(relationship.part_name)
        if root is None:
            # It might have been the store. Saying "no sources" here would
            # turn an unreadable part into a confident zero.
            unreadable = True
            continue
        if root.tag == _SOURCES_ROOT:
            candidates.append(root)

    if len(candidates) > 1:
        return SourceStore(status=SourceStoreStatus.AMBIGUOUS)
    if not candidates:
        if unreadable:
            return SourceStore(status=SourceStoreStatus.UNREADABLE)
        return SourceStore(status=SourceStoreStatus.ABSENT)
    if unreadable:
        # One readable store and one part we could not classify: the
        # unreadable part may have been a second store.
        return SourceStore(status=SourceStoreStatus.UNREADABLE)

    return _read_sources(candidates[0])


def _read_sources(root: Element) -> SourceStore:
    records: list[BibliographySourceRecord] = []
    seen: set[str] = set()
    duplicates: list[str] = []
    truncated = False

    for element in root.findall(f"{{{NS_BIBLIOGRAPHY}}}Source"):
        if len(records) >= MAX_SOURCES:
            truncated = True
            break
        tag = _text(element, "Tag", MAX_TAG_CHARS)
        if not tag:
            # A source with no tag cannot be cited by tag, so it is not a
            # target for anything and is not recorded as one.
            continue
        if tag in seen and tag not in duplicates:
            duplicates.append(tag)
        seen.add(tag)
        records.append(
            BibliographySourceRecord(
                tag=tag,
                source_type=_text(element, "SourceType", MAX_SOURCE_TYPE_CHARS),
                title=_text(element, "Title", MAX_TITLE_CHARS),
                container_title=_container_title(element),
                publisher=_text(element, "Publisher", MAX_PUBLISHER_CHARS),
                year=_text(element, "Year", MAX_YEAR_CHARS),
                authors=_authors(element),
                identifiers=_identifiers(element),
            )
        )

    return SourceStore(
        status=SourceStoreStatus.EXACT,
        sources=tuple(records),
        truncated=truncated,
        duplicate_tags=tuple(duplicates),
    )


def _text(parent: Element, name: str, limit: int) -> str | None:
    child = parent.find(f"{{{NS_BIBLIOGRAPHY}}}{name}")
    if child is None or child.text is None:
        return None
    value = child.text.strip()
    return value[:limit] if value else None


def _container_title(source: Element) -> str | None:
    """The containing work, whatever Word called it for this source type."""
    for name in ("JournalName", "BookTitle", "ConferenceName", "PublicationTitle"):
        value = _text(source, name, MAX_CONTAINER_CHARS)
        if value:
            return value
    return None


def _authors(source: Element) -> tuple[SourceAuthor, ...]:
    """Every person and corporate author, in document order.

    Word nests these three deep (``Author/Author/NameList/Person``) and uses a
    different shape for a corporate author. Both are read; neither is invented
    from the other.
    """
    authors: list[SourceAuthor] = []
    container = source.find(f"{{{NS_BIBLIOGRAPHY}}}Author")
    if container is None:
        return ()

    for role in container:
        corporate = role.find(f"{{{NS_BIBLIOGRAPHY}}}Corporate")
        if corporate is not None and corporate.text and corporate.text.strip():
            authors.append(
                SourceAuthor(
                    raw=corporate.text.strip()[:200],
                    normalized_family=None,
                    corporate=True,
                )
            )
        name_list = role.find(f"{{{NS_BIBLIOGRAPHY}}}NameList")
        if name_list is None:
            continue
        for person in name_list.findall(f"{{{NS_BIBLIOGRAPHY}}}Person"):
            author = _person(person)
            if author is not None:
                authors.append(author)
        if len(authors) >= MAX_AUTHORS:
            break

    return tuple(authors[:MAX_AUTHORS])


def _person(person: Element) -> SourceAuthor | None:
    last = _text(person, "Last", 200)
    first = _text(person, "First", 200)
    middle = _text(person, "Middle", 200)
    parts = [part for part in (first, middle, last) if part]
    if not parts:
        return None
    return SourceAuthor(
        raw=" ".join(parts)[:200],
        # Particles stay attached: splitting "van Dijk" into "Dijk" is how an
        # exact author match is lost. Word already gives the family name as
        # its own element, so nothing is being parsed out of a full name here.
        normalized_family=last.casefold()[:80] if last else None,
        corporate=False,
    )


def _identifiers(source: Element) -> tuple[SourceIdentifier, ...]:
    """Typed identifiers from named elements, never from scanning prose.

    Two things follow from the value arriving in its own element. The end of
    the value is the end of the element, so the boundary is never ambiguous —
    the trailing-punctuation problem that makes a DOI read out of a sentence
    unsafe simply does not arise here. And the *intent* is explicit: Word
    labelled the field ``DOI``, which is a stronger statement than a ``doi:``
    prefix in running text.
    """
    identifiers: list[SourceIdentifier] = []

    doi_raw = _text(source, "DOI", MAX_IDENTIFIER_CHARS)
    if doi_raw:
        normalized = _normalize_doi(doi_raw)
        identifiers.append(
            SourceIdentifier(
                scheme="DOI",
                raw=doi_raw,
                normalized=normalized,
                syntax_status=_syntax(PatternName.DOI, normalized),
            )
        )

    standard = _text(source, "StandardNumber", MAX_IDENTIFIER_CHARS)
    if standard:
        scheme, normalized = _classify_standard_number(standard)
        if scheme is not None:
            identifiers.append(
                SourceIdentifier(
                    scheme=scheme,
                    raw=standard,
                    normalized=normalized,
                    syntax_status=_syntax(
                        PatternName.ISBN if scheme == "ISBN" else PatternName.ISSN,
                        normalized,
                    ),
                )
            )

    url = _text(source, "URL", MAX_IDENTIFIER_CHARS)
    if url:
        identifiers.append(
            SourceIdentifier(
                scheme="URL",
                raw=url,
                normalized=url,
                syntax_status=_syntax(PatternName.URL, url),
            )
        )

    return tuple(identifiers[:MAX_IDENTIFIERS])


_DOI_RESOLVER_PREFIXES = (
    "https://doi.org/",
    "http://doi.org/",
    "https://dx.doi.org/",
    "http://dx.doi.org/",
    "doi:",
    "DOI:",
)


def _normalize_doi(raw: str) -> str | None:
    """A DOI in the core form the Phase 4 matcher expects.

    ``https://doi.org/10.1234/abc`` and ``10.1234/abc`` are the same identifier
    written two ways, and the matcher only recognizes the second. Normalizing
    is prefix removal and nothing else: no case folding of the suffix, which is
    case-sensitive, and no trimming of trailing punctuation, which may be part
    of the DOI.
    """
    value = raw.strip()
    for prefix in _DOI_RESOLVER_PREFIXES:
        if value.lower().startswith(prefix.lower()):
            value = value[len(prefix) :]
            break
    return value or None


def _classify_standard_number(raw: str) -> tuple[str | None, str | None]:
    """ISBN or ISSN from Word's one ``StandardNumber`` field.

    The field is untyped, so the value's own shape decides — and only when it
    decides unambiguously. An ISSN is four digits, a hyphen and four more; an
    ISBN is ten or thirteen characters once separators are removed. A value
    that is neither is recorded as no identifier at all rather than as a
    guessed one.
    """
    value = raw.strip()
    compact = value.replace("-", "").replace(" ", "")
    if match_pattern(PatternName.ISSN, value):
        return "ISSN", value
    if len(compact) in {10, 13} and match_pattern(PatternName.ISBN, compact):
        return "ISBN", compact
    return None, None


def _syntax(pattern: PatternName, value: str | None) -> str:
    """An offline syntax check. Never a statement that the identifier exists."""
    if value is None:
        return "NOT_CHECKED"
    return "VALID" if match_pattern(pattern, value) else "INVALID"
