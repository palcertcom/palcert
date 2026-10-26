"""Whether a document may be edited at all.

Each refusal is a promise PalCert makes to somebody who never asked for
SmartFix: the supervisor reading a tracked-changes draft, the author who
locked their file, the institution that signed one.
"""

from __future__ import annotations

import io

import pytest

from app.docx.limits import AnalyzerLimits
from app.docx.package import DocxPackage, resolve_namespaces
from app.docx.warnings import WarningCollector
from app.smartfix import safety
from app.smartfix.capability import RefusalCode
from tests.docx.builder import DocxBuilder, section_properties, settings_part
from tests.smartfix.support import analyze

PLAIN = '<w:p><w:r><w:t xml:space="preserve">Body</w:t></w:r></w:p>' + section_properties()


def _assess(content: bytes) -> RefusalCode | None:
    warnings = WarningCollector()
    limits = AnalyzerLimits.default()
    package = DocxPackage.open(io.BytesIO(content), limits, warnings)
    try:
        from app.docx.document import read_document

        result = read_document(package, limits, warnings)
        root = package.parse_part(package.main_document_part())
        return safety.assess(package, result.model, resolve_namespaces(root.tag))
    finally:
        package.close()


def test_an_ordinary_document_may_be_corrected() -> None:
    assert _assess(DocxBuilder(body=PLAIN).build()) is None


def test_an_insertion_refuses_the_document() -> None:
    content = DocxBuilder(
        body='<w:p><w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">'
        '<w:r><w:t xml:space="preserve">New</w:t></w:r></w:ins></w:p>' + section_properties()
    ).build()
    assert _assess(content) is RefusalCode.TRACKED_CHANGES


def test_a_deletion_refuses_the_document() -> None:
    content = DocxBuilder(
        body='<w:p><w:del w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">'
        "<w:r><w:delText>Gone</w:delText></w:r></w:del></w:p>" + section_properties()
    ).build()
    assert _assess(content) is RefusalCode.TRACKED_CHANGES


def test_a_recorded_formatting_change_refuses_the_document() -> None:
    """``w:rPrChange`` records what the formatting used to be.

    Editing the current formatting without touching that record would make
    the document claim a change that never happened; rewriting the record
    would falsify somebody's review history. Neither is PalCert's to do.
    """
    content = DocxBuilder(
        body="<w:p><w:r><w:rPr><w:b/>"
        '<w:rPrChange w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z"><w:rPr/></w:rPrChange>'
        '</w:rPr><w:t xml:space="preserve">Body</w:t></w:r></w:p>' + section_properties()
    ).build()
    assert _assess(content) is RefusalCode.TRACKED_CHANGES


@pytest.mark.parametrize(
    "protection",
    [
        '<w:documentProtection w:edit="readOnly" w:enforcement="1"/>',
        '<w:documentProtection w:edit="comments" w:enforcement="true"/>',
        '<w:writeProtection w:recommended="1"/>',
    ],
)
def test_a_protected_document_is_refused(protection: str) -> None:
    content = DocxBuilder(body=PLAIN, settings=settings_part(protection)).build()
    assert _assess(content) is RefusalCode.PROTECTED


def test_protection_that_word_ignores_is_ignored_here_too() -> None:
    content = DocxBuilder(
        body=PLAIN,
        settings=settings_part('<w:documentProtection w:edit="readOnly" w:enforcement="0"/>'),
    ).build()
    assert _assess(content) is None


def test_a_signed_package_is_refused() -> None:
    """Any edit invalidates the signature, which is the signature working.

    Handing the user a corrected copy with a broken signature would give them
    a document that looks certified and is not.
    """
    content = DocxBuilder(
        body=PLAIN,
        raw_parts={"_xmlsignatures/origin.sigs": b"", "_xmlsignatures/sig1.xml": b"<x/>"},
    ).build()
    assert _assess(content) is RefusalCode.SIGNED


def test_a_signature_is_refused_before_tracked_changes_are_considered() -> None:
    # Order matters only for the message the user reads, and a broken
    # signature is the more consequential of the two.
    content = DocxBuilder(
        body='<w:p><w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">'
        '<w:r><w:t xml:space="preserve">New</w:t></w:r></w:ins></w:p>' + section_properties(),
        raw_parts={"_xmlsignatures/origin.sigs": b""},
    ).build()
    assert _assess(content) is RefusalCode.SIGNED


def test_the_analysis_helper_reports_the_same_refusal() -> None:
    content = DocxBuilder(
        body=PLAIN, settings=settings_part('<w:writeProtection w:recommended="1"/>')
    ).build()
    assert analyze(content).refusal is RefusalCode.PROTECTED
