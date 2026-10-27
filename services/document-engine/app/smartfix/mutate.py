"""Applying an approved plan to a DOCX, or refusing to.

The entry point is `apply_docx_fix_plan(source, expected_sha256, plan)`. It
either returns corrected bytes with a manifest, or raises — there is no partial
outcome, because a half-corrected thesis is worse than an uncorrected one.

The sequence is deliberately paranoid, and each step exists because of what it
would cost to skip it:

1. **The source is the source.** Its digest must be the one the plan was
   computed from; otherwise PalCert is editing a document nobody reviewed a
   plan for.
2. **The plan is the plan.** Schema, engine version and capability registry
   version all have to match this build. A plan approved under a registry that
   could change less of the document must not execute under one that can
   change more.
3. **The document has not moved underneath it.** Every action's `before` is
   re-read from the document and must still agree.
4. **Nothing is written until everything resolves.** Actions are checked in
   full before the first edit, so a plan that cannot be applied completely is
   not applied at all.
5. **The result is proved, not asserted.** Visible text, media, field
   instructions and relationships are projected before and after and must
   match, and every manifest entry is verified by re-reading the *output*.
"""

from __future__ import annotations

import hashlib
import io
import zipfile
from dataclasses import dataclass
from enum import StrEnum
from xml.etree.ElementTree import Element

from app.docx.limits import AnalyzerLimits
from app.docx.model import StructuralModel
from app.docx.warnings import WarningCollector
from app.smartfix import proofs
from app.smartfix.capability import (
    CAPABILITY_REGISTRY_VERSION,
    SMARTFIX_ENGINE_NAME,
    SMARTFIX_ENGINE_VERSION,
    ActionType,
    TargetScope,
)
from app.smartfix.contracts import SmartFixContract, assert_contract
from app.smartfix.extended import apply_inline_drawing, apply_list_starts, validate_extended_action
from app.smartfix.locate import DocumentIndex, build_index
from app.smartfix.model import (
    ChangeManifest,
    ChangeManifestEntry,
    FixAction,
    FixValue,
    IntegrityProofs,
    SmartFixPlan,
)
from app.smartfix.observe import NodeLookup, line_rule_for, observe
from app.smartfix.ooxml import (
    UnwritableValueError,
    apply_paragraph_action,
    apply_run_action,
    apply_section_action,
)
from app.smartfix.serialize import rewrite_package, serialize_part


class FixErrorCode(StrEnum):
    """Why a correction was refused.

    Every one of these is a refusal to write, never a partially written
    document. They are stable codes because the orchestration turns them into
    a released reservation and a message the user reads.
    """

    SOURCE_INTEGRITY_FAILED = "SMARTFIX_SOURCE_INTEGRITY_FAILED"
    PLAN_INVALID = "SMARTFIX_PLAN_INVALID"
    PLAN_ENGINE_MISMATCH = "SMARTFIX_PLAN_ENGINE_MISMATCH"
    PLAN_REFUSED = "SMARTFIX_PLAN_REFUSED"
    PLAN_EMPTY = "SMARTFIX_PLAN_EMPTY"
    TARGET_NOT_FOUND = "SMARTFIX_TARGET_NOT_FOUND"
    SOURCE_CHANGED = "SMARTFIX_SOURCE_CHANGED"
    VALUE_UNWRITABLE = "SMARTFIX_VALUE_UNWRITABLE"
    INTEGRITY_PROOF_FAILED = "SMARTFIX_INTEGRITY_PROOF_FAILED"
    CHANGE_NOT_APPLIED = "SMARTFIX_CHANGE_NOT_APPLIED"
    PACKAGE_INVALID = "SMARTFIX_PACKAGE_INVALID"


class FixError(Exception):
    """A correction that was refused, with a code the caller can act on."""

    def __init__(self, code: FixErrorCode, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True, slots=True)
class FixOutcome:
    content: bytes
    sha256: str
    manifest: ChangeManifest


def apply_docx_fix_plan(
    source: bytes,
    expected_source_sha256: str,
    plan: SmartFixPlan,
    limits: AnalyzerLimits | None = None,
) -> FixOutcome:
    """Apply one approved plan, or refuse."""
    effective_limits = limits or AnalyzerLimits.default()

    source_sha = hashlib.sha256(source).hexdigest()
    if source_sha != expected_source_sha256.lower():
        raise FixError(
            FixErrorCode.SOURCE_INTEGRITY_FAILED,
            "the document does not match the digest the plan was computed from",
        )

    _assert_plan_executable(plan, source_sha)

    with zipfile.ZipFile(io.BytesIO(source)) as archive:
        before_projection = proofs.project(archive, effective_limits)

    index, package = build_index(io.BytesIO(source), effective_limits, WarningCollector())
    try:
        lookup = NodeLookup(index.model)
        resolved = _resolve(plan.actions, index, lookup)
        changed_parts = _apply(resolved, index, lookup)
        replacements = {
            part: serialize_part(package.read_bytes(part), index.roots[part])
            for part in sorted(changed_parts)
        }
        with zipfile.ZipFile(io.BytesIO(source)) as archive:
            output = rewrite_package(archive, replacements)
    finally:
        package.close()

    with zipfile.ZipFile(io.BytesIO(output)) as archive:
        after_projection = proofs.project(archive, effective_limits)

    integrity = IntegrityProofs(
        source_visible_text=before_projection.visible_text,
        output_visible_text=after_projection.visible_text,
        source_media_set=before_projection.media_set,
        output_media_set=after_projection.media_set,
        source_field_instructions=before_projection.field_instructions,
        output_field_instructions=after_projection.field_instructions,
        source_relationships=before_projection.relationships,
        output_relationships=after_projection.relationships,
    )
    mismatched = integrity.mismatches()
    if mismatched:
        raise FixError(
            FixErrorCode.INTEGRITY_PROOF_FAILED,
            f"the corrected document changed more than formatting: {', '.join(mismatched)}",
        )

    entries = _verify_against_output(index.model, resolved, output, effective_limits)

    return FixOutcome(
        content=output,
        sha256=hashlib.sha256(output).hexdigest(),
        manifest=ChangeManifest(
            plan_hash=plan.hash_hex(),
            source_sha256=source_sha,
            output_sha256=hashlib.sha256(output).hexdigest(),
            entries=entries,
            changed_parts=tuple(sorted(changed_parts)),
            integrity=integrity,
        ),
    )


@dataclass(frozen=True, slots=True)
class _ResolvedAction:
    """One action with its target already found and its prior value re-read."""

    action: FixAction
    part_name: str
    before: FixValue | None
    #: The element the action edits: a run, a paragraph or a ``w:sectPr``.
    target: Element


def _assert_plan_executable(plan: SmartFixPlan, source_sha: str) -> None:
    try:
        assert_contract(SmartFixContract.SMART_FIX_PLAN, plan.to_json())
    except ValueError as error:
        raise FixError(FixErrorCode.PLAN_INVALID, str(error)) from error

    if plan.refusal is not None:
        raise FixError(
            FixErrorCode.PLAN_REFUSED,
            f"the plan refuses this document: {plan.refusal.value}",
        )
    if not plan.actions:
        raise FixError(FixErrorCode.PLAN_EMPTY, "the plan contains no actions")
    if plan.source.document_sha256.lower() != source_sha:
        raise FixError(
            FixErrorCode.SOURCE_INTEGRITY_FAILED,
            "the plan is bound to a different document",
        )
    if (
        plan.engine_name != SMARTFIX_ENGINE_NAME
        or plan.engine_version != SMARTFIX_ENGINE_VERSION
        or plan.capability_registry_version != CAPABILITY_REGISTRY_VERSION
    ):
        # A plan the user approved described what *that* engine and *that*
        # registry could change. Executing it under a different one would
        # apply a different promise.
        raise FixError(
            FixErrorCode.PLAN_ENGINE_MISMATCH,
            "the plan was produced by a different fix engine or capability registry",
        )

    seen: set[str] = set()
    for action in plan.actions:
        if action.action_id in seen:
            raise FixError(FixErrorCode.PLAN_INVALID, f"action {action.action_id} appears twice")
        seen.add(action.action_id)


def _resolve(
    actions: tuple[FixAction, ...],
    index: DocumentIndex,
    lookup: NodeLookup,
) -> tuple[_ResolvedAction, ...]:
    """Locate every action and re-read its prior value, before writing any.

    A plan that cannot be applied completely is not applied at all: a
    half-corrected document would pass some rules, fail others, and leave the
    user unable to tell which of their paragraphs PalCert touched.
    """
    resolved: list[_ResolvedAction] = []
    for action in actions:
        if action.target_scope is TargetScope.SECTION_PROPERTIES:
            if action.section_index is None:
                raise FixError(
                    FixErrorCode.PLAN_INVALID,
                    f"action {action.action_id} edits a section without naming one",
                )
            section = index.section_for(action.section_index)
            if section is None:
                raise FixError(
                    FixErrorCode.TARGET_NOT_FOUND,
                    f"action {action.action_id} names a section the document does not have",
                )
            part_name, element = section.part_name, section.sect_pr
        else:
            located = index.element_for(action.node_id)
            if located is None:
                raise FixError(
                    FixErrorCode.TARGET_NOT_FOUND,
                    f"action {action.action_id} names an element the document does not have",
                )
            part_name, element = located

        current = observe(lookup, action, index.model)
        try:
            validate_extended_action(action, element, index, lookup)
        except UnwritableValueError as error:
            raise FixError(FixErrorCode.VALUE_UNWRITABLE, str(error)) from error
        if action.before is not None and not action.before.matches(current):
            raise FixError(
                FixErrorCode.SOURCE_CHANGED,
                f"action {action.action_id} expected a different value in the document",
            )
        resolved.append(
            _ResolvedAction(action=action, part_name=part_name, before=current, target=element)
        )
    return tuple(resolved)


def _apply(
    resolved: tuple[_ResolvedAction, ...],
    index: DocumentIndex,
    lookup: NodeLookup,
) -> set[str]:
    """Write every resolved action. Nothing here can fail to find its target."""
    changed: set[str] = set()
    try:
        changed.update(apply_list_starts(tuple(e.action for e in resolved), index, lookup))
    except UnwritableValueError as error:
        raise FixError(FixErrorCode.VALUE_UNWRITABLE, str(error)) from error
    for entry in resolved:
        action = entry.action
        try:
            if action.action_type is ActionType.SET_LIST_START:
                continue
            if action.target_scope is TargetScope.DRAWING_PROPERTIES:
                apply_inline_drawing(entry.target)
            elif action.target_scope is TargetScope.SECTION_PROPERTIES:
                apply_section_action(entry.target, action, index.namespaces)
            elif action.target_scope is TargetScope.RUN_PROPERTIES:
                apply_run_action(entry.target, action, index.namespaces)
            else:
                apply_paragraph_action(
                    entry.target,
                    action,
                    index.namespaces,
                    line_rule=line_rule_for(lookup, action.node_id),
                )
        except UnwritableValueError as error:
            raise FixError(FixErrorCode.VALUE_UNWRITABLE, str(error)) from error
        changed.add(entry.part_name)
    return changed


def _verify_against_output(
    original: StructuralModel,
    resolved: tuple[_ResolvedAction, ...],
    output: bytes,
    limits: AnalyzerLimits,
) -> tuple[ChangeManifestEntry, ...]:
    """Build the manifest from the corrected document, not from the plan.

    A planned action is an intention. Reading the output back and confirming
    that each target now *has* the value is the only way the manifest can
    claim to describe what happened, and the only way an action that silently
    did nothing — the wrong script channel, a style that still wins — is
    caught before delivery rather than by the recheck (§110).
    """
    index, package = build_index(io.BytesIO(output), limits, WarningCollector())
    try:
        # XML text hashes cannot detect a style hiding or revealing a run.
        # Compare effective visibility after resolving paragraph/character
        # style inheritance and direct overrides, in every indexed story.
        # Reuse the source/output models already parsed for target validation.
        if _run_visibility(original) != _run_visibility(index.model):
            raise FixError(
                FixErrorCode.INTEGRITY_PROOF_FAILED,
                "the corrected document changed effective content visibility",
            )
        lookup = NodeLookup(index.model)
        entries: list[ChangeManifestEntry] = []
        for entry in resolved:
            action = entry.action
            now = observe(lookup, action, index.model)
            if not action.after.matches(now):
                raise FixError(
                    FixErrorCode.CHANGE_NOT_APPLIED,
                    f"action {action.action_id} did not take effect in the corrected document",
                )
            entries.append(
                ChangeManifestEntry(
                    action_id=action.action_id,
                    rule_code=action.rule_code,
                    action_type=action.action_type,
                    node_id=action.node_id,
                    before=entry.before,
                    after=action.after,
                    part_name=entry.part_name,
                    script_channel=action.script_channel,
                    section_index=action.section_index,
                )
            )
    finally:
        package.close()
    return tuple(entries)


def _run_visibility(model: StructuralModel) -> tuple[tuple[str, bool], ...]:
    return tuple(
        (run.locator.node_id, paragraph.revision.visible_in_final and run.visible)
        for paragraph in model.paragraphs
        for run in paragraph.runs
    )
