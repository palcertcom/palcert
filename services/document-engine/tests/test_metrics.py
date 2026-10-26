"""Telemetry contract for the document engine (Phase 20 Checkpoint 3).

The engine handles other people's unpublished documents, so the assertions
here are mostly about what is *absent*: no filename, no document id, no
extracted text, no unbounded label. A metrics endpoint is the most widely
copied and least access-controlled surface a service has.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
import structlog
from fastapi.testclient import TestClient

from app import metrics
from app.config import Settings
from app.main import create_app


@pytest.fixture
def make_client() -> Iterator[object]:
    saved = structlog.get_config()
    clients: list[TestClient] = []

    def build(**overrides: object) -> TestClient:
        settings = Settings(environment="test", log_json=True, log_level="warning", **overrides)  # type: ignore[arg-type]
        client = TestClient(create_app(settings))
        clients.append(client)
        return client

    try:
        yield build
    finally:
        for client in clients:
            client.close()
        structlog.configure(**saved)


SCRAPE_TOKEN = "scrape-secret"  # noqa: S105 - a test fixture, not a credential


def sample_lines(text: str, prefix: str) -> list[str]:
    return [line for line in text.splitlines() if line.startswith(prefix)]


def test_scrape_serves_the_prometheus_text_format(client: TestClient) -> None:
    response = client.get("/metrics")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert response.headers["cache-control"] == "no-store"
    assert "# HELP palcert_build_info" in response.text


def test_scrape_publishes_exactly_one_build_identity(client: TestClient) -> None:
    lines = sample_lines(client.get("/metrics").text, "palcert_build_info{")

    assert len(lines) == 1
    assert 'service="palcert-document-engine"' in lines[0]
    assert 'environment="test"' in lines[0]


def test_scrape_is_absent_rather_than_forbidden_when_disabled(make_client) -> None:  # type: ignore[no-untyped-def]
    client = make_client(metrics_enabled=False)

    # 404, not 403: a deployment that turned telemetry off should look like one
    # that never had it rather than advertise a disabled feature.
    assert client.get("/metrics").status_code == 404


@pytest.mark.parametrize(
    "header",
    [None, "", "scrape-secret", "Basic scrape-secret", "Bearer wrong", "Bearer scrape-secre"],
)
def test_scrape_refuses_every_wrong_token(make_client, header: str | None) -> None:  # type: ignore[no-untyped-def]
    client = make_client(metrics_token=SCRAPE_TOKEN)
    headers = {} if header is None else {"authorization": header}

    assert client.get("/metrics", headers=headers).status_code == 403


def test_scrape_accepts_the_configured_token_and_never_echoes_it(make_client) -> None:  # type: ignore[no-untyped-def]
    client = make_client(metrics_token=SCRAPE_TOKEN)

    response = client.get("/metrics", headers={"authorization": f"Bearer {SCRAPE_TOKEN}"})

    assert response.status_code == 200
    assert SCRAPE_TOKEN not in response.text


def test_http_metrics_use_route_templates_not_requested_paths(client: TestClient) -> None:
    client.get("/analysis/docx/capabilities")

    lines = sample_lines(client.get("/metrics").text, "palcert_http_requests_total{")

    assert any('route="/analysis/docx/capabilities"' in line for line in lines)
    assert all("9f3c" not in line for line in lines)
    for line in lines:
        assert 'status_class="' in line


def test_unmatched_requests_share_one_series(client: TestClient) -> None:
    for path in ("/wp-admin", "/.env", "/phpmyadmin"):
        client.get(path)

    lines = sample_lines(client.get("/metrics").text, "palcert_http_requests_total{")
    unmatched = [
        line for line in lines if metrics.UNMATCHED_ROUTE in line and 'status_class="4xx"' in line
    ]

    # One series for three probed paths is the whole property, and none of the
    # probed paths appears anywhere. The counter's value is deliberately not
    # asserted: the registry is process-wide, and a test that depends on how
    # many requests other tests made fails on collection order rather than on
    # behaviour.
    assert len(unmatched) == 1
    for path in ("wp-admin", ".env", "phpmyadmin"):
        assert all(path not in line for line in lines)


def test_probes_and_scrapes_are_not_counted_as_traffic(client: TestClient) -> None:
    client.get("/health/live")
    client.get("/health/ready")

    lines = sample_lines(client.get("/metrics").text, "palcert_http_requests_total{")

    assert not any("/health" in line for line in lines)
    assert not any("/metrics" in line for line in lines)


def test_status_class_is_five_values_not_sixty() -> None:
    assert metrics.status_class(200) == "2xx"
    assert metrics.status_class(404) == "4xx"
    assert metrics.status_class(503) == "5xx"
    assert metrics.status_class(0) == "unknown"
    assert metrics.status_class(999) == "unknown"


def test_analysis_outcomes_separate_a_bad_document_from_a_broken_analyzer() -> None:
    assert metrics.analysis_outcome_for("INVALID_DOCUMENT") == "rejected"
    assert metrics.analysis_outcome_for("UNSUPPORTED_DOCUMENT") == "rejected"
    assert metrics.analysis_outcome_for("SERVICE_UNAVAILABLE") == "timed_out"
    assert metrics.analysis_outcome_for("INTERNAL_ERROR") == "failed"


def test_an_unknown_outcome_never_mints_a_new_label() -> None:
    metrics.observe_analysis("docx", "something-nobody-declared", 0.1, 10)

    rendered = metrics.render().decode()
    assert "something-nobody-declared" not in rendered


def test_a_rejected_upload_is_recorded_without_naming_the_document(client: TestClient) -> None:
    oversized = b"x" * (Settings(environment="test").max_document_bytes + 1)

    client.post(
        "/analysis/docx",
        content=oversized,
        headers={
            "x-palcert-document-id": "9f3c1f6e-1111-2222-3333-444455556666",
            "x-palcert-expected-sha256": "0" * 64,
        },
    )

    lines = sample_lines(client.get("/metrics").text, "palcert_analyses_total{")
    assert any('outcome="too_large"' in line for line in lines)
    assert all("9f3c1f6e" not in line for line in lines)


def test_no_label_anywhere_carries_an_identifier(client: TestClient) -> None:
    client.get("/analysis/pdf/capabilities")

    rendered = client.get("/metrics").text
    samples = [line for line in rendered.splitlines() if line and not line.startswith("#")]

    for forbidden in ("document_id", "documentId", "filename", "title", "user", "organization"):
        assert all(forbidden not in line for line in samples), forbidden
