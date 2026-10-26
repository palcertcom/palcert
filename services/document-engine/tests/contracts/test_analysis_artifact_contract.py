"""The analysis artifact contract, from the Python side (§33).

The same fixtures the TypeScript suite validates, against the same schema
file. Phase 6 left this shape defined only here, which meant Node had to trust
whatever dictionaries arrived; running both sides over one fixture set is what
turns "they should agree" into "CI proves they agree".
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.engine.contracts.artifact_contract import validate_analysis_artifact
from app.engine.contracts.validation import validate_contract

FIXTURES = Path(__file__).resolve().parents[4] / "contracts" / "fixtures" / "analysis"


def _load(name: str) -> object:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_fixture_directory_exists() -> None:
    assert FIXTURES.is_dir(), f"missing shared fixtures at {FIXTURES}"


def test_accepts_a_real_artifact() -> None:
    result = validate_analysis_artifact(_load("artifact-v2-minimal.json"))
    assert result.valid, [issue.message for issue in result.issues]


def test_inner_fact_set_satisfies_the_evaluation_contract() -> None:
    artifact = _load("artifact-v2-minimal.json")
    assert isinstance(artifact, dict)
    result = validate_contract("DocumentFactSet", artifact["factSet"])
    assert result.valid, [issue.message for issue in result.issues]


@pytest.mark.parametrize("name", sorted(path.name for path in FIXTURES.glob("invalid-*.json")))
def test_rejects_invalid_fixtures(name: str) -> None:
    assert validate_analysis_artifact(_load(name)).valid is False


def test_rejection_fixtures_exist() -> None:
    assert list(FIXTURES.glob("invalid-*.json"))


def test_the_production_image_ships_the_shared_contracts() -> None:
    """The image must carry the files both runtimes read at runtime.

    The schema validator and the property support registry both walk up from
    their module to find repository data, which works in a checkout and fails
    in an image that copied only the package. That failure surfaces on the
    first analysis in production and nowhere earlier — the Docker CI job builds
    the image without running it — so it is asserted here instead.
    """
    root = Path(__file__).resolve()
    while not (root / "docker").is_dir():
        root = root.parent
    dockerfile = (root / "docker" / "document-engine.Dockerfile").read_text(encoding="utf-8")
    assert "COPY --chown=palcert:palcert contracts ./contracts" in dockerfile
