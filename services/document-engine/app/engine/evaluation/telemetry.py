"""Structured telemetry for an evaluation run.

One log record per ``evaluate_all``, carrying counts and timings and nothing
else. The field names below are the contract for dashboards and alerts; they
are constants so a renamed field is a code change that shows up in review,
not a silently broken graph.

**What is never logged.** No fact value, no rule's expected value, no violation
evidence, no document text, no rule title or guidance. A fact set describes a
thesis someone has not yet published or a manuscript under blind review, and
"debug logging" is how that kind of content ends up in a log aggregator with a
ninety-day retention policy and forty people who can search it. The record
carries identifiers and numbers only, and :mod:`tests.engine.test_telemetry`
holds it to that.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from app.engine.evaluation.result import RuleEvaluationResult
from app.engine.rules.outcomes import Outcome
from app.logging_config import get_logger

#: The event name every evaluation record is logged under.
EVALUATION_COMPLETED_EVENT = "rule_engine.evaluation_completed"


class MetricField:
    """Field names on the evaluation record.

    Grouped by what they measure. Every field is an identifier, a count or a
    duration; there is deliberately no field that could hold document content.
    """

    ENGINE_NAME = "engine_name"
    ENGINE_VERSION = "engine_version"
    DOCUMENT_ID = "document_id"
    EXTRACTOR_NAME = "extractor_name"
    EXTRACTOR_VERSION = "extractor_version"
    FACT_SCHEMA_VERSION = "fact_schema_version"

    RULE_COUNT = "rule_count"
    FACT_COUNT = "fact_count"
    COVERAGE_ENTRY_COUNT = "coverage_entry_count"
    DURATION_MS = "duration_ms"

    OUTCOME_PASS = "outcome_pass"  # noqa: S105 - an outcome name, not a secret
    OUTCOME_FAIL = "outcome_fail"
    OUTCOME_NOT_APPLICABLE = "outcome_not_applicable"
    OUTCOME_INDETERMINATE = "outcome_indeterminate"

    REVIEW_REQUIRED = "review_required"
    BLOCKING_FAILED = "blocking_failed"
    BLOCKING_UNRESOLVED = "blocking_unresolved"

    FACTS_EVALUATED = "facts_evaluated"
    VIOLATIONS_TOTAL = "violations_total"
    VIOLATIONS_RETURNED = "violations_returned"
    RULES_TRUNCATED = "rules_truncated"

    REASON_CODES = "reason_codes"


@dataclass(frozen=True, slots=True)
class EvaluationSummary:
    """The numbers one evaluation run produced."""

    engine_name: str
    engine_version: str
    document_id: str
    extractor_name: str
    extractor_version: str
    fact_schema_version: int
    rule_count: int
    fact_count: int
    coverage_entry_count: int
    duration_ms: float
    outcome_pass: int
    outcome_fail: int
    outcome_not_applicable: int
    outcome_indeterminate: int
    review_required: int
    blocking_failed: int
    blocking_unresolved: int
    facts_evaluated: int
    violations_total: int
    violations_returned: int
    rules_truncated: int
    reason_codes: dict[str, int]

    def to_fields(self) -> dict[str, Any]:
        return {
            MetricField.ENGINE_NAME: self.engine_name,
            MetricField.ENGINE_VERSION: self.engine_version,
            MetricField.DOCUMENT_ID: self.document_id,
            MetricField.EXTRACTOR_NAME: self.extractor_name,
            MetricField.EXTRACTOR_VERSION: self.extractor_version,
            MetricField.FACT_SCHEMA_VERSION: self.fact_schema_version,
            MetricField.RULE_COUNT: self.rule_count,
            MetricField.FACT_COUNT: self.fact_count,
            MetricField.COVERAGE_ENTRY_COUNT: self.coverage_entry_count,
            MetricField.DURATION_MS: self.duration_ms,
            MetricField.OUTCOME_PASS: self.outcome_pass,
            MetricField.OUTCOME_FAIL: self.outcome_fail,
            MetricField.OUTCOME_NOT_APPLICABLE: self.outcome_not_applicable,
            MetricField.OUTCOME_INDETERMINATE: self.outcome_indeterminate,
            MetricField.REVIEW_REQUIRED: self.review_required,
            MetricField.BLOCKING_FAILED: self.blocking_failed,
            MetricField.BLOCKING_UNRESOLVED: self.blocking_unresolved,
            MetricField.FACTS_EVALUATED: self.facts_evaluated,
            MetricField.VIOLATIONS_TOTAL: self.violations_total,
            MetricField.VIOLATIONS_RETURNED: self.violations_returned,
            MetricField.RULES_TRUNCATED: self.rules_truncated,
            MetricField.REASON_CODES: dict(sorted(self.reason_codes.items())),
        }


def summarize(
    *,
    engine_name: str,
    engine_version: str,
    document_id: str,
    extractor_name: str,
    extractor_version: str,
    fact_schema_version: int,
    fact_count: int,
    coverage_entry_count: int,
    duration_ms: float,
    results: Sequence[RuleEvaluationResult],
) -> EvaluationSummary:
    """Reduce a run's results to counts.

    ``blocking_unresolved`` is the number Phase 7 will care about most: a
    blocking rule that came back INDETERMINATE holds the whole compliance
    decision open, and an operator watching a queue needs to see that number
    climb before the review backlog does.
    """
    outcomes = Counter(result.outcome for result in results)
    reasons = Counter(result.reason_code.value for result in results)

    return EvaluationSummary(
        engine_name=engine_name,
        engine_version=engine_version,
        document_id=document_id,
        extractor_name=extractor_name,
        extractor_version=extractor_version,
        fact_schema_version=fact_schema_version,
        rule_count=len(results),
        fact_count=fact_count,
        coverage_entry_count=coverage_entry_count,
        duration_ms=round(duration_ms, 3),
        outcome_pass=outcomes[Outcome.PASS],
        outcome_fail=outcomes[Outcome.FAIL],
        outcome_not_applicable=outcomes[Outcome.NOT_APPLICABLE],
        outcome_indeterminate=outcomes[Outcome.INDETERMINATE],
        review_required=sum(1 for result in results if result.requires_review),
        blocking_failed=sum(
            1 for result in results if result.blocking and result.outcome is Outcome.FAIL
        ),
        blocking_unresolved=sum(
            1 for result in results if result.blocking and result.outcome is Outcome.INDETERMINATE
        ),
        facts_evaluated=sum(result.counts.evaluated_facts for result in results),
        violations_total=sum(result.total_violation_count for result in results),
        violations_returned=sum(len(result.violations) for result in results),
        rules_truncated=sum(1 for result in results if result.truncated),
        reason_codes=dict(reasons),
    )


def record(summary: EvaluationSummary) -> None:
    """Emit the run's record.

    ``info``, not ``debug``: this is the operational signal for the engine,
    and a signal that only appears when someone turns debug logging on is one
    nobody is watching when it matters.
    """
    get_logger("palcert.rule_engine").info(EVALUATION_COMPLETED_EVENT, **summary.to_fields())
