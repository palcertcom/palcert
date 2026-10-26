"""The golden correction corpus, executed end to end.

Every case is analyzed, planned, corrected and analyzed again with the real
engine. A case that claims a rule is fixed has to prove it against the
corrected document — the plan's own opinion counts for nothing here.

Three invariants are asserted for every case that produces a corrected
document, because they are the promises the whole phase rests on: the visible
text is unchanged, the rules SmartFix targeted now pass, and no rule that
passed before fails afterwards.
"""

from __future__ import annotations

import hashlib
import io
import zipfile

import pytest

from app.smartfix.mutate import FixError, apply_docx_fix_plan
from app.smartfix.proofs import project
from tests.smartfix.corpus import Case, build_corpus
from tests.smartfix.support import (
    LIMITS,
    analyze,
    fixability,
    make_plan,
    outcomes_for,
    passed,
    reason,
)

CASES = build_corpus()


def _ids(case: Case) -> str:
    return case.name


@pytest.fixture(scope="module", params=CASES, ids=[case.name for case in CASES])
def case(request: pytest.FixtureRequest) -> Case:
    return request.param  # type: ignore[no-any-return]


def test_every_case_explains_itself(case: Case) -> None:
    # A fixture nobody can explain is a fixture nobody will maintain.
    assert len(case.why) > 40


def test_plan_matches_its_expectations(case: Case) -> None:
    plan, _ = make_plan(case.build(), case.rules)

    if case.refusal is not None:
        assert plan.refusal is not None
        assert plan.refusal.value == case.refusal
        assert plan.actions == ()
        return

    assert plan.refusal is None
    for code in case.fixed:
        assert fixability(plan, code) == "FIXABLE", code
    for code, expected_status, expected_reason in case.refused:
        assert fixability(plan, code) == expected_status, code
        assert reason(plan, code) == expected_reason, code
    listed = {entry.rule_code for entry in plan.rules}
    for code in case.absent:
        assert code not in listed, code
    if case.expected_actions is not None:
        assert len(plan.actions) == case.expected_actions


def test_a_refused_document_is_never_corrected(case: Case) -> None:
    if case.refusal is None and case.expected_actions != 0:
        pytest.skip("this case produces a correction")
    source = case.build()
    plan, analysis = make_plan(source, case.rules)
    with pytest.raises(FixError):
        # There is nothing to apply, and the engine says so rather than
        # producing an identical "corrected" copy the user would be charged
        # for.
        apply_docx_fix_plan(source, analysis.sha256, plan, LIMITS)


def test_correction_fixes_what_it_targeted(case: Case) -> None:
    if case.refusal is not None or not case.fixed:
        pytest.skip("this case produces no correction")

    source = case.build()
    plan, _ = make_plan(source, case.rules)
    outcome = apply_docx_fix_plan(source, hashlib.sha256(source).hexdigest(), plan, LIMITS)

    after = analyze(outcome.content)
    outcomes = outcomes_for(after, case.rules)
    for code in case.fixed:
        assert passed(outcomes, code), f"{code} still fails: {outcomes.get(code)}"


def test_correction_changes_no_visible_text(case: Case) -> None:
    if case.refusal is not None or not case.fixed:
        pytest.skip("this case produces no correction")

    source = case.build()
    plan, _ = make_plan(source, case.rules)
    outcome = apply_docx_fix_plan(source, hashlib.sha256(source).hexdigest(), plan, LIMITS)

    with (
        zipfile.ZipFile(io.BytesIO(source)) as before,
        zipfile.ZipFile(io.BytesIO(outcome.content)) as after,
    ):
        left = project(before, LIMITS)
        right = project(after, LIMITS)
    assert left.visible_text == right.visible_text
    assert left.media_set == right.media_set
    assert left.field_instructions == right.field_instructions
    assert left.relationships == right.relationships


def test_correction_does_not_regress_a_passing_rule(case: Case) -> None:
    if case.refusal is not None or not case.fixed:
        pytest.skip("this case produces no correction")

    source = case.build()
    before = analyze(source)
    plan, _ = make_plan(source, case.rules)
    outcome = apply_docx_fix_plan(source, before.sha256, plan, LIMITS)
    after = analyze(outcome.content)

    was = outcomes_for(before, case.rules)
    now = outcomes_for(after, case.rules)
    for code in case.unchanged:
        assert passed(was, code), f"{code} was expected to pass before the correction"
        assert passed(now, code), f"{code} regressed: {now.get(code)}"


def test_untouched_parts_are_byte_identical(case: Case) -> None:
    if case.refusal is not None or not case.fixed:
        pytest.skip("this case produces no correction")

    source = case.build()
    plan, analysis = make_plan(source, case.rules)
    outcome = apply_docx_fix_plan(source, analysis.sha256, plan, LIMITS)

    changed = set(outcome.manifest.changed_parts)
    with (
        zipfile.ZipFile(io.BytesIO(source)) as before,
        zipfile.ZipFile(io.BytesIO(outcome.content)) as after,
    ):
        assert before.namelist() == after.namelist()
        for name in before.namelist():
            if name in changed:
                continue
            assert before.read(name) == after.read(name), name


def test_correction_is_deterministic(case: Case) -> None:
    if case.refusal is not None or not case.fixed:
        pytest.skip("this case produces no correction")

    source = case.build()
    plan, analysis = make_plan(source, case.rules)
    first = apply_docx_fix_plan(source, analysis.sha256, plan, LIMITS)
    second = apply_docx_fix_plan(source, analysis.sha256, plan, LIMITS)
    # No wall-clock timestamp reaches the archive, so the same plan over the
    # same source is the same bytes — which is what makes idempotency testable
    # at all.
    assert first.sha256 == second.sha256
    assert first.content == second.content


def test_reapplying_the_plan_to_its_own_output_is_refused(case: Case) -> None:
    if case.refusal is not None or not case.fixed:
        pytest.skip("this case produces no correction")

    source = case.build()
    plan, analysis = make_plan(source, case.rules)
    outcome = apply_docx_fix_plan(source, analysis.sha256, plan, LIMITS)

    with pytest.raises(FixError) as raised:
        # The plan is bound to the document it was computed from. Running it
        # again against the corrected copy is not idempotence, it is applying
        # a plan to a document nobody reviewed it against.
        apply_docx_fix_plan(outcome.content, outcome.sha256, plan, LIMITS)
    assert raised.value.code.value == "SMARTFIX_SOURCE_INTEGRITY_FAILED"


def test_replanning_the_corrected_document_finds_nothing_to_do(case: Case) -> None:
    if case.refusal is not None or not case.fixed:
        pytest.skip("this case produces no correction")

    source = case.build()
    plan, analysis = make_plan(source, case.rules)
    outcome = apply_docx_fix_plan(source, analysis.sha256, plan, LIMITS)

    replanned, _ = make_plan(outcome.content, case.rules)
    # The real idempotency property: a second pass over the corrected document
    # has nothing left to correct for the rules that were targeted.
    remaining = {action.rule_code for action in replanned.actions}
    assert remaining.isdisjoint(set(case.fixed))
