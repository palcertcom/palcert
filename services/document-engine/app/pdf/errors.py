"""Why a PDF analysis stopped (§79).

Every one of these means no report can honestly be produced, so the paid check
fails and the reservation is released without a charge. They are deliberately
few: almost everything else about a damaged PDF degrades coverage instead.
"""

from __future__ import annotations

from enum import StrEnum


class PdfFailure(StrEnum):
    #: The bytes are not the bytes the DocumentVersion promised (§9).
    SOURCE_INTEGRITY_FAILED = "DOCUMENT_SOURCE_INTEGRITY_FAILED"
    #: A password is required. PalCert does not collect, store or guess one (§19).
    PASSWORD_REQUIRED = "PDF_PASSWORD_REQUIRED"  # noqa: S105 - an error code, not a credential
    #: Encrypted with a scheme the engine cannot open at all.
    ENCRYPTION_UNSUPPORTED = "PDF_ENCRYPTION_UNSUPPORTED"
    #: The parser cannot open the file safely.
    DOCUMENT_INVALID = "PDF_DOCUMENT_INVALID"
    #: Beyond a document-level bound; see PdfLimits.
    LIMIT_EXCEEDED = "PDF_LIMIT_EXCEEDED"
    #: The isolated worker died or overran its budget.
    ANALYSIS_TIMEOUT = "PDF_ANALYSIS_TIMEOUT"
    ANALYZER_CRASHED = "PDF_ANALYZER_CRASHED"


class PdfAnalysisError(Exception):
    """A fatal analysis failure carrying a stable code."""

    def __init__(self, code: PdfFailure, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else str(code))
        self.code = code
        self.detail = detail
