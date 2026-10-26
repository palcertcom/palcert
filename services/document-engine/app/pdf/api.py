"""The PDF analyzer's HTTP surface (§7, §152).

The same narrow boundary the DOCX analyzer uses: bytes and a digest in,
artifact bytes and counters out. No bucket name, no object key, no URL and no
database identifier crosses it, and none of the PDF's own internals come back
out - a caller gets an artifact, never a raw object dictionary (§152).

The body is the artifact exactly as serialized here, with its metadata in
headers. Re-wrapping it would force the caller to re-serialize, and a
re-serialized artifact is a different byte string with a different hash, which
would quietly destroy the integrity property the hash exists to provide (§110).
"""

from __future__ import annotations

import hashlib
import json
import time

from fastapi import APIRouter, Request, Response

from app import metrics
from app.config import Settings
from app.errors import AppError, ErrorCode
from app.pdf.analyzer import ANALYZER_NAME, ANALYZER_VERSION, engine_identity
from app.pdf.errors import PdfAnalysisError, PdfFailure
from app.pdf.isolation import run_isolated
from app.pdf.limits import PdfLimits
from app.pdf.support import Format, Support, entry_for, properties, registry_version

#: Failures that are the *document's* fault. The distinction decides the HTTP
#: status, and through it whether the worker retries: a password-protected PDF
#: will still need a password on the third attempt (§79, §86).
_DOCUMENT_FAULT: frozenset[PdfFailure] = frozenset(
    {
        PdfFailure.SOURCE_INTEGRITY_FAILED,
        PdfFailure.PASSWORD_REQUIRED,
        PdfFailure.ENCRYPTION_UNSUPPORTED,
        PdfFailure.DOCUMENT_INVALID,
        PdfFailure.LIMIT_EXCEEDED,
    }
)

ARTIFACT_SHA_HEADER = "x-palcert-artifact-sha256"
DOCUMENT_ID_HEADER = "x-palcert-document-id"
EXPECTED_SHA_HEADER = "x-palcert-expected-sha256"


def build_router(settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/analysis", tags=["analysis"])

    @router.get("/pdf/capabilities")
    async def capabilities() -> dict[str, object]:
        """What this analyzer is, and what PDF can and cannot answer (§63).

        The property table is served from the shared registry rather than
        restated here, so the compatibility preview a user sees before paying
        cannot drift from what the analyzer will actually do (§61).
        """
        identity = engine_identity()
        return {
            **identity.as_json(),
            "propertySupportRegistryVersion": registry_version(),
            "properties": [
                {
                    "name": entry.name,
                    "scopes": list(entry.scopes),
                    "valueKind": entry.value_kind,
                    "unit": entry.unit,
                    "support": str(entry.pdf),
                    "note": entry.pdf_note,
                }
                for entry in properties()
                if entry.pdf is not Support.UNSUPPORTED
            ],
            "unavailable": [
                {"name": entry.name, "reason": entry.pdf_note}
                for entry in properties()
                if entry.pdf is Support.UNSUPPORTED
            ],
        }

    @router.post("/pdf")
    async def analyze_pdf(request: Request) -> Response:
        """Analyze one PDF and return its artifact bytes."""
        document_id = (request.headers.get(DOCUMENT_ID_HEADER) or "").strip()
        expected_sha256 = (request.headers.get(EXPECTED_SHA_HEADER) or "").strip()
        if not document_id or len(document_id) > 200:
            raise AppError(ErrorCode.VALIDATION_FAILED, "a document id header is required")
        if len(expected_sha256) != 64 or not all(
            character in "0123456789abcdefABCDEF" for character in expected_sha256
        ):
            raise AppError(ErrorCode.VALIDATION_FAILED, "a SHA-256 hex digest header is required")

        data = await request.body()
        if not data:
            raise AppError(ErrorCode.VALIDATION_FAILED, "the request carried no document")
        if len(data) > settings.max_document_bytes:
            metrics.observe_analysis("pdf", "too_large", 0.0, len(data))
            raise AppError(
                ErrorCode.INVALID_DOCUMENT,
                "the document exceeds the analyzer's size limit",
                details={"maxBytes": settings.max_document_bytes},
            )

        limits = PdfLimits(
            max_bytes=settings.max_document_bytes,
            timeout_ms=int(settings.processing_timeout_seconds * 1000),
        )
        started = time.monotonic()
        try:
            artifact = run_isolated(
                data,
                expected_sha256=expected_sha256,
                document_id=document_id,
                limits=limits,
            )
        except PdfAnalysisError as error:
            app_error = _as_app_error(error)
            metrics.observe_analysis(
                "pdf",
                metrics.analysis_outcome_for(str(app_error.code)),
                time.monotonic() - started,
                len(data),
            )
            raise app_error from error
        duration_ms = int((time.monotonic() - started) * 1000)
        metrics.observe_analysis("pdf", "succeeded", duration_ms / 1000, len(data))

        # Serialized once, hashed as serialized, returned as hashed.
        content = json.dumps(artifact, separators=(",", ":"), sort_keys=False).encode("utf-8")
        digest = hashlib.sha256(content).hexdigest()
        model = artifact["structuralModel"]
        fact_set = artifact["factSet"]
        warnings = artifact["warnings"]

        return Response(
            content=content,
            media_type="application/json",
            headers={
                ARTIFACT_SHA_HEADER: digest,
                "x-palcert-analyzer-name": ANALYZER_NAME,
                "x-palcert-analyzer-version": ANALYZER_VERSION,
                "x-palcert-fact-schema-version": str(artifact["factSchemaVersion"]),
                "x-palcert-analysis-schema-version": str(artifact["analysisSchemaVersion"]),
                "x-palcert-fact-count": str(len(fact_set["facts"])),
                "x-palcert-warning-count": str(len(warnings)),
                "x-palcert-duration-ms": str(duration_ms),
                "x-palcert-document-format": "PDF",
                # Counters and classifications only. Never a title, a filename,
                # an author or any document text (§107, §108).
                "x-palcert-summary": json.dumps(
                    {
                        "pageCount": len(model["pages"]),
                        "textLayer": model["documentTextLayer"],
                        "tagged": model["features"]["tagged"],
                        "imageOnlyPages": sum(
                            1 for page in model["pages"] if page["textLayer"] == "IMAGE_ONLY"
                        ),
                        "nativeTextPages": sum(
                            1 for page in model["pages"] if page["textLayer"] == "NATIVE_TEXT"
                        ),
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                ),
                "x-palcert-warning-codes": ",".join(
                    sorted({str(warning["code"]) for warning in warnings})
                ),
            },
        )

    return router


def _as_app_error(error: PdfAnalysisError) -> AppError:
    """Map an analysis failure onto the shared error contract."""
    if (
        error.code is PdfFailure.PASSWORD_REQUIRED
        or error.code is PdfFailure.ENCRYPTION_UNSUPPORTED
    ):
        code = ErrorCode.UNSUPPORTED_DOCUMENT
    elif error.code in _DOCUMENT_FAULT:
        code = ErrorCode.INVALID_DOCUMENT
    elif error.code is PdfFailure.ANALYSIS_TIMEOUT:
        code = ErrorCode.SERVICE_UNAVAILABLE
    else:
        code = ErrorCode.INTERNAL_ERROR

    return AppError(
        code,
        "the document could not be analyzed",
        details={"analysisError": str(error.code)},
        internal_context={"detail": error.detail},
    )


def format_of(name: str) -> Support:
    """Convenience for callers asking what PDF can do with one property."""
    entry = entry_for(name)
    return Support.UNSUPPORTED if entry is None else entry.support(Format.PDF)
