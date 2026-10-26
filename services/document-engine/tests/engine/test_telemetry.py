"""The evaluation record: what it carries and, more importantly, what it must not."""

from __future__ import annotations

import json
from typing import Any

import structlog

from app.engine.evaluation.engine import ENGINE_NAME, ENGINE_VERSION, DeterministicRuleEngine
from app.engine.evaluation.telemetry import (
    EVALUATION_COMPLETED_EVENT,
    MetricField,
    summarize,
)
from tests.engine.conftest import (
    coverage,
    document_scope,
    element_scope,
    fact_set,
    number_fact,
    rule,
    string_fact,
)

#: A value no legitimate log line could contain by coincidence. If it shows up
#: in the record, document content is leaking.
SENTINEL = "CONFIDENTIAL-9f3a7c-DO-NOT-LOG"

SIZE = element_scope("PARAGRAPH", "fontSize")
TITLE = document_scope("title")
COVER = [
    coverage("ELEMENT", element_type="PARAGRAPH", prop="fontSize"),
    coverage("DOCUMENT", prop="title"),
]


def _facts() -> Any:
    return fact_set(
        [
            number_fact(SIZE, "11", "POINT", "p-1", 1, 1),
            number_fact(SIZE, "12", "POINT", "p-2", 1, 2),
            string_fact(TITLE, SENTINEL, "t-1", 1),
        ],
        COVER,
    )


def _rules() -> list[Any]:
    return [
        rule(
            SIZE,
            "EQUALS",
            {"type": "NUMBER", "number": 12},
            code="R.SIZE",
            unit="POINT",
            blocking=True,
        ),
        rule(TITLE, "EQUALS", {"type": "STRING", "text": SENTINEL}, code="R.TITLE"),
        rule(
            TITLE,
            "EXISTS",
            {"type": "NONE"},
            code="R.ETHICS",
            evaluation_mode="AI_ASSISTED",
            blocking=True,
        ),
    ]


def _captured() -> list[dict[str, Any]]:
    with structlog.testing.capture_logs() as records:
        DeterministicRuleEngine().evaluate_all(_facts(), _rules())
    return [entry for entry in records if entry["event"] == EVALUATION_COMPLETED_EVENT]


class TestOneRecordPerRun:
    def test_evaluate_all_emits_exactly_one_record(self) -> None:
        assert len(_captured()) == 1

    def test_the_record_is_at_info_level(self) -> None:
        # A signal that only exists under debug logging is one nobody watches.
        assert _captured()[0]["log_level"] == "info"


class TestTheRecordCarriesTheDocumentedFields:
    def test_every_metric_field_is_present(self) -> None:
        record = _captured()[0]
        documented = {
            value
            for name, value in vars(MetricField).items()
            if not name.startswith("_") and isinstance(value, str)
        }
        assert documented <= set(record)

    def test_identity_fields(self) -> None:
        record = _captured()[0]
        assert record[MetricField.ENGINE_NAME] == ENGINE_NAME
        assert record[MetricField.ENGINE_VERSION] == ENGINE_VERSION
        assert record[MetricField.DOCUMENT_ID] == "synthetic-test-document"
        assert record[MetricField.EXTRACTOR_NAME] == "synthetic"
        assert record[MetricField.FACT_SCHEMA_VERSION] == 1

    def test_the_counts_reconcile_with_the_results(self) -> None:
        record = _captured()[0]
        assert record[MetricField.RULE_COUNT] == 3
        assert record[MetricField.FACT_COUNT] == 3
        assert record[MetricField.COVERAGE_ENTRY_COUNT] == 2
        # R.SIZE fails on p-1, R.TITLE passes, R.ETHICS is unresolved.
        assert record[MetricField.OUTCOME_FAIL] == 1
        assert record[MetricField.OUTCOME_PASS] == 1
        assert record[MetricField.OUTCOME_INDETERMINATE] == 1
        assert record[MetricField.REVIEW_REQUIRED] == 1
        assert record[MetricField.BLOCKING_FAILED] == 1
        assert record[MetricField.BLOCKING_UNRESOLVED] == 1
        assert record[MetricField.VIOLATIONS_TOTAL] == 1
        assert record[MetricField.VIOLATIONS_RETURNED] == 1
        assert record[MetricField.RULES_TRUNCATED] == 0
        assert record[MetricField.REASON_CODES] == {
            "AI_REVIEW_REQUIRED": 1,
            "SATISFIED": 1,
            "VALUE_MISMATCH": 1,
        }

    def test_duration_is_measured_not_defaulted(self) -> None:
        record = _captured()[0]
        assert isinstance(record[MetricField.DURATION_MS], float)
        assert record[MetricField.DURATION_MS] >= 0


class TestTheRecordCarriesNoContent:
    """The property the module docstring promises."""

    def test_no_fact_value_reaches_the_log(self) -> None:
        serialized = json.dumps(_captured()[0], default=str)
        assert SENTINEL not in serialized

    def test_no_expected_value_reaches_the_log(self) -> None:
        # The rule's expected value is the standard's content; a journal's
        # unpublished requirements are confidential too.
        serialized = json.dumps(_captured()[0], default=str)
        assert '"12"' not in serialized
        assert "fontSize" not in serialized

    def test_no_violation_evidence_reaches_the_log(self) -> None:
        serialized = json.dumps(_captured()[0], default=str)
        assert "p-1" not in serialized
        assert "normalizedValue" not in serialized
        assert "location" not in serialized

    def test_no_rule_code_reaches_the_log(self) -> None:
        # Rule codes are aggregated into reason-code counts, never listed:
        # a list of failing rule codes is a description of the document.
        serialized = json.dumps(_captured()[0], default=str)
        assert "R.SIZE" not in serialized
        assert "R.TITLE" not in serialized

    def test_every_field_is_a_number_a_version_or_an_identifier(self) -> None:
        record = _captured()[0]
        for name, value in record.items():
            if name in ("event", "log_level"):
                continue
            if isinstance(value, dict):
                assert all(isinstance(count, int) for count in value.values()), name
                continue
            assert isinstance(value, (int, float, str)), name
            if isinstance(value, str):
                # Identifiers only: short, single-token.
                assert len(value) <= 128 and " " not in value, name


class TestSummaryIsDeterministic:
    def test_reason_codes_are_emitted_in_a_fixed_order(self) -> None:
        # Dictionary order must not depend on which rule finished first, or
        # two identical runs produce two different log lines.
        results = DeterministicRuleEngine().evaluate_all(_facts(), _rules())
        forward = summarize(
            engine_name=ENGINE_NAME,
            engine_version=ENGINE_VERSION,
            document_id="d",
            extractor_name="x",
            extractor_version="1",
            fact_schema_version=1,
            fact_count=3,
            coverage_entry_count=2,
            duration_ms=0.0,
            results=results,
        ).to_fields()
        backward = summarize(
            engine_name=ENGINE_NAME,
            engine_version=ENGINE_VERSION,
            document_id="d",
            extractor_name="x",
            extractor_version="1",
            fact_schema_version=1,
            fact_count=3,
            coverage_entry_count=2,
            duration_ms=0.0,
            results=list(reversed(results)),
        ).to_fields()
        assert json.dumps(forward) == json.dumps(backward)
