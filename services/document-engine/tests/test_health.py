from fastapi.testclient import TestClient

from app.logging_config import REQUEST_ID_HEADER


def test_live_returns_ok(client: TestClient) -> None:
    response = client.get("/health/live")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "palcert-document-engine"
    assert body["dependencies"] == []


def test_health_payload_uses_camel_case_matching_the_typescript_contract(
    client: TestClient,
) -> None:
    body = client.get("/health/ready").json()

    assert "uptimeSeconds" in body
    assert "checkedAt" in body
    assert "uptime_seconds" not in body


def test_ready_returns_ok(client: TestClient) -> None:
    assert client.get("/health/ready").status_code == 200


def test_correlation_id_is_generated_when_absent(client: TestClient) -> None:
    response = client.get("/health/live")

    request_id = response.headers[REQUEST_ID_HEADER]
    assert len(request_id) == 36


def test_correlation_id_is_propagated_from_the_caller(client: TestClient) -> None:
    response = client.get("/health/live", headers={REQUEST_ID_HEADER: "api-request-1"})

    assert response.headers[REQUEST_ID_HEADER] == "api-request-1"


def test_oversized_correlation_id_is_replaced(client: TestClient) -> None:
    response = client.get("/health/live", headers={REQUEST_ID_HEADER: "x" * 500})

    assert response.headers[REQUEST_ID_HEADER] != "x" * 500
    assert len(response.headers[REQUEST_ID_HEADER]) == 36
