"""Stable application errors mirroring the TypeScript contract (Master Prompt 47)."""

from __future__ import annotations

from enum import StrEnum
from typing import Any


class ErrorCode(StrEnum):
    """Subset of PalCert error codes the document engine can raise.

    Values must match `@palcert/contracts` exactly — they cross the service
    boundary and reach clients unchanged.
    """

    VALIDATION_FAILED = "VALIDATION_FAILED"
    NOT_FOUND = "NOT_FOUND"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"
    INVALID_DOCUMENT = "INVALID_DOCUMENT"
    UNSUPPORTED_DOCUMENT = "UNSUPPORTED_DOCUMENT"


_DEFAULT_STATUS: dict[ErrorCode, int] = {
    ErrorCode.VALIDATION_FAILED: 400,
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.INTERNAL_ERROR: 500,
    ErrorCode.SERVICE_UNAVAILABLE: 503,
    ErrorCode.INVALID_DOCUMENT: 422,
    ErrorCode.UNSUPPORTED_DOCUMENT: 415,
}


class AppError(Exception):
    """Application error carrying a client-safe code and internal diagnostics."""

    def __init__(
        self,
        code: ErrorCode,
        message: str | None = None,
        *,
        http_status: int | None = None,
        details: dict[str, Any] | None = None,
        internal_context: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message or code.value)
        self.code = code
        self.message = message or code.value
        self.http_status = http_status or _DEFAULT_STATUS[code]
        self.details = details
        self.internal_context = internal_context

    def to_public_dict(self, request_id: str | None = None) -> dict[str, Any]:
        """Serialize for the client. Never includes internal context."""
        error: dict[str, Any] = {"code": self.code.value, "message": self.message}
        if self.details is not None:
            error["details"] = self.details
        if request_id is not None:
            error["requestId"] = request_id
        return {"error": error}


def default_status_for(code: ErrorCode) -> int:
    return _DEFAULT_STATUS[code]
