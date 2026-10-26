"""Centralized, validated configuration for the document engine (Master Prompt 46)."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration is validated once at start-up; the process refuses to boot if invalid."""

    model_config = SettingsConfigDict(
        env_prefix="DOC_ENGINE_",
        env_file=None,
        extra="ignore",
        frozen=True,
    )

    environment: Literal["development", "test", "production"] = "development"
    service_name: str = "palcert-document-engine"
    version: str = "0.1.0"

    host: str = "0.0.0.0"  # noqa: S104 - bound inside a container network
    port: int = Field(default=8000, ge=1, le=65535)

    log_level: Literal["debug", "info", "warning", "error"] = "info"
    log_json: bool = True

    # Release identity, supplied by the image build (Phase 20 Checkpoint 2).
    # Empty rather than a fake default: "unknown" is honest, a made-up commit
    # is not.
    commit: str = ""

    # Telemetry (Phase 20 Checkpoint 3). The scrape endpoint is protected
    # first by topology — the release proxy has no route to it — and second by
    # this token, for deployments whose internal network is shared.
    metrics_enabled: bool = True
    metrics_token: str | None = None

    # Resource guards for untrusted uploads (Master Prompt 37).
    max_document_bytes: int = Field(default=50 * 1024 * 1024, ge=1)
    processing_timeout_seconds: int = Field(default=300, ge=1)

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide settings singleton."""
    return Settings()
