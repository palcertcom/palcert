"""Evaluation results and their canonical serialization.

Results are machine-readable evidence, not prose. No natural-language
explanation is generated here: the report and AI layers of later phases turn
`reasonCode` + `expected` + `actual` + `location` into something a person
reads, and they need structure to do that, not a sentence to re-parse.

Serialization is canonical — key order fixed, absent values omitted rather than
nulled, violations sorted by location — so two runs of the same evaluation
produce byte-identical JSON. Dictionary iteration order must never reach the
output.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from app.engine.facts.model import Location
from app.engine.rules.outcomes import (
    EvaluationMode,
    EvidenceLevel,
    Outcome,
    ReasonCode,
    Severity,
)
from app.engine.units.registry import Unit


@dataclass(frozen=True, slots=True)
class MeasuredValue:
    """A value as evidence.

    Both the raw and the normalized form are carried, so a report can say "your
    3.05 cm" *and* "which is 30.5 mm, against the required 30 mm". Showing only
    the normalized value would hide what the author actually wrote.
    """

    value: str
    unit: Unit | None = None
    normalized_value: str | None = None
    normalized_unit: Unit | None = None

    def to_json(self) -> dict[str, Any]:
        result: dict[str, Any] = {"value": self.value}
        if self.unit is not None:
            result["unit"] = self.unit.value
        if self.normalized_value is not None:
            result["normalizedValue"] = self.normalized_value
        if self.normalized_unit is not None:
            result["normalizedUnit"] = self.normalized_unit.value
        return result


@dataclass(frozen=True, slots=True)
class Violation:
    reason_code: ReasonCode
    actual: MeasuredValue
    location: Location | None = None
    expected: MeasuredValue | None = None
    tolerance: str | None = None

    def to_json(self) -> dict[str, Any]:
        result: dict[str, Any] = {"reasonCode": self.reason_code.value}
        if self.location is not None:
            result["location"] = self.location.to_json()
        if self.expected is not None:
            result["expected"] = self.expected.to_json()
        result["actual"] = self.actual.to_json()
        if self.tolerance is not None:
            result["tolerance"] = self.tolerance
        return result

    def sort_key(self) -> tuple[int, int, int, str]:
        """Canonical ordering.

        Violations without a location sort last, so an evidence-bearing
        violation is never buried behind an anonymous one.
        """
        if self.location is None:
            return (3, 0, 0, "")
        return self.location.sort_key()


@dataclass(frozen=True, slots=True)
class EvaluationCounts:
    """Per-rule tallies.

    These are what turns a result into a report line: "Body font size: 118
    paragraphs checked, 7 violations".
    """

    matched_facts: int = 0
    evaluated_facts: int = 0
    passed_facts: int = 0
    failed_facts: int = 0
    indeterminate_facts: int = 0

    def to_json(self) -> dict[str, int]:
        return {
            "matchedFacts": self.matched_facts,
            "evaluatedFacts": self.evaluated_facts,
            "passedFacts": self.passed_facts,
            "failedFacts": self.failed_facts,
            "indeterminateFacts": self.indeterminate_facts,
        }


@dataclass(frozen=True, slots=True)
class EngineInfo:
    engine_name: str
    engine_version: str
    rule_schema_version: int
    fact_schema_version: int

    def to_json(self) -> dict[str, Any]:
        return {
            "engineName": self.engine_name,
            "engineVersion": self.engine_version,
            "ruleSchemaVersion": self.rule_schema_version,
            "factSchemaVersion": self.fact_schema_version,
        }


@dataclass(frozen=True, slots=True)
class RuleEvaluationResult:
    """One rule's verdict.

    `blocking`, `severity` and `evaluation_mode` are carried through from the
    rule deliberately. Phase 4 does not compute compliance, but Phase 7 needs
    exactly these to apply "blocking + FAIL blocks compliance" and "blocking +
    INDETERMINATE prevents a final PASS until resolved" without re-reading the
    standard.
    """

    rule_code: str
    outcome: Outcome
    reason_code: ReasonCode
    evidence_level: EvidenceLevel
    requires_review: bool
    blocking: bool
    severity: Severity
    evaluation_mode: EvaluationMode
    operator: str
    counts: EvaluationCounts
    violations: tuple[Violation, ...]
    total_violation_count: int
    truncated: bool
    engine: EngineInfo

    def with_violations(
        self, violations: list[Violation] | tuple[Violation, ...], *, truncated: bool
    ) -> RuleEvaluationResult:
        """A copy carrying a different violation list.

        Used by the whole-response budget. The counts are untouched: capping
        what is *returned* must never change what was *found*.
        """
        return replace(
            self,
            violations=tuple(violations),
            truncated=self.truncated or truncated,
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "ruleCode": self.rule_code,
            "outcome": self.outcome.value,
            "reasonCode": self.reason_code.value,
            "evidenceLevel": self.evidence_level.value,
            "requiresReview": self.requires_review,
            "blocking": self.blocking,
            "severity": self.severity.value,
            "evaluationMode": self.evaluation_mode.value,
            "operator": self.operator,
            "counts": self.counts.to_json(),
            "violations": [
                violation.to_json() for violation in sorted(self.violations, key=Violation.sort_key)
            ],
            "totalViolationCount": self.total_violation_count,
            "truncated": self.truncated,
            "engine": self.engine.to_json(),
        }


def response_to_json(
    document_id: str, engine: EngineInfo, results: list[RuleEvaluationResult]
) -> dict[str, Any]:
    """The whole-evaluation envelope, canonically serialized."""
    return {
        "documentId": document_id,
        "engine": engine.to_json(),
        "results": [result.to_json() for result in results],
    }
