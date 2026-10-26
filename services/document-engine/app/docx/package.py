"""The OPC package: parts, content types and relationships (§19).

A DOCX is an Open Packaging Convention package, and OPC is explicit that a
part is found through a *relationship*, not at a fixed path. Word normally
writes ``word/styles.xml``, but it is free not to, and generators other than
Word regularly do not. An analyzer that hard-codes paths reports "no styles"
for a perfectly good document — silently, and with confident coverage.

So parts are resolved the way the specification says: the package
relationships name the main document, and the main document's own
relationships name styles, numbering, theme, headers, footers and notes.

Two rules are absolute here:

* **An external relationship never causes a fetch** (§19). Its target is
  recorded as data. The analyzer makes no network call of any kind.
* **A target never escapes the package.** Resolution is pure string work over
  ZIP entry names, and a target that walks above the root is refused rather
  than resolved to a filesystem path.
"""

from __future__ import annotations

import posixpath
import zipfile
from dataclasses import dataclass
from typing import IO, Self
from xml.etree.ElementTree import Element

from app.docx.errors import DocxAnalysisError, DocxErrorCode
from app.docx.limits import AnalyzerLimits, ResourceLimitExceededError
from app.docx.namespaces import (
    NS_PACKAGE_RELATIONSHIPS,
    Namespaces,
    OoxmlProfile,
    detect_profile,
    relationship_kind,
)
from app.docx.warnings import WarningCode, WarningCollector
from app.docx.xmlsafe import parse_xml_bytes, parse_xml_stream

PACKAGE_RELATIONSHIPS_PART = "_rels/.rels"
CONTENT_TYPES_PART = "[Content_Types].xml"

#: Relationship kinds the analyzer looks up, by their stable final segment.
REL_OFFICE_DOCUMENT = "officeDocument"
REL_STYLES = "styles"
REL_NUMBERING = "numbering"
REL_THEME = "theme"
REL_HEADER = "header"
REL_FOOTER = "footer"
REL_FOOTNOTES = "footnotes"
REL_ENDNOTES = "endnotes"
REL_COMMENTS = "comments"
REL_SETTINGS = "settings"
REL_IMAGE = "image"
REL_HYPERLINK = "hyperlink"
REL_CORE_PROPERTIES = "core-properties"
REL_EXTENDED_PROPERTIES = "extended-properties"
REL_CUSTOM_PROPERTIES = "custom-properties"


@dataclass(frozen=True, slots=True)
class Relationship:
    id: str
    kind: str
    target: str
    external: bool
    #: Resolved part name inside the package; empty for an external target.
    part_name: str


@dataclass(frozen=True, slots=True)
class RelationshipSet:
    """One part's relationships, indexed by id and by kind."""

    source_part: str
    by_id: dict[str, Relationship]

    def get(self, relationship_id: str) -> Relationship | None:
        return self.by_id.get(relationship_id)

    def of_kind(self, kind: str) -> tuple[Relationship, ...]:
        """Every internal relationship of one kind, in canonical id order."""
        return tuple(
            sorted(
                (rel for rel in self.by_id.values() if rel.kind == kind and not rel.external),
                key=lambda rel: rel.id,
            )
        )

    def first_of_kind(self, kind: str) -> Relationship | None:
        found = self.of_kind(kind)
        return found[0] if found else None


def _resolve_target(source_part: str, target: str) -> str:
    """A relationship target as a package part name.

    Pure string resolution over ZIP entry names — never a filesystem path, so
    ``../`` cannot reach outside anything. A target that walks above the
    package root is refused: no part can live there, so the package is wrong.
    """
    cleaned = target.split("#", 1)[0].replace("\\", "/")
    if not cleaned:
        return ""
    if cleaned.startswith("/"):
        return cleaned.lstrip("/")

    base = posixpath.dirname(source_part)
    joined = (
        posixpath.normpath(posixpath.join(base, cleaned)) if base else posixpath.normpath(cleaned)
    )
    if joined.startswith("..") or joined.startswith("/"):
        raise DocxAnalysisError(
            DocxErrorCode.PACKAGE_INVALID, "a relationship target escapes the package"
        )
    return joined


def _relationships_part_for(part_name: str) -> str:
    directory = posixpath.dirname(part_name)
    base = posixpath.basename(part_name)
    return posixpath.join(directory, "_rels", f"{base}.rels") if directory else f"_rels/{base}.rels"


class DocxPackage:
    """A read-only view of one DOCX package.

    Opened from bytes that Phase 5 already validated as a safe archive; this
    class adds the OOXML-specific reading on top, never re-deciding whether
    the archive itself is safe.
    """

    __slots__ = (
        "_archive",
        "_content_types",
        "_limits",
        "_names",
        "_rels",
        "_total_xml_bytes",
        "warnings",
    )

    def __init__(
        self,
        archive: zipfile.ZipFile,
        limits: AnalyzerLimits,
        warnings: WarningCollector,
    ) -> None:
        self._archive = archive
        self._limits = limits
        self.warnings = warnings
        self._names = frozenset(archive.namelist())
        self._rels: dict[str, RelationshipSet] = {}
        self._content_types: dict[str, str] = {}
        self._total_xml_bytes = 0

    @classmethod
    def open(
        cls,
        source: IO[bytes] | str | zipfile.ZipFile,
        limits: AnalyzerLimits,
        warnings: WarningCollector,
    ) -> Self:
        """Open a package for reading.

        A classmethod rather than a staticmethod so a subclass opens as itself:
        Phase 12 needs a package that keeps the element trees it parses, and
        having it re-implement the content-type load to get one would be two
        copies of the same start-up sequence.
        """
        if isinstance(source, zipfile.ZipFile):
            archive = source
        else:
            try:
                archive = zipfile.ZipFile(source)
            except zipfile.BadZipFile as error:
                raise DocxAnalysisError(
                    DocxErrorCode.PACKAGE_INVALID, "not a readable ZIP package"
                ) from error
        package = cls(archive, limits, warnings)
        package._load_content_types()
        return package

    def close(self) -> None:
        self._archive.close()

    # -- parts --------------------------------------------------------------

    def has_part(self, part_name: str) -> bool:
        return part_name in self._names

    def part_names(self) -> frozenset[str]:
        """Every entry in the package, whether or not it is a declared part.

        Exposed because some questions are about the package rather than about
        any part of it — whether it carries a digital signature, for one.
        """
        return self._names

    def read_bytes(self, part_name: str) -> bytes:
        if part_name not in self._names:
            raise DocxAnalysisError(DocxErrorCode.PACKAGE_INVALID, f"missing part {part_name}")
        info = self._archive.getinfo(part_name)
        if info.file_size > self._limits.max_part_bytes:
            raise ResourceLimitExceededError("max_part_bytes", self._limits.max_part_bytes)
        self._account(info.file_size)
        with self._archive.open(part_name) as stream:
            return stream.read(self._limits.max_part_bytes + 1)[: self._limits.max_part_bytes]

    def parse_part(self, part_name: str) -> Element:
        """Parse one XML part into an element tree, bounded as it is read."""
        if part_name not in self._names:
            raise DocxAnalysisError(DocxErrorCode.PACKAGE_INVALID, f"missing part {part_name}")
        info = self._archive.getinfo(part_name)
        if info.file_size > self._limits.max_part_bytes:
            raise ResourceLimitExceededError("max_part_bytes", self._limits.max_part_bytes)
        self._account(info.file_size)
        with self._archive.open(part_name) as stream:
            return parse_xml_stream(stream, self._limits)

    def parse_optional_part(self, part_name: str) -> Element | None:
        """Parse a part that may legitimately be absent.

        A part that is *referenced* but unreadable is a warning plus degraded
        coverage, never a substituted value (§77).
        """
        if part_name not in self._names:
            return None
        try:
            return self.parse_part(part_name)
        except DocxAnalysisError as error:
            self.warnings.add(WarningCode.PART_UNREADABLE, part=part_name, reason=str(error.code))
            return None

    def _account(self, size: int) -> None:
        self._total_xml_bytes += size
        if self._total_xml_bytes > self._limits.max_total_xml_bytes:
            raise ResourceLimitExceededError(
                "max_total_xml_bytes", self._limits.max_total_xml_bytes
            )

    # -- content types ------------------------------------------------------

    def _load_content_types(self) -> None:
        if CONTENT_TYPES_PART not in self._names:
            raise DocxAnalysisError(
                DocxErrorCode.PACKAGE_INVALID, "the package has no [Content_Types].xml"
            )
        root = parse_xml_bytes(self.read_bytes(CONTENT_TYPES_PART), self._limits)
        for child in root:
            tag = child.tag.rpartition("}")[2]
            if tag == "Override":
                name = (child.get("PartName") or "").lstrip("/")
                content_type = child.get("ContentType") or ""
                if name:
                    self._content_types[name] = content_type
            elif tag == "Default":
                extension = (child.get("Extension") or "").lower()
                if extension:
                    self._content_types[f"*.{extension}"] = child.get("ContentType") or ""

    def content_type_of(self, part_name: str) -> str:
        direct = self._content_types.get(part_name)
        if direct is not None:
            return direct
        extension = posixpath.splitext(part_name)[1].lstrip(".").lower()
        return self._content_types.get(f"*.{extension}", "")

    def content_types(self) -> dict[str, str]:
        return dict(self._content_types)

    # -- relationships ------------------------------------------------------

    def relationships_of(self, part_name: str) -> RelationshipSet:
        """The relationships declared by one part, loaded once."""
        cached = self._rels.get(part_name)
        if cached is not None:
            return cached

        rels_part = (
            PACKAGE_RELATIONSHIPS_PART if part_name == "" else _relationships_part_for(part_name)
        )
        by_id: dict[str, Relationship] = {}
        if rels_part in self._names:
            root = parse_xml_bytes(self.read_bytes(rels_part), self._limits)
            expected = f"{{{NS_PACKAGE_RELATIONSHIPS}}}Relationship"
            for child in root:
                if child.tag != expected:
                    continue
                if len(by_id) >= self._limits.max_relationships:
                    raise ResourceLimitExceededError(
                        "max_relationships", self._limits.max_relationships
                    )
                relationship_id = child.get("Id") or ""
                target = child.get("Target") or ""
                external = (child.get("TargetMode") or "").lower() == "external"
                if not relationship_id:
                    continue
                by_id[relationship_id] = Relationship(
                    id=relationship_id,
                    kind=relationship_kind(child.get("Type") or ""),
                    target=target,
                    external=external,
                    # An external target is data. It is never resolved, never
                    # opened, never fetched.
                    part_name="" if external else _resolve_target(part_name, target),
                )

        resolved = RelationshipSet(source_part=part_name, by_id=by_id)
        self._rels[part_name] = resolved
        return resolved

    def part_for_relationship(self, source_part: str, relationship_id: str | None) -> str | None:
        """The part a relationship id points at, or None with a warning.

        A dangling relationship is reported, never guessed at (§77).
        """
        if not relationship_id:
            return None
        relationship = self.relationships_of(source_part).get(relationship_id)
        if relationship is None or relationship.external:
            self.warnings.add(
                WarningCode.RELATIONSHIP_TARGET_MISSING,
                part=source_part,
                relationshipId=relationship_id,
            )
            return None
        if not self.has_part(relationship.part_name):
            self.warnings.add(
                WarningCode.RELATIONSHIP_TARGET_MISSING,
                part=source_part,
                relationshipId=relationship_id,
            )
            return None
        return relationship.part_name

    # -- the main document --------------------------------------------------

    def main_document_part(self) -> str:
        """The main document part, found through the package relationships."""
        package_rels = self.relationships_of("")
        relationship = package_rels.first_of_kind(REL_OFFICE_DOCUMENT)
        if relationship is None or not self.has_part(relationship.part_name):
            # A package with no officeDocument relationship is not a
            # WordprocessingML document, whatever its file extension says.
            raise DocxAnalysisError(DocxErrorCode.PACKAGE_INVALID, "no officeDocument relationship")
        return relationship.part_name


def resolve_namespaces(root_tag: str) -> Namespaces:
    """The namespace set for a main document root, or an explicit failure.

    Refusing an unknown profile is the point: parsing a Strict package with
    Transitional names finds nothing and would report an empty document as
    COMPLETE (§20).
    """
    profile: OoxmlProfile | None = detect_profile(root_tag)
    if profile is None:
        raise DocxAnalysisError(
            DocxErrorCode.PROFILE_UNSUPPORTED, "unrecognized WordprocessingML namespace"
        )
    return Namespaces.for_profile(profile)
