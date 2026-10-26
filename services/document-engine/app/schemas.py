"""Response models shared with the PalCert API (Master Prompt 35)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

HealthStatusLiteral = Literal["ok", "degraded", "error"]


class HealthDependency(BaseModel):
    name: str
    status: HealthStatusLiteral
    latency_ms: float | None = Field(default=None, serialization_alias="latencyMs")
    message: str | None = None


class HealthResponse(BaseModel):
    """Mirrors `HealthResponse` in @palcert/contracts."""

    status: HealthStatusLiteral
    service: str
    version: str
    uptime_seconds: int = Field(serialization_alias="uptimeSeconds")
    checked_at: datetime = Field(serialization_alias="checkedAt")
    dependencies: list[HealthDependency] = Field(default_factory=list)

    model_config = {"populate_by_name": True}
