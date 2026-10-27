"""The SmartFix HTTP surface.

The boundary is deliberately narrow: bytes and identifiers in, bytes and
identifiers out. These tests hold that line — nothing about *where* a document
lives may cross, and a refusal has to arrive as a code the worker can act on
rather than as a stack trace.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from fastapi.testclient import TestClient

from app.smartfix.api import (
    DOCUMENT_ID_HEADER,
    MANIFEST_SHA_HEADER,
    OUTPUT_SHA_HEADER,
    PLAN_SHA_HEADER,
)
from app.smartfix.framing import decode, encode
from app.smartfix.model import SmartFixPlan, canonical_json, sha256_hex
from tests.docx.builder import DocxBuilder, section_properties
from tests.smartfix.support import element, plan_source, rule

BODY = (
    '<w:p><w:r><w:rPr><w:sz w:val="20"/></w:rPr>'
    '<w:t xml:space="preserve">Body text</w:t></w:r></w:p>'
) + section_properties()

SIZE_RULE = rule(
    "SIZE", element("fontSize"), "EQUALS", {"type": "NUMBER", "number": 12}, unit="POINT"
)


def _document() -> tuple[bytes, str]:
    content = DocxBuilder(body=BODY).build()
    return content, hashlib.sha256(content).hexdigest()


def _plan_body(content: bytes, digest: str, rules: list[dict[str, Any]] | None = None) -> bytes:
    return encode(
        {
            "rules": rules if rules is not None else [SIZE_RULE],
            "source": plan_source(digest).to_json(),
        },
        content,
    )


def test_the_capabilities_endpoint_publishes_the_registry(client: TestClient) -> None:
    response = client.get("/smartfix/capabilities")
    assert response.status_code == 200
    payload = response.json()
    assert payload["fixEngineName"] == "palcert-docx-fixer"
    # The Rule Builder needs this to tell a standard author which of their
    # rules SmartFix could act on, rather than letting them mark one SAFE and
    # discover later that PalCert has no way to make the change.
    assert any(
        entry["property"] == "fontSizeComplexScript"
        for entry in payload["registry"]["capabilities"]
    )


def test_planning_returns_a_hashed_plan(client: TestClient) -> None:
    content, digest = _document()
    response = client.post(
        "/smartfix/plan",
        content=_plan_body(content, digest),
        headers={DOCUMENT_ID_HEADER: "doc-1"},
    )
    assert response.status_code == 200
    plan = SmartFixPlan.from_json(response.json())
    assert len(plan.actions) == 1
    # The hash travels in a header and is over the bytes actually returned, so
    # the caller stores the same number the engine will recompute.
    assert response.headers[PLAN_SHA_HEADER] == sha256_hex(response.content)
    assert response.headers["x-palcert-action-count"] == "1"


def test_ai_preview_and_proposal_compile_use_the_same_source_and_hash(client: TestClient) -> None:
    content, digest = _document()
    payload = {
        "rules": [SIZE_RULE],
        "source": plan_source(digest).to_json(),
        "includeAIContext": True,
    }
    initial = client.post(
        "/smartfix/plan", content=encode(payload, content), headers={DOCUMENT_ID_HEADER: "d"}
    )
    assert initial.status_code == 200
    context, plan_bytes = decode(initial.content)
    assert context["rules"][0]["outcome"] == "FAIL"
    assert context["complete"] is False
    assert b"Body text" not in initial.content
    assert initial.headers[PLAN_SHA_HEADER] == sha256_hex(plan_bytes)
    assert json.loads(plan_bytes)["actions"] == []
    payload["aiTargets"] = [{"ruleCode": "SIZE", "kind": "NUMBER", "value": "12"}]
    proposed = client.post(
        "/smartfix/plan", content=encode(payload, content), headers={DOCUMENT_ID_HEADER: "d"}
    )
    assert proposed.status_code == 200
    after, final_bytes = decode(proposed.content)
    assert after["complete"] is True
    plan = json.loads(final_bytes)
    assert plan["source"]["documentSha256"] == digest
    assert proposed.headers[PLAN_SHA_HEADER] == sha256_hex(final_bytes)
    applied = client.post(
        "/smartfix/apply",
        content=encode(
            {"plan": plan, "planHash": sha256_hex(final_bytes), "expectedSourceSha256": digest},
            content,
        ),
    )
    assert applied.status_code == 200


def test_ai_cannot_submit_xml_or_override_rule_scopes(client: TestClient) -> None:
    content, digest = _document()
    payload = {
        "rules": [SIZE_RULE],
        "source": plan_source(digest).to_json(),
        "aiTargets": [
            {"ruleCode": "SIZE", "kind": "NUMBER", "value": "12", "xml": "<w:t>rewrite</w:t>"}
        ],
    }
    response = client.post(
        "/smartfix/plan", content=encode(payload, content), headers={DOCUMENT_ID_HEADER: "d"}
    )
    assert response.status_code == 400


def test_a_plan_response_is_canonical(client: TestClient) -> None:
    content, digest = _document()
    first = client.post(
        "/smartfix/plan", content=_plan_body(content, digest), headers={DOCUMENT_ID_HEADER: "d"}
    )
    second = client.post(
        "/smartfix/plan", content=_plan_body(content, digest), headers={DOCUMENT_ID_HEADER: "d"}
    )
    assert first.content == second.content


def test_planning_without_a_document_id_is_refused(client: TestClient) -> None:
    content, digest = _document()
    response = client.post("/smartfix/plan", content=_plan_body(content, digest))
    assert response.status_code == 400


def test_planning_a_document_that_is_not_the_one_named_is_refused(client: TestClient) -> None:
    content, _ = _document()
    response = client.post(
        "/smartfix/plan",
        content=_plan_body(content, "0" * 64),
        headers={DOCUMENT_ID_HEADER: "doc-1"},
    )
    assert response.status_code in (400, 422)


def test_an_unframed_body_is_refused(client: TestClient) -> None:
    response = client.post(
        "/smartfix/plan", content=b"not a frame", headers={DOCUMENT_ID_HEADER: "doc-1"}
    )
    assert response.status_code == 400


def test_an_empty_body_is_refused(client: TestClient) -> None:
    response = client.post("/smartfix/plan", content=b"", headers={DOCUMENT_ID_HEADER: "doc-1"})
    assert response.status_code == 400


def test_applying_returns_the_corrected_document_and_its_manifest(client: TestClient) -> None:
    content, digest = _document()
    planned = client.post(
        "/smartfix/plan", content=_plan_body(content, digest), headers={DOCUMENT_ID_HEADER: "d"}
    )
    payload = planned.json()

    response = client.post(
        "/smartfix/apply",
        content=encode(
            {
                "plan": payload,
                "planHash": sha256_hex(canonical_json(payload)),
                "expectedSourceSha256": digest,
            },
            content,
        ),
    )
    assert response.status_code == 200
    manifest, corrected = decode(response.content)
    assert response.headers[OUTPUT_SHA_HEADER] == hashlib.sha256(corrected).hexdigest()
    assert response.headers[MANIFEST_SHA_HEADER]
    assert manifest["changedParts"] == ["word/document.xml"]
    assert (
        manifest["integrity"]["sourceVisibleTextHash"]
        == (manifest["integrity"]["outputVisibleTextHash"])
    )
    assert corrected != content


def test_applying_a_plan_whose_hash_does_not_match_is_refused(client: TestClient) -> None:
    content, digest = _document()
    planned = client.post(
        "/smartfix/plan", content=_plan_body(content, digest), headers={DOCUMENT_ID_HEADER: "d"}
    )
    response = client.post(
        "/smartfix/apply",
        content=encode(
            {"plan": planned.json(), "planHash": "0" * 64, "expectedSourceSha256": digest},
            content,
        ),
    )
    # 422: the document (or the plan bound to it) is the problem, not the
    # request's shape — the worker must not retry either.
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fixError"] == "SMARTFIX_PLAN_INVALID"


def test_applying_to_a_different_document_is_refused(client: TestClient) -> None:
    content, digest = _document()
    planned = client.post(
        "/smartfix/plan", content=_plan_body(content, digest), headers={DOCUMENT_ID_HEADER: "d"}
    )
    payload = planned.json()
    other = DocxBuilder(body=BODY.replace("Body text", "Other text")).build()
    response = client.post(
        "/smartfix/apply",
        content=encode(
            {
                "plan": payload,
                "planHash": sha256_hex(canonical_json(payload)),
                "expectedSourceSha256": digest,
            },
            other,
        ),
    )
    # 422: the document (or the plan bound to it) is the problem, not the
    # request's shape — the worker must not retry either.
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fixError"] == "SMARTFIX_SOURCE_INTEGRITY_FAILED"


def test_applying_an_empty_plan_is_refused(client: TestClient) -> None:
    content, digest = _document()
    planned = client.post(
        "/smartfix/plan",
        content=_plan_body(content, digest, rules=[]),
        headers={DOCUMENT_ID_HEADER: "d"},
    )
    payload = planned.json()
    response = client.post(
        "/smartfix/apply",
        content=encode(
            {
                "plan": payload,
                "planHash": sha256_hex(canonical_json(payload)),
                "expectedSourceSha256": digest,
            },
            content,
        ),
    )
    # 422: the document (or the plan bound to it) is the problem, not the
    # request's shape — the worker must not retry either.
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fixError"] == "SMARTFIX_PLAN_EMPTY"


def test_a_malformed_apply_request_is_refused(client: TestClient) -> None:
    content, _ = _document()
    response = client.post("/smartfix/apply", content=encode({"plan": {}}, content))
    assert response.status_code == 400


def test_no_response_carries_a_storage_location(client: TestClient) -> None:
    """The engine never learns where a document lives, so it cannot leak it.

    A compromised document engine has nothing to reach for — no bucket, no
    object key, no URL, no database identifier.
    """
    content, digest = _document()
    response = client.post(
        "/smartfix/plan", content=_plan_body(content, digest), headers={DOCUMENT_ID_HEADER: "d"}
    )
    rendered = json.dumps(response.json()) + json.dumps(dict(response.headers))
    for forbidden in ("s3://", "http://", "https://", "bucket", "objectKey"):
        assert forbidden not in rendered


def test_preflight_failure_is_reported_as_a_document_refusal(client: TestClient) -> None:
    content, digest = _document()
    rules = [
        SIZE_RULE,
        {**SIZE_RULE, "ruleCode": "CONFLICT", "expected": {"type": "NUMBER", "number": 14}},
    ]
    response = client.post(
        "/smartfix/plan",
        content=_plan_body(content, digest, rules),
        headers={DOCUMENT_ID_HEADER: "doc"},
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fixError"].startswith("SMARTFIX_")
