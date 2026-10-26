"""The analyzer's HTTP surface (§17).

The Node worker holds the storage credentials and the database; this service
holds the OOXML knowledge. So the boundary is deliberately narrow: bytes and a
digest in, artifact bytes and counters out. No bucket name, no object key, no
URL and no database identifier crosses it, which means a compromised document
engine has nothing to reach for.

The response body is the artifact **exactly as serialized** by the analyzer,
with its metadata in headers. Returning it wrapped in another JSON object
would force the caller to re-serialize it, and a re-serialized artifact is a
different byte string with a different hash — which would quietly destroy the
integrity property the hash exists to provide (§87).
"""

from __future__ import annotations

import json
import time

from fastapi import APIRouter, Request, Response

from app import metrics
from app.config import Settings
from app.docx.analyzer import AnalysisRequest, analyze, analyzer_identity
from app.docx.errors import DocxAnalysisError, DocxErrorCode
from app.docx.limits import AnalyzerLimits
from app.errors import AppError, ErrorCode

#: Which analyzer failures are the *document's* fault (the caller sent
#: something PalCert cannot analyze) and which are the service's. The
#: distinction decides the HTTP status, and through it whether the worker
#: retries (§91).
_DOCUMENT_FAULT: frozenset[DocxErrorCode] = frozenset(
    {
        DocxErrorCode.PACKAGE_INVALID,
        DocxErrorCode.XML_INVALID,
        DocxErrorCode.STRUCTURE_INVALID,
        DocxErrorCode.STYLE_CYCLE,
        DocxErrorCode.SOURCE_INTEGRITY_FAILED,
        DocxErrorCode.RESOURCE_LIMIT_EXCEEDED,
    }
)

ARTIFACT_SHA_HEADER = "x-palcert-artifact-sha256"
DOCUMENT_ID_HEADER = "x-palcert-document-id"
EXPECTED_SHA_HEADER = "x-palcert-expected-sha256"


def build_router(settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/analysis", tags=["analysis"])

    limits = AnalyzerLimits(max_part_bytes=settings.max_document_bytes)

    @router.get("/docx/capabilities")
    async def capabilities() -> dict[str, object]:
        """What this analyzer is and what it can extract (§97).

        Additive metadata for the Rule Builder. It describes the analyzer, not
        any standard, and changes nothing about published rule semantics.
        """
        from app.docx.catalogue import catalogue_json

        return {**analyzer_identity(), **catalogue_json()}

    @router.post("/docx")
    async def analyze_docx(request: Request) -> Response:
        """Analyze one DOCX and return its artifact bytes.

        The document arrives as the raw request body rather than as a form
        field: it is up to 200 MB of binary, and multipart framing would add
        a parser and a dependency between PalCert and its own bytes for no
        benefit. The two identifiers travel as headers.
        """
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
            metrics.observe_analysis("docx", "too_large", 0.0, len(data))
            raise AppError(
                ErrorCode.INVALID_DOCUMENT,
                "the document exceeds the analyzer's size limit",
                details={"maxBytes": settings.max_document_bytes},
            )

        started = time.perf_counter()
        try:
            outcome = analyze(
                AnalysisRequest(
                    document_id=document_id,
                    content=data,
                    expected_sha256=expected_sha256,
                    limits=limits,
                    timeout_seconds=float(settings.processing_timeout_seconds),
                )
            )
        except DocxAnalysisError as error:
            app_error = _as_app_error(error)
            metrics.observe_analysis(
                "docx",
                metrics.analysis_outcome_for(str(app_error.code)),
                time.perf_counter() - started,
                len(data),
            )
            raise app_error from error

        metrics.observe_analysis("docx", "succeeded", time.perf_counter() - started, len(data))

        return Response(
            content=outcome.artifact.content,
            media_type="application/json",
            headers={
                ARTIFACT_SHA_HEADER: outcome.artifact.sha256,
                "x-palcert-analyzer-name": outcome.analyzer_name,
                "x-palcert-analyzer-version": outcome.analyzer_version,
                "x-palcert-fact-schema-version": str(outcome.fact_schema_version),
                "x-palcert-analysis-schema-version": str(outcome.analysis_schema_version),
                "x-palcert-fact-count": str(outcome.artifact.fact_count),
                "x-palcert-warning-count": str(outcome.artifact.warning_count),
                "x-palcert-duration-ms": str(outcome.duration_ms),
                # Counters only. Never a title, a filename or any text (§71).
                "x-palcert-summary": json.dumps(
                    outcome.artifact.summary, separators=(",", ":"), sort_keys=True
                ),
                "x-palcert-warning-codes": ",".join(
                    sorted({str(warning.code) for warning in outcome.warnings})
                ),
            },
        )

    return router


def _as_app_error(error: DocxAnalysisError) -> AppError:
    """Map an analyzer failure onto the shared error contract.

    The analyzer's own code travels in a header so the worker can classify
    the failure precisely, while the body stays the ordinary PalCert error
    shape. The detail is operator-facing and carries no document content.
    """
    if error.code is DocxErrorCode.PROFILE_UNSUPPORTED:
        code = ErrorCode.UNSUPPORTED_DOCUMENT
    elif error.code in _DOCUMENT_FAULT:
        code = ErrorCode.INVALID_DOCUMENT
    elif error.code is DocxErrorCode.ANALYSIS_TIMEOUT:
        code = ErrorCode.SERVICE_UNAVAILABLE
    else:
        code = ErrorCode.INTERNAL_ERROR

    return AppError(
        code,
        "the document could not be analyzed",
        details={"analysisError": str(error.code)},
        internal_context={"detail": error.detail},
    )
