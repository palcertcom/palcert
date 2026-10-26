"""Structured analysis warnings (§78).

An analysis may succeed while knowing less than it wanted to. When that
happens the caller needs two machine-readable things: *what* went unresolved,
and *which fact domains* are therefore not COMPLETE. Prose cannot carry that,
so every warning is a code from this closed set plus a small, non-confidential
detail dictionary.

Nothing here may contain document text. A warning names a style id, a
relationship id or a part name — never a heading, a sentence or an author.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from app.docx.limits import AnalyzerLimits


class WarningCode(StrEnum):
    """Every non-fatal condition the analyzer can report."""

    STYLE_PARENT_MISSING = "STYLE_PARENT_MISSING"
    STYLE_CYCLE = "STYLE_CYCLE"
    STYLE_CHAIN_TOO_DEEP = "STYLE_CHAIN_TOO_DEEP"
    THEME_MISSING = "THEME_MISSING"
    THEME_REFERENCE_UNRESOLVED = "THEME_REFERENCE_UNRESOLVED"
    NUMBERING_REFERENCE_MISSING = "NUMBERING_REFERENCE_MISSING"
    NUMBERING_PART_MISSING = "NUMBERING_PART_MISSING"
    RELATIONSHIP_TARGET_MISSING = "RELATIONSHIP_TARGET_MISSING"
    UNSUPPORTED_MARKUP = "UNSUPPORTED_MARKUP"
    ALTERNATE_CONTENT_FALLBACK_USED = "ALTERNATE_CONTENT_FALLBACK_USED"
    ALTERNATE_CONTENT_BRANCH_SELECTED = "ALTERNATE_CONTENT_BRANCH_SELECTED"
    TABLE_STYLE_PARTIAL = "TABLE_STYLE_PARTIAL"
    TABLE_STYLE_CONDITIONAL_IGNORED = "TABLE_STYLE_CONDITIONAL_IGNORED"
    LAYOUT_NOT_RENDERED = "LAYOUT_NOT_RENDERED"
    APPLICATION_DEFAULT_UNRESOLVED = "APPLICATION_DEFAULT_UNRESOLVED"
    MIRRORED_MARGINS_PAGE_SIDE_UNKNOWN = "MIRRORED_MARGINS_PAGE_SIDE_UNKNOWN"
    PART_UNREADABLE = "PART_UNREADABLE"
    NODE_ID_TRUNCATED = "NODE_ID_TRUNCATED"
    FIELD_INSTRUCTION_UNPARSED = "FIELD_INSTRUCTION_UNPARSED"
    CAPTION_DETECTION_PARTIAL = "CAPTION_DETECTION_PARTIAL"
    REVISION_MARKUP_PARTIAL = "REVISION_MARKUP_PARTIAL"
    METADATA_PART_MISSING = "METADATA_PART_MISSING"
    #: Legacy equation objects are present: their place, number and preview
    #: are known, their mathematics is not (it is never parsed or executed).
    LEGACY_EQUATION_SEMANTICS_UNAVAILABLE = "LEGACY_EQUATION_SEMANTICS_UNAVAILABLE"


@dataclass(frozen=True, slots=True)
class AnalysisWarning:
    code: WarningCode
    #: Small, non-confidential key/values: style ids, part names, counts.
    detail: dict[str, str] = field(default_factory=dict)

    def to_json(self) -> dict[str, object]:
        return {"code": str(self.code), "detail": dict(sorted(self.detail.items()))}


class WarningCollector:
    """Collects warnings, deduplicated and bounded.

    Deduplication matters more than it looks: a document with one broken style
    referenced by four thousand paragraphs must not produce four thousand
    warnings, and the count of *distinct* problems is what an operator reads.
    """

    __slots__ = ("_limits", "_seen", "_suppressed")

    def __init__(self, limits: AnalyzerLimits | None = None) -> None:
        self._limits = limits or AnalyzerLimits.default()
        self._seen: dict[tuple[WarningCode, tuple[tuple[str, str], ...]], AnalysisWarning] = {}
        self._suppressed = 0

    def add(self, code: WarningCode, **detail: str) -> None:
        key = (code, tuple(sorted(detail.items())))
        if key in self._seen:
            return
        if len(self._seen) >= self._limits.max_warnings:
            self._suppressed += 1
            return
        self._seen[key] = AnalysisWarning(code=code, detail=dict(detail))

    def has(self, code: WarningCode) -> bool:
        return any(warning.code is code for warning in self._seen.values())

    @property
    def suppressed(self) -> int:
        return self._suppressed

    def all(self) -> tuple[AnalysisWarning, ...]:
        """Canonically ordered, so the artifact bytes do not depend on the
        order problems happened to be discovered in (§86)."""
        return tuple(
            sorted(
                self._seen.values(),
                key=lambda warning: (str(warning.code), sorted(warning.detail.items())),
            )
        )
