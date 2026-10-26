"""The style catalogue: ``docDefaults``, styles, inheritance and cycles (§31, §32, §35, §76).

Reading the nearest XML property is not formatting resolution. A paragraph
that declares nothing may still be 14 pt bold Arial, because its style says
so, or because the style its style is based on says so, or because
``docDefaults`` says so. Any analyzer that skips this reports "no font"
for most real documents.

Three failure modes are handled explicitly rather than by crashing:

* **A missing parent** (``w:basedOn`` naming a style that is not there) —
  warning, and the chain simply ends. No value is substituted.
* **A cycle** (A based on B based on A) — detected, warned, and the chain is
  cut at the repeat. The policy is deliberate (§76): a cycle affects the
  styles involved, not the whole document, so PalCert degrades the affected
  fact domains to PARTIAL rather than refusing a document a user cannot fix.
* **A chain longer than the limit** — warned and cut, so a crafted file cannot
  make resolution quadratic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from xml.etree.ElementTree import Element

from app.docx.limits import AnalyzerLimits, ResourceLimitExceededError
from app.docx.namespaces import Namespaces
from app.docx.rawprops import (
    RawParagraphProperties,
    RawRunProperties,
    parse_paragraph_properties,
    parse_run_properties,
)
from app.docx.warnings import WarningCode, WarningCollector


class StyleType(StrEnum):
    PARAGRAPH = "paragraph"
    CHARACTER = "character"
    TABLE = "table"
    NUMBERING = "numbering"


@dataclass(frozen=True, slots=True)
class Style:
    style_id: str
    style_type: StyleType
    #: The display name. Localized and customizable, so never used to decide
    #: what a style *means* (§46).
    name: str | None
    based_on: str | None
    linked: str | None
    is_default: bool
    paragraph: RawParagraphProperties
    run: RawRunProperties
    #: True when the style carries ``w:tblStylePr`` conditional formatting,
    #: which Phase 6 does not resolve (§50).
    has_conditional_formatting: bool = False


@dataclass(frozen=True, slots=True)
class DocumentDefaults:
    """``w:docDefaults``: the base of every chain (§35).

    Absent entries stay absent. If neither the document nor any style states a
    property, PalCert reports it unresolved rather than filling in what Word
    would have chosen (§36).
    """

    run: RawRunProperties = field(default_factory=RawRunProperties.empty)
    paragraph: RawParagraphProperties = field(default_factory=RawParagraphProperties.empty)


@dataclass(frozen=True, slots=True)
class StyleCatalogue:
    """Every style in the document, plus the defaults and the default styles."""

    defaults: DocumentDefaults
    styles: dict[str, Style]
    default_style_ids: dict[StyleType, str]
    present: bool

    @staticmethod
    def empty() -> StyleCatalogue:
        return StyleCatalogue(
            defaults=DocumentDefaults(), styles={}, default_style_ids={}, present=False
        )

    def get(self, style_id: str | None) -> Style | None:
        return self.styles.get(style_id) if style_id else None

    def default_for(self, style_type: StyleType) -> Style | None:
        style_id = self.default_style_ids.get(style_type)
        return self.styles.get(style_id) if style_id else None

    def chain(
        self,
        style_id: str | None,
        warnings: WarningCollector,
        limits: AnalyzerLimits,
        expected_type: StyleType | None = None,
    ) -> tuple[Style, ...]:
        """The style's ancestry, **root first**.

        Root first is what makes application order trivial: each style
        overrides the one before it, so the caller simply applies the tuple in
        order. The walk is bounded and cycle-safe.
        """
        if not style_id:
            return ()

        chain: list[Style] = []
        seen: set[str] = set()
        current: str | None = style_id

        while current:
            if current in seen:
                warnings.add(WarningCode.STYLE_CYCLE, styleId=current)
                break
            if len(chain) >= limits.max_style_chain_depth:
                warnings.add(
                    WarningCode.STYLE_CHAIN_TOO_DEEP,
                    styleId=style_id,
                    depth=str(limits.max_style_chain_depth),
                )
                break

            style = self.styles.get(current)
            if style is None:
                # Only warn when a *parent* is missing. A paragraph naming a
                # style that does not exist is reported by the caller, which
                # knows whether the reference was the document's or a style's.
                if chain:
                    warnings.add(
                        WarningCode.STYLE_PARENT_MISSING,
                        styleId=current,
                        referencedBy=chain[-1].style_id,
                    )
                break

            if expected_type is not None and not chain and style.style_type is not expected_type:
                # OOXML: a reference to the wrong style type is ignored rather
                # than coerced — a character style named as a paragraph style
                # does not become one.
                warnings.add(
                    WarningCode.UNSUPPORTED_MARKUP,
                    styleId=current,
                    expected=str(expected_type),
                    found=str(style.style_type),
                )
                break

            seen.add(current)
            chain.append(style)
            current = style.based_on

        chain.reverse()
        return tuple(chain)

    def has_cycle_for(self, style_id: str | None, limits: AnalyzerLimits) -> bool:
        """Whether this style's ancestry contains a cycle, without warning."""
        seen: set[str] = set()
        current = style_id
        depth = 0
        while current:
            if current in seen:
                return True
            if depth >= limits.max_style_chain_depth:
                return False
            style = self.styles.get(current)
            if style is None:
                return False
            seen.add(current)
            current = style.based_on
            depth += 1
        return False


def _style_name(element: Element, namespaces: Namespaces) -> str | None:
    name = element.find(namespaces.qn("w:name"))
    if name is None:
        return None
    value = name.get(namespaces.qn("w:val"))
    return value.strip() if value and value.strip() else None


def _referenced_style(element: Element, namespaces: Namespaces, tag: str) -> str | None:
    found = element.find(namespaces.qn(tag))
    if found is None:
        return None
    value = found.get(namespaces.qn("w:val"))
    return value.strip() if value and value.strip() else None


def parse_styles(
    root: Element | None,
    namespaces: Namespaces,
    warnings: WarningCollector,
    limits: AnalyzerLimits,
) -> StyleCatalogue:
    """Read ``styles.xml`` into a catalogue.

    A document with no styles part is legal, and produces an empty catalogue
    rather than an error: every property then resolves from direct formatting
    or stays unresolved.
    """
    if root is None:
        return StyleCatalogue.empty()

    defaults = DocumentDefaults()
    doc_defaults = root.find(namespaces.qn("w:docDefaults"))
    if doc_defaults is not None:
        run_default = doc_defaults.find(namespaces.qn("w:rPrDefault"))
        paragraph_default = doc_defaults.find(namespaces.qn("w:pPrDefault"))
        defaults = DocumentDefaults(
            run=parse_run_properties(
                run_default.find(namespaces.qn("w:rPr")) if run_default is not None else None,
                namespaces,
            ),
            paragraph=parse_paragraph_properties(
                paragraph_default.find(namespaces.qn("w:pPr"))
                if paragraph_default is not None
                else None,
                namespaces,
            ),
        )

    styles: dict[str, Style] = {}
    default_ids: dict[StyleType, str] = {}

    for element in root.findall(namespaces.qn("w:style")):
        if len(styles) >= limits.max_styles:
            raise ResourceLimitExceededError("max_styles", limits.max_styles)

        style_id = element.get(namespaces.qn("w:styleId"))
        if not style_id:
            continue
        raw_type = (element.get(namespaces.qn("w:type")) or "paragraph").strip().lower()
        try:
            style_type = StyleType(raw_type)
        except ValueError:
            warnings.add(WarningCode.UNSUPPORTED_MARKUP, styleId=style_id, styleType=raw_type)
            continue

        is_default = (element.get(namespaces.qn("w:default")) or "").strip().lower() in {
            "1",
            "true",
            "on",
        }
        style = Style(
            style_id=style_id,
            style_type=style_type,
            name=_style_name(element, namespaces),
            based_on=_referenced_style(element, namespaces, "w:basedOn"),
            linked=_referenced_style(element, namespaces, "w:link"),
            is_default=is_default,
            paragraph=parse_paragraph_properties(element.find(namespaces.qn("w:pPr")), namespaces),
            run=parse_run_properties(element.find(namespaces.qn("w:rPr")), namespaces),
            has_conditional_formatting=element.find(namespaces.qn("w:tblStylePr")) is not None,
        )
        styles[style_id] = style
        # The first default of each type wins, which is what Word does with a
        # malformed styles part declaring two.
        if is_default and style_type not in default_ids:
            default_ids[style_type] = style_id

    return StyleCatalogue(
        defaults=defaults, styles=styles, default_style_ids=default_ids, present=True
    )
