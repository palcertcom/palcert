"""The SmartFix plan and manifest, as Python objects.

The wire shape is defined once in `contracts/schemas/smartfix.schema.json`;
this module is the engine's reading of it. Every object serializes to exactly
the JSON that schema describes, and `assert_contract` is applied at the
boundaries rather than trusted — a plan is the list of edits PalCert will make
to somebody's thesis, and an unrecognised field in one is a disagreement about
what was approved, not a detail to shrug off.

Two things are deliberately absent from these objects. There is no document
text: a formatting change is described by where it happened and what the value
was, and carrying the sentence would be carrying the thesis. And there is no
selector of any kind — no XPath, no regular expression, no XML fragment. A
node id is a locator that only `app.smartfix.locate` knows how to resolve.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from app.smartfix.capability import (
    MANIFEST_SCHEMA_VERSION,
    PLAN_SCHEMA_VERSION,
    SMARTFIX_ENGINE_NAME,
    SMARTFIX_ENGINE_VERSION,
    ActionType,
    Fixability,
    ReasonCode,
    RefusalCode,
    ScriptChannel,
    TargetScope,
)


def canonical_json(payload: Any) -> bytes:
    """Deterministic JSON bytes.

    The same three choices the Phase 6 artifact makes: sorted keys remove
    dictionary ordering, compact separators remove whitespace, and
    ``ensure_ascii=False`` keeps Arabic readable. A plan is hashed, and a hash
    over bytes that depend on anything but the content is not a hash of the
    content.
    """
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def plain_decimal(value: Decimal) -> str:
    """A decimal as the contract's exact string form.

    Never a JSON number: a font size read back as a binary float is a
    formatting change nobody asked for.
    """
    normalized = value.normalize()
    text = format(normalized, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


@dataclass(frozen=True, slots=True)
class FixValue:
    """A value an action sets or expects: exactly one of three forms."""

    kind: str
    number: Decimal | None = None
    text: str | None = None
    flag: bool | None = None
    unit: str | None = None

    @staticmethod
    def of_number(value: Decimal, unit: str | None = None) -> FixValue:
        return FixValue(kind="NUMBER", number=value, unit=unit)

    @staticmethod
    def of_text(value: str) -> FixValue:
        return FixValue(kind="STRING", text=value)

    @staticmethod
    def of_flag(value: bool) -> FixValue:
        return FixValue(kind="BOOLEAN", flag=value)

    def to_json(self) -> dict[str, Any]:
        if self.kind == "NUMBER":
            if self.number is None:  # pragma: no cover - the constructors prevent it
                raise ValueError("a NUMBER value carries no number")
            payload: dict[str, Any] = {"kind": "NUMBER", "number": plain_decimal(self.number)}
            if self.unit is not None:
                payload["unit"] = self.unit
            return payload
        if self.kind == "STRING":
            return {"kind": "STRING", "text": self.text}
        return {"kind": "BOOLEAN", "flag": bool(self.flag)}

    @staticmethod
    def from_json(data: dict[str, Any]) -> FixValue:
        kind = data["kind"]
        if kind == "NUMBER":
            return FixValue(kind=kind, number=Decimal(data["number"]), unit=data.get("unit"))
        if kind == "STRING":
            return FixValue(kind=kind, text=data["text"])
        return FixValue(kind=kind, flag=bool(data["flag"]))

    def matches(self, other: FixValue | None) -> bool:
        """Whether two values are the same value.

        Numbers compare numerically, so 12 and 12.0 are one size rather than
        two — otherwise the `expectedBefore` guard would refuse a document
        that is exactly what the planner saw.
        """
        if other is None or self.kind != other.kind:
            return False
        if self.kind == "NUMBER":
            return self.number == other.number and self.unit == other.unit
        if self.kind == "STRING":
            return self.text == other.text
        return bool(self.flag) is bool(other.flag)


@dataclass(frozen=True, slots=True)
class FixAction:
    """One deterministic property change on one element."""

    action_id: str
    rule_code: str
    action_type: ActionType
    target_scope: TargetScope
    node_id: str
    after: FixValue
    before: FixValue | None = None
    structural_path: tuple[str, ...] = ()
    section_index: int | None = None
    script_channel: ScriptChannel | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "actionId": self.action_id,
            "ruleCode": self.rule_code,
            "actionType": self.action_type.value,
            "targetScope": self.target_scope.value,
            "nodeId": self.node_id,
            "after": self.after.to_json(),
        }
        if self.structural_path:
            payload["structuralPath"] = list(self.structural_path)
        if self.section_index is not None:
            payload["sectionIndex"] = self.section_index
        if self.script_channel is not None:
            payload["scriptChannel"] = self.script_channel.value
        if self.before is not None:
            payload["before"] = self.before.to_json()
        return payload

    @staticmethod
    def from_json(data: dict[str, Any]) -> FixAction:
        return FixAction(
            action_id=data["actionId"],
            rule_code=data["ruleCode"],
            action_type=ActionType(data["actionType"]),
            target_scope=TargetScope(data["targetScope"]),
            node_id=data["nodeId"],
            after=FixValue.from_json(data["after"]),
            before=FixValue.from_json(data["before"]) if "before" in data else None,
            structural_path=tuple(data.get("structuralPath", ())),
            section_index=data.get("sectionIndex"),
            script_channel=(
                ScriptChannel(data["scriptChannel"]) if "scriptChannel" in data else None
            ),
        )


@dataclass(frozen=True, slots=True)
class PlannedRule:
    """One failing rule, and what SmartFix can do about it."""

    rule_code: str
    fixability: Fixability
    action_ids: tuple[str, ...] = ()
    target_count: int = 0
    fixable_target_count: int = 0
    reason_code: ReasonCode | None = None
    autofix: str | None = None
    evaluation_mode: str | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ruleCode": self.rule_code,
            "fixability": self.fixability.value,
            "actionIds": list(self.action_ids),
            "targetCount": self.target_count,
            "fixableTargetCount": self.fixable_target_count,
        }
        if self.reason_code is not None:
            payload["reasonCode"] = self.reason_code.value
        if self.autofix is not None:
            payload["autofix"] = self.autofix
        if self.evaluation_mode is not None:
            payload["evaluationMode"] = self.evaluation_mode
        return payload

    @staticmethod
    def from_json(data: dict[str, Any]) -> PlannedRule:
        return PlannedRule(
            rule_code=data["ruleCode"],
            fixability=Fixability(data["fixability"]),
            action_ids=tuple(data.get("actionIds", ())),
            target_count=int(data["targetCount"]),
            fixable_target_count=int(data["fixableTargetCount"]),
            reason_code=ReasonCode(data["reasonCode"]) if "reasonCode" in data else None,
            autofix=data.get("autofix"),
            evaluation_mode=data.get("evaluationMode"),
        )


@dataclass(frozen=True, slots=True)
class PlanSource:
    """What the plan was computed from.

    A plan not bound to its inputs could be executed against a document it
    never described. Every one of these is checked before a byte is written.
    """

    document_version_id: str
    document_sha256: str
    analysis_artifact_sha256: str
    standard_version_id: str
    standard_content_hash: str
    report_hash: str
    rule_schema_version: int
    fact_schema_version: int
    check_id: str | None = None
    check_run_id: str | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "documentVersionId": self.document_version_id,
            "documentSha256": self.document_sha256,
            "analysisArtifactSha256": self.analysis_artifact_sha256,
            "standardVersionId": self.standard_version_id,
            "standardContentHash": self.standard_content_hash,
            "reportHash": self.report_hash,
            "ruleSchemaVersion": self.rule_schema_version,
            "factSchemaVersion": self.fact_schema_version,
        }
        if self.check_id is not None:
            payload["checkId"] = self.check_id
        if self.check_run_id is not None:
            payload["checkRunId"] = self.check_run_id
        return payload

    @staticmethod
    def from_json(data: dict[str, Any]) -> PlanSource:
        return PlanSource(
            document_version_id=data["documentVersionId"],
            document_sha256=data["documentSha256"],
            analysis_artifact_sha256=data["analysisArtifactSha256"],
            standard_version_id=data["standardVersionId"],
            standard_content_hash=data["standardContentHash"],
            report_hash=data["reportHash"],
            rule_schema_version=int(data["ruleSchemaVersion"]),
            fact_schema_version=int(data["factSchemaVersion"]),
            check_id=data.get("checkId"),
            check_run_id=data.get("checkRunId"),
        )


@dataclass(frozen=True, slots=True)
class SmartFixPlan:
    """Exactly what PalCert intends to change, bound to what it read."""

    source: PlanSource
    rules: tuple[PlannedRule, ...] = ()
    actions: tuple[FixAction, ...] = ()
    refusal: RefusalCode | None = None
    plan_schema_version: int = PLAN_SCHEMA_VERSION
    engine_name: str = SMARTFIX_ENGINE_NAME
    engine_version: str = SMARTFIX_ENGINE_VERSION
    capability_registry_version: int = 0
    ai_planning: dict[str, Any] | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "planSchemaVersion": self.plan_schema_version,
            "source": self.source.to_json(),
            "engine": {
                "fixEngineName": self.engine_name,
                "fixEngineVersion": self.engine_version,
                "capabilityRegistryVersion": self.capability_registry_version,
            },
            "rules": [rule.to_json() for rule in self.rules],
            "actions": [action.to_json() for action in self.actions],
        }
        if self.refusal is not None:
            payload["refusal"] = {"code": self.refusal.value}
        if self.ai_planning is not None:
            payload["aiPlanning"] = self.ai_planning
        return payload

    @staticmethod
    def from_json(data: dict[str, Any]) -> SmartFixPlan:
        engine = data["engine"]
        return SmartFixPlan(
            source=PlanSource.from_json(data["source"]),
            rules=tuple(PlannedRule.from_json(entry) for entry in data.get("rules", ())),
            actions=tuple(FixAction.from_json(entry) for entry in data.get("actions", ())),
            refusal=(RefusalCode(data["refusal"]["code"]) if "refusal" in data else None),
            plan_schema_version=int(data["planSchemaVersion"]),
            engine_name=engine["fixEngineName"],
            engine_version=engine["fixEngineVersion"],
            capability_registry_version=int(engine["capabilityRegistryVersion"]),
            ai_planning=data.get("aiPlanning"),
        )

    def hash_hex(self) -> str:
        """The plan's identity.

        Taken over the canonical JSON of the plan itself, so the hash the API
        stores and the hash the engine recomputes are the same number for the
        same plan and a different number for any other.
        """
        return sha256_hex(canonical_json(self.to_json()))


@dataclass(frozen=True, slots=True)
class ChangeManifestEntry:
    """One change that was actually applied."""

    action_id: str
    rule_code: str
    action_type: ActionType
    node_id: str
    before: FixValue | None
    after: FixValue
    part_name: str
    script_channel: ScriptChannel | None = None
    section_index: int | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "actionId": self.action_id,
            "ruleCode": self.rule_code,
            "actionType": self.action_type.value,
            "nodeId": self.node_id,
            "after": self.after.to_json(),
            "partName": self.part_name,
        }
        # `before` is required by the contract; an action against a property no
        # layer declared has no prior value, and the manifest says so with an
        # explicit absence rather than inventing one.
        payload["before"] = (
            self.before.to_json()
            if self.before is not None
            else {
                "kind": "STRING",
                "text": "(not set)",
            }
        )
        if self.script_channel is not None:
            payload["scriptChannel"] = self.script_channel.value
        if self.section_index is not None:
            payload["sectionIndex"] = self.section_index
        return payload


@dataclass(frozen=True, slots=True)
class IntegrityProofs:
    """Machine proofs that the transformation changed formatting and nothing else."""

    source_visible_text: str
    output_visible_text: str
    source_media_set: str
    output_media_set: str
    source_field_instructions: str
    output_field_instructions: str
    source_relationships: str
    output_relationships: str

    def to_json(self) -> dict[str, Any]:
        return {
            "sourceVisibleTextHash": self.source_visible_text,
            "outputVisibleTextHash": self.output_visible_text,
            "sourceMediaSetHash": self.source_media_set,
            "outputMediaSetHash": self.output_media_set,
            "sourceFieldInstructionHash": self.source_field_instructions,
            "outputFieldInstructionHash": self.output_field_instructions,
            "sourceRelationshipHash": self.source_relationships,
            "outputRelationshipHash": self.output_relationships,
        }

    def mismatches(self) -> tuple[str, ...]:
        """Which proofs disagree, named so the refusal can say which."""
        failed: list[str] = []
        for name, before, after in (
            ("visibleText", self.source_visible_text, self.output_visible_text),
            ("media", self.source_media_set, self.output_media_set),
            ("fieldInstructions", self.source_field_instructions, self.output_field_instructions),
            ("relationships", self.source_relationships, self.output_relationships),
        ):
            if before != after:
                failed.append(name)
        return tuple(failed)


@dataclass(frozen=True, slots=True)
class ChangeManifest:
    """What SmartFix actually changed, with the proofs that it changed nothing else."""

    plan_hash: str
    source_sha256: str
    output_sha256: str
    entries: tuple[ChangeManifestEntry, ...]
    changed_parts: tuple[str, ...]
    integrity: IntegrityProofs
    manifest_schema_version: int = MANIFEST_SCHEMA_VERSION
    engine_name: str = SMARTFIX_ENGINE_NAME
    engine_version: str = SMARTFIX_ENGINE_VERSION

    def to_json(self) -> dict[str, Any]:
        return {
            "manifestSchemaVersion": self.manifest_schema_version,
            "engine": {
                "fixEngineName": self.engine_name,
                "fixEngineVersion": self.engine_version,
            },
            "planHash": self.plan_hash,
            "sourceSha256": self.source_sha256,
            "outputSha256": self.output_sha256,
            "entries": [entry.to_json() for entry in self.entries],
            "changedParts": list(self.changed_parts),
            "integrity": self.integrity.to_json(),
        }

    def hash_hex(self) -> str:
        return sha256_hex(canonical_json(self.to_json()))


@dataclass(slots=True)
class PlanBuilder:
    """Accumulates actions with stable, dense identifiers.

    Action ids are positional (`a-0001`) rather than random: a plan is hashed,
    and a hash that changes when nothing else did would make two identical
    plans look like two different intentions.
    """

    _actions: list[FixAction] = field(default_factory=list)

    def next_id(self) -> str:
        return f"a-{len(self._actions) + 1:04d}"

    def add(self, action: FixAction) -> str:
        self._actions.append(action)
        return action.action_id

    @property
    def actions(self) -> tuple[FixAction, ...]:
        return tuple(self._actions)
