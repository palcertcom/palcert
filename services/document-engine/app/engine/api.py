"""The rule engine's HTTP surface (§31, §32).

Node orchestrates; Python evaluates. The boundary is deliberately narrow: a
fact set and a list of published rule definitions in, evaluation results out.

What does *not* cross it is the point. No database connection, no storage
credentials, no user session, no raw DOCX. The deterministic engine stays a
pure function of its two inputs, which is what makes it testable in isolation
and what means a compromised engine has nothing to reach for.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request

from app.config import Settings
from app.engine.contracts.validation import validate_contract
from app.engine.evaluation.engine import (
    ENGINE_NAME,
    ENGINE_VERSION,
    SUPPORTED_RULE_SCHEMA_VERSIONS,
    DeterministicRuleEngine,
    RuleDefinition,
)
from app.engine.evaluation.limits import EvaluationLimits
from app.engine.facts.model import FACT_SCHEMA_VERSION, DocumentFactSet
from app.errors import AppError, ErrorCode

MAX_REQUEST_BYTES = 64 * 1024 * 1024


def build_router(settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/evaluation", tags=["evaluation"])
    engine = DeterministicRuleEngine(EvaluationLimits())
    del settings

    @router.get("/capabilities")
    async def capabilities() -> dict[str, Any]:
        """What this engine is and which schema versions it implements."""
        return {
            "engineName": ENGINE_NAME,
            "engineVersion": ENGINE_VERSION,
            "factSchemaVersion": FACT_SCHEMA_VERSION,
            "supportedRuleSchemaVersions": sorted(SUPPORTED_RULE_SCHEMA_VERSIONS),
        }

    @router.post("")
    async def evaluate(request: Request) -> dict[str, Any]:
        """Evaluate published rules against one fact set."""
        raw = await request.body()
        if len(raw) > MAX_REQUEST_BYTES:
            raise AppError(
                ErrorCode.VALIDATION_FAILED,
                "the evaluation request exceeds the size limit",
                details={"maxBytes": MAX_REQUEST_BYTES},
            )

        payload = await _parse(request, raw)

        # The request is validated against the shared contract before anything
        # is evaluated. Malformed input from PalCert's own API is still
        # malformed input (§35).
        result = validate_contract("EvaluationRequest", payload)
        if not result.valid:
            raise AppError(
                ErrorCode.VALIDATION_FAILED,
                "the evaluation request does not satisfy the shared contract",
                details={"issues": [issue.message for issue in result.issues][:20]},
            )

        fact_set = DocumentFactSet.from_json(payload["factSet"])
        rules = [_rule_from(entry) for entry in payload["rules"]]

        results = engine.evaluate_all(fact_set, rules)
        response = {
            "documentId": fact_set.document_id,
            "engine": {
                "engineName": ENGINE_NAME,
                "engineVersion": ENGINE_VERSION,
                "ruleSchemaVersion": _response_rule_schema_version(rules),
                "factSchemaVersion": fact_set.fact_schema_version,
            },
            "results": [item.to_json() for item in results],
        }

        # And the output is validated before it leaves. An engine that emits
        # something the contract forbids must not have that stored as evidence.
        outgoing = validate_contract("EvaluationResponse", response)
        if not outgoing.valid:
            raise AppError(
                ErrorCode.INTERNAL_ERROR,
                "the evaluation response failed its own contract",
                internal_context={"issues": [issue.message for issue in outgoing.issues][:20]},
            )
        return response

    return router


async def _parse(request: Request, raw: bytes) -> dict[str, Any]:
    del request
    try:
        payload = json.loads(raw)
    except ValueError as error:
        raise AppError(ErrorCode.VALIDATION_FAILED, "the request body is not JSON") from error
    if not isinstance(payload, dict):
        raise AppError(ErrorCode.VALIDATION_FAILED, "the request body must be an object")
    return payload


def _rule_from(entry: Any) -> RuleDefinition:
    return RuleDefinition.from_json(entry)


def _response_rule_schema_version(rules: list[RuleDefinition]) -> int:
    """The schema version the engine judged these rules by.

    A standard's rules all carry the same version in practice; taking the
    maximum keeps the response honest for a mixed set rather than silently
    reporting whichever happened to be first.
    """
    versions = [rule.rule_schema_version for rule in rules]
    return max(versions) if versions else max(SUPPORTED_RULE_SCHEMA_VERSIONS)
