"""The Python half of the cross-language SmartFix contract tests.

The fixtures are the same files `packages/contracts/src/smartfix/
cross-language.spec.ts` reads, validated against the same schema. One runtime
accepting what the other rejects fails CI, which is the whole reason there is
one schema rather than two hand-written models.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.smartfix.contracts import (
    SmartFixContractError,
    assert_contract,
    load_schema,
    validate_contract,
)


def _fixture_root() -> Path:
    for directory in Path(__file__).resolve().parents:
        candidate = directory / "contracts" / "fixtures" / "smartfix"
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError("Could not locate contracts/fixtures/smartfix")


ROOT = _fixture_root()
ACCEPTED = sorted((ROOT / "accepted").glob("*.json"))
REJECTED = sorted((ROOT / "rejected").glob("*.json"))


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_fixtures_are_present() -> None:
    assert len(ACCEPTED) >= 8
    assert len(REJECTED) >= 15


@pytest.mark.parametrize("path", ACCEPTED, ids=lambda p: p.stem)
def test_accepted_fixture_validates(path: Path) -> None:
    fixture = _read(path)
    result = validate_contract(fixture["contract"], fixture["value"])
    assert result.issues == ()
    assert result.valid


@pytest.mark.parametrize("path", REJECTED, ids=lambda p: p.stem)
def test_rejected_fixture_is_refused(path: Path) -> None:
    fixture = _read(path)
    result = validate_contract(fixture["contract"], fixture["value"])
    assert not result.valid
    assert result.issues


@pytest.mark.parametrize("path", ACCEPTED + REJECTED, ids=lambda p: p.stem)
def test_every_fixture_says_why_it_exists(path: Path) -> None:
    # A fixture nobody can explain is a fixture nobody will maintain.
    assert len(_read(path)["why"]) > 20


def test_assert_contract_lists_every_problem() -> None:
    with pytest.raises(SmartFixContractError) as raised:
        assert_contract("FixAction", {"actionId": "../etc", "actionType": "NOPE"})
    message = str(raised.value)
    assert "FixAction" in message
    assert message.count(";") >= 2


def test_unknown_contract_is_a_programming_error() -> None:
    with pytest.raises(KeyError):
        validate_contract("RewriteEverything", {})


def test_schema_is_the_shared_file() -> None:
    assert load_schema()["$id"] == "https://palcert.com/schemas/smartfix.schema.json"
