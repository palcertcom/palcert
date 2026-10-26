"""The rule engine's HTTP boundary (§31, §32).

Node orchestrates; Python evaluates. These tests are about the boundary
itself rather than about any operator: that a request is validated against
the shared contract before anything is evaluated, that a response is
validated before it leaves, and that nothing beyond a fact set and a list of
published rules is needed — or accepted.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


def _fact_set() -> dict[str, Any]:
    return {
        "factSchemaVersion": 2,
        "documentId": "synthetic-test-document",
        "extractor": {"name": "synthetic", "version": "1"},
        # The engine refuses to judge a scope the extractor did not claim to
        # have covered, so a fact set that omits this reads as INDETERMINATE
        # rather than as a pass.
        "coverage": [{"kind": "DOCUMENT", "status": "COMPLETE"}],
        "facts": [
            {
                "scope": {"kind": "DOCUMENT", "property": "marginTop"},
                "value": {"type": "NUMBER", "number": "30"},
                "unit": "MILLIMETRE",
                "location": {"locationSchemaVersion": 1, "nodeId": "n-1"},
            }
        ],
    }


def _rule(**overrides: Any) -> dict[str, Any]:
    rule: dict[str, Any] = {
        "ruleCode": "MARGIN.TOP.MIN",
        "scope": {"kind": "DOCUMENT", "property": "marginTop"},
        "operator": "GREATER_THAN_OR_EQUAL",
        "expected": {"type": "NUMBER", "number": 25},
        "unit": "MILLIMETRE",
        "evaluationMode": "DETERMINISTIC",
        "severity": "MAJOR",
        "blocking": True,
        "ruleSchemaVersion": 2,
    }
    rule.update(overrides)
    return rule


def test_capabilities_names_the_engine_and_its_schema_versions(client: TestClient) -> None:
    response = client.get("/evaluation/capabilities")
    assert response.status_code == 200

    body = response.json()
    assert body["engineName"]
    # A semantic engine version, not a build identifier: how a rule is
    # evaluated must be identifiable independently of deployments (§79).
    assert body["engineVersion"]
    assert body["factSchemaVersion"] >= 1
    assert body["supportedRuleSchemaVersions"]


def test_evaluates_a_published_rule_against_a_fact_set(client: TestClient) -> None:
    response = client.post("/evaluation", json={"factSet": _fact_set(), "rules": [_rule()]})
    assert response.status_code == 200

    body = response.json()
    assert body["documentId"] == "synthetic-test-document"
    assert len(body["results"]) == 1

    result = body["results"][0]
    assert result["ruleCode"] == "MARGIN.TOP.MIN"
    assert result["outcome"] == "PASS"
    assert result["reasonCode"] == "SATISFIED"
    assert result["evidenceLevel"] == "DETERMINISTIC"
    # Every result names the engine that produced it, so a stored outcome can
    # still be explained after the engine has moved on.
    assert result["engine"]["engineName"] == body["engine"]["engineName"]


def test_reports_a_failing_rule_with_machine_readable_evidence(client: TestClient) -> None:
    facts = _fact_set()
    facts["facts"][0]["value"]["number"] = "10"

    response = client.post("/evaluation", json={"factSet": facts, "rules": [_rule()]})
    assert response.status_code == 200

    result = response.json()["results"][0]
    assert result["outcome"] == "FAIL"
    assert result["totalViolationCount"] >= 1
    violation = result["violations"][0]
    # Codes and typed values, never prose: the report layer turns this into a
    # sentence, in whichever language the reader wants.
    assert violation["reasonCode"]
    assert violation["actual"]["value"] == "10"
    assert "message" not in violation


def test_refuses_a_request_that_does_not_satisfy_the_shared_contract(
    client: TestClient,
) -> None:
    response = client.post("/evaluation", json={"factSet": {"factSchemaVersion": 2}, "rules": []})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


def test_refuses_a_body_that_is_not_an_object(client: TestClient) -> None:
    response = client.post(
        "/evaluation", content=b"[]", headers={"content-type": "application/json"}
    )
    assert response.status_code == 400


def test_refuses_a_body_that_is_not_json(client: TestClient) -> None:
    response = client.post(
        "/evaluation", content=b"not json", headers={"content-type": "application/json"}
    )
    assert response.status_code == 400


def test_evaluates_an_empty_rule_set_without_inventing_results(client: TestClient) -> None:
    # A standard with no rules cannot say anything about a document, and the
    # engine must not pretend otherwise.
    response = client.post("/evaluation", json={"factSet": _fact_set(), "rules": []})
    assert response.status_code == 200
    assert response.json()["results"] == []


def test_carries_no_document_text_across_the_boundary(client: TestClient) -> None:
    # The engine receives facts, not the document. Nothing it returns should
    # contain anything resembling the user's prose (§49, §71).
    response = client.post("/evaluation", json={"factSet": _fact_set(), "rules": [_rule()]})
    body = response.text
    assert "filename" not in body
    assert "text" not in body
