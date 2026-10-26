"""Deciding what SmartFix will change, and what it will not.

A plan is free, and it is produced before anybody pays for anything, because
the user has to see the exact list of changes before agreeing to them. Nothing
here writes a byte.

Three rules govern every decision in this module.

**A rule must be deterministic, SAFE, and supported.** `autofix: SAFE` is a
ceiling set by the standard's author — it says the change *would* be safe if
PalCert could make it. The capability registry says whether PalCert can. Both
have to agree, and an AI-assisted or manual rule is never touched at all: no
model is consulted here, and none ever will be.

**A target must be a single known value.** `EQUALS` names one. An inclusive
bound names a boundary reachable without overshooting. `IN` names a set and
`MATCHES_PATTERN` names a language, and choosing a member of either would be
PalCert deciding what the author's document should say. `EXISTS` and
`NOT_EXISTS` can only be satisfied by writing or deleting content, which is
where academic meaning lives. Those become manual work and are shown as such.

**A planned change must actually fix the rule.** WordprocessingML stores page
geometry in whole twips, so a margin in millimetres rarely lands on one
exactly. Every numeric target is therefore converted to the units the document
will really hold, converted back, and re-evaluated with the same operator the
check used. A target that would not pass after rounding is not planned: it
would look like a fix, cost the user money, and fail the recheck.

One subtlety deserves its own note. The fact set reports *one fact per
distinct value per paragraph*, so a paragraph whose five runs are all 11 pt
produces a single fact located at the first of them. Planning only that run
would leave four behind and fail the recheck for reasons the manifest could
not explain. So a run-level fix expands to every run in the same paragraph
that currently holds the same value — which is exactly the set of runs the
fact was standing for (§27).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction

from app.docx.model import StructuralModel
from app.engine.evaluation.engine import DeterministicRuleEngine, RuleDefinition
from app.engine.facts.model import (
    DocumentFact,
    DocumentFactSet,
    FactValue,
    FactValueType,
    ScopeKind,
)
from app.engine.facts.selection import FactIndex
from app.engine.rules.operators import ExpectedValue, ExpectedValueType, evaluator_for
from app.engine.rules.outcomes import EvaluationMode, Outcome
from app.engine.units.registry import Unit, convert
from app.smartfix.capability import (
    AMBIGUOUS_TARGET_OPERATORS,
    CAPABILITY_REGISTRY_VERSION,
    CONTENT_CHANGE_OPERATORS,
    DETERMINISTIC_TARGET_OPERATORS,
    Fixability,
    FixCapability,
    ReasonCode,
    RefusalCode,
    TargetScope,
    capability_for,
    element_type_is_fixable,
    refusal_reason_for,
)
from app.smartfix.model import (
    FixAction,
    FixValue,
    PlanBuilder,
    PlannedRule,
    PlanSource,
    SmartFixPlan,
)
from app.smartfix.observe import NodeLookup, decimal_of, observe
from app.smartfix.ooxml import length_from_twips, twips_from

#: Units the mutator stores as whole twips, and therefore has to round.
_TWIP_UNITS = frozenset({"POINT", "MILLIMETRE"})


@dataclass(frozen=True, slots=True)
class PlannerRule:
    """A published rule plus the one thing SmartFix needs that evaluation does not."""

    definition: RuleDefinition
    #: The standard author's ceiling: NONE, SAFE or ADVANCED.
    autofix: str


@dataclass(frozen=True, slots=True)
class _Outcome:
    """What the planner decided about one rule."""

    planned: PlannedRule
    actions: tuple[FixAction, ...]


def plan_corrections(
    model: StructuralModel,
    fact_set: DocumentFactSet,
    rules: tuple[PlannerRule, ...],
    source: PlanSource,
    refusal: RefusalCode | None = None,
) -> SmartFixPlan:
    """Build the plan for one completed check.

    Only *failing* rules appear in the plan. A rule the document already
    satisfies has nothing to do with a correction, and listing it would put
    work in front of the user that does not exist.

    ``refusal`` comes from `app.smartfix.safety`: a document that cannot be
    edited at all still gets a plan listing what fails, so the user can see
    what a correction would have addressed — but every rule is marked unsafe
    to edit and nothing is planned.
    """
    ordered = sorted(rules, key=lambda entry: entry.definition.rule_code)
    # The verdicts come from the *same* engine the check used, rather than from
    # a second opinion computed here. That is what makes "SmartFix fixes what
    # the check failed" a fact rather than a hope — and it is the only correct
    # treatment of EXISTS and NOT_EXISTS, whose answer depends on whether any
    # fact matched at all and so belongs to the rule, not to a fact.
    verdicts = {
        result.rule_code: result
        for result in DeterministicRuleEngine().evaluate_all(
            fact_set, [entry.definition for entry in ordered]
        )
    }

    index = FactIndex(fact_set)
    lookup = NodeLookup(model)
    builder = PlanBuilder()
    planned: list[PlannedRule] = []

    for rule in ordered:
        result = verdicts.get(rule.definition.rule_code)
        if result is None or result.outcome is not Outcome.FAIL:
            # Only failing rules belong in a list of intended changes.
            continue
        planned.append(_plan_rule(rule, index, lookup, model, builder, refusal))

    return SmartFixPlan(
        source=source,
        rules=tuple(planned),
        actions=() if refusal is not None else builder.actions,
        refusal=refusal,
        capability_registry_version=CAPABILITY_REGISTRY_VERSION,
    )


def _refused(
    rule: PlannerRule, status: Fixability, reason: ReasonCode | None, targets: int = 0
) -> PlannedRule:
    return PlannedRule(
        rule_code=rule.definition.rule_code,
        fixability=status,
        target_count=targets,
        fixable_target_count=0,
        reason_code=reason,
        autofix=rule.autofix,
        evaluation_mode=rule.definition.evaluation_mode.value,
    )


def _plan_rule(
    rule: PlannerRule,
    index: FactIndex,
    lookup: NodeLookup,
    model: StructuralModel,
    builder: PlanBuilder,
    refusal: RefusalCode | None,
) -> PlannedRule:
    """What SmartFix will do about one failing rule."""
    definition = rule.definition

    if refusal is not None:
        return _refused(rule, Fixability.SOURCE_DOCUMENT_UNSAFE_TO_EDIT, None)

    if definition.evaluation_mode is not EvaluationMode.DETERMINISTIC:
        return _refused(rule, Fixability.NOT_SUPPORTED, ReasonCode.RULE_NOT_DETERMINISTIC)
    if rule.autofix != "SAFE":
        return _refused(rule, Fixability.NOT_SUPPORTED, ReasonCode.AUTOFIX_NOT_SAFE)
    if definition.operator in CONTENT_CHANGE_OPERATORS:
        return _refused(rule, Fixability.MANUAL_ACTION_REQUIRED, ReasonCode.CONTENT_CHANGE_REQUIRED)
    if definition.operator in AMBIGUOUS_TARGET_OPERATORS:
        return _refused(rule, Fixability.AMBIGUOUS_TARGET, ReasonCode.OPERATOR_AMBIGUOUS)
    if definition.operator not in DETERMINISTIC_TARGET_OPERATORS:
        return _refused(rule, Fixability.NOT_SUPPORTED, ReasonCode.OPERATOR_AMBIGUOUS)

    scope = definition.scope
    if scope.kind is ScopeKind.METADATA:
        return _refused(rule, Fixability.NOT_SUPPORTED, ReasonCode.METADATA_NOT_SUPPORTED)
    if scope.kind not in (ScopeKind.DOCUMENT, ScopeKind.ELEMENT):
        # SECTION and PAGE scopes address logical regions PalCert locates by
        # analysis rather than by structure; there is no single element to
        # edit, so nothing here can honestly claim to fix them.
        return _refused(rule, Fixability.NOT_SUPPORTED, ReasonCode.SCOPE_NOT_SUPPORTED)

    # Asked before the capability lookup, and asked of the *rule's* element
    # type rather than of anything in the document.
    #
    # Capability matching is (scope kind, property) and knows nothing about
    # element types, so a `lineSpacing` capability answers for whichever
    # element a rule points at. Phase 18 will emit ELEMENT/CITATION and
    # ELEMENT/REFERENCE_ENTRY facts, and without this a standard could make a
    # reference entry re-indentable through a capability written for body
    # paragraphs — a change to how somebody's scholarship reads, arriving
    # through a table that never mentioned it.
    #
    # A rule naming no element type is refused by the same check. Falling
    # through to a generic capability would be the same hole with no name on
    # it, so the answer is no rather than "probably a paragraph".
    if scope.kind is ScopeKind.ELEMENT and not element_type_is_fixable(
        scope.element_type.value if scope.element_type is not None else None
    ):
        return _refused(rule, Fixability.NOT_SUPPORTED, ReasonCode.ELEMENT_TYPE_NOT_EDITABLE)

    property_name = scope.property or scope.field_name or ""
    capability = capability_for(scope.kind.value, property_name)
    if capability is None:
        return _refused(
            rule, Fixability.NOT_SUPPORTED, refusal_reason_for(scope.kind.value, property_name)
        )

    evaluator = evaluator_for(definition.operator)
    if evaluator is None:  # pragma: no cover - the operator sets above cover the vocabulary
        return _refused(rule, Fixability.NOT_SUPPORTED, ReasonCode.OPERATOR_AMBIGUOUS)

    # Which elements actually fail. The rule-level verdict said the rule does;
    # this says where, across the *whole* fact set rather than the capped
    # violation list a report carries (§27).
    failing = [
        fact
        for fact in index.select(definition.scope)
        if evaluator.evaluate(
            fact, definition.expected, definition.unit, definition.tolerance
        ).outcome
        is Outcome.FAIL
    ]
    if not failing:
        return _refused(rule, Fixability.NOT_SUPPORTED, ReasonCode.LOCATION_EVIDENCE_MISSING)

    action_ids: list[str] = []
    targets = 0
    fixed = 0
    unusable: ReasonCode | None = None

    for fact in failing:
        expansion = _expand(fact, capability, lookup, model)
        targets += max(len(expansion), 1)
        if not expansion:
            unusable = unusable or ReasonCode.LOCATION_EVIDENCE_MISSING
            continue

        target = _target_value(rule, fact, capability)
        if isinstance(target, ReasonCode):
            unusable = unusable or target
            continue

        if not _would_pass(target, fact, definition):
            unusable = unusable or ReasonCode.TARGET_NOT_REPRESENTABLE
            continue

        for node_id, section_index, before in expansion:
            action_id = builder.next_id()
            builder.add(
                FixAction(
                    action_id=action_id,
                    rule_code=definition.rule_code,
                    action_type=capability.action_type,
                    target_scope=capability.target_scope,
                    node_id=node_id,
                    after=target,
                    before=before,
                    section_index=section_index,
                    script_channel=capability.script_channel,
                )
            )
            action_ids.append(action_id)
            fixed += 1

    if fixed == 0:
        return _refused(
            rule,
            Fixability.NOT_SUPPORTED,
            unusable or ReasonCode.EXPECTED_VALUE_UNUSABLE,
            targets,
        )

    return PlannedRule(
        rule_code=definition.rule_code,
        fixability=Fixability.FIXABLE if fixed >= targets else Fixability.PARTIALLY_FIXABLE,
        action_ids=tuple(action_ids),
        target_count=targets,
        fixable_target_count=fixed,
        reason_code=None if fixed >= targets else unusable,
        autofix=rule.autofix,
        evaluation_mode=definition.evaluation_mode.value,
    )


def _expand(
    fact: DocumentFact,
    capability: FixCapability,
    lookup: NodeLookup,
    model: StructuralModel,
) -> tuple[tuple[str, int | None, FixValue | None], ...]:
    """Every element this one failing fact stands for.

    A section fact names its section. A paragraph fact names its paragraph. A
    run fact names *one* run, but the extractor emitted one fact per distinct
    value per paragraph — so it stands for every run in that paragraph holding
    the same value, and all of them have to change for the rule to pass.
    """
    location = fact.location
    if location is None or not location.node_id:
        return ()

    if capability.target_scope is TargetScope.SECTION_PROPERTIES:
        ordinal = location.ordinal
        if ordinal is None or not 1 <= ordinal <= len(model.sections):
            return ()
        probe = _probe(location.node_id, capability, section_index=ordinal - 1)
        return ((location.node_id, ordinal - 1, observe(lookup, probe, model)),)

    if capability.target_scope is TargetScope.PARAGRAPH_PROPERTIES:
        if location.node_id not in lookup.paragraphs:
            return ()
        probe = _probe(location.node_id, capability)
        return ((location.node_id, None, observe(lookup, probe, model)),)

    paragraph = lookup.paragraph_of_run(location.node_id)
    if paragraph is None or location.node_id not in lookup.runs:
        return ()

    observed = observe(lookup, _probe(location.node_id, capability), model)
    expanded: list[tuple[str, int | None, FixValue | None]] = []
    for run in paragraph.runs:
        if not run.visible or not run.text.strip():
            # The extractor skips these, so the fact never stood for them.
            continue
        current = observe(lookup, _probe(run.locator.node_id, capability), model)
        if current is not None and current.matches(observed):
            expanded.append((run.locator.node_id, None, current))
    return tuple(expanded)


def _probe(node_id: str, capability: FixCapability, section_index: int | None = None) -> FixAction:
    """A throwaway action used only to read a value back.

    `observe` answers "what does this element currently hold for this
    property?", and an action is how that question is asked. Building one here
    keeps a single reader for both the planner and the mutator, so the value
    the plan records is the value the mutator will re-check.
    """
    return FixAction(
        action_id="probe",
        rule_code="probe",
        action_type=capability.action_type,
        target_scope=capability.target_scope,
        node_id=node_id,
        after=FixValue.of_text("probe"),
        section_index=section_index,
        script_channel=capability.script_channel,
    )


def _target_value(
    rule: PlannerRule, fact: DocumentFact, capability: FixCapability
) -> FixValue | ReasonCode:
    """The one value that makes this fact satisfy this rule.

    Returns a reason code instead when the expected value cannot be expressed
    as a document property value at all — which is a refusal to guess, not a
    gap to fill in later.
    """
    expected = rule.definition.expected
    operator = rule.definition.operator

    if capability.value_kind == "BOOLEAN":
        if expected.type is not ExpectedValueType.BOOLEAN or expected.boolean is None:
            return ReasonCode.EXPECTED_VALUE_UNUSABLE
        return FixValue.of_flag(bool(expected.boolean))

    if capability.value_kind == "STRING":
        if expected.type is not ExpectedValueType.STRING or not expected.text:
            return ReasonCode.EXPECTED_VALUE_UNUSABLE
        return FixValue.of_text(expected.text)

    number = _numeric_target(expected, operator, fact)
    if number is None:
        return ReasonCode.EXPECTED_VALUE_UNUSABLE

    unit = capability.unit or "POINT"
    converted = _to_capability_unit(number, rule.definition.unit, fact, unit)
    if converted is None:
        return ReasonCode.EXPECTED_VALUE_UNUSABLE

    if unit in _TWIP_UNITS:
        # The document will hold whole twips, so the honest target is the value
        # the document will really have — not the one the rule asked for.
        converted = length_from_twips(twips_from(decimal_of(converted), unit), unit)
    return FixValue.of_number(decimal_of(converted), unit)


def _numeric_target(expected: ExpectedValue, operator: str, fact: DocumentFact) -> Fraction | None:
    """The nearest satisfying value for a numeric comparison."""
    if operator == "EQUALS":
        return None if expected.number is None else Fraction(expected.number)
    if operator in ("GREATER_THAN_OR_EQUAL", "LESS_THAN_OR_EQUAL"):
        return None if expected.number is None else Fraction(expected.number)
    if operator == "BETWEEN":
        if expected.minimum is None or expected.maximum is None:
            return None
        actual = fact.value.as_fraction()
        minimum = Fraction(expected.minimum)
        maximum = Fraction(expected.maximum)
        if actual is None:
            return minimum
        # The nearer bound, so a document that is slightly too wide is not
        # dragged all the way to the other end of the permitted range.
        return minimum if actual < minimum else maximum
    return None


def _to_capability_unit(
    value: Fraction, rule_unit: Unit | None, fact: DocumentFact, capability_unit: str
) -> Fraction | None:
    """The target in the unit the mutator writes.

    A rule may state a margin in centimetres while the document stores
    millimetres. Converting here, exactly, is what keeps the plan's number and
    the document's number the same measurement.
    """
    target_unit = Unit(capability_unit)
    source_unit = rule_unit or fact.unit
    if source_unit is None:
        return value
    try:
        return convert(value, source_unit, target_unit)
    except ValueError:
        # Incompatible dimensions: the rule is measuring something other than
        # what this property holds, and no conversion would be honest.
        return None


def _would_pass(target: FixValue, fact: DocumentFact, definition: RuleDefinition) -> bool:
    """Re-evaluate the rule against the value the document will really hold.

    This is the step that keeps SmartFix honest about rounding. The same
    operator the check used is asked the same question about the corrected
    value, so a "fix" that would still fail is never planned, never charged
    for, and never delivered.
    """
    evaluator = evaluator_for(definition.operator)
    if evaluator is None:  # pragma: no cover - guarded by the caller
        return False
    corrected = _fact_with(fact, target)
    verdict = evaluator.evaluate(
        corrected, definition.expected, definition.unit, definition.tolerance
    )
    return verdict.outcome is Outcome.PASS


def _fact_with(fact: DocumentFact, target: FixValue) -> DocumentFact:
    """The same fact, as it would read after the correction."""
    if target.kind == "NUMBER":
        value = FactValue(type=FactValueType.NUMBER, number=target.number or Decimal(0))
        unit = Unit(target.unit) if target.unit else fact.unit
    elif target.kind == "BOOLEAN":
        value = FactValue(type=FactValueType.BOOLEAN, boolean=bool(target.flag))
        unit = fact.unit
    else:
        value = FactValue(type=fact.value.type, text=target.text, enum_value=target.text)
        unit = fact.unit
    return DocumentFact(
        scope=fact.scope, value=value, unit=unit, location=fact.location, provenance=fact.provenance
    )
