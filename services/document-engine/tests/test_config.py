import pytest
from pydantic import ValidationError

from app.config import Settings


def test_defaults_are_safe() -> None:
    settings = Settings()

    assert settings.environment == "development"
    assert settings.is_production is False
    assert settings.log_json is True
    assert settings.max_document_bytes == 50 * 1024 * 1024
    assert settings.processing_timeout_seconds == 300


def test_environment_variables_override_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DOC_ENGINE_PORT", "9100")
    monkeypatch.setenv("DOC_ENGINE_ENVIRONMENT", "production")

    settings = Settings()

    assert settings.port == 9100
    assert settings.is_production is True


def test_invalid_port_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Settings(port=70000)


def test_invalid_environment_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Settings(environment="staging")  # type: ignore[arg-type]


def test_settings_are_immutable() -> None:
    settings = Settings()
    with pytest.raises(ValidationError):
        settings.port = 1234  # type: ignore[misc]
