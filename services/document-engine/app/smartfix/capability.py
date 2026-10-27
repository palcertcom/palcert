"""The SmartFix capability registry and its policy constants (§13, §18, §30).

The table itself lives in `contracts/registries/smartfix-capabilities.json`.
This module is the typed Python reading of it; the API's reading is generated
into `packages/contracts/src/smartfix/registry.generated.ts` from the same
file. Neither language owns a private copy, because a registry that says
"SmartFix can change this" on one side and "it cannot" on the other would mean
the user approved a plan the engine will not honour — or, worse, one it will
exceed.

The table is the floor. A standard rule's ``autofix: SAFE`` is a ceiling set by
whoever wrote the standard: it says the change would be safe if PalCert could
make it. This says whether PalCert can. A property that is not here is never
edited, however the rule is labelled.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Any

_REGISTRY_RELATIVE = Path("contracts") / "registries" / "smartfix-capabilities.json"


def _find_registry() -> Path:
    """Locate the shared registry by walking up to the repository root.

    Searched rather than hard-coded to a parent depth, so moving this module
    one package deeper does not silently fall back to a stale table.
    """
    for directory in Path(__file__).resolve().parents:
        candidate = directory / _REGISTRY_RELATIVE
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        f"Could not find {_REGISTRY_RELATIVE} above {__file__}. The capability registry is "
        f"shared with the API; there is no fallback copy."
    )


@lru_cache(maxsize=1)
def load_registry() -> dict[str, Any]:
    """The capability registry, read from the single source of truth."""
    with _find_registry().open(encoding="utf-8") as handle:
        registry: dict[str, Any] = json.load(handle)
    return registry


_REGISTRY = load_registry()

#: The mutation engine's own identity, separate from the application version,
#: the git SHA and the DOCX analyzer version: a change to how a document is
#: *transformed* is a different kind of event from a change to how it is
#: *read*, and a stored manifest has to say which transformer produced it.
SMARTFIX_ENGINE_NAME: str = _REGISTRY["engine"]["name"]
SMARTFIX_ENGINE_VERSION: str = _REGISTRY["engine"]["version"]

#: Stamped on every plan, so a plan approved yesterday is never executed under
#: a registry that has since learned to change more of the document than the
#: user was shown.
CAPABILITY_REGISTRY_VERSION: int = _REGISTRY["registryVersion"]

PLAN_SCHEMA_VERSION: int = _REGISTRY["planSchemaVersion"]
MANIFEST_SCHEMA_VERSION: int = _REGISTRY["manifestSchemaVersion"]

#: Operators that name exactly one correct value. Anything outside this set
#: becomes AMBIGUOUS_TARGET and is shown to the user as manual work: SmartFix
#: has to know what "fixed" means before it edits anything.
DETERMINISTIC_TARGET_OPERATORS: frozenset[str] = frozenset(
    _REGISTRY["operatorPolicy"]["deterministic"]
)

#: Operators that name a set or a language rather than a value. Choosing a
#: member would be PalCert deciding what the author's document should say.
AMBIGUOUS_TARGET_OPERATORS: frozenset[str] = frozenset(_REGISTRY["operatorPolicy"]["ambiguous"])

#: Operators whose only remedy is writing or deleting content.
CONTENT_CHANGE_OPERATORS: frozenset[str] = frozenset(_REGISTRY["operatorPolicy"]["contentChange"])

#: Element types SmartFix must never edit, whatever a rule says.
#:
#: A separate axis from the capability table, not a gap in it. Capability
#: lookup asks for a scope kind and a property and is deliberately blind to
#: element type, so a ``lineSpacing`` capability answers for whatever element a
#: rule points at. That is right for a paragraph and wrong for a citation.
FORBIDDEN_ELEMENT_TYPES: frozenset[str] = frozenset(_REGISTRY["elementTypePolicy"]["forbidden"])

#: The reason a forbidden — or unnamed — element type is refused with.
FORBIDDEN_ELEMENT_TYPE_REASON: str = _REGISTRY["elementTypePolicy"]["reasonCode"]


class TargetScope(StrEnum):
    SECTION_PROPERTIES = "SECTION_PROPERTIES"
    PARAGRAPH_PROPERTIES = "PARAGRAPH_PROPERTIES"
    RUN_PROPERTIES = "RUN_PROPERTIES"
    DRAWING_PROPERTIES = "DRAWING_PROPERTIES"


class ScriptChannel(StrEnum):
    """Which OOXML script channel a run-level action writes.

    WordprocessingML keeps Latin, complex-script and East Asian typography in
    separate attributes and elements. Writing ``w:sz`` for an Arabic paragraph
    changes nothing a reader can see while the manifest claims the size was
    corrected — so the channel is part of the capability, never a detail left
    to the mutator to guess.
    """

    LATIN = "LATIN"
    COMPLEX_SCRIPT = "COMPLEX_SCRIPT"
    EAST_ASIAN = "EAST_ASIAN"


class ActionType(StrEnum):
    """The closed vocabulary of transformations this engine can perform.

    Every one is a formatting property change on an element that already
    exists. Nothing here creates, deletes, moves or rewrites content, because
    that is where academic meaning lives.
    """

    SET_RUN_FONT_FAMILY = "SET_RUN_FONT_FAMILY"
    SET_RUN_FONT_SIZE = "SET_RUN_FONT_SIZE"
    SET_RUN_BOLD = "SET_RUN_BOLD"
    SET_RUN_ITALIC = "SET_RUN_ITALIC"
    SET_RUN_UNDERLINE = "SET_RUN_UNDERLINE"
    SET_RUN_LANGUAGE = "SET_RUN_LANGUAGE"
    SET_RUN_COLOR = "SET_RUN_COLOR"
    SET_PARAGRAPH_STYLE = "SET_PARAGRAPH_STYLE"
    SET_LIST_START = "SET_LIST_START"
    SET_DRAWING_PLACEMENT = "SET_DRAWING_PLACEMENT"
    SET_PARAGRAPH_ALIGNMENT = "SET_PARAGRAPH_ALIGNMENT"
    SET_PARAGRAPH_LINE_SPACING = "SET_PARAGRAPH_LINE_SPACING"
    SET_PARAGRAPH_SPACING_BEFORE = "SET_PARAGRAPH_SPACING_BEFORE"
    SET_PARAGRAPH_SPACING_AFTER = "SET_PARAGRAPH_SPACING_AFTER"
    SET_PARAGRAPH_INDENT_START = "SET_PARAGRAPH_INDENT_START"
    SET_PARAGRAPH_INDENT_END = "SET_PARAGRAPH_INDENT_END"
    SET_PARAGRAPH_FIRST_LINE_INDENT = "SET_PARAGRAPH_FIRST_LINE_INDENT"
    SET_PARAGRAPH_HANGING_INDENT = "SET_PARAGRAPH_HANGING_INDENT"
    SET_SECTION_MARGIN_TOP = "SET_SECTION_MARGIN_TOP"
    SET_SECTION_MARGIN_BOTTOM = "SET_SECTION_MARGIN_BOTTOM"
    SET_SECTION_MARGIN_LEFT = "SET_SECTION_MARGIN_LEFT"
    SET_SECTION_MARGIN_RIGHT = "SET_SECTION_MARGIN_RIGHT"
    SET_SECTION_HEADER_DISTANCE = "SET_SECTION_HEADER_DISTANCE"
    SET_SECTION_FOOTER_DISTANCE = "SET_SECTION_FOOTER_DISTANCE"


class Fixability(StrEnum):
    """Why a failing rule can or cannot be corrected automatically."""

    FIXABLE = "FIXABLE"
    PARTIALLY_FIXABLE = "PARTIALLY_FIXABLE"
    NOT_SUPPORTED = "NOT_SUPPORTED"
    MANUAL_ACTION_REQUIRED = "MANUAL_ACTION_REQUIRED"
    INSUFFICIENT_LOCATION_EVIDENCE = "INSUFFICIENT_LOCATION_EVIDENCE"
    AMBIGUOUS_TARGET = "AMBIGUOUS_TARGET"
    SOURCE_DOCUMENT_UNSAFE_TO_EDIT = "SOURCE_DOCUMENT_UNSAFE_TO_EDIT"


class ReasonCode(StrEnum):
    """Why a failing rule was not planned, or was planned only in part."""

    PROPERTY_NOT_SUPPORTED = "SMARTFIX_PROPERTY_NOT_SUPPORTED"
    SCOPE_NOT_SUPPORTED = "SMARTFIX_SCOPE_NOT_SUPPORTED"
    OPERATOR_AMBIGUOUS = "SMARTFIX_OPERATOR_AMBIGUOUS"
    CONTENT_CHANGE_REQUIRED = "SMARTFIX_CONTENT_CHANGE_REQUIRED"
    RULE_NOT_DETERMINISTIC = "SMARTFIX_RULE_NOT_DETERMINISTIC"
    AUTOFIX_NOT_SAFE = "SMARTFIX_AUTOFIX_NOT_SAFE"
    COUNT_NOT_EDITABLE = "SMARTFIX_COUNT_NOT_EDITABLE"
    PAGINATION_NOT_EDITABLE = "SMARTFIX_PAGINATION_NOT_EDITABLE"
    LOCATION_EVIDENCE_MISSING = "SMARTFIX_LOCATION_EVIDENCE_MISSING"
    EXPECTED_VALUE_UNUSABLE = "SMARTFIX_EXPECTED_VALUE_UNUSABLE"
    #: WordprocessingML stores page geometry in twips, so a margin in
    #: millimetres almost never lands on a whole one. Where the nearest
    #: representable value would still fail the rule, SmartFix leaves the
    #: document alone rather than making a change that looks like a fix and
    #: fails the recheck.
    TARGET_NOT_REPRESENTABLE = "SMARTFIX_TARGET_NOT_REPRESENTABLE"
    METADATA_NOT_SUPPORTED = "SMARTFIX_METADATA_NOT_SUPPORTED"
    #: The rule names an element type SmartFix must not edit, or names none.
    #: An ELEMENT-scoped rule with no element type is refused by this code too:
    #: an unnamed element type is not a permission to edit every element.
    ELEMENT_TYPE_NOT_EDITABLE = "SMARTFIX_ELEMENT_TYPE_NOT_EDITABLE"


class RefusalCode(StrEnum):
    """Why the source document cannot be edited at all.

    A refusal is a property of the *document*, not of any one rule, so it is
    recorded once on the plan and the plan carries no actions.
    """

    TRACKED_CHANGES = "SMARTFIX_TRACKED_CHANGES_UNSUPPORTED"
    PROTECTED = "SMARTFIX_DOCUMENT_PROTECTED"
    SIGNED = "SMARTFIX_SIGNED_DOCUMENT_UNSUPPORTED"
    FORMAT = "SMARTFIX_SOURCE_FORMAT_UNSUPPORTED"


@dataclass(frozen=True, slots=True)
class FixCapability:
    property: str
    scopes: tuple[str, ...]
    action_type: ActionType
    target_scope: TargetScope
    value_kind: str
    script_channel: ScriptChannel | None = None
    unit: str | None = None


CAPABILITIES: tuple[FixCapability, ...] = tuple(
    FixCapability(
        property=row["property"],
        scopes=tuple(row["scopes"]),
        action_type=ActionType(row["actionType"]),
        target_scope=TargetScope(row["targetScope"]),
        value_kind=row["valueKind"],
        script_channel=ScriptChannel(row["scriptChannel"]) if "scriptChannel" in row else None,
        unit=row.get("unit"),
    )
    for row in _REGISTRY["capabilities"]
)

_BY_KEY: dict[str, FixCapability] = {
    f"{scope}:{capability.property}": capability
    for capability in CAPABILITIES
    for scope in capability.scopes
}


def element_type_is_fixable(element_type: str | None) -> bool:
    """Whether SmartFix may edit an element of this type at all.

    ``None`` is refused as firmly as a forbidden type. An ELEMENT-scoped rule
    that names no element type would otherwise inherit whichever capability
    matched its property, and a fix would reach an element nobody agreed it
    could touch. Fail closed: an unnamed element type is not a permission.
    """
    if element_type is None:
        return False
    return element_type not in FORBIDDEN_ELEMENT_TYPES


def capability_for(scope_kind: str, prop: str) -> FixCapability | None:
    """The capability for a scope and property, or ``None`` if there is none."""
    return _BY_KEY.get(f"{scope_kind}:{prop}")


#: Properties PalCert deliberately refuses to edit, and why.
#:
#: These are not gaps waiting to be filled. A word count is an outcome of what
#: the author wrote and a page count is an outcome of a layout engine PalCert
#: does not run, so naming them means the user is told *why* rather than being
#: told "unsupported" about a property the engine simply never met.
REFUSED_PROPERTY_REASONS: dict[str, ReasonCode] = {
    name: ReasonCode(code) for name, code in _REGISTRY["refusedProperties"].items()
}


def refusal_reason_for(scope_kind: str, prop: str) -> ReasonCode:
    """The reason a property is not fixable, for the UI to translate."""
    if scope_kind == "METADATA":
        return ReasonCode.METADATA_NOT_SUPPORTED
    return REFUSED_PROPERTY_REASONS.get(prop, ReasonCode.PROPERTY_NOT_SUPPORTED)
