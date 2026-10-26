"""The mutation engine's refusals, and what it writes when it does not refuse.

Most of this file is about saying no. A mutation engine that corrects nine
documents and quietly mangles the tenth is worse than one that corrects none,
so every guard has a test that proves it fires.
"""

from __future__ import annotations

import hashlib
import io
import re
import zipfile
from decimal import Decimal

import pytest

from app.smartfix.capability import (
    CAPABILITY_REGISTRY_VERSION,
    ActionType,
    ScriptChannel,
    TargetScope,
)
from app.smartfix.model import FixAction, FixValue, SmartFixPlan
from app.smartfix.mutate import FixError, FixErrorCode, apply_docx_fix_plan
from tests.docx.builder import DocxBuilder, section_properties
from tests.smartfix.support import LIMITS, analyze, plan_source

BODY = (
    '<w:p><w:pPr><w:jc w:val="left"/></w:pPr>'
    '<w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">Body text</w:t></w:r>'
    "</w:p>"
    '<w:p><w:r><w:rPr><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">مرحبا</w:t></w:r></w:p>'
) + section_properties()


def source_bytes() -> bytes:
    return DocxBuilder(body=BODY).build()


def size_action(
    node_id: str = "main/body/p:1/r:1",
    *,
    before: str | None = "10",
    after: str = "12",
    channel: ScriptChannel = ScriptChannel.LATIN,
    action_id: str = "a-0001",
) -> FixAction:
    return FixAction(
        action_id=action_id,
        rule_code="BODY_FONT_SIZE",
        action_type=ActionType.SET_RUN_FONT_SIZE,
        target_scope=TargetScope.RUN_PROPERTIES,
        node_id=node_id,
        script_channel=channel,
        before=None if before is None else FixValue.of_number(Decimal(before), "POINT"),
        after=FixValue.of_number(Decimal(after), "POINT"),
    )


def build_plan(*actions: FixAction, sha256: str, **overrides: object) -> SmartFixPlan:
    defaults: dict[str, object] = {
        "source": plan_source(sha256),
        "actions": actions,
        "capability_registry_version": CAPABILITY_REGISTRY_VERSION,
    }
    defaults.update(overrides)
    return SmartFixPlan(**defaults)  # type: ignore[arg-type]


def test_a_correction_is_applied_and_proved() -> None:
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    outcome = apply_docx_fix_plan(source, digest, build_plan(size_action(), sha256=digest), LIMITS)

    assert outcome.manifest.changed_parts == ("word/document.xml",)
    assert len(outcome.manifest.entries) == 1
    entry = outcome.manifest.entries[0]
    assert entry.before is not None
    assert entry.before.to_json()["number"] == "10"
    assert entry.after.to_json()["number"] == "12"
    assert outcome.manifest.integrity.mismatches() == ()


def test_a_document_that_is_not_the_source_is_refused() -> None:
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(size_action(), sha256=digest)
    with pytest.raises(FixError) as raised:
        apply_docx_fix_plan(source, "0" * 64, plan, LIMITS)
    assert raised.value.code is FixErrorCode.SOURCE_INTEGRITY_FAILED


def test_a_plan_bound_to_another_document_is_refused() -> None:
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(size_action(), sha256="a" * 64)
    with pytest.raises(FixError) as raised:
        apply_docx_fix_plan(source, digest, plan, LIMITS)
    assert raised.value.code is FixErrorCode.SOURCE_INTEGRITY_FAILED


def test_a_plan_from_another_engine_is_refused() -> None:
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(size_action(), sha256=digest, engine_version="9.9.9")
    with pytest.raises(FixError) as raised:
        apply_docx_fix_plan(source, digest, plan, LIMITS)
    assert raised.value.code is FixErrorCode.PLAN_ENGINE_MISMATCH


def test_a_plan_from_another_capability_registry_is_refused() -> None:
    # The registry version is what the user was shown. A plan approved under a
    # registry that could change less must not run under one that can change
    # more.
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(size_action(), sha256=digest, capability_registry_version=99)
    with pytest.raises(FixError) as raised:
        apply_docx_fix_plan(source, digest, plan, LIMITS)
    assert raised.value.code is FixErrorCode.PLAN_ENGINE_MISMATCH


def test_a_plan_stamped_with_registry_version_one_is_refused() -> None:
    """Registry 1 is a real former policy, not an invented number.

    Version 1 could edit any element a rule named. Version 2 cannot touch a
    citation or a reference entry, and refuses an ELEMENT rule that names no
    element type at all. A plan a user approved under 1 therefore describes an
    engine that had never heard of that restriction, and running it here would
    apply a promise nobody made. The bump is what makes the narrowing
    retroactive; this is the test that says so.
    """
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(size_action(), sha256=digest, capability_registry_version=1)

    with pytest.raises(FixError) as raised:
        apply_docx_fix_plan(source, digest, plan, LIMITS)

    assert raised.value.code is FixErrorCode.PLAN_ENGINE_MISMATCH
    # The refusal is total: the document is not partially rewritten on the way
    # to deciding it should not be rewritten at all.
    assert hashlib.sha256(source).hexdigest() == digest


def test_a_plan_stamped_with_the_current_registry_version_still_executes() -> None:
    """The gate rejects the old policy without rejecting the new one.

    An ordinary paragraph font-size correction — nothing to do with citations —
    planned under registry 2 and applied normally. Without this the bump could
    have been "refuse everything", which would pass the rejection test above
    and break SmartFix entirely.
    """
    assert CAPABILITY_REGISTRY_VERSION == 2
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(
        size_action(), sha256=digest, capability_registry_version=CAPABILITY_REGISTRY_VERSION
    )

    outcome = apply_docx_fix_plan(source, digest, plan, LIMITS)

    assert outcome.manifest.entries != ()
    assert outcome.content != source


def test_an_empty_plan_is_refused() -> None:
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    with pytest.raises(FixError) as raised:
        apply_docx_fix_plan(source, digest, build_plan(sha256=digest), LIMITS)
    assert raised.value.code is FixErrorCode.PLAN_EMPTY


def test_a_missing_target_is_refused_before_anything_is_written() -> None:
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(
        size_action(),
        size_action(node_id="main/body/p:99/r:1", action_id="a-0002"),
        sha256=digest,
    )
    with pytest.raises(FixError) as raised:
        apply_docx_fix_plan(source, digest, plan, LIMITS)
    # The first action was perfectly applicable; refusing the whole plan is
    # the point, because a half-corrected document is worse than none.
    assert raised.value.code is FixErrorCode.TARGET_NOT_FOUND


def test_a_document_that_moved_underneath_the_plan_is_refused() -> None:
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(size_action(before="14"), sha256=digest)
    with pytest.raises(FixError) as raised:
        apply_docx_fix_plan(source, digest, plan, LIMITS)
    assert raised.value.code is FixErrorCode.SOURCE_CHANGED


def test_a_duplicate_action_id_is_refused() -> None:
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(size_action(), size_action(node_id="main/body/p:2/r:1"), sha256=digest)
    with pytest.raises(FixError) as raised:
        apply_docx_fix_plan(source, digest, plan, LIMITS)
    assert raised.value.code is FixErrorCode.PLAN_INVALID


def test_a_size_that_is_not_a_whole_half_point_is_refused() -> None:
    # 12.3 pt cannot be written. Rounding it to 12.5 would be PalCert choosing
    # a size nobody asked for.
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(size_action(after="12.3"), sha256=digest)
    with pytest.raises(FixError) as raised:
        apply_docx_fix_plan(source, digest, plan, LIMITS)
    assert raised.value.code is FixErrorCode.VALUE_UNWRITABLE


def test_a_complex_script_size_is_written_to_its_own_element() -> None:
    """Arabic text is sized by ``w:szCs``, and only by ``w:szCs``.

    This is the failure mode the script channel exists to prevent: writing
    ``w:sz`` would succeed, produce a valid file, change nothing a reader sees,
    and let the manifest claim the size was corrected.
    """
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(
        FixAction(
            action_id="a-0001",
            rule_code="BODY_FONT_SIZE_CS",
            action_type=ActionType.SET_RUN_FONT_SIZE,
            target_scope=TargetScope.RUN_PROPERTIES,
            node_id="main/body/p:2/r:1",
            script_channel=ScriptChannel.COMPLEX_SCRIPT,
            before=FixValue.of_number(Decimal("10"), "POINT"),
            after=FixValue.of_number(Decimal("13"), "POINT"),
        ),
        sha256=digest,
    )
    outcome = apply_docx_fix_plan(source, digest, plan, LIMITS)
    assert outcome.manifest.entries[0].script_channel is ScriptChannel.COMPLEX_SCRIPT

    with zipfile.ZipFile(io.BytesIO(outcome.content)) as archive:
        document = archive.read("word/document.xml").decode("utf-8")
    assert 'w:szCs w:val="26"' in document
    assert not re.search(r'<w:sz w:val="26"', document)


def test_a_change_that_does_not_read_back_is_refused() -> None:
    """The manifest is built from the output, so a silent non-change is caught.

    30 mm is 1700.79 twips and a document can only hold 1701, which reads back
    as 30.004 mm. The planner never produces such an action — it rounds the
    target first — but a hand-built one proves the guard fires rather than
    letting the manifest claim a value the document does not have.
    """
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(
        FixAction(
            action_id="a-0001",
            rule_code="MARGIN_LEFT",
            action_type=ActionType.SET_SECTION_MARGIN_LEFT,
            target_scope=TargetScope.SECTION_PROPERTIES,
            node_id="main/section:1",
            section_index=0,
            after=FixValue.of_number(Decimal("30"), "MILLIMETRE"),
        ),
        sha256=digest,
    )
    with pytest.raises(FixError) as raised:
        apply_docx_fix_plan(source, digest, plan, LIMITS)
    assert raised.value.code is FixErrorCode.CHANGE_NOT_APPLIED


def test_the_original_document_is_never_modified() -> None:
    source = source_bytes()
    original = bytes(source)
    digest = hashlib.sha256(source).hexdigest()
    apply_docx_fix_plan(source, digest, build_plan(size_action(), sha256=digest), LIMITS)
    assert source == original


def test_a_refusing_plan_is_not_executed() -> None:
    from app.smartfix.capability import RefusalCode

    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(size_action(), sha256=digest, refusal=RefusalCode.TRACKED_CHANGES)
    with pytest.raises(FixError) as raised:
        apply_docx_fix_plan(source, digest, plan, LIMITS)
    assert raised.value.code is FixErrorCode.PLAN_REFUSED


def test_the_manifest_hashes_the_plan_it_executed() -> None:
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(size_action(), sha256=digest)
    outcome = apply_docx_fix_plan(source, digest, plan, LIMITS)
    assert outcome.manifest.plan_hash == plan.hash_hex()
    assert outcome.manifest.source_sha256 == digest
    assert outcome.manifest.output_sha256 == outcome.sha256


def test_the_manifest_carries_no_document_text() -> None:
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    outcome = apply_docx_fix_plan(source, digest, build_plan(size_action(), sha256=digest), LIMITS)
    rendered = str(outcome.manifest.to_json())
    # A manifest describes where a change happened and what the value was.
    # Storing the sentence would be storing the thesis.
    assert "Body text" not in rendered
    assert "مرحبا" not in rendered


def test_a_paragraph_property_lands_in_schema_order() -> None:
    """``w:jc`` must follow ``w:ind`` and precede ``w:outlineLvl``.

    ``CT_PPr`` is a sequence, not a bag. A property appended at the end
    produces a document Word opens and a validator rejects, and PalCert would
    have handed the user a file their institution's tooling refuses.
    """
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    plan = build_plan(
        FixAction(
            action_id="a-0001",
            rule_code="INDENT",
            action_type=ActionType.SET_PARAGRAPH_INDENT_START,
            target_scope=TargetScope.PARAGRAPH_PROPERTIES,
            node_id="main/body/p:1",
            after=FixValue.of_number(Decimal("36"), "POINT"),
        ),
        sha256=digest,
    )
    outcome = apply_docx_fix_plan(source, digest, plan, LIMITS)
    with zipfile.ZipFile(io.BytesIO(outcome.content)) as archive:
        document = archive.read("word/document.xml").decode("utf-8")
    properties = re.search(r"<w:pPr>(.*?)</w:pPr>", document, re.S)
    assert properties is not None
    order = re.findall(r"<w:(\w+)", properties.group(1))
    assert order.index("ind") < order.index("jc")


def test_analysis_of_the_corrected_document_still_works() -> None:
    source = source_bytes()
    digest = hashlib.sha256(source).hexdigest()
    outcome = apply_docx_fix_plan(source, digest, build_plan(size_action(), sha256=digest), LIMITS)
    # The output is not merely bytes: it has to be a document PalCert can read
    # again, because the recheck is going to.
    after = analyze(outcome.content)
    assert after.model.paragraphs
    assert after.refusal is None
