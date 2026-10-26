"""The deterministic rule engine.

Orchestration only: selecting facts, deciding what a set of per-fact verdicts
means, and applying the missing-evidence rules. The per-fact judgements live in
the operator registry, and scope matching lives in the selector, so each
decision has exactly one home.

Three properties this module exists to guarantee.

**Never a false PASS.** Absence of evidence is not evidence of compliance. If
the extractor could not see a domain, an ordinary comparison over it is
INDETERMINATE, not PASS.

**Never a false FAIL.** An unsupported operator, an incompatible unit or an
internal error says nothing about the document, so none of them produce a
violation.

**Deterministic.** Same rule, same facts, same engine version ⇒ the same
result, byte for byte, regardless of the order facts arrived in.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from app.engine.evaluation.limits import EvaluationLimits, ResourceLimitExceededError
from app.engine.evaluation.result import (
    EngineInfo,
    EvaluationCounts,
    MeasuredValue,
    RuleEvaluationResult,
    Violation,
)
from app.engine.evaluation.telemetry import record, summarize
from app.engine.facts.model import (
    SUPPORTED_FACT_SCHEMA_VERSIONS,
    CoverageStatus,
    DocumentFact,
    DocumentFactSet,
    FactScope,
    SourceKind,
)
from app.engine.facts.selection import FactIndex
from app.engine.rules.operators import (
    ExpectedValue,
    FactVerdict,
    Operator,
    evaluator_for,
)
from app.engine.rules.outcomes import (
    EvaluationMode,
    EvidenceLevel,
    Outcome,
    ReasonCode,
    Severity,
)
from app.engine.units.registry import Unit

ENGINE_NAME = "palcert-deterministic"

#: The evaluation engine's own version.
#:
#: Deliberately not the application's git commit: a result recorded today must
#: still be explainable after a hundred unrelated deployments, so the engine's
#: behaviour needs an identity of its own. It changes when evaluation semantics
#: change, and only then.
ENGINE_VERSION = "1.0.0"

#: Rule-schema versions this engine implements.
#:
#: A rule stamped with anything else is refused explicitly. Evaluating a v3 rule
#: under v2 semantics would produce a confident verdict about something the code
#: has never seen.
SUPPORTED_RULE_SCHEMA_VERSIONS: frozenset[int] = frozenset({1, 2})


@dataclass(frozen=True, slots=True)
class RuleDefinition:
    """A Phase 3 rule, as published.

    Parsed but not reshaped: the engine reads exactly what the standard stored.
    """

    rule_code: str
    scope: FactScope
    operator: str
    expected: ExpectedValue
    evaluation_mode: EvaluationMode
    severity: Severity
    blocking: bool
    rule_schema_version: int
    unit: Unit | None = None
    tolerance: Decimal | None = None

    @staticmethod
    def from_json(data: dict[str, Any]) -> RuleDefinition:
        tolerance = data.get("tolerance")
        return RuleDefinition(
            rule_code=data["ruleCode"],
            scope=FactScope.from_json(data["scope"]),
            operator=data["operator"],
            expected=ExpectedValue.from_json(data["expected"]),
            evaluation_mode=EvaluationMode(data["evaluationMode"]),
            severity=Severity(data["severity"]),
            blocking=bool(data["blocking"]),
            rule_schema_version=int(data.get("ruleSchemaVersion", 1)),
            unit=Unit(data["unit"]) if data.get("unit") is not None else None,
            tolerance=(
                Decimal(repr(tolerance))
                if isinstance(tolerance, float)
                else Decimal(str(tolerance))
                if tolerance is not None
                else None
            ),
        )


@dataclass(slots=True)
class _Accumulator:
    """Per-rule tallies, kept while the facts are walked."""

    matched: int = 0
    evaluated: int = 0
    passed: int = 0
    failed: int = 0
    indeterminate: int = 0
    violations: list[Violation] = field(default_factory=list)
    total_violations: int = 0
    first_indeterminate_reason: ReasonCode | None = None


class DeterministicRuleEngine:
    """Evaluates published rules against a normalized fact set."""

    def __init__(self, limits: EvaluationLimits | None = None) -> None:
        self._limits = limits or EvaluationLimits()

    # -- public API ---------------------------------------------------------

    def evaluate_all(
        self, fact_set: DocumentFactSet, rules: list[RuleDefinition]
    ) -> list[RuleEvaluationResult]:
        """Evaluate every rule, in the order given.

        Rule order is the caller's (the standard's display order), and is
        preserved rather than re-sorted: the report reads in the order the
        standard's author chose.
        """
        self._limits.check_rule_count(len(rules))
        self._limits.check_fact_count(len(fact_set.facts))
        self._limits.check_coverage_count(len(fact_set.coverage))

        started = time.perf_counter()
        index = FactIndex(fact_set)
        results: list[RuleEvaluationResult] = []
        returned_violations = 0

        for rule in rules:
            result = self._evaluate_one(rule, fact_set, index)

            # The whole-response violation budget. Counts stay accurate; only
            # the returned evidence is capped.
            remaining = self._limits.max_returned_violations_total - returned_violations
            if len(result.violations) > max(remaining, 0):
                kept = result.violations[: max(remaining, 0)]
                result = result.with_violations(kept, truncated=True)
            returned_violations += len(result.violations)

            results.append(result)

        # Counts and timings only — see the telemetry module for what this
        # record must never carry.
        record(
            summarize(
                engine_name=ENGINE_NAME,
                engine_version=ENGINE_VERSION,
                document_id=fact_set.document_id,
                extractor_name=fact_set.extractor.name,
                extractor_version=fact_set.extractor.version,
                fact_schema_version=fact_set.fact_schema_version,
                fact_count=len(fact_set.facts),
                coverage_entry_count=len(fact_set.coverage),
                duration_ms=(time.perf_counter() - started) * 1000,
                results=results,
            )
        )

        return results

    def evaluate(self, fact_set: DocumentFactSet, rule: RuleDefinition) -> RuleEvaluationResult:
        self._limits.check_fact_count(len(fact_set.facts))
        return self._evaluate_one(rule, fact_set, FactIndex(fact_set))

    # -- orchestration ------------------------------------------------------

    def _evaluate_one(
        self, rule: RuleDefinition, fact_set: DocumentFactSet, index: FactIndex
    ) -> RuleEvaluationResult:
        engine = EngineInfo(
            engine_name=ENGINE_NAME,
            engine_version=ENGINE_VERSION,
            rule_schema_version=rule.rule_schema_version,
            fact_schema_version=fact_set.fact_schema_version,
        )

        def terminal(
            outcome: Outcome,
            reason: ReasonCode,
            *,
            requires_review: bool = False,
            evidence: EvidenceLevel = EvidenceLevel.NONE,
        ) -> RuleEvaluationResult:
            return RuleEvaluationResult(
                rule_code=rule.rule_code,
                outcome=outcome,
                reason_code=reason,
                evidence_level=evidence,
                requires_review=requires_review,
                blocking=rule.blocking,
                severity=rule.severity,
                evaluation_mode=rule.evaluation_mode,
                operator=rule.operator,
                counts=EvaluationCounts(),
                violations=(),
                total_violation_count=0,
                truncated=False,
                engine=engine,
            )

        # --- schema gates --------------------------------------------------
        if fact_set.fact_schema_version not in SUPPORTED_FACT_SCHEMA_VERSIONS:
            return terminal(Outcome.INDETERMINATE, ReasonCode.FACT_SCHEMA_UNSUPPORTED)

        if rule.rule_schema_version not in SUPPORTED_RULE_SCHEMA_VERSIONS:
            return terminal(Outcome.INDETERMINATE, ReasonCode.RULE_SCHEMA_UNSUPPORTED)

        # --- evaluation authority ------------------------------------------
        #
        # Phase 4 evaluates DETERMINISTIC rules only. An AI-assisted or manual
        # rule gets an explicit unresolved state; fabricating a verdict for one
        # would be exactly the failure the review model exists to prevent.
        #
        # This is also what makes rule-schema v2's blocking amendment safe: a
        # blocking AI rule is representable, and it resolves to INDETERMINATE
        # with requiresReview, so Phase 7 cannot finalise compliance while it
        # is outstanding.
        if rule.evaluation_mode is EvaluationMode.AI_ASSISTED:
            return terminal(
                Outcome.INDETERMINATE, ReasonCode.AI_REVIEW_REQUIRED, requires_review=True
            )
        if rule.evaluation_mode is EvaluationMode.MANUAL:
            return terminal(
                Outcome.INDETERMINATE, ReasonCode.MANUAL_REVIEW_REQUIRED, requires_review=True
            )

        # --- operator support ----------------------------------------------
        evaluator = evaluator_for(rule.operator)
        if evaluator is None:
            return terminal(Outcome.INDETERMINATE, ReasonCode.EVALUATOR_NOT_SUPPORTED)

        if rule.expected.type not in evaluator.expected_types:
            return terminal(Outcome.INDETERMINATE, ReasonCode.VALUE_TYPE_INCOMPATIBLE)

        # --- facts and coverage --------------------------------------------
        matched = index.select(rule.scope)
        coverage = fact_set.coverage_for(rule.scope)

        if _is_advisory(matched):
            # Phase 18, Checkpoint 15. A fact PalCert *recognized* rather than
            # *read* may be reported and must never decide.
            #
            # The gate is placed here, before presence and before aggregation,
            # because both of those paths can produce a verdict and both would
            # otherwise produce it from inferred evidence. It is also placed
            # before the coverage checks rather than after, because coverage
            # does not protect this: PARTIAL demotes a PASS and does nothing at
            # all to a FAIL, so a heuristic detector that missed something
            # could fail a compliant document outright.
            #
            # Keyed on provenance rather than on the property name, which
            # matters: an analyzer that emitted a heuristic value for an exact
            # property would be a bug, and this makes it a harmless one.
            return terminal(
                Outcome.INDETERMINATE,
                ReasonCode.ADVISORY_EVIDENCE_ONLY,
                evidence=EvidenceLevel.ADVISORY,
            )

        if evaluator.unary:
            return self._presence_result(rule, matched, coverage, engine)

        if not matched:
            return self._no_facts_result(rule, coverage, engine)

        if coverage is CoverageStatus.UNAVAILABLE:
            # Facts exist but the extractor says it could not see the domain
            # reliably. Judging on a sample it has disowned would be worse than
            # saying we do not know.
            return terminal(Outcome.INDETERMINATE, ReasonCode.NO_COMPLETE_EVIDENCE)

        return self._aggregate(rule, evaluator.evaluate, matched, coverage, engine)

    # -- presence -----------------------------------------------------------

    def _presence_result(
        self,
        rule: RuleDefinition,
        matched: tuple[DocumentFact, ...],
        coverage: CoverageStatus,
        engine: EngineInfo,
    ) -> RuleEvaluationResult:
        """EXISTS / NOT_EXISTS.

        These are the operators for which coverage is decisive: "no matching
        fact" only means "not present" when the extractor is known to have
        looked. Under PARTIAL or UNAVAILABLE coverage an absence proves nothing.
        """
        operator = Operator(rule.operator)
        present = len(matched) > 0
        counts = EvaluationCounts(matched_facts=len(matched))

        def build(
            outcome: Outcome, reason: ReasonCode, violations: tuple[Violation, ...] = ()
        ) -> RuleEvaluationResult:
            return RuleEvaluationResult(
                rule_code=rule.rule_code,
                outcome=outcome,
                reason_code=reason,
                evidence_level=(
                    EvidenceLevel.DETERMINISTIC
                    if outcome in (Outcome.PASS, Outcome.FAIL)
                    else EvidenceLevel.NONE
                ),
                requires_review=False,
                blocking=rule.blocking,
                severity=rule.severity,
                evaluation_mode=rule.evaluation_mode,
                operator=rule.operator,
                counts=counts,
                violations=violations,
                total_violation_count=len(violations),
                truncated=False,
                engine=engine,
            )

        if present:
            if operator is Operator.EXISTS:
                return build(Outcome.PASS, ReasonCode.SATISFIED)
            return build(
                Outcome.FAIL,
                ReasonCode.FORBIDDEN_VALUE_PRESENT,
                self._presence_violations(matched, ReasonCode.FORBIDDEN_VALUE_PRESENT),
            )

        if coverage is not CoverageStatus.COMPLETE:
            return build(Outcome.INDETERMINATE, ReasonCode.NO_COMPLETE_EVIDENCE)

        if operator is Operator.EXISTS:
            return build(
                Outcome.FAIL,
                ReasonCode.REQUIRED_VALUE_MISSING,
                (
                    Violation(
                        reason_code=ReasonCode.REQUIRED_VALUE_MISSING,
                        actual=MeasuredValue(value="absent"),
                    ),
                ),
            )
        return build(Outcome.PASS, ReasonCode.SATISFIED)

    def _presence_violations(
        self, matched: tuple[DocumentFact, ...], reason: ReasonCode
    ) -> tuple[Violation, ...]:
        capped = matched[: self._limits.max_returned_violations_per_rule]
        return tuple(
            Violation(
                reason_code=reason,
                location=fact.location,
                actual=MeasuredValue(value=fact.value.display(), unit=fact.unit),
            )
            for fact in capped
        )

    # -- no matching facts --------------------------------------------------

    def _no_facts_result(
        self, rule: RuleDefinition, coverage: CoverageStatus, engine: EngineInfo
    ) -> RuleEvaluationResult:
        """An ordinary comparison with nothing to compare.

        With COMPLETE coverage this is NOT_APPLICABLE: the document genuinely
        contains no figures, so a rule about figure captions does not apply to
        it. That is emphatically not PASS — the document did not satisfy the
        rule, the rule simply had nothing to say about it, and a later scoring
        phase must be able to tell those apart.

        Without complete coverage it is INDETERMINATE: we do not know whether
        there are figures.
        """
        applicable = coverage is CoverageStatus.COMPLETE
        return RuleEvaluationResult(
            rule_code=rule.rule_code,
            outcome=Outcome.NOT_APPLICABLE if applicable else Outcome.INDETERMINATE,
            reason_code=(
                ReasonCode.NO_MATCHING_FACTS if applicable else ReasonCode.NO_COMPLETE_EVIDENCE
            ),
            evidence_level=EvidenceLevel.DETERMINISTIC if applicable else EvidenceLevel.NONE,
            requires_review=False,
            blocking=rule.blocking,
            severity=rule.severity,
            evaluation_mode=rule.evaluation_mode,
            operator=rule.operator,
            counts=EvaluationCounts(),
            violations=(),
            total_violation_count=0,
            truncated=False,
            engine=engine,
        )

    # -- aggregation --------------------------------------------------------

    def _aggregate(
        self,
        rule: RuleDefinition,
        evaluate_fact: Any,
        matched: tuple[DocumentFact, ...],
        coverage: CoverageStatus,
        engine: EngineInfo,
    ) -> RuleEvaluationResult:
        """Combine per-fact verdicts into one rule verdict.

        **Every** matching fact is evaluated — never only the first. "Every body
        paragraph is 12 pt" is not answered by looking at one paragraph, and a
        report that says "7 violations" has to have counted them.

        Precedence: any FAIL ⇒ FAIL. Otherwise any INDETERMINATE ⇒
        INDETERMINATE. Otherwise PASS. A failure is the most specific thing the
        engine can say, and an unknown must never be able to mask one.
        """
        accumulator = _Accumulator(matched=len(matched))

        for fact in matched:
            verdict: FactVerdict = evaluate_fact(fact, rule.expected, rule.unit, rule.tolerance)
            accumulator.evaluated += 1

            if verdict.outcome is Outcome.PASS:
                accumulator.passed += 1
                continue

            if verdict.outcome is Outcome.FAIL:
                accumulator.failed += 1
                accumulator.total_violations += 1
                # Counts stay exact; only the returned list is capped, so a
                # document with 40,000 identical violations reports 40,000
                # without serializing 40,000 objects.
                if len(accumulator.violations) < self._limits.max_returned_violations_per_rule:
                    accumulator.violations.append(_violation_from(verdict, fact))
                continue

            accumulator.indeterminate += 1
            if accumulator.first_indeterminate_reason is None:
                accumulator.first_indeterminate_reason = verdict.reason

        if accumulator.failed > 0:
            outcome = Outcome.FAIL
            reason = (
                accumulator.violations[0].reason_code
                if accumulator.violations
                else (ReasonCode.VALUE_MISMATCH)
            )
        elif accumulator.indeterminate > 0:
            outcome = Outcome.INDETERMINATE
            reason = accumulator.first_indeterminate_reason or ReasonCode.NO_COMPLETE_EVIDENCE
        elif coverage is CoverageStatus.PARTIAL:
            # Everything seen passed, but the extractor admits it did not see
            # everything. "All 40 paragraphs we could read are correct" is not
            # "all paragraphs are correct".
            outcome = Outcome.INDETERMINATE
            reason = ReasonCode.NO_COMPLETE_EVIDENCE
        else:
            outcome = Outcome.PASS
            reason = ReasonCode.SATISFIED

        return RuleEvaluationResult(
            rule_code=rule.rule_code,
            outcome=outcome,
            reason_code=reason,
            evidence_level=(
                EvidenceLevel.DETERMINISTIC
                if outcome in (Outcome.PASS, Outcome.FAIL)
                else EvidenceLevel.NONE
            ),
            requires_review=False,
            blocking=rule.blocking,
            severity=rule.severity,
            evaluation_mode=rule.evaluation_mode,
            operator=rule.operator,
            counts=EvaluationCounts(
                matched_facts=accumulator.matched,
                evaluated_facts=accumulator.evaluated,
                passed_facts=accumulator.passed,
                failed_facts=accumulator.failed,
                indeterminate_facts=accumulator.indeterminate,
            ),
            violations=tuple(accumulator.violations),
            total_violation_count=accumulator.total_violations,
            truncated=accumulator.total_violations > len(accumulator.violations),
            engine=engine,
        )


def _is_advisory(matched: tuple[DocumentFact, ...]) -> bool:
    """Does any matched fact say it was inferred rather than read?

    **Any**, not all. A rule mixing exact and heuristic facts is not partly
    authoritative: the verdict would still rest on a recognition, and a reader
    told PASS has no way to know which facts carried it. So one heuristic fact
    makes the whole rule advisory, and a rule that wants an authoritative
    answer has to be written against a property whose facts are all exact.

    A fact with no provenance at all is treated as exact. Provenance is
    optional in the contract and every analyzer that omits it is reading
    markup; inverting that default would turn every such fact advisory and
    quietly stop the engine deciding anything.
    """
    return any(
        fact.provenance is not None and fact.provenance.source_kind is SourceKind.HEURISTIC
        for fact in matched
    )


def _violation_from(verdict: FactVerdict, fact: DocumentFact) -> Violation:
    expected = (
        MeasuredValue(
            value=verdict.expected_display,
            unit=verdict.expected_unit,
            normalized_value=verdict.normalized_expected,
            normalized_unit=verdict.normalized_unit,
        )
        if verdict.expected_display is not None
        else None
    )
    return Violation(
        reason_code=verdict.reason,
        location=fact.location,
        expected=expected,
        actual=MeasuredValue(
            value=verdict.actual_display or fact.value.display(),
            unit=verdict.actual_unit or fact.unit,
            normalized_value=verdict.normalized_actual,
            normalized_unit=verdict.normalized_unit,
        ),
    )


__all__ = [
    "ENGINE_NAME",
    "ENGINE_VERSION",
    "SUPPORTED_RULE_SCHEMA_VERSIONS",
    "DeterministicRuleEngine",
    "EvaluationLimits",
    "ResourceLimitExceededError",
    "RuleDefinition",
    "time",
]
