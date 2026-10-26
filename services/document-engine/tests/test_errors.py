import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.errors import AppError, ErrorCode, default_status_for
from app.main import create_app


def test_error_codes_map_to_valid_http_statuses() -> None:
    for code in ErrorCode:
        assert 400 <= default_status_for(code) < 600


def test_public_dict_excludes_internal_context() -> None:
    error = AppError(
        ErrorCode.INVALID_DOCUMENT,
        "Document could not be parsed",
        details={"page": 3},
        internal_context={"path": "/srv/uploads/secret.docx", "token": "abc123"},
    )

    payload = error.to_public_dict("req-1")

    assert payload == {
        "error": {
            "code": "INVALID_DOCUMENT",
            "message": "Document could not be parsed",
            "details": {"page": 3},
            "requestId": "req-1",
        }
    }
    assert "abc123" not in str(payload)
    assert "/srv/uploads" not in str(payload)


def test_app_error_response_is_structured() -> None:
    settings = Settings(environment="test")
    app: FastAPI = create_app(settings)

    @app.get("/boom-app-error")
    async def boom() -> None:
        raise AppError(ErrorCode.UNSUPPORTED_DOCUMENT, "Only DOCX and PDF are supported")

    with TestClient(app) as client:
        response = client.get("/boom-app-error")

    assert response.status_code == 415
    assert response.json()["error"]["code"] == "UNSUPPORTED_DOCUMENT"
    assert response.json()["error"]["requestId"]


def test_unexpected_error_never_leaks_details() -> None:
    settings = Settings(environment="test")
    app: FastAPI = create_app(settings)

    @app.get("/boom-unexpected")
    async def boom() -> None:
        raise RuntimeError("connection string postgres://user:hunter2@db")

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/boom-unexpected")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "INTERNAL_ERROR"
    assert "hunter2" not in response.text


def test_docs_are_disabled_in_production() -> None:
    app = create_app(Settings(environment="production"))
    assert app.docs_url is None
    assert app.openapi_url is None


@pytest.mark.parametrize("path", ["/docs", "/openapi.json"])
def test_docs_are_available_outside_production(path: str) -> None:
    with TestClient(create_app(Settings(environment="development"))) as client:
        assert client.get(path).status_code == 200
