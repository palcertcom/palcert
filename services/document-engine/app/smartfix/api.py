"""SmartFix's HTTP surface.

The same narrow boundary the analyzer draws (§17), for the same reason: the
Node worker holds the storage credentials and the database, this service holds
the OOXML knowledge, and nothing about *where* a document lives crosses
between them. No bucket, no object key, no URL, no database identifier — bytes
in, bytes out.

Bodies are framed (see `app.smartfix.framing`): a JSON header carrying the
plan or the rules, then the document. A plan with a hundred thousand actions
does not fit in an HTTP header, and base64 inside a JSON envelope would inflate
a 200 MB thesis by a third for no benefit.

Two endpoints, and the split is the whole commercial design. `/smartfix/plan`
is free: it reads a document and returns exactly what PalCert *would* change,
so the user decides before paying. `/smartfix/apply` executes a plan that was
already approved — never a regenerated one.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response

from app.config import Settings
from app.docx.errors import DocxAnalysisError, DocxErrorCode
from app.docx.limits import AnalyzerLimits
from app.errors import AppError, ErrorCode
from app.smartfix.ai import attach_targets, formatting_context, initial_ai_plan
from app.smartfix.capability import (
    CAPABILITY_REGISTRY_VERSION,
    SMARTFIX_ENGINE_NAME,
    SMARTFIX_ENGINE_VERSION,
)
from app.smartfix.contracts import SmartFixContractError
from app.smartfix.framing import FramingError, decode, encode
from app.smartfix.model import PlanSource, canonical_json, sha256_hex
from app.smartfix.mutate import FixError, FixErrorCode
from app.smartfix.service import (
    PlanRequest,
    apply_plan,
    engine_identity,
    parse_rules,
    plan_for_document,
)

DOCUMENT_ID_HEADER = "x-palcert-document-id"
PLAN_SHA_HEADER = "x-palcert-plan-sha256"
MANIFEST_SHA_HEADER = "x-palcert-manifest-sha256"
OUTPUT_SHA_HEADER = "x-palcert-output-sha256"

#: Which refusals are the *document's* fault and which are the caller's. The
#: distinction decides the HTTP status, and through it whether the worker
#: retries — retrying a plan that does not match its document would fail the
#: same way for ever.
_CALLER_FAULT: frozenset[FixErrorCode] = frozenset(
    {
        FixErrorCode.PLAN_INVALID,
        FixErrorCode.PLAN_ENGINE_MISMATCH,
        FixErrorCode.PLAN_REFUSED,
        FixErrorCode.PLAN_EMPTY,
        FixErrorCode.SOURCE_INTEGRITY_FAILED,
        FixErrorCode.SOURCE_CHANGED,
        FixErrorCode.TARGET_NOT_FOUND,
        FixErrorCode.VALUE_UNWRITABLE,
        FixErrorCode.PACKAGE_INVALID,
    }
)


def build_router(settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/smartfix", tags=["smartfix"])
    limits = AnalyzerLimits(max_part_bytes=settings.max_document_bytes)

    @router.get("/capabilities")
    async def capabilities() -> dict[str, object]:
        """What this engine is and what it is able to change.

        The capability registry is published so the Rule Builder can tell a
        standard author which of their rules SmartFix could act on — rather
        than letting them mark a rule SAFE and discover later that PalCert has
        no way to make the change.
        """
        from app.smartfix.capability import load_registry

        return {**engine_identity(), "registry": load_registry()}

    @router.post("/plan")
    async def plan(request: Request) -> Response:
        """Decide what could be corrected. Free, and writes nothing."""
        payload, document = await _read_frame(request, settings)
        document_id = (request.headers.get(DOCUMENT_ID_HEADER) or "").strip()
        if not document_id or len(document_id) > 200:
            raise AppError(ErrorCode.VALIDATION_FAILED, "a document id header is required")

        try:
            rules = attach_targets(
                parse_rules(list(payload.get("rules", []))), payload.get("aiTargets", [])
            )
            source = PlanSource.from_json(dict(payload["source"]))
        except (KeyError, TypeError, ValueError) as error:
            raise AppError(
                ErrorCode.VALIDATION_FAILED, "the plan request is not well formed"
            ) from error

        try:
            plan_request = PlanRequest(
                document_id=document_id,
                content=document,
                expected_sha256=source.document_sha256,
                rules=rules,
                source=source,
                limits=limits,
            )
            built = (
                initial_ai_plan(plan_request)
                if payload.get("includeAIContext") is True and "aiTargets" not in payload
                else plan_for_document(plan_request)
            )
            context = (
                formatting_context(plan_request, built, payload["rules"])
                if payload.get("includeAIContext") is True
                else None
            )
        except FixError as error:
            raise _as_fix_error(error) from error
        except DocxAnalysisError as error:
            raise _as_app_error(error) from error
        except SmartFixContractError as error:
            raise AppError(
                ErrorCode.INTERNAL_ERROR,
                "the plan did not satisfy its own contract",
                internal_context={"detail": str(error)[:400]},
            ) from error

        body = canonical_json(built.to_json())
        return Response(
            content=encode(context, body) if context is not None else body,
            media_type="application/octet-stream" if context is not None else "application/json",
            headers={
                PLAN_SHA_HEADER: sha256_hex(body),
                "x-palcert-action-count": str(len(built.actions)),
                "x-palcert-rule-count": str(len(built.rules)),
                "x-palcert-refusal": built.refusal.value if built.refusal else "",
                "x-palcert-fix-engine-name": SMARTFIX_ENGINE_NAME,
                "x-palcert-fix-engine-version": SMARTFIX_ENGINE_VERSION,
                "x-palcert-capability-registry-version": str(CAPABILITY_REGISTRY_VERSION),
            },
        )

    @router.post("/apply")
    async def apply(request: Request) -> Response:
        """Execute an approved plan and return the corrected document."""
        payload, document = await _read_frame(request, settings)
        try:
            plan_payload: dict[str, Any] = dict(payload["plan"])
            plan_hash = str(payload["planHash"])
            expected = str(payload["expectedSourceSha256"])
        except (KeyError, TypeError) as error:
            raise AppError(
                ErrorCode.VALIDATION_FAILED, "the apply request is not well formed"
            ) from error

        try:
            outcome = apply_plan(document, expected, plan_payload, plan_hash, limits)
        except FixError as error:
            raise _as_fix_error(error) from error
        except DocxAnalysisError as error:
            raise _as_app_error(error) from error

        manifest = outcome.manifest.to_json()
        return Response(
            content=encode(manifest, outcome.content),
            media_type="application/octet-stream",
            headers={
                OUTPUT_SHA_HEADER: outcome.sha256,
                MANIFEST_SHA_HEADER: outcome.manifest.hash_hex(),
                "x-palcert-entry-count": str(len(outcome.manifest.entries)),
                "x-palcert-output-size": str(len(outcome.content)),
            },
        )

    return router


async def _read_frame(request: Request, settings: Settings) -> tuple[dict[str, Any], bytes]:
    data = await request.body()
    if not data:
        raise AppError(ErrorCode.VALIDATION_FAILED, "the request carried no body")
    try:
        payload, document = decode(data)
    except FramingError as error:
        raise AppError(ErrorCode.VALIDATION_FAILED, str(error)) from error
    if not document:
        raise AppError(ErrorCode.VALIDATION_FAILED, "the request carried no document")
    if len(document) > settings.max_document_bytes:
        raise AppError(
            ErrorCode.INVALID_DOCUMENT,
            "the document exceeds the engine's size limit",
            details={"maxBytes": settings.max_document_bytes},
        )
    return payload, document


def _as_fix_error(error: FixError) -> AppError:
    """Map a refusal onto the shared error contract.

    The code travels in the details so the worker can release the reservation
    and tell the user precisely why nothing was charged. The message carries no
    document content — never a paragraph, never a node id's surrounding text.
    """
    code = ErrorCode.INVALID_DOCUMENT if error.code in _CALLER_FAULT else ErrorCode.INTERNAL_ERROR
    return AppError(
        code,
        "the document could not be corrected",
        details={"fixError": error.code.value},
        internal_context={"detail": error.detail},
    )


def _as_app_error(error: DocxAnalysisError) -> AppError:
    if error.code is DocxErrorCode.PROFILE_UNSUPPORTED:
        code = ErrorCode.UNSUPPORTED_DOCUMENT
    elif error.code is DocxErrorCode.ANALYSIS_TIMEOUT:
        code = ErrorCode.SERVICE_UNAVAILABLE
    else:
        code = ErrorCode.INVALID_DOCUMENT
    return AppError(
        code,
        "the document could not be read",
        details={"analysisError": str(error.code)},
        internal_context={"detail": error.detail},
    )
