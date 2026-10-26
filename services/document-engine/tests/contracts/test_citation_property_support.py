"""The citation properties, as four representations that must agree.

A rule author meets these properties through the public support registry. The
analyzer meets them through the DOCX fact catalogue. The projector meets them
through the projection registry. The rule engine meets their scopes and units
through the fact schema. Four descriptions of every property, and each of those
descriptions can be edited on its own.

So they are held to each other here. A unit declared in one and not another
would be a fact measured in something no rule can compare; an element type in
one and not another would let a rule be written against a fact no analyzer
produces, and the rule would come back INDETERMINATE for ever with nothing
explaining why.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.docx.catalogue import BY_NAME
from app.engine.contracts.citation_projection import PROJECTED_PROPERTIES
from app.pdf.support import Format, Support, entry_for, registry_version, support_for

#: The five properties an *exact* citation observation may assert. Frozen:
#: Checkpoint 15 added an advisory class beside them and changed none of them.
EXACT_CITATION_PROPERTIES = (
    "nativeCitationCount",
    "nativeBibliographySourceCount",
    "nativeSourceResolved",
    "referenceRegionPresent",
    "citationTargetResolved",
)

#: The advisory counters Checkpoint 15 exposed. Separate names, never values
#: of the exact rows: `observedReferenceRegionPresent` is a recognition and
#: `referenceRegionPresent` is a proof, and one must not be able to read as
#: the other.
ADVISORY_CITATION_PROPERTIES = (
    "observedCitationCount",
    "observedReferenceCount",
    "observedReferenceRegionPresent",
)

CITATION_PROPERTIES = EXACT_CITATION_PROPERTIES + ADVISORY_CITATION_PROPERTIES

#: The subset the DOCX analyzer can answer, and therefore the subset the DOCX
#: fact catalogue describes. ``citationTargetResolved`` is absent by design: a
#: Word citation resolves to a bibliography *source* record, never to a
#: rendered reference entry, so DOCX cannot answer the question at all.
DOCX_CITATION_PROPERTIES = tuple(
    name for name in EXACT_CITATION_PROPERTIES if name != "citationTargetResolved"
)

_REPO = Path(__file__).resolve().parents[4]


def _evaluation_schema() -> dict[str, Any]:
    schema: dict[str, Any] = json.loads(
        (_REPO / "contracts" / "schemas" / "evaluation.schema.json").read_text(encoding="utf-8")
    )
    return schema


# --- every citation property is publicly declared --------------------------


@pytest.mark.parametrize("name", CITATION_PROPERTIES)
def test_each_citation_property_is_in_the_public_support_registry(name: str) -> None:
    entry = entry_for(name)
    assert entry is not None, f"{name} is emitted but not publicly declared"
    # Every declared property carries a note for each format, including the
    # formats that cannot answer it: "unsupported" without a reason is what a
    # rule author cannot act on.
    assert entry.docx_note
    assert entry.pdf_note


@pytest.mark.parametrize("name", DOCX_CITATION_PROPERTIES)
def test_the_docx_answerable_properties_are_exact_for_docx(name: str) -> None:
    entry = entry_for(name)
    assert entry is not None
    assert entry.docx is Support.EXACT


@pytest.mark.parametrize(
    "name", ["nativeCitationCount", "nativeBibliographySourceCount", "nativeSourceResolved"]
)
def test_the_word_native_citation_properties_are_not_claimed_for_pdf(name: str) -> None:
    """A PDF cannot be asked these questions at all.

    Every Word CITATION field, Word-managed source records, a Word citation's
    tag matched against a Word source set. UNSUPPORTED is what makes a rule
    about them INDETERMINATE on a PDF instead of failing it on a confident
    zero, and what keeps the pre-payment preview honest.
    """
    assert support_for(Format.PDF, name) is Support.UNSUPPORTED
    entry = entry_for(name)
    assert entry is not None and entry.pdf_note


def test_the_reference_region_marker_is_exact_for_pdf_too() -> None:
    """The one property defined without reference to storage.

    "A reference region demonstrably exists, proven by structure" — a DOCX
    proves it with a BIBLIOGRAPHY field and a PDF with a declared /BibEntry.
    Same claim, same refusal to emit false.
    """
    assert support_for(Format.PDF, "referenceRegionPresent") is Support.EXACT
    entry = entry_for("referenceRegionPresent")
    assert entry is not None and entry.pdf_note


def test_the_support_registry_declares_the_element_types_it_means() -> None:
    assert registry_version() >= 2
    for name in ("nativeSourceResolved", "citationTargetResolved"):
        resolved = entry_for(name)
        assert resolved is not None
        assert resolved.scopes == ("ELEMENT",)
        assert resolved.element_types == ("CITATION",)

    for name in ("nativeCitationCount", "nativeBibliographySourceCount", "referenceRegionPresent"):
        entry = entry_for(name)
        assert entry is not None
        assert entry.scopes == ("DOCUMENT",)
        assert entry.element_types == ()


# --- the representations agree ---------------------------------------------


@pytest.mark.parametrize("name", CITATION_PROPERTIES)
def test_the_projection_registry_and_the_support_registry_agree(name: str) -> None:
    projected = next(entry for entry in PROJECTED_PROPERTIES if entry.property == name)
    public = entry_for(name)
    assert public is not None
    assert public.value_kind == projected.value_kind
    assert public.unit == projected.unit
    assert public.scopes == (projected.scope_kind,)
    if projected.element_type is None:
        assert public.element_types == ()
    else:
        assert public.element_types == (projected.element_type,)


@pytest.mark.parametrize("name", DOCX_CITATION_PROPERTIES)
def test_the_fact_catalogue_agrees_with_both(name: str) -> None:
    documented = BY_NAME[name]
    public = entry_for(name)
    assert public is not None
    assert str(documented.value_kind) == public.value_kind
    assert (str(documented.unit) if documented.unit else None) == public.unit
    assert tuple(documented.scopes) == public.scopes
    assert documented.element_types == public.element_types


@pytest.mark.parametrize("name", CITATION_PROPERTIES)
def test_the_fact_schema_knows_the_units_and_element_types_used(name: str) -> None:
    """The vocabulary a rule and a fact are both written in.

    A unit or an element type the schema does not list would validate nowhere:
    the fact set would be rejected by the shared contract, and the rule would
    be rejected by the rule validator.
    """
    schema = _evaluation_schema()
    units = schema["$defs"]["Unit"]["enum"]
    element_types = schema["$defs"]["RuleElementType"]["enum"]

    public = entry_for(name)
    assert public is not None
    if public.unit is not None:
        assert public.unit in units
    for element_type in public.element_types:
        assert element_type in element_types


def test_the_count_unit_is_the_one_the_schema_names() -> None:
    schema = _evaluation_schema()
    assert "COUNT" in schema["$defs"]["Unit"]["enum"]
    for name in ("nativeCitationCount", "nativeBibliographySourceCount"):
        entry = entry_for(name)
        assert entry is not None and entry.unit == "COUNT"


def test_the_boolean_citation_properties_are_unitless_everywhere() -> None:
    for name in ("nativeSourceResolved", "referenceRegionPresent", "citationTargetResolved"):
        public = entry_for(name)
        projected = next(entry for entry in PROJECTED_PROPERTIES if entry.property == name)
        assert public is not None
        assert public.value_kind == "BOOLEAN"
        assert public.unit is None
        assert projected.unit is None
        if name in DOCX_CITATION_PROPERTIES:
            assert BY_NAME[name].unit is None


# --- citation-target resolution is its own property ------------------------


def test_citation_target_resolution_is_declared_per_format_not_copied() -> None:
    """The two resolution properties are different questions, not aliases.

    ``nativeSourceResolved`` asks whether a Word citation's tag matches a
    record in the document's Word source store. ``citationTargetResolved``
    asks whether a declared citation resolves to exactly one declared
    reference entry in the same document. A DOCX can answer the first and not
    the second — its links target source records, which are not reference
    entries — and a tagged PDF can answer the second and not the first.
    """
    target = entry_for("citationTargetResolved")
    native = entry_for("nativeSourceResolved")
    assert target is not None and native is not None

    assert target.docx is Support.UNSUPPORTED
    assert target.pdf is Support.EXACT
    assert native.docx is Support.EXACT
    assert native.pdf is Support.UNSUPPORTED

    # Not an alias: the support levels are mirror images, and the notes say
    # why rather than repeating each other.
    assert target.docx_note != native.docx_note
    assert target.pdf_note != native.pdf_note


def test_citation_target_resolution_is_not_in_the_docx_fact_catalogue() -> None:
    """The DOCX analyzer must not be able to emit it by accident.

    The fact builder asserts every property it emits against this catalogue,
    so absence here is the enforcement, not just documentation.
    """
    assert "citationTargetResolved" not in BY_NAME


# --- what stays undiscoverable ---------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        # Link evidence. A target, a candidate list or the method that found
        # them is how PalCert reached a conclusion, not a property of the
        # document, and exposing one would invite a rule written against
        # PalCert's own reasoning.
        "citationTargetId",
        "citationCandidateIds",
        "citationLinkMethod",
        # Bibliographic content. A DOI or a rendered entry's text is user
        # content; a rule about it would be a rule about what somebody cited.
        "citationDoi",
        "referenceEntryText",
        "referenceEntryDoi",
        # A graded answer from a heuristic, which no deterministic rule may read.
        "citationConfidence",
        # Advisory counters from the artifact's summary that stay unexposed.
        # Checkpoint 15 exposed three of these deliberately and left the rest:
        # an orphan or duplicate count is a *judgement* over the discovered
        # population rather than a count of it, and exposing one would publish
        # a conclusion drawn from a lower bound.
        "orphanCitationCount",
        "uncitedReferenceCount",
        "duplicateReferenceCount",
    ],
)
def test_unapproved_citation_shapes_are_not_discoverable(name: str) -> None:
    assert entry_for(name) is None
    assert support_for(Format.DOCX, name) is Support.UNSUPPORTED
    assert support_for(Format.PDF, name) is Support.UNSUPPORTED


def test_no_property_is_exposed_for_a_reference_entry() -> None:
    """REFERENCE_ENTRY carries no properties, and must not appear to.

    A rendered entry's identity is established by classification, so nothing
    about it is projected at any coverage. An ELEMENT row that named it would
    read as though something were.
    """
    from app.pdf.support import properties

    for entry in properties():
        assert "REFERENCE_ENTRY" not in entry.element_types


@pytest.mark.parametrize("name", ADVISORY_CITATION_PROPERTIES)
def test_an_advisory_property_is_advisory_on_pdf_and_unsupported_on_docx(name: str) -> None:
    """Checkpoint 15's exposure, stated as the contract sees it.

    ADVISORY rather than EXACT, because the population is a lower bound and a
    rule about it can never pass or fail. UNSUPPORTED on DOCX, because
    heuristic discovery is implemented for PDF only and claiming otherwise
    would promise a fact no analyzer produces.
    """
    assert entry_for(name) is not None
    assert support_for(Format.PDF, name) is Support.ADVISORY
    assert support_for(Format.DOCX, name) is Support.UNSUPPORTED


@pytest.mark.parametrize("name", EXACT_CITATION_PROPERTIES)
def test_an_exact_citation_property_never_became_advisory(name: str) -> None:
    """The other half: nothing that was exact was downgraded to make room.

    A property renamed or relabelled to admit heuristic evidence is the
    failure mode this checkpoint exists to avoid, and it would be invisible in
    a diff that only added rows.
    """
    for fmt in (Format.PDF, Format.DOCX):
        assert support_for(fmt, name) is not Support.ADVISORY


def test_the_projected_set_is_exactly_what_is_publicly_declared() -> None:
    """Neither registry may grow without the other.

    A projected property missing from the support registry is a fact no rule
    author can find; a publicly declared citation property with no projection
    is a promise nothing keeps.
    """
    assert {entry.property for entry in PROJECTED_PROPERTIES} == set(CITATION_PROPERTIES)
    for name in CITATION_PROPERTIES:
        assert entry_for(name) is not None
