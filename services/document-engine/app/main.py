"""PalCert document engine — FastAPI application.

Phase 0 establishes the service shell only: configuration, structured logging,
correlation IDs, error handling and health probes. DOCX and PDF analysis arrive
in Phase 6 and Phase 13 respectively.
"""

from __future__ import annotations

import secrets
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from app import metrics
from app.config import Settings, get_settings
from app.docx.api import build_router as build_docx_router
from app.engine.api import build_router as build_evaluation_router
from app.errors import AppError, ErrorCode
from app.logging_config import REQUEST_ID_HEADER, configure_logging, get_logger, set_request_id
from app.pdf.api import build_router as build_pdf_router
from app.schemas import HealthResponse
from app.smartfix.api import build_router as build_smartfix_router

_started_at = time.monotonic()

MAX_REQUEST_ID_LENGTH = 128


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    logger = get_logger(__name__)
    logger.info("document_engine.starting", environment=settings.environment, port=settings.port)
    yield
    logger.info("document_engine.stopped")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the application. Exported so tests boot the identical stack."""
    resolved = settings or get_settings()

    configure_logging(
        level=resolved.log_level,
        json_output=resolved.log_json,
        service=resolved.service_name,
        version=resolved.version,
    )

    app = FastAPI(
        title="PalCert Document Engine",
        version=resolved.version,
        description="Document intelligence service for the PalCert platform.",
        docs_url=None if resolved.is_production else "/docs",
        redoc_url=None,
        openapi_url=None if resolved.is_production else "/openapi.json",
        lifespan=lifespan,
    )
    app.state.settings = resolved
    metrics.set_build_info(
        service=resolved.service_name,
        version=resolved.version,
        commit=resolved.commit,
        environment=resolved.environment,
    )

    _register_middleware(app)
    _register_exception_handlers(app)
    _register_routes(app, resolved)
    return app


def _register_middleware(app: FastAPI) -> None:
    @app.middleware("http")
    async def correlation_id_middleware(
        request: Request, call_next: Callable[[Request], Awaitable[JSONResponse]]
    ) -> JSONResponse:
        incoming = request.headers.get(REQUEST_ID_HEADER)
        is_usable = bool(incoming) and 0 < len(incoming or "") <= MAX_REQUEST_ID_LENGTH
        request_id = incoming if is_usable and incoming else str(uuid.uuid4())
        set_request_id(request_id)
        request.state.request_id = request_id

        started = time.perf_counter()
        response = await call_next(request)
        duration_ms = (time.perf_counter() - started) * 1000

        response.headers[REQUEST_ID_HEADER] = request_id
        get_logger(__name__).info(
            "http_request",
            method=request.method,
            path=request.url.path,
            status_code=response.status_code,
            duration_ms=round(duration_ms, 2),
        )
        _record_http_metrics(request, response, duration_ms / 1000)
        set_request_id(None)
        return response


def _record_http_metrics(request: Request, response: JSONResponse, seconds: float) -> None:
    """Count and time one request, labelled by the route it matched.

    Probes and the scrape itself are excluded: they run every few seconds and
    would be most of every rate and latency panel while being none of the
    traffic anyone cares about.
    """
    path = request.url.path
    if path.startswith("/health") or path.startswith("/metrics"):
        return

    route = metrics.route_label(request.scope)
    metrics.HTTP_REQUESTS.labels(
        route=route,
        method=request.method,
        status_class=metrics.status_class(response.status_code),
    ).inc()
    metrics.HTTP_DURATION.labels(route=route, method=request.method).observe(seconds)


def _register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        request_id = getattr(request.state, "request_id", None)
        get_logger(__name__).warning(
            "request_rejected",
            error_code=exc.code.value,
            status_code=exc.http_status,
            context=exc.internal_context,
        )
        return JSONResponse(
            status_code=exc.http_status,
            content=exc.to_public_dict(request_id),
            headers={REQUEST_ID_HEADER: request_id} if request_id else None,
        )

    @app.exception_handler(Exception)
    async def handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        request_id = getattr(request.state, "request_id", None)
        get_logger(__name__).error("unhandled_error", exc_info=exc)
        # Expose nothing about the failure (Master Prompt 47).
        return JSONResponse(
            status_code=500,
            content=AppError(
                ErrorCode.INTERNAL_ERROR, "An unexpected error occurred."
            ).to_public_dict(request_id),
        )


def _register_routes(app: FastAPI, settings: Settings) -> None:
    def _build_health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            service=settings.service_name,
            version=settings.version,
            uptime_seconds=int(time.monotonic() - _started_at),
            checked_at=datetime.now(UTC),
            dependencies=[],
        )

    @app.get("/health/live", response_model=HealthResponse, response_model_by_alias=True)
    async def live() -> HealthResponse:
        """Liveness probe — the process is running."""
        return _build_health()

    @app.get("/health/ready", response_model=HealthResponse, response_model_by_alias=True)
    async def ready() -> HealthResponse:
        """Readiness probe.

        The engine is stateless and has no downstream dependencies: it is a
        pure function of the bytes it is handed. Storage and database probes
        would be probes of somebody else's dependencies.
        """
        return _build_health()

    @app.get("/metrics", include_in_schema=False)
    async def scrape(request: Request) -> Response:
        """The Prometheus scrape endpoint (Phase 20 Checkpoint 3).

        Kept out of the OpenAPI document, and out of the release proxy's route
        table: an external caller never reaches this handler at all. The token
        is the second lock, for a deployment whose internal network is shared.

        Disabled reads as 404 rather than 403, so a deployment that turned
        telemetry off looks like one that never had it.
        """
        if not settings.metrics_enabled:
            return Response(status_code=404)
        # An unset token and an empty one mean the same thing. A container
        # passing `METRICS_TOKEN=` would otherwise configure a token nobody
        # can present, and every scrape would 403 with no way to tell why.
        expected = settings.metrics_token or None
        if expected is not None and not _token_matches(
            request.headers.get("authorization"), expected
        ):
            return Response(status_code=403)

        return Response(
            content=metrics.render(),
            media_type=metrics.CONTENT_TYPE,
            # A scrape is a point-in-time reading; nothing in front of it may
            # serve a cached copy.
            headers={"Cache-Control": "no-store"},
        )

    app.include_router(build_docx_router(settings))
    app.include_router(build_pdf_router(settings))
    app.include_router(build_evaluation_router(settings))
    app.include_router(build_smartfix_router(settings))


def _token_matches(authorization: str | None, expected: str) -> bool:
    """Constant-time comparison of the presented bearer token."""
    if not authorization:
        return False
    scheme, _, presented = authorization.partition(" ")
    if scheme.lower() != "bearer" or not presented:
        return False
    return secrets.compare_digest(presented, expected)


app = create_app()
