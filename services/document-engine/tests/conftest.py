import os
from collections.abc import Iterator

import pytest
import structlog
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import create_app


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove ambient DOC_ENGINE_* variables so tests never depend on the shell.

    `Settings` reads the process environment, so a developer (or CI job) with a
    sourced .env would otherwise see different results from a clean checkout.
    """
    for key in [k for k in os.environ if k.startswith("DOC_ENGINE_")]:
        monkeypatch.delenv(key, raising=False)
    get_settings.cache_clear()


@pytest.fixture
def settings() -> Settings:
    return Settings(environment="test", log_json=True, log_level="warning")


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    """A test client over a real application, leaving no global state behind.

    Building the app configures structlog, which is process-global. Without
    restoring it, a suite that builds an app silently changes how every later
    test observes logging — including the telemetry suites, which capture
    records to prove that document content never reaches a log line. That
    would make a privacy assertion pass or fail on collection order, so the
    configuration is put back exactly as it was found.
    """
    saved = structlog.get_config()
    try:
        with TestClient(create_app(settings)) as test_client:
            yield test_client
    finally:
        structlog.configure(**saved)
