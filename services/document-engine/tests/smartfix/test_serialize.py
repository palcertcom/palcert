"""Re-serializing a part without changing what it means.

ElementTree invents namespace prefixes on output, and OOXML names prefixes
inside attribute *values* — ``mc:Ignorable="w14 wp14"``. A renamed prefix
leaves the file referring to a namespace it no longer declares, which is how a
formatting fix turns into a document Word refuses to open.
"""

from __future__ import annotations

import io
import zipfile

import pytest

from app.docx.xmlsafe import parse_xml_bytes
from app.smartfix.serialize import PartSerializationError, rewrite_package, serialize_part

PART = (
    b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    b'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
    b'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" '
    b'mc:Ignorable="w14"><w:body><w:p><w:r><w:t xml:space="preserve">Hello</w:t>'
    b"</w:r></w:p></w:body></w:document>"
)


def test_the_root_start_tag_is_preserved_verbatim() -> None:
    root = parse_xml_bytes(PART)
    output = serialize_part(PART, root)
    assert b'mc:Ignorable="w14"' in output
    assert b'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"' in output
    # A prefix ElementTree invented would show up here.
    assert b"ns0:" not in output


def test_the_declaration_is_kept() -> None:
    assert serialize_part(PART, parse_xml_bytes(PART)).startswith(b"<?xml version=")


def test_xml_space_survives() -> None:
    output = serialize_part(PART, parse_xml_bytes(PART))
    assert b'xml:space="preserve"' in output


def test_an_edit_is_reflected() -> None:
    root = parse_xml_bytes(PART)
    body = root[0]
    paragraph = body[0]
    paragraph.set("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}rsidR", "00")
    output = serialize_part(PART, root)
    assert b"w:rsidR" in output


def test_a_comment_before_the_root_is_not_mistaken_for_it() -> None:
    prologue = b'<?xml version="1.0"?><!-- <w:p> --> '
    data = prologue + PART.split(b"?>\r\n", 1)[1]
    output = serialize_part(data, parse_xml_bytes(data))
    assert b"<!-- <w:p> -->" in output
    assert output.count(b"<w:document") == 1


def test_a_doctype_is_refused_rather_than_rewritten() -> None:
    data = b'<!DOCTYPE w:document><w:document xmlns:w="urn:x"/>'
    with pytest.raises(PartSerializationError):
        serialize_part(data, parse_xml_bytes(b'<w:document xmlns:w="urn:x"/>'))


def test_rewriting_a_package_copies_everything_it_did_not_change() -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(zipfile.ZipInfo("a.xml", (2026, 1, 1, 0, 0, 0)), b"<a/>")
        archive.writestr(zipfile.ZipInfo("b.bin", (2026, 1, 1, 0, 0, 0)), b"\x00\x01\x02")

    with zipfile.ZipFile(io.BytesIO(buffer.getvalue())) as source:
        output = rewrite_package(source, {"a.xml": b'<a changed="1"/>'})

    with zipfile.ZipFile(io.BytesIO(output)) as result:
        assert result.namelist() == ["a.xml", "b.bin"]
        assert result.read("a.xml") == b'<a changed="1"/>'
        assert result.read("b.bin") == b"\x00\x01\x02"
        assert result.getinfo("b.bin").date_time == (2026, 1, 1, 0, 0, 0)


def test_rewriting_nothing_produces_the_same_entries() -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(zipfile.ZipInfo("a.xml", (2026, 1, 1, 0, 0, 0)), b"<a/>")

    with zipfile.ZipFile(io.BytesIO(buffer.getvalue())) as source:
        first = rewrite_package(source, {})
    with zipfile.ZipFile(io.BytesIO(buffer.getvalue())) as source:
        second = rewrite_package(source, {})
    # No wall-clock timestamp reaches the archive, so two runs agree exactly.
    assert first == second
