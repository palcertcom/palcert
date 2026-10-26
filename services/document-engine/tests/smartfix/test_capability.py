"""The capability registry, checked against the analyzer's own catalogue.

The registry says which document properties SmartFix can change. The Phase 6
catalogue says which properties the analyzer can *measure*. A capability for a
property the analyzer never emits could never fire; a capability whose unit
disagrees with the catalogue would convert a margin into the wrong number of
millimetres. Both are caught here rather than in somebody's thesis.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.docx.catalogue import PROPERTIES
from app.smartfix.capability import (
    AMBIGUOUS_TARGET_OPERATORS,
    CAPABILITIES,
    CAPABILITY_REGISTRY_VERSION,
    CONTENT_CHANGE_OPERATORS,
    DETERMINISTIC_TARGET_OPERATORS,
    FORBIDDEN_ELEMENT_TYPE_REASON,
    FORBIDDEN_ELEMENT_TYPES,
    REFUSED_PROPERTY_REASONS,
    SMARTFIX_ENGINE_NAME,
    SMARTFIX_ENGINE_VERSION,
    ActionType,
    Fixability,
    ReasonCode,
    RefusalCode,
    ScriptChannel,
    TargetScope,
    capability_for,
    element_type_is_fixable,
    load_registry,
    refusal_reason_for,
)
from app.smartfix.contracts import load_schema

_CATALOGUE = {definition.name: definition for definition in PROPERTIES}


def test_every_capability_names_a_property_the_analyzer_measures() -> None:
    for capability in CAPABILITIES:
        assert capability.property in _CATALOGUE, capability.property


def test_every_capability_agrees_with_the_catalogue_scope() -> None:
    for capability in CAPABILITIES:
        catalogued = _CATALOGUE[capability.property].scopes
        for scope in capability.scopes:
            assert scope in catalogued, f"{capability.property} under {scope}"


def test_every_capability_agrees_with_the_catalogue_unit() -> None:
    for capability in CAPABILITIES:
        catalogued = _CATALOGUE[capability.property].unit
        if capability.unit is None or capability.property == "lineSpacing":
            # lineSpacing has no catalogue unit: whether it means lines or
            # points depends on lineSpacingMode, which the planner reads.
            continue
        assert catalogued is not None
        assert str(catalogued) == capability.unit, capability.property


def test_every_capability_agrees_with_the_catalogue_value_kind() -> None:
    for capability in CAPABILITIES:
        catalogued = str(_CATALOGUE[capability.property].value_kind)
        expected = "STRING" if catalogued == "ENUM" else catalogued
        assert expected == capability.value_kind, capability.property


def test_run_capabilities_always_declare_a_script_channel() -> None:
    # Without one the mutator would have to choose between w:sz and w:szCs,
    # and choosing wrong reports an Arabic thesis as corrected while nothing
    # on the page changed.
    for capability in CAPABILITIES:
        if capability.target_scope is TargetScope.RUN_PROPERTIES:
            assert capability.script_channel is not None, capability.property
        else:
            assert capability.script_channel is None, capability.property


def test_complex_script_properties_write_the_complex_script_channel() -> None:
    assert capability_for("ELEMENT", "fontSize").script_channel is ScriptChannel.LATIN
    for name in ("fontSizeComplexScript", "boldComplexScript", "italicComplexScript"):
        assert capability_for("ELEMENT", name).script_channel is ScriptChannel.COMPLEX_SCRIPT
    assert (
        capability_for("ELEMENT", "fontFamilyEastAsian").script_channel is ScriptChannel.EAST_ASIAN
    )


def test_no_capability_creates_or_deletes_content() -> None:
    for capability in CAPABILITIES:
        assert capability.action_type.value.startswith("SET_"), capability.action_type


def test_action_types_are_exactly_the_schema_vocabulary() -> None:
    schema_types = set(load_schema()["$defs"]["FixActionType"]["enum"])
    assert {member.value for member in ActionType} == schema_types


def test_operator_policy_covers_each_operator_once() -> None:
    classified = (
        DETERMINISTIC_TARGET_OPERATORS | AMBIGUOUS_TARGET_OPERATORS | CONTENT_CHANGE_OPERATORS
    )
    assert len(classified) == (
        len(DETERMINISTIC_TARGET_OPERATORS)
        + len(AMBIGUOUS_TARGET_OPERATORS)
        + len(CONTENT_CHANGE_OPERATORS)
    )
    assert "EXISTS" in CONTENT_CHANGE_OPERATORS
    assert "NOT_EXISTS" in CONTENT_CHANGE_OPERATORS
    assert "EQUALS" in DETERMINISTIC_TARGET_OPERATORS
    assert "GREATER_THAN" in AMBIGUOUS_TARGET_OPERATORS


def test_nothing_is_both_supported_and_refused() -> None:
    for capability in CAPABILITIES:
        assert capability.property not in REFUSED_PROPERTY_REASONS


@pytest.mark.parametrize(
    ("scope", "prop", "expected"),
    [
        ("DOCUMENT", "wordCount", ReasonCode.COUNT_NOT_EDITABLE),
        ("DOCUMENT", "sectionCount", ReasonCode.PAGINATION_NOT_EDITABLE),
        ("ELEMENT", "pageBreakBefore", ReasonCode.PAGINATION_NOT_EDITABLE),
        ("METADATA", "title", ReasonCode.METADATA_NOT_SUPPORTED),
        ("METADATA", "somethingNew", ReasonCode.METADATA_NOT_SUPPORTED),
        ("ELEMENT", "invented", ReasonCode.PROPERTY_NOT_SUPPORTED),
    ],
)
def test_refusals_explain_themselves(scope: str, prop: str, expected: ReasonCode) -> None:
    assert refusal_reason_for(scope, prop) is expected


def test_refused_properties_exist_in_the_catalogue() -> None:
    for name in REFUSED_PROPERTY_REASONS:
        assert name in _CATALOGUE, name


def test_reason_codes_are_exactly_the_registry_vocabulary() -> None:
    # The Python enum and the shared registry are two readings of one
    # vocabulary. A code the planner emits that the registry does not declare
    # is a code the UI has no translation for.
    assert {member.value for member in ReasonCode} == set(load_registry()["reasonCodes"]["values"])


def test_refusal_codes_are_exactly_the_schema_vocabulary() -> None:
    schema_codes = set(
        load_schema()["$defs"]["SmartFixPlan"]["properties"]["refusal"]["properties"]["code"][
            "enum"
        ]
    )
    assert {member.value for member in RefusalCode} == schema_codes


def test_fixability_matches_the_schema_vocabulary() -> None:
    assert {member.value for member in Fixability} == set(
        load_schema()["$defs"]["FixabilityStatus"]["enum"]
    )


def test_engine_identity_is_stamped_and_semantic() -> None:
    assert SMARTFIX_ENGINE_NAME == "palcert-docx-fixer"
    assert len(SMARTFIX_ENGINE_VERSION.split(".")) == 3
    assert CAPABILITY_REGISTRY_VERSION >= 1


def test_the_capability_registry_version_is_two_and_comes_from_the_registry() -> None:
    """Pinned to the exact number, and to its one source.

    The mutation path refuses a plan whose stamped registry version is not
    this one, so the number is the boundary between two capability policies:
    version 1 could edit any element a rule named, version 2 cannot touch a
    citation or a reference entry. A literal typed anywhere else would be a
    second answer to a question that must have one.
    """
    assert CAPABILITY_REGISTRY_VERSION == 2
    assert load_registry()["registryVersion"] == CAPABILITY_REGISTRY_VERSION


def test_narrowing_the_policy_did_not_disturb_the_unrelated_versions() -> None:
    # The mutation bytes and the plan shape did not change; only what SmartFix
    # is permitted to touch did. Bumping those too would invalidate stored
    # manifests and plans for no reason anybody could point at.
    registry = load_registry()
    assert registry["engine"]["version"] == "1.0.0"
    assert registry["planSchemaVersion"] == 1
    assert registry["manifestSchemaVersion"] == 1


def test_registry_is_the_file_the_api_generates_from() -> None:
    # Both runtimes read this path; the TypeScript constant is generated from
    # it and CI fails if the generated copy drifts.
    root = next(
        parent
        for parent in Path(__file__).resolve().parents
        if (parent / "contracts" / "registries").is_dir()
    )
    generated = (
        root / "packages" / "contracts" / "src" / "smartfix" / "registry.generated.ts"
    ).read_text(encoding="utf-8")
    for capability in CAPABILITIES:
        assert f"property: '{capability.property}'" in generated
    assert f"registryVersion: {load_registry()['registryVersion']}" in generated


# ---------------------------------------------------------------------------
# The element-type policy (Phase 18 Checkpoint 1)
# ---------------------------------------------------------------------------


def test_the_forbidden_element_types_are_read_from_the_shared_registry() -> None:
    # Not retyped here. A private second list is how the API comes to promise
    # a fix the engine refuses.
    declared = frozenset(load_registry()["elementTypePolicy"]["forbidden"])
    assert declared == FORBIDDEN_ELEMENT_TYPES
    assert frozenset({"CITATION", "REFERENCE_ENTRY"}) == FORBIDDEN_ELEMENT_TYPES


def test_the_element_type_refusal_uses_a_declared_reason_code() -> None:
    assert FORBIDDEN_ELEMENT_TYPE_REASON in {code.value for code in ReasonCode}
    assert FORBIDDEN_ELEMENT_TYPE_REASON in load_registry()["reasonCodes"]["values"]
    assert ReasonCode(FORBIDDEN_ELEMENT_TYPE_REASON) is ReasonCode.ELEMENT_TYPE_NOT_EDITABLE


def test_a_forbidden_element_type_is_never_fixable() -> None:
    for element_type in FORBIDDEN_ELEMENT_TYPES:
        assert element_type_is_fixable(element_type) is False


def test_an_absent_element_type_is_never_fixable() -> None:
    # An unnamed element type is not a permission.
    assert element_type_is_fixable(None) is False


def test_an_ordinary_element_type_is_unaffected() -> None:
    assert element_type_is_fixable("PARAGRAPH") is True
    assert element_type_is_fixable("HEADING") is True


def test_no_capability_row_carries_its_own_element_type_list() -> None:
    # The two axes stay separate: capabilities name properties and scopes, and
    # the element-type policy names element types. A capability that grew its
    # own list would be a second place to look, and the guard would stop being
    # the one answer.
    for row in load_registry()["capabilities"]:
        assert "elementTypes" not in row
        assert "forbiddenElementTypes" not in row
