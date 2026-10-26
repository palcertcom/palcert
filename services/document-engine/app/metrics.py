"""Prometheus metrics for the document engine (Phase 20 Checkpoint 3).

Vendor-neutral by construction: the module emits the Prometheus text
exposition format and nothing else. No hosted agent, no vendor SDK, no
outbound connection — a scraper comes to ``/metrics`` and reads it.

**Nothing about a document reaches telemetry.** The engine handles the bytes
of other people's unpublished work, and a metric is the most widely copied,
longest retained and least access-controlled thing a service emits. So the
labels here are a closed set of analyzer names, outcome words and normalized
route templates. No filename, no document id, no title, no extracted text, no
exception message — the structured log line already carries the safe
diagnostics an operator needs, behind the access controls a log has.
"""

from __future__ import annotations

from collections.abc import Iterable

from prometheus_client import (
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    gc_collector,
    generate_latest,
    platform_collector,
    process_collector,
)

CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"
"""The classic Prometheus text format, which every scraper understands."""

REGISTRY = CollectorRegistry()
"""The engine's own registry rather than the library default.

A process-global default registry is shared with anything that imports
``prometheus_client``, and a test that builds a second app would collide on
every metric name. One registry the application owns keeps both honest.

The cost of owning it is that the library's default collectors are not
attached automatically, so they are registered explicitly below. Without
them the engine would report what it did and nothing about whether the
process doing it was healthy — and "why is analysis slow?" is usually
answered by memory or file descriptors rather than by a counter.
"""

process_collector.ProcessCollector(registry=REGISTRY)
platform_collector.PlatformCollector(registry=REGISTRY)
gc_collector.GCCollector(registry=REGISTRY)

BUILD_INFO = Gauge(
    "palcert_build_info",
    "Always 1. Labels identify the running build.",
    ["service", "version", "commit", "environment"],
    registry=REGISTRY,
)

HTTP_REQUESTS = Counter(
    "palcert_http_requests_total",
    "HTTP requests handled, by route template, method and status class.",
    ["route", "method", "status_class"],
    registry=REGISTRY,
)

HTTP_DURATION = Histogram(
    "palcert_http_request_duration_seconds",
    "HTTP request duration, by route template and method.",
    ["route", "method"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60),
    registry=REGISTRY,
)

ANALYSES = Counter(
    "palcert_analyses_total",
    "Document analyses attempted, by analyzer and outcome.",
    ["analyzer", "outcome"],
    registry=REGISTRY,
)
"""``analyzer`` is ``docx`` or ``pdf``; ``outcome`` is one of
:data:`ANALYSIS_OUTCOMES`. Deliberately not the failure's message: an
exception string is unbounded text written by whoever supplied the document,
and labelling by it is how a metrics endpoint becomes a memory leak."""

ANALYSIS_OUTCOMES = ("succeeded", "rejected", "too_large", "timed_out", "failed")
"""The closed set of analysis outcomes.

``rejected`` means the document was read and refused on its own merits —
corrupt, encrypted, not what it claimed to be. ``failed`` is the analyzer
itself going wrong, which is PalCert's bug and the one an alert should page
on. Keeping them apart matters: a pile of malformed uploads is a Tuesday, a
pile of analyzer errors is an incident.
"""

ANALYSIS_DURATION = Histogram(
    "palcert_analysis_duration_seconds",
    "Time to analyze one document, by analyzer.",
    ["analyzer"],
    # A small DOCX is milliseconds; a large scanned PDF is tens of seconds.
    # The top bucket sits at the processing timeout, so saturation there and
    # the timeout counter tell the same story.
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300),
    registry=REGISTRY,
)

ANALYSIS_BYTES = Histogram(
    "palcert_analysis_document_bytes",
    "Size of documents submitted for analysis, by analyzer.",
    ["analyzer"],
    buckets=(64_000, 256_000, 1_000_000, 4_000_000, 16_000_000, 50_000_000, 200_000_000),
    registry=REGISTRY,
)

UNMATCHED_ROUTE = "<unmatched>"
"""What a request that matched no route is labelled.

A scanner probing a hundred paths must produce one timeseries, not a hundred.
"""


def set_build_info(service: str, version: str, commit: str, environment: str) -> None:
    """Publish the running build as labels on a constant gauge."""
    # Cleared first: a process that builds more than one app — the module-level
    # instance plus one per test — must still report exactly one build.
    BUILD_INFO.clear()
    BUILD_INFO.labels(
        service=service, version=version, commit=commit or "unknown", environment=environment
    ).set(1)


def status_class(status_code: int) -> str:
    """``2xx``, ``4xx``… — five values instead of sixty."""
    if status_code < 100 or status_code > 599:
        return "unknown"
    return f"{status_code // 100}xx"


def route_label(scope: object) -> str:
    """The matched route template, never the requested path.

    Starlette records the matched route on the ASGI scope once routing has
    run, and its ``path`` is the declared pattern. Reading that instead of
    ``request.url.path`` is what keeps a document id out of a label.
    """
    route = None
    if isinstance(scope, dict):
        route = scope.get("route")
    path = getattr(route, "path", None)
    return path if isinstance(path, str) and path else UNMATCHED_ROUTE


def observe_analysis(analyzer: str, outcome: str, seconds: float, document_bytes: int) -> None:
    """Record one analysis attempt.

    An unknown outcome is recorded as ``failed`` rather than minting a new
    label: the label set is a contract, and a caller's typo must not quietly
    become a new timeseries that no alert covers.
    """
    safe_outcome = outcome if outcome in ANALYSIS_OUTCOMES else "failed"
    ANALYSES.labels(analyzer=analyzer, outcome=safe_outcome).inc()
    ANALYSIS_DURATION.labels(analyzer=analyzer).observe(max(0.0, seconds))
    ANALYSIS_BYTES.labels(analyzer=analyzer).observe(max(0, document_bytes))


def analysis_outcome_for(error_code: str) -> str:
    """Which analysis outcome an error contract code represents.

    Derived from the shared error code rather than from the analyzer's own
    failure enum, so the label set stays a handful of words no matter how many
    failure codes either analyzer grows. A document PalCert read and refused
    (`INVALID_DOCUMENT`, `UNSUPPORTED_DOCUMENT`) is not the same event as the
    analyzer itself going wrong (`INTERNAL_ERROR`), and an alert must be able
    to tell them apart: a pile of the first is a Tuesday, a pile of the second
    is an incident.
    """
    if error_code in ("INVALID_DOCUMENT", "UNSUPPORTED_DOCUMENT"):
        return "rejected"
    if error_code == "SERVICE_UNAVAILABLE":
        return "timed_out"
    return "failed"


def render() -> bytes:
    """The exposition text a scraper reads."""
    return generate_latest(REGISTRY)


def known_analysis_outcomes() -> Iterable[str]:
    return ANALYSIS_OUTCOMES
