"""Structured logging with request correlation IDs (Master Prompt 46, 48)."""

from __future__ import annotations

import logging
from contextvars import ContextVar

import structlog

REQUEST_ID_HEADER = "x-request-id"

_request_id: ContextVar[str | None] = ContextVar("palcert_request_id", default=None)


def set_request_id(request_id: str | None) -> None:
    _request_id.set(request_id)


def get_request_id() -> str | None:
    return _request_id.get()


def _inject_request_id(
    _logger: object, _method: str, event_dict: structlog.types.EventDict
) -> structlog.types.EventDict:
    request_id = get_request_id()
    if request_id is not None:
        event_dict["request_id"] = request_id
    return event_dict


def configure_logging(*, level: str, json_output: bool, service: str, version: str) -> None:
    """Configure structlog. Safe to call more than once (tests re-configure)."""
    logging.basicConfig(format="%(message)s", level=getattr(logging, level.upper()))

    renderer: structlog.types.Processor = (
        structlog.processors.JSONRenderer() if json_output else structlog.dev.ConsoleRenderer()
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            _inject_request_id,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, level.upper())),
        cache_logger_on_first_use=True,
    )

    structlog.contextvars.bind_contextvars(service=service, version=version)


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    logger: structlog.stdlib.BoundLogger = structlog.get_logger(name)
    return logger
