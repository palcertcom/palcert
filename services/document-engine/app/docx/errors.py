"""Fatal DOCX analysis failures (§79, §118).

The distinction this module exists to keep: a *warning* means the analyzer
produced a smaller truth than it wanted; an *error* means it cannot honestly
produce anything. ``word/document.xml`` that will not parse is an error. One
unsupported extension element that only affects caption detection is a
warning plus reduced coverage.
"""

from __future__ import annotations

from enum import StrEnum


class DocxErrorCode(StrEnum):
    """Stable codes shared with the API. Never a message, never a stack."""

    SOURCE_INTEGRITY_FAILED = "DOCX_SOURCE_INTEGRITY_FAILED"
    PACKAGE_INVALID = "DOCX_PACKAGE_INVALID"
    XML_INVALID = "DOCX_XML_INVALID"
    PROFILE_UNSUPPORTED = "DOCX_PROFILE_UNSUPPORTED"
    STRUCTURE_INVALID = "DOCX_STRUCTURE_INVALID"
    STYLE_CYCLE = "DOCX_STYLE_CYCLE"
    RESOURCE_LIMIT_EXCEEDED = "DOCX_RESOURCE_LIMIT_EXCEEDED"
    ARTIFACT_INVALID = "DOCX_ARTIFACT_INVALID"
    ANALYSIS_FAILED = "DOCX_ANALYSIS_FAILED"
    ANALYSIS_TIMEOUT = "DOCX_ANALYSIS_TIMEOUT"


class DocxAnalysisError(Exception):
    """A fatal analysis failure carrying a stable code.

    ``detail`` is operator-facing and must stay free of document content: a
    part name, an element name, a limit name — never text from the document.
    """

    def __init__(self, code: DocxErrorCode, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else str(code))
        self.code = code
        self.detail = detail

    @property
    def retryable(self) -> bool:
        """Whether re-running the same bytes could plausibly succeed.

        Malformed OOXML is deterministic: retrying it wastes a worker and
        delays the user's answer (§91). Only the timeout is worth another
        attempt, and only because it may have been a loaded machine.
        """
        return self.code is DocxErrorCode.ANALYSIS_TIMEOUT
