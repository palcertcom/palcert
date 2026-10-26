"""The operator registry.

Each Phase 3 operator gets one evaluator that declares what it accepts and how
it decides a single fact. A registry rather than a five-hundred-line ``match``
because the declarations are the useful part: the engine can answer "can this
operator take a string?" without running it, which is what turns
``VALUE_TYPE_INCOMPATIBLE`` into a considered answer instead of a crash.

Every evaluator judges **one fact against one expected value**. Aggregating
across many facts is the orchestrator's job, so multi-fact semantics are
decided in exactly one place.

There is no ``eval``, no ``exec``, no dynamic import and no user-supplied code
anywhere in this module. Rules are data; only the evaluators below execute.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from fractions import Fraction
from typing import Any

from app.engine.facts.model import DocumentFact, FactValueType
from app.engine.rules.outcomes import Outcome, ReasonCode
from app.engine.rules.patterns import (
    PATTERNS_REQUIRING_ARGUMENT,
    PatternInputTooLongError,
    PatternName,
    match_pattern,
)
from app.engine.rules.text import TextComparison, comparison_for_property, contains, equals
from app.engine.units.registry import (
    IncompatibleUnitsError,
    Unit,
    convert_to_common,
    format_exact,
    to_fraction,
)


class Operator(StrEnum):
    """The Phase 3 ``RuleOperator`` vocabulary, unchanged.

    Deliberately not extended. Introducing a second, near-miss operator
    vocabulary here would mean a rule authored in the builder and a rule
    understood by the engine were different things.

    Counting is expressed through the fact model rather than through dedicated
    ``COUNT_MIN``/``COUNT_MAX`` operators: a rule measures a counting property
    (``pageCount``, ``wordCount``, ``figureCount``) with the ordinary
    comparison operators. One numeric comparison path is easier to keep correct
    than two.
    """

    EQUALS = "EQUALS"
    NOT_EQUALS = "NOT_EQUALS"
    GREATER_THAN = "GREATER_THAN"
    GREATER_THAN_OR_EQUAL = "GREATER_THAN_OR_EQUAL"
    LESS_THAN = "LESS_THAN"
    LESS_THAN_OR_EQUAL = "LESS_THAN_OR_EQUAL"
    BETWEEN = "BETWEEN"
    IN = "IN"
    NOT_IN = "NOT_IN"
    CONTAINS = "CONTAINS"
    NOT_CONTAINS = "NOT_CONTAINS"
    MATCHES_PATTERN = "MATCHES_PATTERN"
    EXISTS = "EXISTS"
    NOT_EXISTS = "NOT_EXISTS"


class ExpectedValueType(StrEnum):
    """The Phase 3 ``RuleValueType`` vocabulary, unchanged."""

    NUMBER = "NUMBER"
    STRING = "STRING"
    BOOLEAN = "BOOLEAN"
    NUMBER_RANGE = "NUMBER_RANGE"
    STRING_LIST = "STRING_LIST"
    NUMBER_LIST = "NUMBER_LIST"
    PATTERN = "PATTERN"
    NONE = "NONE"


@dataclass(frozen=True, slots=True)
class FactVerdict:
    """The engine's judgement of one fact.

    ``expected_display`` and ``actual_display`` carry evidence for the
    violation, and the normalized pair records what was actually compared after
    unit conversion — so a report can show both "the standard asks for 30 mm"
    and "your 3.05 cm is 30.5 mm".
    """

    outcome: Outcome
    reason: ReasonCode
    expected_display: str | None = None
    actual_display: str | None = None
    expected_unit: Unit | None = None
    actual_unit: Unit | None = None
    normalized_expected: str | None = None
    normalized_actual: str | None = None
    normalized_unit: Unit | None = None


def _passed() -> FactVerdict:
    return FactVerdict(outcome=Outcome.PASS, reason=ReasonCode.SATISFIED)


@dataclass(frozen=True, slots=True)
class ExpectedValue:
    """A Phase 3 expected value, parsed.

    Numbers arrive from the rule as JSON numbers (Phase 3 stores them that way,
    and rewriting published rules to change that would break their hashes), so
    they are converted through ``repr`` into an exact ``Decimal`` at this
    boundary — the shortest round-trip decimal, which is precisely what the
    JavaScript side serialized. From here on the value is exact.
    """

    type: ExpectedValueType
    number: Decimal | None = None
    text: str | None = None
    boolean: bool | None = None
    minimum: Decimal | None = None
    maximum: Decimal | None = None
    values: tuple[str, ...] = ()
    numbers: tuple[Decimal, ...] = ()
    pattern: PatternName | None = None
    argument: str | None = None

    @staticmethod
    def from_json(data: dict[str, Any]) -> ExpectedValue:
        value_type = ExpectedValueType(data["type"])
        return ExpectedValue(
            type=value_type,
            number=_to_decimal(data.get("number")),
            text=data.get("text"),
            boolean=data.get("boolean"),
            minimum=_to_decimal(data.get("min")),
            maximum=_to_decimal(data.get("max")),
            values=tuple(str(entry) for entry in data.get("values", []))
            if value_type is ExpectedValueType.STRING_LIST
            else (),
            numbers=tuple(_to_decimal_strict(entry) for entry in data.get("values", []))
            if value_type is ExpectedValueType.NUMBER_LIST
            else (),
            pattern=(
                PatternName(data["pattern"])
                if data.get("pattern") is not None and _is_known_pattern(data["pattern"])
                else None
            ),
            argument=data.get("argument"),
        )

    def display(self) -> str:
        if self.type is ExpectedValueType.NUMBER and self.number is not None:
            return _plain(self.number)
        if self.type is ExpectedValueType.STRING and self.text is not None:
            return self.text
        if self.type is ExpectedValueType.BOOLEAN and self.boolean is not None:
            return "true" if self.boolean else "false"
        if self.type is ExpectedValueType.NUMBER_RANGE:
            return f"{_plain(self.minimum or Decimal(0))}..{_plain(self.maximum or Decimal(0))}"
        if self.type is ExpectedValueType.STRING_LIST:
            return ", ".join(self.values)
        if self.type is ExpectedValueType.NUMBER_LIST:
            return ", ".join(_plain(entry) for entry in self.numbers)
        if self.type is ExpectedValueType.PATTERN and self.pattern is not None:
            return (
                f"{self.pattern.value}({self.argument})"
                if self.argument is not None
                else self.pattern.value
            )
        return self.type.value


def _is_known_pattern(name: str) -> bool:
    return name in {pattern.value for pattern in PatternName}


def _to_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    return _to_decimal_strict(value)


def _to_decimal_strict(value: Any) -> Decimal:
    """Convert a rule's JSON number into an exact Decimal.

    ``repr`` of a Python float is its shortest round-trip representation, which
    is the same string JavaScript produced when the rule was written. Going
    through it avoids ``Decimal(0.1)`` becoming 0.1000000000000000055511151231.
    """
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):  # bool is an int subclass; refuse it explicitly
        raise ValueError("A boolean is not a number")
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(repr(value))
    try:
        return Decimal(str(value))
    except InvalidOperation as error:
        raise ValueError(f"{value!r} is not a number") from error


def _plain(value: Decimal) -> str:
    return format(value.normalize(), "f") if value == value.to_integral_value() else str(value)


# ---------------------------------------------------------------------------
# Numeric comparison
# ---------------------------------------------------------------------------


def _numeric_pair(
    fact: DocumentFact, expected: Decimal, expected_unit: Unit | None
) -> tuple[Fraction, Fraction, Unit | None] | FactVerdict:
    """Bring a fact and an expected value into one unit, or explain why not."""
    actual = fact.value.as_fraction()
    if actual is None:
        return FactVerdict(
            outcome=Outcome.INDETERMINATE,
            reason=ReasonCode.VALUE_TYPE_INCOMPATIBLE,
            actual_display=fact.value.display(),
        )

    try:
        left, right, unit = convert_to_common(
            actual, fact.unit, to_fraction(expected), expected_unit
        )
    except IncompatibleUnitsError:
        # Never FAIL: the document may well comply, we simply cannot compare
        # a count with a length, or a pixel with a millimetre.
        return FactVerdict(
            outcome=Outcome.INDETERMINATE,
            reason=ReasonCode.UNIT_INCOMPATIBLE,
            expected_display=_plain(expected),
            expected_unit=expected_unit,
            actual_display=fact.value.display(),
            actual_unit=fact.unit,
        )

    return left, right, unit


def _numeric_verdict(
    fact: DocumentFact,
    expected: Decimal,
    expected_unit: Unit | None,
    compare: Callable[[Fraction, Fraction], bool],
    failure_reason: ReasonCode,
    tolerance: Decimal | None = None,
) -> FactVerdict:
    prepared = _numeric_pair(fact, expected, expected_unit)
    if isinstance(prepared, FactVerdict):
        return prepared

    actual, target, unit = prepared

    if tolerance is not None:
        # Tolerance is applied *after* conversion, in the common unit, so
        # "30 mm ± 1 mm" judges an observed 3.05 cm as 30.5 mm against 30 mm.
        converted_tolerance = to_fraction(tolerance)
        if expected_unit is not None and unit is not None and expected_unit is not unit:
            from app.engine.units.registry import convert

            converted_tolerance = convert(converted_tolerance, expected_unit, unit)
        satisfied = abs(actual - target) <= converted_tolerance
        reason = ReasonCode.OUTSIDE_TOLERANCE
    else:
        satisfied = compare(actual, target)
        reason = failure_reason

    if satisfied:
        return _passed()

    return FactVerdict(
        outcome=Outcome.FAIL,
        reason=reason,
        expected_display=_plain(expected),
        expected_unit=expected_unit,
        actual_display=fact.value.display(),
        actual_unit=fact.unit,
        normalized_expected=format_exact(target),
        normalized_actual=format_exact(actual),
        normalized_unit=unit,
    )


# ---------------------------------------------------------------------------
# String comparison
# ---------------------------------------------------------------------------


def _string_of(fact: DocumentFact) -> str | FactVerdict:
    if fact.value.type is FactValueType.STRING and fact.value.text is not None:
        return fact.value.text
    if fact.value.type is FactValueType.ENUM and fact.value.enum_value is not None:
        return fact.value.enum_value
    return FactVerdict(
        outcome=Outcome.INDETERMINATE,
        reason=ReasonCode.VALUE_TYPE_INCOMPATIBLE,
        actual_display=fact.value.display(),
    )


def _comparison_mode(fact: DocumentFact) -> TextComparison:
    return comparison_for_property(fact.scope.property or fact.scope.field_name)


# ---------------------------------------------------------------------------
# Evaluators
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class OperatorEvaluator:
    """One operator, with everything the engine needs to know about it.

    The declared compatibility is what lets the engine reject a nonsensical
    pairing before running anything, and what the contract tests check against
    the Phase 3 catalogue.
    """

    operator: Operator
    expected_types: frozenset[ExpectedValueType]
    fact_types: frozenset[FactValueType]
    unary: bool
    supports_tolerance: bool
    evaluate: Callable[[DocumentFact, ExpectedValue, Unit | None, Decimal | None], FactVerdict]


def _equals(
    fact: DocumentFact, expected: ExpectedValue, unit: Unit | None, tolerance: Decimal | None
) -> FactVerdict:
    if expected.type is ExpectedValueType.NUMBER and expected.number is not None:
        return _numeric_verdict(
            fact,
            expected.number,
            unit,
            lambda actual, target: actual == target,
            ReasonCode.VALUE_MISMATCH,
            tolerance,
        )

    if expected.type is ExpectedValueType.BOOLEAN:
        if fact.value.type is not FactValueType.BOOLEAN or fact.value.boolean is None:
            return FactVerdict(
                outcome=Outcome.INDETERMINATE,
                reason=ReasonCode.VALUE_TYPE_INCOMPATIBLE,
                actual_display=fact.value.display(),
            )
        if fact.value.boolean == expected.boolean:
            return _passed()
        return FactVerdict(
            outcome=Outcome.FAIL,
            reason=ReasonCode.VALUE_MISMATCH,
            expected_display=expected.display(),
            actual_display=fact.value.display(),
        )

    text = _string_of(fact)
    if isinstance(text, FactVerdict):
        return text
    if expected.text is not None and equals(text, expected.text, _comparison_mode(fact)):
        return _passed()
    return FactVerdict(
        outcome=Outcome.FAIL,
        reason=ReasonCode.VALUE_MISMATCH,
        expected_display=expected.display(),
        actual_display=fact.value.display(),
    )


def _not_equals(
    fact: DocumentFact, expected: ExpectedValue, unit: Unit | None, tolerance: Decimal | None
) -> FactVerdict:
    inner = _equals(fact, expected, unit, tolerance)
    if inner.outcome is Outcome.PASS:
        return FactVerdict(
            outcome=Outcome.FAIL,
            reason=ReasonCode.FORBIDDEN_VALUE_PRESENT,
            expected_display=expected.display(),
            actual_display=fact.value.display(),
            actual_unit=fact.unit,
        )
    if inner.outcome is Outcome.FAIL:
        return _passed()
    # INDETERMINATE stays INDETERMINATE: not knowing whether two values are
    # equal is not the same as knowing they differ.
    return inner


def _ordering(
    compare: Callable[[Fraction, Fraction], bool], reason: ReasonCode
) -> Callable[[DocumentFact, ExpectedValue, Unit | None, Decimal | None], FactVerdict]:
    def evaluate(
        fact: DocumentFact,
        expected: ExpectedValue,
        unit: Unit | None,
        tolerance: Decimal | None,
    ) -> FactVerdict:
        if expected.number is None:
            return FactVerdict(
                outcome=Outcome.INDETERMINATE, reason=ReasonCode.VALUE_TYPE_INCOMPATIBLE
            )
        # Tolerance is deliberately ignored for a strict ordering: "at least
        # 30 mm, give or take 1 mm" has no single defensible reading, and
        # Phase 3 validation already refuses that combination for the operators
        # where it is meaningless.
        return _numeric_verdict(fact, expected.number, unit, compare, reason, None)

    return evaluate


def _between(
    fact: DocumentFact, expected: ExpectedValue, unit: Unit | None, tolerance: Decimal | None
) -> FactVerdict:
    if expected.minimum is None or expected.maximum is None:
        return FactVerdict(outcome=Outcome.INDETERMINATE, reason=ReasonCode.VALUE_TYPE_INCOMPATIBLE)

    low = _numeric_pair(fact, expected.minimum, unit)
    if isinstance(low, FactVerdict):
        return low
    high = _numeric_pair(fact, expected.maximum, unit)
    if isinstance(high, FactVerdict):
        return high

    actual, minimum, common = low
    _, maximum, _ = high

    slack = to_fraction(tolerance) if tolerance is not None else Fraction(0)
    if minimum - slack <= actual <= maximum + slack:
        return _passed()

    return FactVerdict(
        outcome=Outcome.FAIL,
        reason=ReasonCode.OUTSIDE_RANGE if tolerance is None else ReasonCode.OUTSIDE_TOLERANCE,
        expected_display=expected.display(),
        expected_unit=unit,
        actual_display=fact.value.display(),
        actual_unit=fact.unit,
        normalized_actual=format_exact(actual),
        normalized_unit=common,
    )


def _membership(
    forbidden: bool,
) -> Callable[[DocumentFact, ExpectedValue, Unit | None, Decimal | None], FactVerdict]:
    def evaluate(
        fact: DocumentFact,
        expected: ExpectedValue,
        unit: Unit | None,
        _tolerance: Decimal | None,
    ) -> FactVerdict:
        if expected.type is ExpectedValueType.NUMBER_LIST:
            actual = fact.value.as_fraction()
            if actual is None:
                return FactVerdict(
                    outcome=Outcome.INDETERMINATE,
                    reason=ReasonCode.VALUE_TYPE_INCOMPATIBLE,
                    actual_display=fact.value.display(),
                )
            try:
                present = False
                for candidate in expected.numbers:
                    observed, target, _ = convert_to_common(
                        actual, fact.unit, to_fraction(candidate), unit
                    )
                    if observed == target:
                        present = True
                        break
            except IncompatibleUnitsError:
                return FactVerdict(
                    outcome=Outcome.INDETERMINATE,
                    reason=ReasonCode.UNIT_INCOMPATIBLE,
                    expected_display=expected.display(),
                    expected_unit=unit,
                    actual_display=fact.value.display(),
                    actual_unit=fact.unit,
                )
        else:
            text = _string_of(fact)
            if isinstance(text, FactVerdict):
                return text
            mode = _comparison_mode(fact)
            present = any(equals(text, candidate, mode) for candidate in expected.values)

        satisfied = (not present) if forbidden else present
        if satisfied:
            return _passed()

        return FactVerdict(
            outcome=Outcome.FAIL,
            reason=ReasonCode.IN_FORBIDDEN_SET if forbidden else ReasonCode.NOT_IN_ALLOWED_SET,
            expected_display=expected.display(),
            expected_unit=unit,
            actual_display=fact.value.display(),
            actual_unit=fact.unit,
        )

    return evaluate


def _containment(
    negated: bool,
) -> Callable[[DocumentFact, ExpectedValue, Unit | None, Decimal | None], FactVerdict]:
    def evaluate(
        fact: DocumentFact,
        expected: ExpectedValue,
        _unit: Unit | None,
        _tolerance: Decimal | None,
    ) -> FactVerdict:
        text = _string_of(fact)
        if isinstance(text, FactVerdict):
            return text
        if expected.text is None:
            return FactVerdict(
                outcome=Outcome.INDETERMINATE, reason=ReasonCode.VALUE_TYPE_INCOMPATIBLE
            )

        present = contains(text, expected.text, _comparison_mode(fact))
        if present is not negated:
            return _passed()

        return FactVerdict(
            outcome=Outcome.FAIL,
            reason=ReasonCode.FORBIDDEN_VALUE_PRESENT if negated else ReasonCode.VALUE_MISMATCH,
            expected_display=expected.display(),
            actual_display=fact.value.display(),
        )

    return evaluate


def _matches_pattern(
    fact: DocumentFact, expected: ExpectedValue, _unit: Unit | None, _tolerance: Decimal | None
) -> FactVerdict:
    if expected.pattern is None:
        # A pattern name this build does not implement. Not a violation — the
        # document may well satisfy it; this engine simply cannot say.
        return FactVerdict(
            outcome=Outcome.INDETERMINATE,
            reason=ReasonCode.EVALUATOR_NOT_SUPPORTED,
            expected_display=expected.display(),
        )
    if expected.pattern in PATTERNS_REQUIRING_ARGUMENT and expected.argument is None:
        return FactVerdict(
            outcome=Outcome.INDETERMINATE,
            reason=ReasonCode.VALUE_TYPE_INCOMPATIBLE,
            expected_display=expected.display(),
        )

    text = _string_of(fact)
    if isinstance(text, FactVerdict):
        return text

    try:
        satisfied = match_pattern(expected.pattern, text, expected.argument)
    except PatternInputTooLongError:
        return FactVerdict(
            outcome=Outcome.INDETERMINATE,
            reason=ReasonCode.RESOURCE_LIMIT_EXCEEDED,
            expected_display=expected.display(),
        )

    if satisfied:
        return _passed()
    return FactVerdict(
        outcome=Outcome.FAIL,
        reason=ReasonCode.PATTERN_MISMATCH,
        expected_display=expected.display(),
        actual_display=fact.value.display(),
    )


def _presence(
    _fact: DocumentFact,
    _expected: ExpectedValue,
    _unit: Unit | None,
    _tolerance: Decimal | None,
) -> FactVerdict:
    """EXISTS / NOT_EXISTS never judge an individual fact.

    Their answer depends on whether any fact matched at all, which only the
    orchestrator knows. Reaching here would mean the orchestrator forgot to
    special-case them, so it returns INDETERMINATE rather than inventing a
    verdict.
    """
    return FactVerdict(outcome=Outcome.INDETERMINATE, reason=ReasonCode.EVALUATOR_NOT_SUPPORTED)


_NUMERIC_FACTS = frozenset({FactValueType.NUMBER})
_TEXTUAL_FACTS = frozenset({FactValueType.STRING, FactValueType.ENUM})

REGISTRY: dict[Operator, OperatorEvaluator] = {
    Operator.EQUALS: OperatorEvaluator(
        operator=Operator.EQUALS,
        expected_types=frozenset(
            {ExpectedValueType.NUMBER, ExpectedValueType.STRING, ExpectedValueType.BOOLEAN}
        ),
        fact_types=_NUMERIC_FACTS | _TEXTUAL_FACTS | frozenset({FactValueType.BOOLEAN}),
        unary=False,
        supports_tolerance=True,
        evaluate=_equals,
    ),
    Operator.NOT_EQUALS: OperatorEvaluator(
        operator=Operator.NOT_EQUALS,
        expected_types=frozenset(
            {ExpectedValueType.NUMBER, ExpectedValueType.STRING, ExpectedValueType.BOOLEAN}
        ),
        fact_types=_NUMERIC_FACTS | _TEXTUAL_FACTS | frozenset({FactValueType.BOOLEAN}),
        unary=False,
        supports_tolerance=True,
        evaluate=_not_equals,
    ),
    Operator.GREATER_THAN: OperatorEvaluator(
        operator=Operator.GREATER_THAN,
        expected_types=frozenset({ExpectedValueType.NUMBER}),
        fact_types=_NUMERIC_FACTS,
        unary=False,
        supports_tolerance=True,
        evaluate=_ordering(lambda actual, target: actual > target, ReasonCode.BELOW_MINIMUM),
    ),
    Operator.GREATER_THAN_OR_EQUAL: OperatorEvaluator(
        operator=Operator.GREATER_THAN_OR_EQUAL,
        expected_types=frozenset({ExpectedValueType.NUMBER}),
        fact_types=_NUMERIC_FACTS,
        unary=False,
        supports_tolerance=True,
        evaluate=_ordering(lambda actual, target: actual >= target, ReasonCode.BELOW_MINIMUM),
    ),
    Operator.LESS_THAN: OperatorEvaluator(
        operator=Operator.LESS_THAN,
        expected_types=frozenset({ExpectedValueType.NUMBER}),
        fact_types=_NUMERIC_FACTS,
        unary=False,
        supports_tolerance=True,
        evaluate=_ordering(lambda actual, target: actual < target, ReasonCode.ABOVE_MAXIMUM),
    ),
    Operator.LESS_THAN_OR_EQUAL: OperatorEvaluator(
        operator=Operator.LESS_THAN_OR_EQUAL,
        expected_types=frozenset({ExpectedValueType.NUMBER}),
        fact_types=_NUMERIC_FACTS,
        unary=False,
        supports_tolerance=True,
        evaluate=_ordering(lambda actual, target: actual <= target, ReasonCode.ABOVE_MAXIMUM),
    ),
    Operator.BETWEEN: OperatorEvaluator(
        operator=Operator.BETWEEN,
        expected_types=frozenset({ExpectedValueType.NUMBER_RANGE}),
        fact_types=_NUMERIC_FACTS,
        unary=False,
        supports_tolerance=True,
        evaluate=_between,
    ),
    Operator.IN: OperatorEvaluator(
        operator=Operator.IN,
        expected_types=frozenset({ExpectedValueType.STRING_LIST, ExpectedValueType.NUMBER_LIST}),
        fact_types=_NUMERIC_FACTS | _TEXTUAL_FACTS,
        unary=False,
        supports_tolerance=False,
        evaluate=_membership(forbidden=False),
    ),
    Operator.NOT_IN: OperatorEvaluator(
        operator=Operator.NOT_IN,
        expected_types=frozenset({ExpectedValueType.STRING_LIST, ExpectedValueType.NUMBER_LIST}),
        fact_types=_NUMERIC_FACTS | _TEXTUAL_FACTS,
        unary=False,
        supports_tolerance=False,
        evaluate=_membership(forbidden=True),
    ),
    Operator.CONTAINS: OperatorEvaluator(
        operator=Operator.CONTAINS,
        expected_types=frozenset({ExpectedValueType.STRING}),
        fact_types=_TEXTUAL_FACTS,
        unary=False,
        supports_tolerance=False,
        evaluate=_containment(negated=False),
    ),
    Operator.NOT_CONTAINS: OperatorEvaluator(
        operator=Operator.NOT_CONTAINS,
        expected_types=frozenset({ExpectedValueType.STRING}),
        fact_types=_TEXTUAL_FACTS,
        unary=False,
        supports_tolerance=False,
        evaluate=_containment(negated=True),
    ),
    Operator.MATCHES_PATTERN: OperatorEvaluator(
        operator=Operator.MATCHES_PATTERN,
        expected_types=frozenset({ExpectedValueType.PATTERN}),
        fact_types=_TEXTUAL_FACTS,
        unary=False,
        supports_tolerance=False,
        evaluate=_matches_pattern,
    ),
    Operator.EXISTS: OperatorEvaluator(
        operator=Operator.EXISTS,
        expected_types=frozenset({ExpectedValueType.NONE}),
        fact_types=frozenset(FactValueType),
        unary=True,
        supports_tolerance=False,
        evaluate=_presence,
    ),
    Operator.NOT_EXISTS: OperatorEvaluator(
        operator=Operator.NOT_EXISTS,
        expected_types=frozenset({ExpectedValueType.NONE}),
        fact_types=frozenset(FactValueType),
        unary=True,
        supports_tolerance=False,
        evaluate=_presence,
    ),
}


def evaluator_for(operator: str) -> OperatorEvaluator | None:
    """The evaluator for an operator, or None if this build has none.

    Returning None rather than raising: an unimplemented operator is an
    INDETERMINATE result with ``EVALUATOR_NOT_SUPPORTED``, never a failure of
    the document.
    """
    try:
        return REGISTRY[Operator(operator)]
    except ValueError:
        return None
